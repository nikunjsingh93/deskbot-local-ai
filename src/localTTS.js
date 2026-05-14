const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_VOICE = 'af_bella';

let ttsInstance = null;
let ttsLoadPromise = null;
let ttsDevice = '';
let currentPlayer = null;
let stopRequested = false;
let audioPrimed = false;
const MAX_TTS_CHUNK_CHARS = 320;
const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQQAAAAAAA==';

function toProgressText(progress) {
  if (!progress || typeof progress !== 'object') return '';
  const status = String(progress.status || '').toLowerCase();
  if (status.includes('download')) {
    const pct = typeof progress.progress === 'number' ? ` ${Math.round(progress.progress)}%` : '';
    return `Downloading Kokoro TTS model...${pct}`;
  }
  if (status.includes('init') || status.includes('compile') || status.includes('load') || status.includes('create')) {
    return 'Loading Kokoro TTS model...';
  }
  return '';
}

async function loadKokoro(onStatus) {
  if (ttsInstance) return ttsInstance;
  if (ttsLoadPromise) return ttsLoadPromise;

  ttsLoadPromise = (async () => {
    const { KokoroTTS } = await import('kokoro-js');
    const progress_callback = (progress) => {
      const text = toProgressText(progress);
      if (text) onStatus(text);
    };

    try {
      onStatus('Preparing Kokoro TTS on WebGPU...');
      ttsInstance = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: 'webgpu',
        dtype: 'fp32',
        progress_callback
      });
      ttsDevice = 'webgpu';
      return ttsInstance;
    } catch {
      onStatus('WebGPU unavailable for Kokoro TTS. Falling back to WASM...');
      ttsInstance = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback
      });
      ttsDevice = 'wasm';
      return ttsInstance;
    }
  })();

  try {
    return await ttsLoadPromise;
  } catch (err) {
    ttsLoadPromise = null;
    ttsInstance = null;
    ttsDevice = '';
    throw err;
  }
}

export async function speakWithKokoro(text, { onStatus, voice }) {
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  stopRequested = false;
  const tts = await loadKokoro(notify);
  const chunks = splitForTts(text, MAX_TTS_CHUNK_CHARS);
  for (let i = 0; i < chunks.length; i += 1) {
    if (stopRequested) break;
    notify(`Generating local neural voice (${ttsDevice.toUpperCase()})... ${i + 1}/${chunks.length}`);
    const audio = await tts.generate(chunks[i], {
      voice: voice || KOKORO_VOICE,
      speed: 1
    });
    if (stopRequested) break;

    const blob = audio.toBlob();
    const url = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        const player = new Audio(url);
        currentPlayer = player;
        player.onended = () => resolve();
        player.onerror = () => reject(new Error('Kokoro audio playback failed.'));
        playWithGestureRetry(player, notify).catch(reject);
      });
    } finally {
      currentPlayer = null;
      URL.revokeObjectURL(url);
    }
  }
}

export async function preloadKokoroTts(onStatus) {
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  await loadKokoro(notify);
  notify(`Kokoro TTS ready (${ttsDevice.toUpperCase()}).`);
}

export function primeKokoroAudio() {
  if (audioPrimed || typeof Audio === 'undefined') return;
  audioPrimed = true;
  try {
    const player = new Audio(SILENT_WAV);
    player.muted = true;
    player.play()
      .then(() => {
        player.pause();
        player.currentTime = 0;
      })
      .catch(() => {
        // Some browsers still reject silent priming. Real playback will wait for a gesture.
      });
  } catch {
    // no-op
  }
}

export function stopKokoroPlayback() {
  stopRequested = true;
  if (currentPlayer) {
    try {
      currentPlayer.pause();
      currentPlayer.currentTime = 0;
    } catch {
      // no-op
    }
    currentPlayer = null;
  }
}

function splitForTts(text, maxChars) {
  const input = String(text || '').trim();
  if (!input) return [];
  const parts = input.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const out = [];

  for (const part of parts) {
    if (part.length <= maxChars) {
      out.push(part);
      continue;
    }

    const sentences = part.match(/[^.!?]+[.!?]?/g)?.map((s) => s.trim()).filter(Boolean) || [part];
    let current = '';
    for (const sentence of sentences) {
      const next = current ? `${current} ${sentence}` : sentence;
      if (next.length <= maxChars) {
        current = next;
      } else {
        if (current) out.push(current);
        current = sentence;
      }
    }
    if (current) out.push(current);
  }

  return out.length ? out : [input];
}

async function playWithGestureRetry(player, notify) {
  try {
    await player.play();
    return;
  } catch (err) {
    if (!isGestureRequiredError(err)) throw err;
  }

  notify('Click or press any key once to enable Kokoro voice playback...');
  await waitForAudioGesture();
  if (stopRequested) return;
  await player.play();
}

function isGestureRequiredError(err) {
  const text = `${err?.name || ''} ${err?.message || err || ''}`.toLowerCase();
  return text.includes('notallowed') || text.includes('interact') || text.includes('user activation') || text.includes('gesture');
}

function waitForAudioGesture() {
  return new Promise((resolve) => {
    const done = () => {
      cleanup();
      primeKokoroAudio();
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
