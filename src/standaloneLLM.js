let cachedModelId = '';
let cachedRunner = null;
let cachedDevice = '';

const DEFAULT_WEBGPU_MODEL = 'onnx-community/SmolLM2-360M-Instruct-ONNX';
const DEFAULT_CPU_MODEL = 'onnx-community/SmolLM2-135M-Instruct-ONNX-MHA';

function buildPrompt(messages, userText) {
  const history = messages.slice(-6).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').trim()
  }));
  const lines = history.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`);
  lines.push(`User: ${userText}`);
  lines.push('Assistant:');
  return lines.join('\n');
}

function parseGeneratedText(result, prompt) {
  const text = Array.isArray(result) ? result[0]?.generated_text : result?.generated_text;
  const full = String(text || '').trim();
  if (!full) return 'I could not generate a response.';
  let out = full.startsWith(prompt) ? full.slice(prompt.length) : full;
  out = out.trim();
  const nextUser = out.indexOf('\nUser:');
  if (nextUser >= 0) out = out.slice(0, nextUser).trim();
  return out || 'I could not generate a response.';
}

function formatProgress(progress) {
  if (!progress || typeof progress !== 'object') return '';
  const status = String(progress.status || '').toLowerCase();
  if (status.includes('download')) {
    const pct = typeof progress.progress === 'number' ? ` ${Math.round(progress.progress)}%` : '';
    return `Downloading model files...${pct}`;
  }
  if (status.includes('init') || status.includes('create') || status.includes('compile') || status.includes('load')) {
    return 'Loading model into memory...';
  }
  return '';
}

async function loadRunner(modelId, onStatus) {
  if (cachedRunner && cachedModelId === modelId) {
    return { runner: cachedRunner, device: cachedDevice, modelId: cachedModelId };
  }

  const { env, pipeline } = await import('@huggingface/transformers');
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  onStatus('Loading local model with WebGPU...');
  try {
    const runner = await pipeline('text-generation', modelId || DEFAULT_WEBGPU_MODEL, {
      device: 'webgpu',
      dtype: 'q4',
      progress_callback: (progress) => {
        const text = formatProgress(progress);
        if (text) onStatus(text);
      }
    });
    cachedModelId = modelId || DEFAULT_WEBGPU_MODEL;
    cachedRunner = runner;
    cachedDevice = 'webgpu';
    return { runner, device: 'webgpu', modelId: cachedModelId };
  } catch {
    onStatus('WebGPU not available, switching to CPU/WASM...');
    const fallbackModel = modelId || DEFAULT_CPU_MODEL;
    const runner = await pipeline('text-generation', fallbackModel, {
      device: 'wasm',
      progress_callback: (progress) => {
        const text = formatProgress(progress);
        if (text) onStatus(text);
      }
    });
    cachedModelId = fallbackModel;
    cachedRunner = runner;
    cachedDevice = 'wasm';
    return { runner, device: 'wasm', modelId: fallbackModel };
  }
}

export async function runStandaloneChat({ messages, userText, model, onStatus }) {
  const notify = typeof onStatus === 'function' ? onStatus : () => {};
  const prompt = buildPrompt(messages, userText);
  const { runner, device, modelId } = await loadRunner(model, notify);
  notify(`Running ${modelId} on ${device.toUpperCase()}...`);

  const result = await runner(prompt, {
    max_new_tokens: 280,
    do_sample: true,
    temperature: 0.7,
    top_p: 0.9,
    repetition_penalty: 1.05
  });

  return {
    reply: parseGeneratedText(result, prompt),
    stats: { mode: 'standalone', model: modelId, device }
  };
}
