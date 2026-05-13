import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, Mic, MicOff, Send, Settings, Trash2, RefreshCw, Volume2, VolumeX, Database, AlertTriangle, X } from 'lucide-react';
import './styles.css';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const STORAGE_KEY = 'deskbot_minimal_safe_v1';

const defaultSettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://192.168.1.213:11434',
  ollamaModel: 'qwen2.5:0.5b',
  openaiBaseUrl: 'http://localhost:1234/v1',
  openaiModel: '',
  ttsEnabled: true,
  autoSpeak: true
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
  const [memories, setMemories] = useState([]);
  const [logs, setLogs] = useState('');
  const [listening, setListening] = useState(false);
  const chatEndRef = useRef(null);
  const recognitionRef = useRef(null);

  const activeModel = settings.provider === 'ollama' ? settings.ollamaModel : settings.openaiModel;
  const activeBaseUrl = settings.provider === 'ollama' ? settings.ollamaBaseUrl : settings.openaiBaseUrl;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    refreshMemories();
    fetch('/api/health').catch(() => {});
  }, []);

  function updateSettings(patch) {
    setSettings((prev) => ({ ...prev, ...patch }));
  }

  async function sendMessage(textOverride) {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setError('');
    setInput('');
    setBusy(true);
    setMood('thinking');

    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);

    try {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: settings.provider,
          baseUrl: activeBaseUrl,
          model: activeModel,
          userText: text,
          messages: nextMessages.slice(-8)
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Chat request failed.');
      const assistantMessage = { role: 'assistant', content: data.reply, savedMemory: data.savedMemory, stats: data.stats };
      setMessages([...nextMessages, assistantMessage]);
      setMood(data.savedMemory ? 'happy' : 'idle');
      if (settings.ttsEnabled && settings.autoSpeak) speak(data.reply);
      if (data.savedMemory) refreshMemories();
    } catch (err) {
      setError(err.message || String(err));
      setMessages([...nextMessages, { role: 'assistant', content: `I stopped: ${err.message || err}` }]);
      setMood('worried');
    } finally {
      setBusy(false);
      window.setTimeout(() => setMood('idle'), 1400);
    }
  }

  async function fetchModels() {
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

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, 'code block omitted'));
    utterance.rate = 1.02;
    utterance.pitch = 1.1;
    utterance.volume = 1;
    window.speechSynthesis.speak(utterance);
  }

  function toggleListening() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError('Speech recognition is not available in this browser. Chrome works best.');
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      setMood('idle');
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onstart = () => {
      setListening(true);
      setMood('listening');
    };
    recognition.onresult = (event) => {
      const transcript = event.results?.[0]?.[0]?.transcript || '';
      setInput(transcript);
      if (transcript.trim()) sendMessage(transcript.trim());
    };
    recognition.onerror = (event) => {
      setError(`Voice input error: ${event.error}`);
      setMood('worried');
    };
    recognition.onend = () => {
      setListening(false);
      setMood('idle');
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
            {busy ? 'Thinking safely...' : listening ? 'Listening...' : 'Ready'}
          </div>
          <div className="model-line">{settings.provider === 'ollama' ? 'Ollama' : 'LM Studio/OpenAI'} · {activeModel || 'no model selected'}</div>
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
            <div ref={chatEndRef} />
          </div>

          {error && <div className="error-box"><AlertTriangle size={16} /> {error}</div>}

          <form className="composer" onSubmit={(e) => { e.preventDefault(); sendMessage(); }}>
            <button type="button" className={`round-button ${listening ? 'active' : ''}`} onClick={toggleListening} disabled={busy} title="Voice input">
              {listening ? <MicOff /> : <Mic />}
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

function SettingsPanel({ settings, updateSettings, close, fetchModels, models, allowedModels, modelStatus, memories, refreshMemories, addMemory, deleteMemory, logs, refreshLogs }) {
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
        </div>

        {tab === 'model' && (
          <div className="settings-section">
            <label>Provider</label>
            <select value={settings.provider} onChange={(e) => updateSettings({ provider: e.target.value })}>
              <option value="ollama">Ollama</option>
              <option value="openai">LM Studio / OpenAI-compatible</option>
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
            ) : (
              <>
                <label>LM Studio/OpenAI Base URL</label>
                <input value={settings.openaiBaseUrl} onChange={(e) => updateSettings({ openaiBaseUrl: e.target.value })} />
                <label>Model</label>
                <select value={settings.openaiModel} onChange={(e) => updateSettings({ openaiModel: e.target.value })}>
                  <option value="">Select after fetching models</option>
                  {models.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                </select>
              </>
            )}

            <div className="row-buttons">
              <button onClick={fetchModels}><RefreshCw size={16} /> Fetch model list</button>
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
