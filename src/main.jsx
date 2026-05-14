import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, Mic, MicOff, Send, Settings, Trash2, RefreshCw, Volume2, VolumeX, Database, AlertTriangle, X } from 'lucide-react';
import './styles.css';
import { runStandaloneChat } from './standaloneLLM.js';
import { speakWithKokoro, stopKokoroPlayback } from './localTTS.js';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const STORAGE_KEY = 'deskbot_minimal_safe_v1';
const DEFAULT_STANDALONE_MODEL = 'onnx-community/SmolLM2-360M-Instruct-ONNX';
const WAKE_SILENCE_SEND_MS = 1200;

const defaultSettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://192.168.1.213:11434',
  ollamaModel: '',
  openaiBaseUrl: 'http://localhost:1234/v1',
  openaiModel: '',
  standaloneModel: 'onnx-community/SmolLM2-360M-Instruct-ONNX',
  ttsEnabled: true,
  autoSpeak: true,
  ttsEngine: 'browser',
  kokoroVoice: 'af_bella',
  wakeEnabled: false,
  wakeWord: 'robot'
};

function App() {
  const [settings, setSettings] = useLocalState('deskbot_settings_v1', defaultSettings);
  const [messages, setMessages] = useLocalState(STORAGE_KEY, [
    { role: 'assistant', content: 'Hi! I am DeskBot. I can chat and remember things you tell me.' }
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState('idle');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState([]);
  const [modelStatus, setModelStatus] = useState('');
  const [wakeArmed, setWakeArmed] = useState(false);
  const [memories, setMemories] = useState([]);
  const [logs, setLogs] = useState('');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const chatEndRef = useRef(null);
  const recognitionRef = useRef(null);
  const manualStopRef = useRef(false);
  const ignoreRecognitionErrorRef = useRef(false);
  const wakeCaptureTimerRef = useRef(null);
  const wakeCapturedRef = useRef('');
  const wakeArmedRef = useRef(false);
  const wakeEnabledPrevRef = useRef(false);

  const activeModel = settings.provider === 'ollama'
    ? settings.ollamaModel
    : settings.provider === 'openai'
      ? settings.openaiModel
      : (settings.standaloneModel || DEFAULT_STANDALONE_MODEL);
  const activeBaseUrl = settings.provider === 'ollama' ? settings.ollamaBaseUrl : settings.openaiBaseUrl;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    refreshMemories();
    fetch('/api/health').catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings.standaloneModel) {
      updateSettings({ standaloneModel: DEFAULT_STANDALONE_MODEL });
    }
  }, [settings.standaloneModel]);

  useEffect(() => {
    if (!['browser', 'kokoro'].includes(settings.ttsEngine)) {
      updateSettings({ ttsEngine: 'browser' });
    }
  }, [settings.ttsEngine]);

  useEffect(() => {
    if (!settings.kokoroVoice) {
      updateSettings({ kokoroVoice: 'af_bella' });
    }
  }, [settings.kokoroVoice]);

  useEffect(() => {
    if (!settings.wakeWord) {
      updateSettings({ wakeWord: 'robot' });
    }
  }, [settings.wakeWord]);

  useEffect(() => {
    const wasEnabled = wakeEnabledPrevRef.current;
    const isEnabled = Boolean(settings.wakeEnabled);
    wakeEnabledPrevRef.current = isEnabled;

    if (isEnabled && !wasEnabled) {
      window.setTimeout(() => {
        if (!busy && !speaking && !listening) {
          toggleListening();
        }
      }, 50);
      return;
    }

    if (!isEnabled && wasEnabled && listening) {
      manualStopRef.current = true;
      ignoreRecognitionErrorRef.current = true;
      recognitionRef.current?.stop();
      setListening(false);
      setWakeArmedState(false);
      setModelStatus('');
    }
  }, [settings.wakeEnabled, busy, speaking, listening]);

  function updateSettings(patch) {
    setSettings((prev) => ({ ...prev, ...patch }));
  }

  function setWakeArmedState(next) {
    wakeArmedRef.current = next;
    setWakeArmed(next);
  }

  function clearChatHistory() {
    setMessages([]);
    setError('');
    setModelStatus('');
  }

  const assistantName = String(settings.wakeWord || 'robot').trim() || 'robot';

  async function sendMessage(textOverride) {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setError('');
    setInput('');
    setBusy(true);
    setMood('thinking');
    if (settings.provider === 'standalone') {
      setModelStatus('Preparing standalone model...');
    } else if (settings.provider === 'ollama') {
      setModelStatus('Loading Ollama model and generating reply...');
    } else {
      setModelStatus('Loading model and generating reply...');
    }

    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);

    try {
      let data;
      if (settings.provider === 'standalone') {
        data = await runStandaloneChat({
          messages: nextMessages.slice(-8),
          userText: text,
          model: settings.standaloneModel,
          onStatus: setModelStatus
        });
      } else {
        const clientGeo = needsGeoLookup(text) ? await getBrowserGeo() : null;
        const response = await fetch(`${API_BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: settings.provider,
            baseUrl: activeBaseUrl,
            model: activeModel,
            userText: text,
            messages: nextMessages.slice(-8),
            clientGeo
          })
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Chat request failed.');
      }

      const assistantMessage = { role: 'assistant', content: data.reply, savedMemory: data.savedMemory, stats: data.stats };
      setMessages([...nextMessages, assistantMessage]);
      setMood(data.savedMemory ? 'happy' : 'idle');
      if (settings.ttsEnabled && settings.autoSpeak) {
        await speak(data.reply);
      }
      if (data.savedMemory) refreshMemories();
      setModelStatus('');
    } catch (err) {
      setError(err.message || String(err));
      setMessages([...nextMessages, { role: 'assistant', content: `I stopped: ${err.message || err}` }]);
      setMood('worried');
      setModelStatus('Request failed.');
    } finally {
      setBusy(false);
      window.setTimeout(() => setMood('idle'), 1400);
      if (settings.wakeEnabled) {
        window.setTimeout(() => {
          if (!listening && !speaking) {
            toggleListening();
          }
        }, 60);
      }
    }
  }

  async function fetchModels() {
    if (settings.provider === 'standalone') {
      const standaloneModels = [
        { name: 'onnx-community/SmolLM2-360M-Instruct-ONNX' },
        { name: 'onnx-community/SmolLM2-135M-Instruct-ONNX-MHA' }
      ];
      setModels(standaloneModels);
      setModelStatus('Standalone model list ready. First run downloads and caches model files in your browser.');
      if (!settings.standaloneModel) {
        updateSettings({ standaloneModel: standaloneModels[0].name });
      }
      return;
    }

    setModelStatus('Fetching models...');
    setModels([]);
    try {
      const response = await fetch(`${API_BASE}/api/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: settings.provider, baseUrl: activeBaseUrl })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch models.');
      setModels(data.models || []);
      const available = data.models || [];
      setModelStatus(`Found ${available.length} model(s).`);
      if (settings.provider === 'ollama') {
        const selected = data.models?.find((m) => m.name === settings.ollamaModel);
        if (!selected && available[0]) {
          updateSettings({ ollamaModel: available[0].name });
          setModelStatus(`Selected model not found, switched to ${available[0].name}.`);
        }
      }
      if (settings.provider === 'openai' && !settings.openaiModel && available[0]) {
        updateSettings({ openaiModel: available[0].name });
      }
    } catch (err) {
      setModelStatus(err.message || String(err));
    }
  }

  async function refreshMemories() {
    try {
      const response = await fetch(`${API_BASE}/api/memories`);
      const data = await response.json();
      setMemories(data.memories || []);
    } catch {
      // backend may not be awake yet
    }
  }

  async function addMemory(content) {
    const trimmed = content.trim();
    if (!trimmed) return;
    await fetch(`${API_BASE}/api/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: trimmed, tags: 'manual' })
    });
    refreshMemories();
  }

  async function deleteMemory(id) {
    await fetch(`${API_BASE}/api/memories/${id}`, { method: 'DELETE' });
    refreshMemories();
  }

  async function refreshLogs() {
    const response = await fetch(`${API_BASE}/api/logs`);
    setLogs(await response.text());
  }

  async function speak(text) {
    if (!('speechSynthesis' in window)) return;
    if (listening) {
      manualStopRef.current = true;
      if (wakeCaptureTimerRef.current) {
        clearTimeout(wakeCaptureTimerRef.current);
        wakeCaptureTimerRef.current = null;
      }
      recognitionRef.current?.stop();
      setListening(false);
      setWakeArmedState(false);
    }
    setSpeaking(true);

    try {
      const cleanText = text
        .replace(/```[\s\S]*?```/g, ' code omitted ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/^[\-\*\d\.\)\s]+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();

      if (!cleanText) return;

      stopKokoroPlayback();
      if (settings.ttsEngine === 'kokoro') {
        try {
          window.speechSynthesis.cancel();
          await speakWithKokoro(cleanText, {
            onStatus: setModelStatus,
            voice: settings.kokoroVoice || 'af_bella'
          });
          setModelStatus('');
          return;
        } catch {
          setModelStatus('Neural TTS unavailable, using default local voice.');
        }
      }

      window.speechSynthesis.cancel();
      const baseRate = 1.0;
      const basePitch = 1.0;
      const chunks = cleanText.match(/[^.!?]+[.!?]?/g) || [cleanText];

      for (const rawChunk of chunks) {
        const chunk = rawChunk.trim();
        if (!chunk) continue;
        await new Promise((resolve) => {
          const utterance = new SpeechSynthesisUtterance(chunk);
          utterance.rate = baseRate;
          utterance.pitch = basePitch;
          utterance.volume = 1;
          utterance.onend = () => {
            setModelStatus('');
            resolve();
          };
          utterance.onerror = () => resolve();
          window.speechSynthesis.speak(utterance);
        });
      }
    } finally {
      setSpeaking(false);
    }
  }

  function toggleListening() {
    if (speaking) return;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('Speech recognition is not available in this browser. Chrome works best.');
      return;
    }
    if (listening) {
      manualStopRef.current = true;
      if (wakeCaptureTimerRef.current) {
        clearTimeout(wakeCaptureTimerRef.current);
        wakeCaptureTimerRef.current = null;
      }
      recognitionRef.current?.stop();
      setListening(false);
      setMood('idle');
      setWakeArmedState(false);
      wakeCapturedRef.current = '';
      setModelStatus('');
      return;
    }
    manualStopRef.current = false;
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = true;
    recognition.onspeechstart = () => {
      if (wakeCaptureTimerRef.current) {
        clearTimeout(wakeCaptureTimerRef.current);
        wakeCaptureTimerRef.current = null;
      }
    };
    recognition.onspeechend = () => {
      if (!settings.wakeEnabled || !wakeArmedRef.current) return;
      const hasCapturedQuery = Boolean(wakeCapturedRef.current.trim());
      if (!hasCapturedQuery) return;
      if (wakeCaptureTimerRef.current) clearTimeout(wakeCaptureTimerRef.current);
      wakeCaptureTimerRef.current = setTimeout(() => {
        manualStopRef.current = true;
        recognitionRef.current?.stop();
      }, 2500);
    };
    recognition.onstart = () => {
      setListening(true);
      setMood('listening');
      wakeCapturedRef.current = '';
      if (settings.wakeEnabled) {
        setModelStatus(`Wake mode on. Say "${assistantName}" then your question.`);
        setWakeArmedState(false);
      }
    };
    recognition.onresult = (event) => {
      const transcript = event.results?.[event.resultIndex]?.[0]?.transcript?.trim() || '';
      if (!transcript) return;

      if (settings.wakeEnabled) {
        const wake = String(settings.wakeWord || 'robot').trim();
        const wakeMatch = findWakeWordMatch(transcript, wake);
        const hasWake = Boolean(wakeMatch);
        if (!hasWake && !wakeArmedRef.current) return;
        const withoutWake = hasWake ? wakeMatch.restText : transcript;
        const userQuery = withoutWake.trim().replace(/^[,.:;\s-]+/, '');
        if (!userQuery) {
          setWakeArmedState(true);
          wakeCapturedRef.current = '';
          setModelStatus(`Heard "${wake}". Now ask your question.`);
          return;
        }
        setWakeArmedState(true);
        wakeCapturedRef.current = wakeCapturedRef.current
          ? `${wakeCapturedRef.current} ${userQuery}`.trim()
          : userQuery;
        setInput(wakeCapturedRef.current);
        setModelStatus('Listening... capturing your question.');
        if (wakeCaptureTimerRef.current) clearTimeout(wakeCaptureTimerRef.current);
        wakeCaptureTimerRef.current = setTimeout(() => {
          manualStopRef.current = true;
          recognitionRef.current?.stop();
        }, WAKE_SILENCE_SEND_MS);
        return;
      }

      setInput(transcript);
      if (transcript) {
        manualStopRef.current = true;
        recognitionRef.current?.stop();
        sendMessage(transcript);
      }
    };
    recognition.onerror = (event) => {
      if (ignoreRecognitionErrorRef.current) {
        ignoreRecognitionErrorRef.current = false;
        return;
      }
      setError(`Voice input error: ${event.error}`);
      setMood('worried');
    };
    recognition.onend = () => {
      if (wakeCaptureTimerRef.current) {
        clearTimeout(wakeCaptureTimerRef.current);
        wakeCaptureTimerRef.current = null;
      }
      const capturedQuery = wakeCapturedRef.current.trim();
      setListening(false);
      setMood('idle');
      setWakeArmedState(false);
      wakeCapturedRef.current = '';
      if (settings.wakeEnabled && capturedQuery) {
        setInput(capturedQuery);
        if (!busy) {
          sendMessage(capturedQuery);
          return;
        }
      }
      if (!busy) setModelStatus('');
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  const allowedModels = useMemo(() => models, [models]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><Bot size={22} /> DeskBot</div>
        <button className="icon-button" onClick={() => setSettingsOpen(true)} title="Settings"><Settings /></button>
      </header>

      <main className="main-panel">
        <section className="robot-stage">
          <RobotFace mood={mood} />
          <div className="robot-status">
            {busy ? 'Thinking...' : listening ? 'Listening...' : 'Ready'}
          </div>
          <div className="model-line">
            {settings.provider === 'ollama' ? 'Ollama' : settings.provider === 'openai' ? 'LM Studio/OpenAI' : 'Standalone (WebGPU)'} · {activeModel || 'no model selected'}
          </div>
          {(busy || modelStatus) && <div className="model-status-live">{modelStatus || 'Working...'}</div>}
        </section>

        <section className="chat-panel">
          <div className="chat-scroll">
            {messages.map((message, idx) => (
              <div key={idx} className={`message ${message.role}`}>
                <div className="bubble">
                  {message.content}
                  {message.savedMemory && <div className="memory-note">Memory saved: {message.savedMemory.content}</div>}
                </div>
              </div>
            ))}
            {busy && <div className="message assistant"><div className="bubble typing">Thinking<span>.</span><span>.</span><span>.</span></div></div>}
            {listening && (!settings.wakeEnabled || wakeArmed) && (
              <div className="message assistant listen-inline">
                <div className="bubble listening-chip">
                  {settings.wakeEnabled
                    ? (wakeArmed ? 'Listening... ask now.' : `Listening for "${assistantName}"...`)
                    : 'Listening...'}
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>

          {error && <div className="error-box"><AlertTriangle size={16} /> {error}</div>}

          <form className={`composer ${settings.wakeEnabled ? 'wake-enabled' : ''}`} onSubmit={(e) => { e.preventDefault(); sendMessage(); }}>
            {!settings.wakeEnabled && (
              <button type="button" className={`round-button ${listening ? 'active' : ''}`} onClick={toggleListening} disabled={busy} title="Voice input">
                {listening ? <MicOff /> : <Mic />}
              </button>
            )}
            <button
              type="button"
              className={`round-button ${settings.ttsEnabled ? '' : 'active'}`}
              onClick={() => {
                const nextEnabled = !settings.ttsEnabled;
                updateSettings({ ttsEnabled: nextEnabled });
                if (!nextEnabled) {
                  window.speechSynthesis.cancel();
                  stopKokoroPlayback();
                  setModelStatus('');
                }
              }}
              disabled={busy}
              title={settings.ttsEnabled ? 'Mute voice replies' : 'Unmute voice replies'}
            >
              {settings.ttsEnabled ? <Volume2 /> : <VolumeX />}
            </button>
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask DeskBot, or say: Remember that I prefer simple Docker setups..." disabled={busy} />
            <button type="submit" className="send-button" disabled={busy || !input.trim()}><Send size={18} /> Send</button>
          </form>
        </section>
      </main>

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          updateSettings={updateSettings}
          clearChatHistory={clearChatHistory}
          close={() => setSettingsOpen(false)}
          fetchModels={fetchModels}
          models={models}
          allowedModels={allowedModels}
          modelStatus={modelStatus}
          memories={memories}
          refreshMemories={refreshMemories}
          addMemory={addMemory}
          deleteMemory={deleteMemory}
          logs={logs}
          refreshLogs={refreshLogs}
        />
      )}
    </div>
  );
}

function RobotFace({ mood }) {
  return (
    <div className={`robot-face ${mood}`}>
      <div className="antenna" />
      <div className="head">
        <div className="eye left"><div className="pupil" /></div>
        <div className="eye right"><div className="pupil" /></div>
        <div className="mouth" />
      </div>
      <div className="neck" />
      <div className="body-light" />
    </div>
  );
}

function isWeatherQuery(text) {
  return /(weather|temperature|forecast|rain|snow|wind|outside|humidity|jacket|umbrella)/i.test(String(text || ''));
}

function isNearbyPlacesQuery(text) {
  return /(restaurant|food|eat|dinner|lunch|breakfast|cafe|coffee|near me|around me|around my area|around my location)/i.test(String(text || ''));
}

function isDistanceQuery(text) {
  return /(how far|distance|how many miles|how many km|how long to drive|from my place to)/i.test(String(text || ''));
}

function needsGeoLookup(text) {
  const q = String(text || '');
  return isWeatherQuery(q) || isNearbyPlacesQuery(q) || isDistanceQuery(q);
}

function findWakeWordMatch(transcript, wakeWord) {
  const cleanedWake = normalizeToken(wakeWord);
  if (!cleanedWake) return null;
  const tokens = String(transcript || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const normalized = normalizeToken(tokens[i]);
    if (!normalized) continue;
    const isExact = normalized === cleanedWake;
    const isNear = normalized.length >= 3 && cleanedWake.length >= 3 && editDistanceAtMostOne(normalized, cleanedWake);
    if (!isExact && !isNear) continue;
    const restText = tokens.filter((_, idx) => idx !== i).join(' ');
    return { restText };
  }
  return null;
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) {
      i += 1;
    } else if (b.length > a.length) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  if (i < a.length || j < b.length) edits += 1;
  return edits <= 1;
}

function getBrowserGeo() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude
        });
      },
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 2500, maximumAge: 10 * 60 * 1000 }
    );
  });
}

function SettingsPanel({ settings, updateSettings, clearChatHistory, close, fetchModels, models, allowedModels, modelStatus, memories, refreshMemories, addMemory, deleteMemory, logs, refreshLogs }) {
  const [tab, setTab] = useState('model');
  const [newMemory, setNewMemory] = useState('');

  return (
    <div className="modal-backdrop">
      <div className="settings-modal">
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="icon-button" onClick={close}><X /></button>
        </div>
        <div className="tabs">
          <button className={tab === 'model' ? 'active' : ''} onClick={() => setTab('model')}>Model</button>
          <button className={tab === 'memory' ? 'active' : ''} onClick={() => { setTab('memory'); refreshMemories(); }}><Database size={16} /> Memory</button>
          <button className={tab === 'diagnostics' ? 'active' : ''} onClick={() => setTab('diagnostics')}>Diagnostics</button>
          <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>About</button>
        </div>

        {tab === 'model' && (
          <div className="settings-section">
            <label>Provider</label>
            <select value={settings.provider} onChange={(e) => updateSettings({ provider: e.target.value })}>
              <option value="ollama">Ollama</option>
              <option value="openai">LM Studio / OpenAI-compatible</option>
              <option value="standalone">Standalone (Browser WebGPU)</option>
            </select>

            {settings.provider === 'ollama' ? (
              <>
                <label>Ollama Base URL</label>
                <input value={settings.ollamaBaseUrl} onChange={(e) => updateSettings({ ollamaBaseUrl: e.target.value })} />
                <label>Ollama Model</label>
                <select value={settings.ollamaModel} onChange={(e) => updateSettings({ ollamaModel: e.target.value })}>
                  <option value="">Select after fetching models</option>
                  {allowedModels.map((m) => <option key={m.name} value={m.name}>{m.name}{m.sizeGb ? ` · ${m.sizeGb.toFixed(2)} GB` : ''}</option>)}
                </select>
              </>
            ) : settings.provider === 'openai' ? (
              <>
                <label>LM Studio/OpenAI Base URL</label>
                <input value={settings.openaiBaseUrl} onChange={(e) => updateSettings({ openaiBaseUrl: e.target.value })} />
                <label>Model</label>
                <select value={settings.openaiModel} onChange={(e) => updateSettings({ openaiModel: e.target.value })}>
                  <option value="">Select after fetching models</option>
                  {models.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
              </>
            ) : (
              <>
                <label>Standalone Model</label>
                <select value={settings.standaloneModel} onChange={(e) => updateSettings({ standaloneModel: e.target.value })}>
                  <option value="onnx-community/SmolLM2-360M-Instruct-ONNX">SmolLM2 360M (better quality)</option>
                  <option value="onnx-community/SmolLM2-135M-Instruct-ONNX-MHA">SmolLM2 135M (faster)</option>
                </select>
                <p className="muted small">First message downloads model files into browser cache. WebGPU is used when available, with CPU fallback.</p>
              </>
            )}

            <div className="row-buttons">
              <button onClick={fetchModels}><RefreshCw size={16} /> Fetch model list</button>
              <button className="danger-light" onClick={clearChatHistory}><Trash2 size={16} /> Clear chat history</button>
            </div>
            {modelStatus && <p className="muted">{modelStatus}</p>}

            <label className="checkbox-row">
              <input type="checkbox" checked={settings.ttsEnabled} onChange={(e) => updateSettings({ ttsEnabled: e.target.checked })} />
              {settings.ttsEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />} Browser TTS voice replies
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={settings.autoSpeak} onChange={(e) => updateSettings({ autoSpeak: e.target.checked })} />
              Auto-speak replies
            </label>
            <label>TTS Engine</label>
            <select value={settings.ttsEngine || 'browser'} onChange={(e) => updateSettings({ ttsEngine: e.target.value })}>
              <option value="browser">Browser default voice</option>
              <option value="kokoro">Kokoro local neural TTS</option>
            </select>
            {settings.ttsEngine === 'kokoro' && (
              <>
                <label>Kokoro Voice</label>
                <select value={settings.kokoroVoice || 'af_bella'} onChange={(e) => updateSettings({ kokoroVoice: e.target.value })}>
                  <option value="af_bella">Bella (female)</option>
                  <option value="af_heart">Heart (female)</option>
                  <option value="af_nicole">Nicole (female)</option>
                  <option value="af_sarah">Sarah (female)</option>
                  <option value="am_michael">Michael (male)</option>
                  <option value="am_fenrir">Fenrir (male)</option>
                  <option value="am_puck">Puck (male)</option>
                  <option value="am_eric">Eric (male)</option>
                  <option value="am_liam">Liam (male)</option>
                </select>
                <p className="muted small">First use downloads model files locally and caches them in browser storage. If unavailable, DeskBot automatically falls back to browser voice.</p>
              </>
            )}
            <label className="checkbox-row">
              <input type="checkbox" checked={Boolean(settings.wakeEnabled)} onChange={(e) => updateSettings({ wakeEnabled: e.target.checked })} />
              Enable wake word listening
            </label>
            <label>Assistant name / wake word</label>
            <input
              value={settings.wakeWord || 'robot'}
              onChange={(e) => updateSettings({ wakeWord: e.target.value })}
              placeholder="robot"
            />
            <p className="muted small">Wake is off by default. Turn it on, then say the wake word and your question, for example: "robot what is the weather?".</p>
          </div>
        )}

        {tab === 'memory' && (
          <div className="settings-section">
            <label>Add memory manually</label>
            <div className="memory-add">
              <input value={newMemory} onChange={(e) => setNewMemory(e.target.value)} placeholder="Example: User prefers simple Docker steps." />
              <button onClick={() => { addMemory(newMemory); setNewMemory(''); }}>Add</button>
            </div>
            <div className="memory-list">
              {memories.length === 0 && <p className="muted">No memories yet. Say “Remember that...” in chat.</p>}
              {memories.map((memory) => (
                <div className="memory-item" key={memory.id}>
                  <div>
                    <strong>#{memory.id}</strong> {memory.content}
                    <div className="muted small">{memory.created_at}</div>
                  </div>
                  <button className="icon-button" onClick={() => deleteMemory(memory.id)}><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'diagnostics' && (
          <div className="settings-section">
            <button onClick={refreshLogs}>Refresh backend logs</button>
            <pre className="logs">{logs || 'Click Refresh backend logs.'}</pre>
          </div>
        )}

        {tab === 'about' && (
          <div className="settings-section">
            <h3>Open Source Licenses</h3>
            <p className="muted small">This app uses open source packages. License links:</p>
            <div className="license-list">
              <a href="https://github.com/facebook/react/blob/main/LICENSE" target="_blank" rel="noreferrer">React (MIT)</a>
              <a href="https://github.com/facebook/react/blob/main/LICENSE" target="_blank" rel="noreferrer">React DOM (MIT)</a>
              <a href="https://github.com/vitejs/vite/blob/main/LICENSE.md" target="_blank" rel="noreferrer">Vite (MIT)</a>
              <a href="https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/LICENSE" target="_blank" rel="noreferrer">@vitejs/plugin-react (MIT)</a>
              <a href="https://github.com/expressjs/express/blob/master/LICENSE" target="_blank" rel="noreferrer">Express (MIT)</a>
              <a href="https://github.com/expressjs/cors/blob/master/LICENSE" target="_blank" rel="noreferrer">cors (MIT)</a>
              <a href="https://github.com/motdotla/dotenv/blob/master/LICENSE" target="_blank" rel="noreferrer">dotenv (BSD-2-Clause)</a>
              <a href="https://github.com/open-cli-tools/concurrently/blob/main/LICENSE" target="_blank" rel="noreferrer">concurrently (MIT)</a>
              <a href="https://github.com/WiseLibs/better-sqlite3/blob/master/LICENSE" target="_blank" rel="noreferrer">better-sqlite3 (MIT)</a>
              <a href="https://sqlite.org/copyright.html" target="_blank" rel="noreferrer">SQLite (Public Domain)</a>
              <a href="https://github.com/lucide-icons/lucide/blob/main/LICENSE" target="_blank" rel="noreferrer">lucide-react (ISC)</a>
              <a href="https://github.com/huggingface/transformers.js/blob/main/LICENSE" target="_blank" rel="noreferrer">@huggingface/transformers (Apache-2.0)</a>
              <a href="https://github.com/hexgrad/kokoro/blob/main/LICENSE" target="_blank" rel="noreferrer">kokoro-js / Kokoro model (Apache-2.0)</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function useLocalState(key, initialValue) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : initialValue;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue];
}

createRoot(document.getElementById('root')).render(<App />);
