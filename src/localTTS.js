const KOKORO_MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const KOKORO_VOICE = 'af_bella';

let ttsInstance = null;
let ttsLoadPromise = null;
let ttsDevice = '';

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

export async function speakWithKokoro(text, { onStatus }) {
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  const tts = await loadKokoro(notify);
  notify(`Generating local neural voice (${ttsDevice.toUpperCase()})...`);
  const audio = await tts.generate(text, {
    voice: KOKORO_VOICE,
    speed: 1
  });

  const blob = audio.toBlob();
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      const player = new Audio(url);
      player.onended = () => resolve();
      player.onerror = () => reject(new Error('Kokoro audio playback failed.'));
      player.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}
