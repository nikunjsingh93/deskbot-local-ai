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
  ollamaNumPredict: intEnv('OLLAMA_NUM_PREDICT', 160),
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

  if (!model) return res.status(400).json({ error: 'Please choose a model first.' });
  if (!userText) return res.status(400).json({ error: 'Message is empty.' });

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
    const llmMessages = buildMessages(incomingMessages, userText, relevantMemories, savedMemory);

    log('INFO', 'Chat request started', {
      provider,
      model,
      messages: llmMessages.length,
      memoryCount: relevantMemories.length,
      savedMemory: Boolean(savedMemory)
    });

    let reply = '';
    let stats = {};

    if (provider === 'ollama') {
      const base = validateBaseUrl(baseUrl);
      const result = await callOllamaChat(base, model, llmMessages);
      reply = result.reply;
      stats = result.stats;

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

    reply = reply.trim() || 'I got an empty response from the model.';
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

function buildMessages(incomingMessages, userText, memories, savedMemory) {
  const safeHistory = incomingMessages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-config.maxHistoryMessages)
    .map((m) => ({ role: m.role, content: sanitizeText(m.content || '', config.maxMessageChars) }))
    .filter((m) => m.content.trim());

  if (!safeHistory.some((m) => m.role === 'user' && m.content.trim() === userText)) {
    safeHistory.push({ role: 'user', content: userText });
  }

  const memoryText = memories.length
    ? memories.map((m) => `- ${m.content}`).join('\n')
    : '- No saved memories matched this message.';

  const savedNote = savedMemory ? `\nThe user just asked you to remember this, and it has already been saved: ${savedMemory.content}` : '';

  const system = `You are DeskBot, a small cute robot pet assistant. Be warm, concise, and useful. You can remember user preferences when the app tells you memory was saved. Do not claim you created reminders yet. Use the saved memories only when relevant.\n\nRelevant saved memories:\n${memoryText}${savedNote}`;

  return [{ role: 'system', content: system }, ...safeHistory];
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
  const scored = memories.map((m) => {
    const haystack = `${m.content} ${m.tags || ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) score += 2;
    }
    if (score === 0) score = 0.1; // keep a few recent memories available even without lexical match
    return { ...m, score };
  });
  return scored.sort((a, b) => b.score - a.score || b.id - a.id).slice(0, limit);
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
