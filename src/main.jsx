import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, Clock3, CloudSun, Maximize2, Mic, MicOff, Minimize2, Send, Settings, Trash2, RefreshCw, Volume2, VolumeX, Database, AlertTriangle, X, LogOut, KeyRound, UserPlus } from 'lucide-react';
import './styles.css';
import { runStandaloneChat } from './standaloneLLM.js';
import { preloadKokoroTts, primeKokoroAudio, speakWithKokoro, stopKokoroPlayback } from './localTTS.js';

const API_BASE = import.meta.env.VITE_API_BASE || '';
const STORAGE_KEY = 'deskbot_minimal_safe_v1';
const LEGACY_SETTINGS_KEY = 'deskbot_settings_v1';
const AUTH_STORAGE_KEY = 'deskbot_auth_v1';
const DEFAULT_STANDALONE_MODEL = 'onnx-community/SmolLM2-360M-Instruct-ONNX';
const FOLLOWUP_WINDOW_MS = 5000;
const WAKE_SILENCE_SEND_MS = 1200;
const DUPLICATE_REPLY_ERROR = 'DeskBot is already waiting for a model reply.';

function isFollowupQuestion(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return /\b(that|this|it|those|they|them|he|she|same|again|another|more|continue|previous|earlier)\b/.test(normalized)
    || /^(yes|no|why|how|what about|and|also|tell me more|go on)\b/.test(normalized);
}

function splitSpeechText(text, maxChars = 320) {
  const input = String(text || '').trim();
  if (!input) return [];
  const sentences = input.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean) || [input];
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= maxChars) {
      current = next;
    } else {
      if (current) chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function playAudioBlob(blob, onStatus) {
  const url = URL.createObjectURL(blob);
  try {
    const player = new Audio(url);
    try {
      await player.play();
    } catch (err) {
      if (!isGestureRequiredError(err)) throw err;
      onStatus('Click or press any key once to enable server voice playback...');
      await waitForAudioGesture();
      await player.play();
    }
    await new Promise((resolve, reject) => {
      player.onended = () => resolve();
      player.onerror = () => reject(new Error('Server audio playback failed.'));
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function isGestureRequiredError(err) {
  const text = `${err?.name || ''} ${err?.message || err || ''}`.toLowerCase();
  return text.includes('notallowed') || text.includes('interact') || text.includes('user activation') || text.includes('gesture');
}

function waitForAudioGesture() {
  return new Promise((resolve) => {
    const done = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.removeEventListener('pointerdown', done);
      window.removeEventListener('keydown', done);
      window.removeEventListener('touchstart', done);
    };
    window.addEventListener('pointerdown', done, { once: true });
    window.addEventListener('keydown', done, { once: true });
    window.addEventListener('touchstart', done, { once: true });
  });
}

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
  wakeWord: 'buddy',
  uiTheme: 'bot-chat',
  timeFormat: '12h'
};

function App() {
  const [auth, setAuth] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [settings, setSettings] = useState(defaultSettings);
  const [messages, setMessages] = useState([
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
  const [clockRobotActive, setClockRobotActive] = useState(false);
  const [memories, setMemories] = useState([]);
  const [users, setUsers] = useState([]);
  const [adminStatus, setAdminStatus] = useState('');
  const [logs, setLogs] = useState('');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(Boolean(document.fullscreenElement));
  const [now, setNow] = useState(() => new Date());
  const [dashboardWeather, setDashboardWeather] = useState({ status: 'idle', data: null, error: '' });
  const chatEndRef = useRef(null);
  const messagesRef = useRef(messages);
  const settingsRef = useRef(settings);
  const authRef = useRef(auth);
  const recognitionRef = useRef(null);
  const manualStopRef = useRef(false);
  const ignoreRecognitionErrorRef = useRef(false);
  const wakeCaptureTimerRef = useRef(null);
  const wakeCapturedRef = useRef('');
  const wakeArmedRef = useRef(false);
  const followupDeadlineRef = useRef(0);
  const followupTimerRef = useRef(null);
  const wakeEnabledPrevRef = useRef(false);
  const wakeCapturedFollowupRef = useRef(false);
  const requestActiveRef = useRef(false);
  const errorClearTimerRef = useRef(null);

  const activeModel = settings.provider === 'ollama'
    ? settings.ollamaModel
    : settings.provider === 'openai'
      ? settings.openaiModel
      : (settings.standaloneModel || DEFAULT_STANDALONE_MODEL);
  const activeBaseUrl = settings.provider === 'ollama' ? settings.ollamaBaseUrl : settings.openaiBaseUrl;

  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    messagesRef.current = messages;
    if (auth?.user?.id) {
      localStorage.setItem(userMessagesKey(auth.user.id), JSON.stringify(messages));
    }
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy, auth?.user?.id]);

  useEffect(() => {
    fetch(`${API_BASE}/api/health`).catch(() => {});
    restoreAuth();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed', err);
      });
    }
  }, []);

  useEffect(() => {
    if (!auth) return;
    refreshMemories();
    fetchModels();
  }, [auth?.token]);

  useEffect(() => {
    const primeAudio = () => primeKokoroAudio();
    window.addEventListener('pointerdown', primeAudio, { once: true });
    window.addEventListener('keydown', primeAudio, { once: true });
    window.addEventListener('touchstart', primeAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', primeAudio);
      window.removeEventListener('keydown', primeAudio);
      window.removeEventListener('touchstart', primeAudio);
    };
  }, []);

  useEffect(() => {
    const syncFullscreen = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  useEffect(() => {
    if (!settings.standaloneModel) {
      updateSettings({ standaloneModel: DEFAULT_STANDALONE_MODEL });
    }
  }, [settings.standaloneModel]);

  useEffect(() => {
    if (!['browser', 'kokoro', 'server-kokoro'].includes(settings.ttsEngine)) {
      updateSettings({ ttsEngine: 'browser' });
    }
  }, [settings.ttsEngine]);

  useEffect(() => {
    if (settings.ttsEngine !== 'kokoro') return;
    let cancelled = false;
    setError('');
    preloadKokoroTts((status) => {
      if (!cancelled) setModelStatus(status);
    }).catch((err) => {
      if (cancelled) return;
      const message = err?.message || String(err);
      setError(`Kokoro TTS error: ${message}`);
      setModelStatus('Kokoro TTS failed to load.');
      console.error('Kokoro preload failed', err);
    });
    return () => {
      cancelled = true;
    };
  }, [settings.ttsEngine]);

  useEffect(() => {
    if (!settings.kokoroVoice) {
      updateSettings({ kokoroVoice: 'af_bella' });
    }
  }, [settings.kokoroVoice]);

  useEffect(() => {
    if (!settings.wakeWord) {
      updateSettings({ wakeWord: 'buddy' });
    }
  }, [settings.wakeWord]);

  useEffect(() => {
    if (!settings.uiTheme) {
      updateSettings({ uiTheme: 'bot-chat' });
    }
  }, [settings.uiTheme]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!['clock-weather', 'clock-weather-big'].includes(settings.uiTheme || 'bot-chat')) return;
    refreshDashboardWeather();
    const timer = window.setInterval(refreshDashboardWeather, 60 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [settings.uiTheme]);

  useEffect(() => {
    if (errorClearTimerRef.current) {
      window.clearTimeout(errorClearTimerRef.current);
      errorClearTimerRef.current = null;
    }
    if (!error.includes(DUPLICATE_REPLY_ERROR)) return undefined;
    errorClearTimerRef.current = window.setTimeout(() => {
      setError((current) => current.includes(DUPLICATE_REPLY_ERROR) ? '' : current);
      errorClearTimerRef.current = null;
    }, 5000);
    return () => {
      if (errorClearTimerRef.current) {
        window.clearTimeout(errorClearTimerRef.current);
        errorClearTimerRef.current = null;
      }
    };
  }, [error]);

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
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      settingsRef.current = next;
      if (authRef.current?.token) {
        apiFetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: next })
        }).catch(() => undefined);
      }
      return next;
    });
  }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch (err) {
      setError(`Fullscreen error: ${err?.message || err}`);
    }
  }

  function setWakeArmedState(next) {
    wakeArmedRef.current = next;
    setWakeArmed(next);
  }

  function clearFollowupWindow() {
    followupDeadlineRef.current = 0;
    if (followupTimerRef.current) {
      clearTimeout(followupTimerRef.current);
      followupTimerRef.current = null;
    }
  }

  function openFollowupWindow() {
    clearFollowupWindow();
    followupDeadlineRef.current = Date.now() + FOLLOWUP_WINDOW_MS;
    setWakeArmedState(true);
    setModelStatus('Listening for follow-up...');
    followupTimerRef.current = setTimeout(() => {
      followupDeadlineRef.current = 0;
      followupTimerRef.current = null;
      setWakeArmedState(false);
      if (!busy) setModelStatus('');
    }, FOLLOWUP_WINDOW_MS);
  }

  const assistantName = String(settings.wakeWord || 'buddy').trim() || 'buddy';

  function apiFetch(path, options = {}) {
    const token = authRef.current?.token;
    const headers = { ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${API_BASE}${path}`, { ...options, headers });
  }

  function applyAuthSession(nextAuth, nextSettings) {
    authRef.current = nextAuth;
    setAuth(nextAuth);
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextAuth));
    const mergedSettings = { ...defaultSettings, ...(nextSettings || {}) };
    settingsRef.current = mergedSettings;
    setSettings(mergedSettings);
    const savedMessages = readUserMessages(nextAuth.user.id);
    messagesRef.current = savedMessages;
    setMessages(savedMessages);
    setError('');
  }

  async function restoreAuth() {
    try {
      const stored = localStorage.getItem(AUTH_STORAGE_KEY);
      const parsed = stored ? JSON.parse(stored) : null;
      if (!parsed?.token) return;
      authRef.current = { token: parsed.token, user: parsed.user };
      const response = await apiFetch('/api/auth/me');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Session expired.');
      applyAuthSession({ token: parsed.token, user: data.user }, data.settings);
    } catch {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      authRef.current = null;
      setAuth(null);
    } finally {
      setAuthChecked(true);
    }
  }

  async function login(username, password) {
    setLoginError('');
    try {
      const response = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Login failed.');
      applyAuthSession({ token: data.token, user: data.user }, data.settings);
    } catch (err) {
      setLoginError(err.message || String(err));
    }
  }

  async function logout() {
    await apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem(AUTH_STORAGE_KEY);
    authRef.current = null;
    setAuth(null);
    setSettings(defaultSettings);
    setMessages([{ role: 'assistant', content: 'Hi! I am DeskBot. I can chat and remember things you tell me.' }]);
    setMemories([]);
    setUsers([]);
    setSettingsOpen(false);
    setError('');
    setModelStatus('');
    stopKokoroPlayback();
    window.speechSynthesis?.cancel();
  }

  async function refreshDashboardWeather() {
    setDashboardWeather((prev) => ({ ...prev, status: 'loading', error: '' }));
    try {
      const geo = await getBrowserGeo();
      if (!geo) throw new Error('Location unavailable');
      const params = new URLSearchParams({
        latitude: String(geo.latitude),
        longitude: String(geo.longitude),
        current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
        daily: 'temperature_2m_max,temperature_2m_min',
        forecast_days: '1',
        timezone: 'auto'
      });
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.reason || 'Weather unavailable');
      setDashboardWeather({
        status: 'ready',
        error: '',
        data: {
          condition: weatherCodeToText(data.current?.weather_code),
          temperature: Math.round(Number(data.current?.temperature_2m)),
          feelsLike: Math.round(Number(data.current?.apparent_temperature)),
          wind: Math.round(Number(data.current?.wind_speed_10m)),
          high: Math.round(Number(data.daily?.temperature_2m_max?.[0])),
          low: Math.round(Number(data.daily?.temperature_2m_min?.[0])),
          updatedAt: new Date()
        }
      });
    } catch (err) {
      setDashboardWeather({ status: 'error', data: null, error: err.message || 'Weather unavailable' });
    }
  }

  async function sendMessage(textOverride, options = {}) {
    const currentSettings = settingsRef.current;
    const currentActiveModel = currentSettings.provider === 'ollama'
      ? currentSettings.ollamaModel
      : currentSettings.provider === 'openai'
        ? currentSettings.openaiModel
        : (currentSettings.standaloneModel || DEFAULT_STANDALONE_MODEL);
    const currentActiveBaseUrl = currentSettings.provider === 'ollama' ? currentSettings.ollamaBaseUrl : currentSettings.openaiBaseUrl;
    const text = (textOverride ?? input).trim();
    if (!text || requestActiveRef.current) return;
    requestActiveRef.current = true;
    setError('');
    setInput('');
    setBusy(true);
    setClockRobotActive(true);
    setMood('thinking');
    if (currentSettings.provider === 'standalone') {
      setModelStatus('Preparing standalone model...');
    } else if (currentSettings.provider === 'ollama') {
      setModelStatus('Loading Ollama model and generating reply...');
    } else {
      setModelStatus('Loading model and generating reply...');
    }

    const currentMessages = messagesRef.current;
    const chatContext = options.preserveContext || isFollowupQuestion(text) ? currentMessages : [];
    const nextMessages = [...chatContext, { role: 'user', content: text }];
    messagesRef.current = nextMessages;
    setMessages(nextMessages);

    try {
      let data;
      if (currentSettings.provider === 'standalone') {
        data = await runStandaloneChat({
          messages: nextMessages.slice(-8),
          userText: text,
          model: currentSettings.standaloneModel,
          onStatus: setModelStatus
        });
      } else {
        const clientGeo = needsGeoLookup(text) ? await getBrowserGeo() : null;
        const response = await apiFetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: currentSettings.provider,
            baseUrl: currentActiveBaseUrl,
            model: currentActiveModel,
            userText: text,
            messages: nextMessages.slice(-8),
            clientGeo
          })
        });
        data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Chat request failed.');
      }

      const assistantMessage = { role: 'assistant', content: data.reply, savedMemory: data.savedMemory, stats: data.stats };
      const completedMessages = [...nextMessages, assistantMessage];
      messagesRef.current = completedMessages;
      setMessages(completedMessages);
      setMood(data.savedMemory ? 'happy' : 'idle');
      if (settingsRef.current.ttsEnabled && settingsRef.current.autoSpeak) {
        await speak(data.reply);
      }
      if (data.savedMemory) refreshMemories();
      setModelStatus('');
    } catch (err) {
      setError(err.message || String(err));
      const failedMessages = [...nextMessages, { role: 'assistant', content: `I stopped: ${err.message || err}` }];
      messagesRef.current = failedMessages;
      setMessages(failedMessages);
      setMood('worried');
      setModelStatus('Request failed.');
    } finally {
      requestActiveRef.current = false;
      setBusy(false);
      setClockRobotActive(false);
      window.setTimeout(() => setMood('idle'), 1400);
      if (settingsRef.current.wakeEnabled) {
        openFollowupWindow();
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
      const response = await apiFetch('/api/models', {
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
      const response = await apiFetch('/api/memories');
      const data = await response.json();
      setMemories(data.memories || []);
    } catch {
      // backend may not be awake yet
    }
  }

  async function addMemory(content) {
    const trimmed = content.trim();
    if (!trimmed) return;
    await apiFetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: trimmed, tags: 'manual' })
    });
    refreshMemories();
  }

  async function deleteMemory(id) {
    await apiFetch(`/api/memories/${id}`, { method: 'DELETE' });
    refreshMemories();
  }

  async function refreshLogs() {
    const response = await apiFetch('/api/logs');
    setLogs(await response.text());
  }

  async function refreshUsers() {
    if (authRef.current?.user?.role !== 'admin') return;
    setAdminStatus('');
    try {
      const response = await apiFetch('/api/users');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to fetch users.');
      setUsers(data.users || []);
    } catch (err) {
      setAdminStatus(err.message || String(err));
    }
  }

  async function addUser(username, password) {
    setAdminStatus('');
    try {
      const response = await apiFetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, settings: defaultSettings })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to add user.');
      setAdminStatus(`Added ${data.user.username}.`);
      await refreshUsers();
    } catch (err) {
      setAdminStatus(err.message || String(err));
    }
  }

  async function updateUserPassword(id, password) {
    setAdminStatus('');
    try {
      const response = await apiFetch(`/api/users/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to update password.');
      setAdminStatus('Password updated.');
      await refreshUsers();
    } catch (err) {
      setAdminStatus(err.message || String(err));
    }
  }

  async function deleteUser(id) {
    setAdminStatus('');
    try {
      const response = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Failed to delete user.');
      setAdminStatus('User deleted.');
      await refreshUsers();
    } catch (err) {
      setAdminStatus(err.message || String(err));
    }
  }

  async function speak(text) {
    const currentSettings = settingsRef.current;
    if (listening) {
      manualStopRef.current = true;
      clearFollowupWindow();
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
      if (currentSettings.ttsEngine === 'kokoro') {
        try {
          window.speechSynthesis?.cancel();
          await speakWithKokoro(cleanText, {
            onStatus: setModelStatus,
            voice: currentSettings.kokoroVoice || 'af_bella'
          });
          setModelStatus('');
          return;
        } catch (err) {
          const message = err?.message || String(err);
          setError(`Kokoro TTS error: ${message}`);
          setModelStatus('Kokoro TTS failed. Check the browser console for details.');
          console.error('Kokoro TTS failed', err);
          return;
        }
      }

      if (currentSettings.ttsEngine === 'server-kokoro') {
        try {
          window.speechSynthesis?.cancel();
          stopKokoroPlayback();
          const chunks = splitSpeechText(cleanText);
          for (let i = 0; i < chunks.length; i += 1) {
            setModelStatus(`Generating server neural voice... ${i + 1}/${chunks.length}`);
            const response = await apiFetch('/api/tts/kokoro', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                text: chunks[i],
                voice: currentSettings.kokoroVoice || 'af_bella'
              })
            });
            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              throw new Error(data.error || 'Server Kokoro TTS failed.');
            }
            const blob = await response.blob();
            await playAudioBlob(blob, setModelStatus);
          }
          setModelStatus('');
          return;
        } catch (err) {
          const message = err?.message || String(err);
          setError(`Server Kokoro TTS error: ${message}`);
          setModelStatus('Server Kokoro TTS failed.');
          console.error('Server Kokoro TTS failed', err);
          return;
        }
      }

      if (!('speechSynthesis' in window)) {
        setError('Browser TTS is not available in this browser.');
        return;
      }
      window.speechSynthesis.cancel();
      const baseRate = 1.0;
      const basePitch = 1.0;
      const chunks = splitSpeechText(cleanText);

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
    if (speaking || requestActiveRef.current) return;
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
      setClockRobotActive(false);
      setWakeArmedState(false);
      wakeCapturedRef.current = '';
      setModelStatus('');
      return;
    }
    manualStopRef.current = false;
    if (!settings.wakeEnabled) setClockRobotActive(true);
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
      wakeCapturedFollowupRef.current = false;
      if (settings.wakeEnabled) {
        const followupActive = Date.now() < followupDeadlineRef.current;
        if (followupActive) {
          setWakeArmedState(true);
          setModelStatus('Listening for follow-up...');
        } else {
          setModelStatus(`Wake mode on. Say "${assistantName}" then your question.`);
          setWakeArmedState(false);
        }
      }
    };
    recognition.onresult = (event) => {
      const transcript = event.results?.[event.resultIndex]?.[0]?.transcript?.trim() || '';
      if (!transcript) return;

      if (settings.wakeEnabled) {
        const wake = String(settings.wakeWord || 'buddy').trim();
        const wakeMatch = findWakeWordMatch(transcript, wake);
        const hasWake = Boolean(wakeMatch);
        const followupActive = Date.now() < followupDeadlineRef.current;
        if (!hasWake && !wakeArmedRef.current && !followupActive) return;
        const withoutWake = hasWake ? wakeMatch.restText : transcript;
        const userQuery = withoutWake.trim().replace(/^[,.:;\s-]+/, '');
        if (!userQuery) {
          setClockRobotActive(true);
          setWakeArmedState(true);
          wakeCapturedRef.current = '';
          setModelStatus(`Heard "${wake}". Now ask your question.`);
          return;
        }
        setClockRobotActive(true);
        wakeCapturedFollowupRef.current = wakeCapturedFollowupRef.current || followupActive || isFollowupQuestion(userQuery);
        clearFollowupWindow();
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
        setClockRobotActive(true);
        manualStopRef.current = true;
        recognitionRef.current?.stop();
        sendMessage(transcript);
      }
    };
    recognition.onerror = (event) => {
      const code = String(event?.error || '');
      if (ignoreRecognitionErrorRef.current || (settings.wakeEnabled && code === 'no-speech')) {
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
      const capturedWasFollowup = wakeCapturedFollowupRef.current;
      setListening(false);
      setMood('idle');
      setWakeArmedState(false);
      wakeCapturedRef.current = '';
      wakeCapturedFollowupRef.current = false;
      if (settings.wakeEnabled && capturedQuery) {
        setInput(capturedQuery);
        if (!requestActiveRef.current) {
          sendMessage(capturedQuery, { preserveContext: capturedWasFollowup });
          return;
        }
      }
      if (settings.wakeEnabled && !capturedQuery) {
        setClockRobotActive(false);
        window.setTimeout(() => {
          if (!busy && !speaking && !listening) {
            toggleListening();
          }
        }, 120);
        return;
      }
      if (!busy) setModelStatus('');
    };
    recognitionRef.current = recognition;
    recognition.start();
  }

  const allowedModels = useMemo(() => models, [models]);
  const uiTheme = settings.uiTheme || 'bot-chat';
  const isChatTheme = uiTheme === 'bot-chat';
  const isClockTheme = ['clock', 'clock-big', 'clock-weather', 'clock-weather-big'].includes(uiTheme);
  const isWeatherTheme = ['clock-weather', 'clock-weather-big'].includes(uiTheme);
  const isBigClockTheme = ['clock-big', 'clock-weather-big'].includes(uiTheme);
  const clockDate = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const clockDisplay = formatClockDisplay(now, settings.timeFormat || '12h');
  const robotStatusText = busy ? 'Thinking...' : speaking ? 'Speaking...' : listening ? 'Listening...' : 'Ready';
  const clockConversationActive = isClockTheme && (clockRobotActive || busy || speaking);
  const voiceButton = !settings.wakeEnabled && (
    <button type="button" className={`round-button ${listening ? 'active' : ''}`} onClick={toggleListening} disabled={busy || speaking} title="Voice input">
      {listening ? <MicOff /> : <Mic />}
    </button>
  );

  if (!authChecked) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="login-brand">
            <img src="/icons/icon-192.png" alt="" />
            <div>
              <h1>Deskbot Local AI</h1>
              <p className="muted">Checking session...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!auth) {
    return <LoginScreen onLogin={login} error={loginError} />;
  }

  return (
    <div className="app-shell">
      <button className="floating-settings icon-button" onClick={() => setSettingsOpen(true)} title="Settings"><Settings /></button>

      <main className={`main-panel theme-${uiTheme}`}>
        {isClockTheme ? (
          <section className={`clock-stage ${clockConversationActive ? 'clock-conversation' : ''}`}>
            {clockConversationActive ? (
              <div className="clock-mode-view clock-robot-view">
                <RobotFace mood={mood} speaking={speaking} />
                <div className="robot-status">
                  {robotStatusText}
                </div>
                {(busy || modelStatus) && <div className="model-status-live">{modelStatus || 'Working...'}</div>}
                {error && <div className="stage-error"><AlertTriangle size={16} /> {error}</div>}
                <div className="stage-actions">{voiceButton}</div>
              </div>
            ) : (
              <div className="clock-mode-view clock-face-view">
                {isBigClockTheme && (
                  <div className="clock-corners">
                    <div className="clock-corner clock-corner-date">{clockDate}</div>
                    {isWeatherTheme && (
                      <div className="clock-corner clock-corner-weather">
                        {dashboardWeather.status === 'ready' && dashboardWeather.data ? (
                          <>
                            <div className="clock-corner-weather-main">
                              <CloudSun size={22} />
                              <span>{dashboardWeather.data.temperature}°</span>
                              <strong>{dashboardWeather.data.condition}</strong>
                            </div>
                            <div className="clock-corner-weather-details">
                              Feels {dashboardWeather.data.feelsLike}° · High {dashboardWeather.data.high}° / Low {dashboardWeather.data.low}° · Wind {dashboardWeather.data.wind} km/h
                            </div>
                          </>
                        ) : dashboardWeather.status === 'loading' ? (
                          <div className="clock-corner-weather-main">
                            <CloudSun size={22} />
                            <strong>Loading weather...</strong>
                          </div>
                        ) : (
                          <div className="clock-corner-weather-main">
                            <CloudSun size={22} />
                            <strong>Weather unavailable</strong>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <div className="clock-time">
                  <span className="clock-time-main">{clockDisplay.time}</span>
                  {clockDisplay.period && <span className="clock-period">{clockDisplay.period}</span>}
                </div>
                {!isBigClockTheme && <div className="clock-date">{clockDate}</div>}
                {isWeatherTheme && !isBigClockTheme && (
                  <WeatherPanel dashboardWeather={dashboardWeather} />
                )}
                <div className="robot-status">
                  {robotStatusText}
                </div>
                {(busy || modelStatus) && <div className="model-status-live">{modelStatus || 'Working...'}</div>}
                {error && <div className="stage-error"><AlertTriangle size={16} /> {error}</div>}
                <div className="stage-actions">{voiceButton}</div>
              </div>
            )}
          </section>
        ) : (
          <section className="robot-stage">
            <RobotFace mood={mood} speaking={speaking} />
            <div className="robot-status">
              {robotStatusText}
            </div>
            <div className="model-line">
              {settings.provider === 'ollama' ? 'Ollama' : settings.provider === 'openai' ? 'LM Studio/OpenAI' : 'Standalone (WebGPU)'} · {activeModel || 'no model selected'}
            </div>
            {(busy || modelStatus) && <div className="model-status-live">{modelStatus || 'Working...'}</div>}
            {!isChatTheme && error && <div className="stage-error"><AlertTriangle size={16} /> {error}</div>}
            {!isChatTheme && <div className="stage-actions">{voiceButton}</div>}
          </section>
        )}

        {isChatTheme && (
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
              {!settings.wakeEnabled && voiceButton}
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
        )}
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
          currentUser={auth.user}
          users={users}
          adminStatus={adminStatus}
          refreshUsers={refreshUsers}
          addUser={addUser}
          updateUserPassword={updateUserPassword}
          deleteUser={deleteUser}
          logout={logout}
          isFullscreen={isFullscreen}
          toggleFullscreen={toggleFullscreen}
        />
      )}
    </div>
  );
}

function LoginScreen({ onLogin, error }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    await onLogin(username, password);
    setBusy(false);
  }

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <img src="/icons/icon-192.png" alt="" />
          <div>
            <h1>Deskbot Local AI</h1>
            <p className="muted">Sign in to continue.</p>
          </div>
        </div>
        <label>Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        <label>Password</label>
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
        {error && <div className="error-box login-error"><AlertTriangle size={16} /> {error}</div>}
        <button className="send-button login-button" type="submit" disabled={busy || !username.trim() || !password}>
          <KeyRound size={18} /> {busy ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function WeatherPanel({ dashboardWeather }) {
  return (
    <div className="weather-panel">
      {dashboardWeather.status === 'ready' && dashboardWeather.data ? (
        <>
          <div className="weather-main">
            <CloudSun size={24} />
            <span>{dashboardWeather.data.temperature}°</span>
            <strong>{dashboardWeather.data.condition}</strong>
          </div>
          <div className="weather-details">
            Feels {dashboardWeather.data.feelsLike}° · High {dashboardWeather.data.high}° / Low {dashboardWeather.data.low}° · Wind {dashboardWeather.data.wind} km/h
          </div>
        </>
      ) : dashboardWeather.status === 'loading' ? (
        <div className="weather-main"><CloudSun size={24} /><strong>Loading weather...</strong></div>
      ) : (
        <div className="weather-main"><CloudSun size={24} /><strong>Weather unavailable</strong></div>
      )}
    </div>
  );
}

function formatClockDisplay(date, timeFormat) {
  const hour12 = timeFormat !== '24h';
  const parts = new Intl.DateTimeFormat([], {
    hour: hour12 ? 'numeric' : '2-digit',
    minute: '2-digit',
    hour12
  }).formatToParts(date);
  const period = hour12 ? parts.find((part) => part.type === 'dayPeriod')?.value?.toUpperCase() || '' : '';
  const time = parts
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
  return { time, period };
}

function RobotFace({ mood, speaking }) {
  return (
    <div className={`robot-face ${mood} ${speaking ? 'speaking' : ''}`}>
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

function weatherCodeToText(code) {
  const value = Number(code);
  if ([0].includes(value)) return 'Clear';
  if ([1, 2].includes(value)) return 'Partly cloudy';
  if ([3].includes(value)) return 'Cloudy';
  if ([45, 48].includes(value)) return 'Fog';
  if ([51, 53, 55, 56, 57].includes(value)) return 'Drizzle';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(value)) return 'Rain';
  if ([71, 73, 75, 77, 85, 86].includes(value)) return 'Snow';
  if ([95, 96, 99].includes(value)) return 'Thunderstorm';
  return 'Weather';
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

function SettingsPanel({ settings, updateSettings, close, fetchModels, models, allowedModels, modelStatus, memories, refreshMemories, addMemory, deleteMemory, logs, refreshLogs, currentUser, users, adminStatus, refreshUsers, addUser, updateUserPassword, deleteUser, logout, isFullscreen, toggleFullscreen }) {
  const [tab, setTab] = useState('model');
  const [newMemory, setNewMemory] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordDrafts, setPasswordDrafts] = useState({});

  return (
    <div className="modal-backdrop">
      <div className="settings-modal">
        <div className="modal-header">
          <h2>Settings</h2>
          <div className="modal-actions">
            <button className="icon-button" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
              {isFullscreen ? <Minimize2 /> : <Maximize2 />}
            </button>
            <button className="icon-button" onClick={close} title="Close settings"><X /></button>
          </div>
        </div>
        <div className="tabs">
          <button className={tab === 'model' ? 'active' : ''} onClick={() => setTab('model')}>Model</button>
          <button className={tab === 'themes' ? 'active' : ''} onClick={() => setTab('themes')}>Themes</button>
          <button className={tab === 'memory' ? 'active' : ''} onClick={() => { setTab('memory'); refreshMemories(); }}><Database size={16} /> Memory</button>
          {currentUser?.role === 'admin' && <button className={tab === 'admin' ? 'active' : ''} onClick={() => { setTab('admin'); refreshUsers(); }}><UserPlus size={16} /> Admin</button>}
          <button className={tab === 'diagnostics' ? 'active' : ''} onClick={() => setTab('diagnostics')}>Diagnostics</button>
          <button className={tab === 'about' ? 'active' : ''} onClick={() => setTab('about')}>About</button>
          <button onClick={logout}><LogOut size={16} /> Logout</button>
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
            </div>
            {modelStatus && <p className="muted">{modelStatus}</p>}

            <label className="checkbox-row">
              <input type="checkbox" checked={settings.ttsEnabled} onChange={(e) => updateSettings({ ttsEnabled: e.target.checked })} />
              {settings.ttsEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />} Voice replies
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={settings.autoSpeak} onChange={(e) => updateSettings({ autoSpeak: e.target.checked })} />
              Auto-speak replies
            </label>
            <label>TTS Engine</label>
            <select value={settings.ttsEngine || 'browser'} onChange={(e) => updateSettings({ ttsEngine: e.target.value })}>
              <option value="browser">Browser default voice</option>
              <option value="kokoro">Kokoro browser WebGPU TTS</option>
              <option value="server-kokoro">Kokoro server TTS</option>
            </select>
            {(settings.ttsEngine === 'kokoro' || settings.ttsEngine === 'server-kokoro') && (
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
                <p className="muted small">
                  {settings.ttsEngine === 'server-kokoro'
                    ? 'Server Kokoro runs on the DeskBot backend and sends WAV audio to this device. Best for older phones.'
                    : 'First use downloads model files locally and caches them in browser storage. If Kokoro cannot start, DeskBot will show the exact error instead of silently switching voices.'}
                </p>
              </>
            )}
            <label className="checkbox-row">
              <input type="checkbox" checked={Boolean(settings.wakeEnabled)} onChange={(e) => updateSettings({ wakeEnabled: e.target.checked })} />
              Enable wake word listening
            </label>
            <label>Assistant name / wake word</label>
            <input
              value={settings.wakeWord || 'buddy'}
              onChange={(e) => updateSettings({ wakeWord: e.target.value })}
              placeholder="buddy"
            />
            <p className="muted small">Wake is off by default. Turn it on, then say the wake word and your question, for example: "buddy what is the weather?". On Android, browser speech recognition can pause or stop in the background, so wake mode may not work reliably.</p>
          </div>
        )}

        {tab === 'themes' && (
          <div className="settings-section">
            <div className="theme-list">
              <button
                className={`theme-option ${settings.uiTheme === 'bot-chat' || !settings.uiTheme ? 'active' : ''}`}
                onClick={() => updateSettings({ uiTheme: 'bot-chat' })}
              >
                <Bot size={18} />
                <span>Bot + Chat</span>
              </button>
              <button
                className={`theme-option ${settings.uiTheme === 'bot-only' ? 'active' : ''}`}
                onClick={() => updateSettings({ uiTheme: 'bot-only' })}
              >
                <Bot size={18} />
                <span>Bot Only</span>
              </button>
              <button
                className={`theme-option ${settings.uiTheme === 'clock' ? 'active' : ''}`}
                onClick={() => updateSettings({ uiTheme: 'clock' })}
              >
                <Clock3 size={18} />
                <span>Clock</span>
              </button>
              <button
                className={`theme-option ${settings.uiTheme === 'clock-big' ? 'active' : ''}`}
                onClick={() => updateSettings({ uiTheme: 'clock-big' })}
              >
                <Clock3 size={18} />
                <span>Big Clock</span>
              </button>
              <button
                className={`theme-option ${settings.uiTheme === 'clock-weather' ? 'active' : ''}`}
                onClick={() => updateSettings({ uiTheme: 'clock-weather' })}
              >
                <CloudSun size={18} />
                <span>Clock + Weather</span>
              </button>
              <button
                className={`theme-option ${settings.uiTheme === 'clock-weather-big' ? 'active' : ''}`}
                onClick={() => updateSettings({ uiTheme: 'clock-weather-big' })}
              >
                <CloudSun size={18} />
                <span>Big Clock + Weather</span>
              </button>
            </div>
            <label>Clock format</label>
            <select value={settings.timeFormat || '12h'} onChange={(e) => updateSettings({ timeFormat: e.target.value })}>
              <option value="12h">AM/PM</option>
              <option value="24h">24 hour</option>
            </select>
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

        {tab === 'admin' && currentUser?.role === 'admin' && (
          <div className="settings-section">
            <label>Add user</label>
            <div className="admin-user-form">
              <input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="Username" autoComplete="off" />
              <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="Password" type="password" autoComplete="new-password" />
              <button onClick={async () => {
                await addUser(newUsername, newPassword);
                setNewUsername('');
                setNewPassword('');
              }}>Add</button>
            </div>
            {adminStatus && <p className="muted">{adminStatus}</p>}
            <div className="memory-list">
              {users.map((user) => (
                <div className="memory-item admin-user-item" key={user.id}>
                  <div>
                    <strong>{user.username}</strong> <span className="muted small">{user.role}</span>
                    <div className="muted small">Created {user.created_at}</div>
                  </div>
                  <input
                    value={passwordDrafts[user.id] || ''}
                    onChange={(e) => setPasswordDrafts((prev) => ({ ...prev, [user.id]: e.target.value }))}
                    placeholder="New password"
                    type="password"
                    autoComplete="new-password"
                  />
                  <button onClick={async () => {
                    await updateUserPassword(user.id, passwordDrafts[user.id] || '');
                    setPasswordDrafts((prev) => ({ ...prev, [user.id]: '' }));
                  }}>Update</button>
                  <button
                    className="icon-button"
                    onClick={() => deleteUser(user.id)}
                    disabled={user.username === 'admin'}
                    title={user.username === 'admin' ? 'The default admin user cannot be deleted' : 'Delete user'}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
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

function userMessagesKey(userId) {
  return `${STORAGE_KEY}_user_${userId}`;
}

function readUserMessages(userId) {
  try {
    const stored = localStorage.getItem(userMessagesKey(userId));
    const parsed = stored ? JSON.parse(stored) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // fall through to starter message
  }
  return [{ role: 'assistant', content: 'Hi! I am DeskBot. I can chat and remember things you tell me.' }];
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
