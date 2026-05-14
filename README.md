# DeskBot Ollama Starter

A minimal React + Vite + Node + SQLite starter for a cute desktop robot assistant.

## Included

- React + Vite web app
- Cute animated robot eyes/face
- Chat box
- Microphone button using browser speech recognition
- Browser TTS voice replies
- Top-right settings button
- Ollama settings
- LM Studio / OpenAI-compatible settings
- Fetch model list button
- SQLite memory database
- Memory manager in settings
- Standalone browser mode (WebGPU) with local model download/cache
- Automatic memory saving for phrases like:
  - `Remember that I prefer simple Docker setups.`
  - `Note that my server IP is 192.168.1.213.`
  - `My favorite model is qwen3:8b.`

## Runtime behavior

- No streaming
- No Ollama polling during normal chat
- No `/api/tags` call before every chat
- One LLM request at a time only
- Cooldown after failed Ollama requests so the app cannot queue retries
- Tiny context by default: `num_ctx=1024`
- Small reply cap: `num_predict=160`
- Limited chat history sent to model
- `keep_alive=0` so the model is not kept loaded by this app

## Install

```bash
cd deskbot-ollama-starter
cp .env.example .env
npm install
npm run dev
```

## Standalone Mode (No Ollama / No LM Studio)

You can run DeskBot fully local in the browser:

1. Open Settings → Model
2. Set Provider to `Standalone (Browser WebGPU)`
3. Choose a small model (`SmolLM2 360M` or `SmolLM2 135M`)
4. Start chatting

Notes:
- First run downloads model files and caches them in browser storage.
- If WebGPU is unavailable, DeskBot falls back to CPU/WASM mode automatically.
- This mode does not require Ollama or LM Studio.

Open:

```text
http://localhost:5173
```

Backend:

```text
http://localhost:5175
```

## Connect to Ubuntu Ollama

In Settings:

```text
Provider: Ollama
Base URL: http://192.168.1.213:11434
Model: select after fetching model list
```

Click **Fetch model list** and select any model, including Llama models.

## Recommended Ollama service settings

On Ubuntu:

```bash
sudo systemctl edit ollama
```

Paste:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_QUEUE=1"
Environment="OLLAMA_KEEP_ALIVE=1m"
Environment="OLLAMA_CONTEXT_LENGTH=1024"
Environment="OLLAMA_LLM_LIBRARY=cpu_avx2"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Check logs:

```bash
journalctl -u ollama -n 80 --no-pager
```

## DeskBot logs

```bash
npm run logs
```

Or open Settings → Diagnostics → Refresh backend logs.

## Changing Ollama request limits

Edit `.env`:

```env
OLLAMA_NUM_CTX=1024
OLLAMA_NUM_PREDICT=160
```

Then restart:

```bash
npm run dev
```

## Important

Do not expose Ollama directly to the internet. Use LAN or Tailscale. Keep `ALLOWED_LLM_HOSTS` restrictive.
