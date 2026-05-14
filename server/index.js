import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const config = {
  port: intEnv('PORT', 5175),
  dataDir: resolveFromRoot(process.env.DATA_DIR || './data'),
  logDir: resolveFromRoot(process.env.LOG_DIR || './logs'),
  allowedHosts: csvEnv('ALLOWED_LLM_HOSTS', 'localhost,127.0.0.1'),
  ollamaNumCtx: intEnv('OLLAMA_NUM_CTX', 1024),
  ollamaNumPredict: intEnv('OLLAMA_NUM_PREDICT', 640),
  ollamaNumThread: intEnv('OLLAMA_NUM_THREAD', 4),
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE ?? '0',
  ollamaTemperature: numEnv('OLLAMA_TEMPERATURE', 0.7),
  ollamaTopK: intEnv('OLLAMA_TOP_K', 40),
  ollamaTopP: numEnv('OLLAMA_TOP_P', 0.9),
  chatTimeoutMs: intEnv('CHAT_TIMEOUT_MS', 30000),
  modelFetchTimeoutMs: intEnv('MODEL_FETCH_TIMEOUT_MS', 10000),
  unloadTimeoutMs: intEnv('UNLOAD_TIMEOUT_MS', 8000),
  errorCooldownMs: intEnv('OLLAMA_ERROR_COOLDOWN_MS', 30000),
  maxHistoryMessages: intEnv('MAX_HISTORY_MESSAGES', 4),
  maxMessageChars: intEnv('MAX_MESSAGE_CHARS', 1200),
  explicitUnloadAfterChat: boolEnv('AUTO_EXPLICIT_UNLOAD_AFTER_CHAT', false)
};

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.logDir, { recursive: true });
const logFile = path.join(config.logDir, 'deskbot.log');

const db = new Database(path.join(config.dataDir, 'deskbot.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source_text TEXT,
  tags TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  model TEXT,
  user_text TEXT,
  assistant_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const insertMemory = db.prepare('INSERT INTO memories (content, source_text, tags) VALUES (?, ?, ?)');
const getMemories = db.prepare('SELECT id, content, tags, created_at, updated_at FROM memories ORDER BY id DESC');
const deleteMemory = db.prepare('DELETE FROM memories WHERE id = ?');
const insertMessageLog = db.prepare('INSERT INTO message_log (provider, model, user_text, assistant_text) VALUES (?, ?, ?, ?)');

let llmBusy = false;
let cooldownUntil = 0;
let activeRequest = null;
const CONTINUE_PROMPT = 'Continue exactly where you stopped. Do not repeat prior text. Continue the same sentence naturally.';
const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let serverKokoro = null;
let serverKokoroLoadPromise = null;

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'DeskBot backend', busy: llmBusy, cooldownMs: Math.max(0, cooldownUntil - Date.now()) });
});

app.get('/api/logs', (_req, res) => {
  try {
    const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    res.type('text/plain').send(text.split('\n').slice(-250).join('\n'));
  } catch (err) {
    res.status(500).type('text/plain').send(String(err?.message || err));
  }
});

app.get('/api/memories', (_req, res) => {
  res.json({ memories: getMemories.all() });
});

app.post('/api/memories', (req, res) => {
  const content = sanitizeText(req.body?.content || '', 2000).trim();
  const tags = sanitizeText(req.body?.tags || '', 200).trim();
  if (!content) return res.status(400).json({ error: 'Memory content is required.' });
  const info = insertMemory.run(content, content, tags);
  log('INFO', 'Memory saved manually', { id: info.lastInsertRowid });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/memories/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid memory id.' });
  deleteMemory.run(id);
  log('INFO', 'Memory deleted', { id });
  res.json({ ok: true });
});

app.post('/api/tts/kokoro', async (req, res) => {
  try {
    const text = sanitizeText(req.body?.text || '', 900).trim();
    const voice = sanitizeText(req.body?.voice || 'af_bella', 40).trim() || 'af_bella';
    if (!text) return res.status(400).json({ error: 'TTS text is required.' });

    const tts = await loadServerKokoro();
    const started = Date.now();
    const audio = await tts.generate(text, { voice, speed: 1 });
    const wav = audio.toWav();
    const buffer = Buffer.from(new Uint8Array(wav));
    log('INFO', 'Server Kokoro TTS generated audio', { chars: text.length, voice, bytes: buffer.length, ms: Date.now() - started });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    log('ERROR', 'Server Kokoro TTS failed', { error: err.message });
    res.status(500).json({ error: humanizeError(err) });
  }
});

app.post('/api/models', async (req, res) => {
  const provider = String(req.body?.provider || 'ollama');
  const baseUrl = String(req.body?.baseUrl || '');
  try {
    if (provider === 'ollama') {
      const base = validateBaseUrl(baseUrl);
      const data = await fetchJson(`${base}/api/tags`, { timeoutMs: config.modelFetchTimeoutMs });
      const models = (data.models || []).map((m) => {
        const sizeGb = typeof m.size === 'number' ? m.size / (1024 ** 3) : null;
        return {
          name: m.name,
          modified_at: m.modified_at,
          size: m.size,
          sizeGb,
          blocked: false,
          blockedReason: ''
        };
      });
      log('INFO', 'Fetched Ollama models', { base, count: models.length });
      return res.json({ provider, models });
    }

    if (provider === 'openai') {
      const base = validateBaseUrl(baseUrl);
      const data = await fetchJson(`${base}/models`, { timeoutMs: config.modelFetchTimeoutMs });
      const models = (data.data || []).map((m) => ({ name: m.id, blocked: false }));
      log('INFO', 'Fetched OpenAI-compatible models', { base, count: models.length });
      return res.json({ provider, models });
    }

    res.status(400).json({ error: 'Unknown provider.' });
  } catch (err) {
    log('ERROR', 'Model fetch failed', { provider, baseUrl, error: err.message });
    res.status(500).json({ error: humanizeError(err) });
  }
});

app.post('/api/chat', async (req, res) => {
  const provider = String(req.body?.provider || 'ollama');
  const model = sanitizeText(req.body?.model || '', 120).trim();
  const baseUrl = String(req.body?.baseUrl || '');
  const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const userText = sanitizeText(req.body?.userText || lastUserText(incomingMessages), config.maxMessageChars).trim();
  const clientGeo = normalizeClientGeo(req.body?.clientGeo);

  if (!model) return res.status(400).json({ error: 'Please choose a model first.' });
  if (!userText) return res.status(400).json({ error: 'Message is empty.' });

  if (isTimeIntent(userText)) {
    return res.json({
      reply: formatTimeReply(),
      savedMemory: null,
      memoriesUsed: [],
      stats: { mode: 'direct_time', ok: true }
    });
  }

  if (isSimpleGreeting(userText)) {
    return res.json({
      reply: 'Hello! How can I help?',
      savedMemory: null,
      memoriesUsed: [],
      stats: { mode: 'direct_greeting', ok: true }
    });
  }

  if (isSimpleAcknowledgement(userText)) {
    return res.json({
      reply: 'Sounds good.',
      savedMemory: null,
      memoriesUsed: [],
      stats: { mode: 'direct_acknowledgement', ok: true }
    });
  }

  // Direct tool-style weather handling to avoid LLM "no realtime access" refusals.
  if (isWeatherIntent(userText)) {
    try {
      const directGeo = normalizeClientGeo(req.body?.clientGeo);
      const geo = await resolveGeo(directGeo);
      if (!geo) {
        return res.json({
          reply: 'I could not determine your location for weather yet. Please allow location access, then ask again.',
          savedMemory: null,
          memoriesUsed: [],
          stats: { mode: 'direct_weather', ok: false, reason: 'missing_location' }
        });
      }
      const weather = await fetchCurrentWeatherData(geo);
      const reply = formatWeatherReply(userText, geo, weather);
      return res.json({
        reply,
        savedMemory: null,
        memoriesUsed: [],
        stats: { mode: 'direct_weather', ok: true }
      });
    } catch (err) {
      log('WARN', 'Direct weather handler failed', { error: err.message });
      return res.json({
        reply: 'I could not fetch live weather right now. Please try again in a moment.',
        savedMemory: null,
        memoriesUsed: [],
        stats: { mode: 'direct_weather', ok: false, reason: 'fetch_failed' }
      });
    }
  }

  // Direct nearby places lookup to avoid fabricated recommendations.
  if (isNearbyPlacesIntent(userText)) {
    try {
      const directGeo = normalizeClientGeo(req.body?.clientGeo);
      const geo = await resolveGeo(directGeo);
      if (!geo) {
        return res.json({
          reply: 'I could not determine your location for nearby places yet. Please allow location access, then ask again.',
          savedMemory: null,
          memoriesUsed: [],
          stats: { mode: 'direct_places', ok: false, reason: 'missing_location' }
        });
      }
      const places = await fetchNearbyPlaces(userText, geo);
      const reply = formatNearbyPlacesReply(userText, geo, places);
      return res.json({
        reply,
        savedMemory: null,
        memoriesUsed: [],
        stats: { mode: 'direct_places', ok: true, count: places.length }
      });
    } catch (err) {
      log('WARN', 'Direct places handler failed', { error: err.message });
      return res.json({
        reply: 'I could not fetch nearby places right now. Please try again in a moment.',
        savedMemory: null,
        memoriesUsed: [],
        stats: { mode: 'direct_places', ok: false, reason: 'fetch_failed' }
      });
    }
  }

  if (isDistanceIntent(userText)) {
    try {
      const directGeo = normalizeClientGeo(req.body?.clientGeo);
      const origin = await resolveGeo(directGeo);
      if (!origin) {
        return res.json({
          reply: 'I could not determine your location yet. Please allow location access, then ask again.',
          savedMemory: null,
          memoriesUsed: [],
          stats: { mode: 'direct_distance', ok: false, reason: 'missing_origin' }
        });
      }
      const placeQuery = extractPlaceFromDistanceQuestion(userText);
      if (!placeQuery) {
        return res.json({
          reply: 'Tell me the destination place, for example: "How far is New York from my place?"',
          savedMemory: null,
          memoriesUsed: [],
          stats: { mode: 'direct_distance', ok: false, reason: 'missing_destination' }
        });
      }
      const destination = await geocodePlace(placeQuery);
      const distanceKm = haversineKm(origin.latitude, origin.longitude, destination.latitude, destination.longitude);
      const reply = formatDistanceReply(origin, destination, distanceKm);
      return res.json({
        reply,
        savedMemory: null,
        memoriesUsed: [],
        stats: { mode: 'direct_distance', ok: true, distanceKm }
      });
    } catch (err) {
      log('WARN', 'Direct distance handler failed', { error: err.message });
      return res.json({
        reply: 'I could not compute that distance right now. Please try again in a moment.',
        savedMemory: null,
        memoriesUsed: [],
        stats: { mode: 'direct_distance', ok: false, reason: 'distance_failed' }
      });
    }
  }

  const now = Date.now();
  if (now < cooldownUntil) {
    const seconds = Math.ceil((cooldownUntil - now) / 1000);
    return res.status(429).json({ error: `DeskBot is cooling down for ${seconds}s after a failed Ollama request. This prevents queueing and protects your server.` });
  }
  if (llmBusy) {
    return res.status(429).json({ error: 'DeskBot is already waiting for a model reply. I blocked this extra request to avoid overloading Ollama.' });
  }

  llmBusy = true;
  activeRequest = { provider, model, startedAt: new Date().toISOString() };
  const started = Date.now();

  try {
    const savedMemory = maybeSaveMemory(userText);
    const relevantMemories = findRelevantMemories(userText, 8);
    const liveContext = await maybeBuildLiveContext(userText, clientGeo);
    const llmMessages = buildMessages(incomingMessages, userText, relevantMemories, savedMemory, liveContext);

    log('INFO', 'Chat request started', {
      provider,
      model,
      messages: llmMessages.length,
      memoryCount: relevantMemories.length,
      savedMemory: Boolean(savedMemory),
      liveContext: Boolean(liveContext)
    });

    let reply = '';
    let stats = {};

    if (provider === 'ollama') {
      const base = validateBaseUrl(baseUrl);
      const result = await callOllamaChat(base, model, llmMessages);
      reply = result.reply;
      stats = result.stats;

      // If the output likely hit generation limits, auto-continue once.
      if (shouldAutoContinue(reply, stats, config.ollamaNumPredict)) {
        const continueMessages = [
          ...llmMessages,
          { role: 'assistant', content: reply },
          { role: 'user', content: CONTINUE_PROMPT }
        ];
        const continued = await callOllamaChat(base, model, continueMessages);
        reply = `${reply.trimEnd()} ${continued.reply.trimStart()}`.trim();
        stats = mergeStats(stats, continued.stats);
      }

      if (config.explicitUnloadAfterChat) {
        // Disabled by default. keep_alive=0 on the chat request is usually enough and avoids extra server work.
        await unloadOllamaModel(base, model).catch((err) => log('WARN', 'Explicit unload after chat failed', { model, error: err.message }));
      }
    } else if (provider === 'openai') {
      const base = validateBaseUrl(baseUrl);
      const result = await callOpenAICompatibleChat(base, model, llmMessages);
      reply = result.reply;
      stats = result.stats;
    } else {
      throw new DeskBotError('Unknown provider.');
    }

    reply = cleanupReply(reply, incomingMessages, userText).trim() || 'I got an empty response from the model.';
    insertMessageLog.run(provider, model, userText, reply);
    log('INFO', 'Chat request completed', { provider, model, totalMs: Date.now() - started, ...stats });
    res.json({ reply, savedMemory, memoriesUsed: relevantMemories, stats });
  } catch (err) {
    const totalMs = Date.now() - started;
    if (provider === 'ollama') cooldownUntil = Date.now() + config.errorCooldownMs;
    log('ERROR', 'Chat request failed', { provider, model, totalMs, error: err.message });
    res.status(err instanceof DeskBotError ? 400 : 500).json({ error: humanizeError(err), cooldownMs: Math.max(0, cooldownUntil - Date.now()) });
  } finally {
    llmBusy = false;
    activeRequest = null;
  }
});

app.get('/api/active', (_req, res) => {
  res.json({ busy: llmBusy, activeRequest, cooldownMs: Math.max(0, cooldownUntil - Date.now()) });
});

app.post('/api/ollama/unload', async (req, res) => {
  const baseUrl = String(req.body?.baseUrl || '');
  const model = sanitizeText(req.body?.model || '', 120).trim();
  if (!model) return res.status(400).json({ error: 'Model is required.' });
  try {
    const base = validateBaseUrl(baseUrl);
    const result = await unloadOllamaModel(base, model);
    log('INFO', 'Manual unload completed', { model });
    res.json({ ok: true, result });
  } catch (err) {
    log('ERROR', 'Manual unload failed', { model, error: err.message });
    res.status(500).json({ error: humanizeError(err) });
  }
});

app.post('/api/ollama/panic-unload', async (req, res) => {
  const baseUrl = String(req.body?.baseUrl || '');
  try {
    const base = validateBaseUrl(baseUrl);
    const ps = await fetchJson(`${base}/api/ps`, { timeoutMs: config.unloadTimeoutMs });
    const running = (ps.models || []).map((m) => m.name || m.model).filter(Boolean);
    const results = [];
    for (const name of running) {
      try {
        const out = await unloadOllamaModel(base, name);
        results.push({ model: name, ok: true, result: out });
      } catch (err) {
        results.push({ model: name, ok: false, error: err.message });
      }
    }
    log('WARN', 'Panic unload used', { runningCount: running.length });
    res.json({ ok: true, running, results });
  } catch (err) {
    log('ERROR', 'Panic unload failed', { error: err.message });
    res.status(500).json({ error: humanizeError(err) });
  }
});

app.listen(config.port, () => {
  log('INFO', `DeskBot backend listening on http://localhost:${config.port}`, {
    logFile,
    allowedHosts: config.allowedHosts
  });
});

async function callOllamaChat(base, model, messages) {
  const payload = {
    model,
    messages,
    stream: false,
    keep_alive: parseKeepAlive(config.ollamaKeepAlive),
    options: {
      num_ctx: config.ollamaNumCtx,
      num_predict: config.ollamaNumPredict,
      num_thread: config.ollamaNumThread,
      temperature: config.ollamaTemperature,
      top_k: config.ollamaTopK,
      top_p: config.ollamaTopP
    }
  };
  const data = await fetchJson(`${base}/api/chat`, {
    method: 'POST',
    body: payload,
    timeoutMs: config.chatTimeoutMs
  });
  return {
    reply: data.message?.content || data.response || '',
    stats: {
      loadDurationMs: nsToMs(data.load_duration),
      promptEvalCount: data.prompt_eval_count,
      evalCount: data.eval_count,
      totalDurationMs: nsToMs(data.total_duration)
    }
  };
}

async function loadServerKokoro() {
  if (serverKokoro) return serverKokoro;
  if (serverKokoroLoadPromise) return serverKokoroLoadPromise;

  serverKokoroLoadPromise = (async () => {
    log('INFO', 'Loading server Kokoro TTS model', { model: KOKORO_MODEL_ID, device: 'cpu', dtype: 'q8' });
    const { KokoroTTS } = await import('kokoro-js');
    serverKokoro = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
      device: 'cpu',
      dtype: 'q8',
      progress_callback: (progress) => {
        const status = String(progress?.status || '');
        if (status) log('DEBUG', 'Server Kokoro load progress', { status, file: progress?.file, progress: progress?.progress });
      }
    });
    log('INFO', 'Server Kokoro TTS model ready');
    return serverKokoro;
  })();

  try {
    return await serverKokoroLoadPromise;
  } catch (err) {
    serverKokoro = null;
    serverKokoroLoadPromise = null;
    throw err;
  }
}

async function callOpenAICompatibleChat(base, model, messages) {
  const payload = {
    model,
    messages,
    stream: false,
    max_tokens: config.ollamaNumPredict,
    temperature: config.ollamaTemperature
  };
  const data = await fetchJson(`${base}/chat/completions`, {
    method: 'POST',
    body: payload,
    timeoutMs: config.chatTimeoutMs
  });
  return {
    reply: data.choices?.[0]?.message?.content || '',
    stats: { usage: data.usage }
  };
}

async function unloadOllamaModel(base, model) {
  return fetchJson(`${base}/api/chat`, {
    method: 'POST',
    body: { model, messages: [], keep_alive: 0, stream: false },
    timeoutMs: config.unloadTimeoutMs
  });
}

function buildMessages(incomingMessages, userText, memories, savedMemory, liveContext) {
  const wantsHistory = shouldUseConversationHistory(userText);
  const safeHistory = (wantsHistory ? incomingMessages : incomingMessages.slice(-1))
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-config.maxHistoryMessages)
    .map((m) => ({
      role: m.role,
      content: sanitizeText(
        m.content || '',
        m.role === 'assistant' ? Math.min(config.maxMessageChars, 420) : Math.min(config.maxMessageChars, 700)
      )
    }))
    .filter((m) => m.content.trim());

  if (!safeHistory.some((m) => m.role === 'user' && m.content.trim() === userText)) {
    safeHistory.push({ role: 'user', content: userText });
  }

  const memoryText = memories.length
    ? memories.map((m) => `- ${m.content}`).join('\n')
    : '- No saved memories matched this message.';

  const savedNote = savedMemory ? `\nThe user just asked you to remember this, and it has already been saved: ${savedMemory.content}` : '';
  const webNote = liveContext ? `\n\nLive web facts (retrieved just now):\n${liveContext}\nUse these facts when relevant and mention that they are current.` : '';

  const system = `You are DeskBot, a small cute robot pet assistant. Answer the user's latest message only. Be warm, concise, and useful. Do not continue or repeat old assistant messages. Ignore prior topics unless the latest message clearly asks a follow-up. You can remember user preferences when the app tells you memory was saved. Use the saved memories only when relevant.

Hard limits:
- You do not have calendar, reminder, notification, email, phone, or meeting tools.
- Never invent meetings, schedules, reminders, tasks, plans, or messages.
- Never say you will send, schedule, remind, notify, or contact anyone.
- For greetings or short acknowledgements, reply briefly and do not introduce new topics.

Relevant saved memories:
${memoryText}${savedNote}${webNote}`;

  return [{ role: 'system', content: system }, ...safeHistory];
}

function shouldUseConversationHistory(userText) {
  const text = String(userText || '').toLowerCase();
  return /\b(that|this|it|those|they|them|he|she|same|again|another|more|continue|previous|earlier)\b/.test(text)
    || /^(yes|no|why|how|what about|and|also)\b/.test(text.trim());
}

function isTimeIntent(text) {
  return /\b(what(?:'s| is) the time|current time|tell me the time|time right now)\b/i.test(text);
}

function formatTimeReply() {
  const time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `It is ${time}.`;
}

function isSimpleGreeting(text) {
  return /^(hi|hello|hey|yo|what'?s up|whats up|good morning|good afternoon|good evening)[!.?\s]*$/i.test(String(text || '').trim());
}

function isSimpleAcknowledgement(text) {
  return /^(ok|okay|got it|thanks|thank you|cool|nice|sounds good|alright)[!.?\s]*$/i.test(String(text || '').trim());
}

function maybeSaveMemory(text) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const patterns = [
    /^(?:please\s+)?remember(?: that)?\s+(.+)$/i,
    /^(?:please\s+)?note(?: that)?\s+(.+)$/i,
    /^my\s+(.+?)\s+is\s+(.+)$/i,
    /^i\s+(?:prefer|like|love|hate|use|want)\s+(.+)$/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) {
      let content;
      if (pattern.source.startsWith('^my')) {
        content = `User's ${match[1].trim()} is ${match[2].trim()}.`;
      } else if (pattern.source.includes('prefer|like')) {
        content = `User ${normalized.trim().replace(/\.$/, '')}.`;
      } else {
        content = match[1].trim();
      }
      content = normalizeMemory(content);
      if (content.length >= 4) {
        const info = insertMemory.run(content, normalized, 'auto');
        log('INFO', 'Memory saved automatically', { id: info.lastInsertRowid, content });
        return { id: info.lastInsertRowid, content };
      }
    }
  }
  return null;
}

function normalizeMemory(content) {
  let out = content.trim();
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (!/[.!?]$/.test(out)) out += '.';
  return out;
}

function findRelevantMemories(query, limit = 8) {
  const memories = getMemories.all();
  if (!memories.length) return [];
  const terms = query.toLowerCase().split(/[^a-z0-9.:-]+/i).filter((w) => w.length >= 3).slice(0, 20);
  const identityQuery = /\b(who am i|my name|what(?:'s| is) my name|do you know me)\b/i.test(query);
  const scored = memories.map((m) => {
    const haystack = `${m.content} ${m.tags || ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
    if (identityQuery && /\b(user'?s name|name is|called)\b/i.test(m.content)) score += 4;
    return { ...m, score };
  }).filter((m) => m.score > 0);
  return scored.sort((a, b) => b.score - a.score || b.id - a.id).slice(0, limit);
}

function cleanupReply(reply, incomingMessages, userText) {
  let text = sanitizeText(reply || '', config.maxMessageChars).trim();
  if (!text) return text;

  const userAskedForSchedule = /\b(remind|reminder|schedule|meeting|calendar|task|notify|notification)\b/i.test(userText);
  const priorAssistantText = incomingMessages
    .filter((m) => m?.role === 'assistant')
    .map((m) => String(m.content || ''))
    .join('\n')
    .toLowerCase();
  const userTerms = new Set(
    String(userText || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((term) => term.length >= 4)
  );
  const seen = new Set();
  const parts = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const kept = [];

  for (const rawPart of parts) {
    const sentence = rawPart.trim();
    if (!sentence) continue;
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const overlapsUser = [...userTerms].some((term) => normalized.includes(term));
    const copiedFromPrior = normalized.length > 70 && priorAssistantText.includes(normalized);
    if (copiedFromPrior && !overlapsUser) continue;
    const inventedSchedule = /\b(remind|reminder|schedule|meeting|calendar|task|notify|notification|comms device|send you)\b/i.test(sentence);
    if (inventedSchedule && !userAskedForSchedule) continue;
    kept.push(sentence);
  }

  return kept.join(' ').trim() || text;
}

function lastUserText(messages) {
  const reversed = [...messages].reverse();
  return reversed.find((m) => m?.role === 'user')?.content || '';
}

function validateBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new DeskBotError('Invalid base URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new DeskBotError('Base URL must start with http:// or https://');
  }
  if (!config.allowedHosts.includes(url.hostname)) {
    throw new DeskBotError(`Host ${url.hostname} is not in ALLOWED_LLM_HOSTS. Add it to .env only if you trust it.`);
  }
  return url.toString().replace(/\/$/, '');
}

async function fetchJson(url, options = {}) {
  const method = options.method || 'GET';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    log('DEBUG', 'HTTP finished', { method, url: redactUrl(url), status: response.status, ms: Date.now() - started });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timed out after ${options.timeoutMs || 15000}ms while calling ${redactUrl(url)}`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function sanitizeText(input, maxLen) {
  return String(input ?? '').replace(/\u0000/g, '').slice(0, maxLen);
}

function log(level, message, meta = {}) {
  const line = `${new Date().toISOString()} ${level} ${message}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}\n`;
  fs.appendFileSync(logFile, line);
  if (level !== 'DEBUG') process.stdout.write(line);
}

function humanizeError(err) {
  const msg = err?.message || String(err);
  if (msg.includes('fetch failed')) return 'Could not reach the model server. Check the base URL and whether Ollama/LM Studio is running.';
  return msg;
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return String(url);
  }
}

function nsToMs(ns) {
  return typeof ns === 'number' ? Math.round(ns / 1_000_000) : undefined;
}

function parseKeepAlive(value) {
  if (value === 0 || value === '0') return 0;
  return value;
}

function shouldAutoContinue(reply, stats, maxPredict) {
  const text = String(reply || '').trim();
  if (!text) return false;

  // If model consumed almost all allowed output tokens, it likely stopped by limit.
  const evalCount = Number(stats?.evalCount);
  if (Number.isFinite(evalCount) && evalCount >= Math.max(32, maxPredict - 8)) return true;

  // Also continue when ending looks cut off (no punctuation/closing quote).
  return !/[.!?'"`)\\]]$/.test(text);
}

function mergeStats(first, second) {
  return {
    ...first,
    continued: true,
    continuedLoadDurationMs: second?.loadDurationMs,
    continuedPromptEvalCount: second?.promptEvalCount,
    continuedEvalCount: second?.evalCount,
    continuedTotalDurationMs: second?.totalDurationMs
  };
}

function normalizeClientGeo(input) {
  const lat = Number(input?.latitude);
  const lon = Number(input?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return {
    latitude: lat,
    longitude: lon,
    city: sanitizeText(input?.city || '', 80),
    region: sanitizeText(input?.region || '', 80),
    country: sanitizeText(input?.country || '', 80)
  };
}

async function maybeBuildLiveContext(userText, clientGeo) {
  if (!isWeatherIntent(userText)) return '';
  const geo = await resolveGeo(clientGeo);
  if (!geo) return 'Could not determine current location for weather lookup.';
  try {
    const weather = await fetchCurrentWeather(geo);
    return weather;
  } catch (err) {
    log('WARN', 'Weather lookup failed', { error: err.message });
    return 'Weather lookup failed right now.';
  }
}

function isWeatherIntent(text) {
  const q = String(text || '').toLowerCase();
  return /(weather|temperature|forecast|rain|snow|wind|outside|humidity)/.test(q);
}

function isNearbyPlacesIntent(text) {
  const q = String(text || '').toLowerCase();
  return /(restaurant|food|eat|dinner|lunch|breakfast|cafe|coffee|near me|around my area|around me|nearby)/.test(q);
}

function isDistanceIntent(text) {
  const q = String(text || '').toLowerCase();
  return /(how far|distance|how many miles|how many km|how long to drive|drive to|from my place to)/.test(q);
}

async function resolveGeo(clientGeo) {
  if (clientGeo) return clientGeo;
  try {
    const ip = await fetchJson('https://ipapi.co/json/', { timeoutMs: 6000 });
    const lat = Number(ip?.latitude);
    const lon = Number(ip?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      latitude: lat,
      longitude: lon,
      city: sanitizeText(ip?.city || '', 80),
      region: sanitizeText(ip?.region || '', 80),
      country: sanitizeText(ip?.country_name || '', 80)
    };
  } catch {
    return null;
  }
}

async function fetchCurrentWeather(geo) {
  const data = await fetchCurrentWeatherData(geo);
  return formatWeatherContext(geo, data);
}

async function fetchCurrentWeatherData(geo) {
  const params = new URLSearchParams({
    latitude: String(geo.latitude),
    longitude: String(geo.longitude),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'auto'
  });
  const url = `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
  return fetchJson(url, { timeoutMs: 8000 });
}

function formatWeatherContext(geo, data) {
  const current = data?.current || {};
  const daily = data?.daily || {};
  const loc = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'your area';
  const condition = weatherCodeToText(current.weather_code);
  const temp = Number(current.temperature_2m);
  const feels = Number(current.apparent_temperature);
  const wind = Number(current.wind_speed_10m);
  const high = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
  const low = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;
  const hiLo = Number.isFinite(high) && Number.isFinite(low) ? ` High ${Math.round(high)}°C / Low ${Math.round(low)}°C.` : '';
  const tempText = Number.isFinite(temp) ? `${Math.round(temp)}°C` : 'unknown';
  const feelsText = Number.isFinite(feels) ? `${Math.round(feels)}°C` : 'unknown';
  const windText = Number.isFinite(wind) ? `${Math.round(wind)} km/h` : 'unknown';
  return `Location: ${loc}. Current weather: ${condition}. Temperature ${tempText}, feels like ${feelsText}, wind ${windText}.${hiLo}`;
}

function formatWeatherReply(userText, geo, data) {
  const q = String(userText || '').toLowerCase();
  const current = data?.current || {};
  const daily = data?.daily || {};
  const loc = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'your area';
  const temp = Number(current.temperature_2m);
  const feels = Number(current.apparent_temperature);
  const wind = Number(current.wind_speed_10m);
  const code = Number(current.weather_code);
  const condition = weatherCodeToText(code);
  const high = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null;
  const low = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null;

  const tempText = Number.isFinite(temp) ? `${Math.round(temp)}°C` : 'unknown';
  const feelsText = Number.isFinite(feels) ? `${Math.round(feels)}°C` : 'unknown';
  const windText = Number.isFinite(wind) ? `${Math.round(wind)} km/h` : 'unknown';
  const hiLo = Number.isFinite(high) && Number.isFinite(low) ? ` High ${Math.round(high)}°C / Low ${Math.round(low)}°C.` : '';
  const summary = `Right now in ${loc}: ${condition}, ${tempText} (feels like ${feelsText}), wind ${windText}.${hiLo}`;

  if (/(jacket|coat|wear)/.test(q)) {
    const jacket = shouldWearJacket(temp, feels, wind, code);
    return `${summary} ${jacket}`;
  }
  if (/(umbrella|rain)/.test(q)) {
    const umbrella = shouldCarryUmbrella(code);
    return `${summary} ${umbrella ? 'Yes, carry an umbrella.' : 'Umbrella is probably not needed right now.'}`;
  }
  return summary;
}

function shouldCarryUmbrella(code) {
  return [51, 53, 55, 56, 57, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(Number(code));
}

function shouldWearJacket(temp, feels, wind, code) {
  const rainy = shouldCarryUmbrella(code);
  const cold = Number.isFinite(feels) ? feels <= 16 : Number.isFinite(temp) && temp <= 16;
  const windy = Number.isFinite(wind) && wind >= 22;
  if (cold && rainy) return 'Yes, wear a jacket and bring an umbrella.';
  if (cold || windy) return 'Yes, a jacket is recommended.';
  if (rainy) return 'A light rain layer is a good idea.';
  return 'You probably do not need a jacket right now.';
}

async function fetchNearbyPlaces(userText, geo) {
  const q = String(userText || '').toLowerCase();
  const wantsMexican = /mexican|taco|burrito|quesadilla|enchilada/.test(q);
  const wantsCafe = /cafe|coffee/.test(q);
  const radius = 3500; // meters

  const tags = [];
  if (wantsCafe) {
    tags.push('["amenity"="cafe"]');
  } else {
    tags.push('["amenity"~"restaurant|fast_food"]');
  }
  if (wantsMexican) {
    tags.push('["cuisine"~"mexican|taco|tex-mex",i]');
  }
  const tagFilter = tags.join('');

  const query = `
[out:json][timeout:20];
(
  node(around:${radius},${geo.latitude},${geo.longitude})${tagFilter};
  way(around:${radius},${geo.latitude},${geo.longitude})${tagFilter};
  relation(around:${radius},${geo.latitude},${geo.longitude})${tagFilter};
);
out center tags 30;
`;

  const data = await fetchOverpassWithFallback(query);

  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const withCoords = elements
    .map((el) => {
      const lat = Number(el?.lat ?? el?.center?.lat);
      const lon = Number(el?.lon ?? el?.center?.lon);
      const name = sanitizeText(el?.tags?.name || '', 120);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !name) return null;
      const distanceKm = haversineKm(geo.latitude, geo.longitude, lat, lon);
      return {
        name,
        distanceKm,
        cuisine: sanitizeText(el?.tags?.cuisine || '', 80),
        area: sanitizeText(el?.tags?.['addr:city'] || el?.tags?.['addr:suburb'] || '', 80)
      };
    })
    .filter(Boolean);

  // Deduplicate by name and keep closest.
  const byName = new Map();
  for (const p of withCoords) {
    const key = p.name.toLowerCase();
    const prev = byName.get(key);
    if (!prev || p.distanceKm < prev.distanceKm) byName.set(key, p);
  }
  return [...byName.values()].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 8);
}

async function fetchOverpassWithFallback(query) {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter'
  ];

  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      // Try POST (preferred).
      const postData = await fetchOverpass(endpoint, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'DeskBotLocalAI/1.0 (local nearby search)'
        },
        body: `data=${encodeURIComponent(query)}`
      });
      return postData;
    } catch (err) {
      lastError = err;
      try {
        // Fallback to GET for endpoints that reject POST format.
        const url = `${endpoint}?data=${encodeURIComponent(query)}`;
        const getData = await fetchOverpass(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'DeskBotLocalAI/1.0 (local nearby search)'
          }
        });
        return getData;
      } catch (err2) {
        lastError = err2;
      }
    }
  }
  throw lastError || new Error('All Overpass endpoints failed.');
}

async function fetchOverpass(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timeout);
  }
}

function extractPlaceFromDistanceQuestion(text) {
  const q = String(text || '').trim();
  const patterns = [
    /how far is\s+(.+?)\s+from\s+(?:my place|me|my location|here)\??$/i,
    /distance\s+to\s+(.+?)\??$/i,
    /how many (?:miles|km|kilometers?) to\s+(.+?)\??$/i,
    /from my place to\s+(.+?)\??$/i
  ];
  for (const p of patterns) {
    const m = q.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

async function geocodePlace(query) {
  // Prefer Open-Meteo geocoding (lighter restrictions), then fall back to Nominatim.
  try {
    const params = new URLSearchParams({
      name: query,
      count: '1',
      language: 'en',
      format: 'json'
    });
    const url = `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`;
    const data = await fetchJson(url, { timeoutMs: 9000 });
    const first = Array.isArray(data?.results) ? data.results[0] : null;
    if (first) {
      const lat = Number(first.latitude);
      const lon = Number(first.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const parts = [first.name, first.admin1, first.country].filter(Boolean);
        return {
          latitude: lat,
          longitude: lon,
          displayName: sanitizeText(parts.join(', ') || query, 180)
        };
      }
    }
  } catch {
    // continue to fallback
  }

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '1'
  });
  const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
  const data = await fetchJson(url, { timeoutMs: 9000 });
  const first = Array.isArray(data) ? data[0] : null;
  if (!first) throw new Error('Destination not found.');
  const lat = Number(first.lat);
  const lon = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Destination coordinates invalid.');
  return {
    latitude: lat,
    longitude: lon,
    displayName: sanitizeText(first.display_name || query, 180)
  };
}

function formatDistanceReply(origin, destination, distanceKm) {
  const miles = distanceKm * 0.621371;
  const originLabel = [origin.city, origin.region, origin.country].filter(Boolean).join(', ') || 'your location';
  const place = destination.displayName.split(',').slice(0, 3).join(', ');

  const driveHours = distanceKm / 72; // rough average road speed
  const driveText = driveHours < 1
    ? `${Math.round(driveHours * 60)} min`
    : `${driveHours.toFixed(1)} hr`;

  return `From ${originLabel} to ${place}: about ${distanceKm.toFixed(1)} km (${miles.toFixed(1)} miles) straight-line distance. Rough driving time is around ${driveText}, depending on traffic and route.`;
}

function formatNearbyPlacesReply(userText, geo, places) {
  const loc = [geo.city, geo.region, geo.country].filter(Boolean).join(', ') || 'your area';
  if (!places.length) {
    return `I could not find strong nearby matches in ${loc} right now. Try asking with a broader term like "restaurants near me" or increase search area.`;
  }
  const q = String(userText || '').toLowerCase();
  const header = /mexican|taco|burrito|enchilada/.test(q)
    ? `Here are nearby Mexican options around ${loc}:`
    : `Here are nearby places around ${loc}:`;
  const lines = places.map((p, i) => {
    const cuisine = p.cuisine ? ` · ${p.cuisine}` : '';
    const area = p.area ? ` · ${p.area}` : '';
    return `${i + 1}. ${p.name} (${p.distanceKm.toFixed(1)} km away${cuisine}${area})`;
  });
  return `${header}\n\n${lines.join('\n')}\n\nThese are from live map data near your current location.`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function weatherCodeToText(code) {
  const c = Number(code);
  const map = {
    0: 'clear sky',
    1: 'mainly clear',
    2: 'partly cloudy',
    3: 'overcast',
    45: 'fog',
    48: 'depositing rime fog',
    51: 'light drizzle',
    53: 'moderate drizzle',
    55: 'dense drizzle',
    61: 'slight rain',
    63: 'moderate rain',
    65: 'heavy rain',
    71: 'slight snow',
    73: 'moderate snow',
    75: 'heavy snow',
    80: 'rain showers',
    81: 'rain showers',
    82: 'violent rain showers',
    95: 'thunderstorm'
  };
  return map[c] || 'unknown conditions';
}

function intEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
}

function numEnv(name, fallback) {
  const value = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function csvEnv(name, fallback) {
  return String(process.env[name] || fallback).split(',').map((x) => x.trim()).filter(Boolean);
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.resolve(rootDir, p);
}

class DeskBotError extends Error {}
