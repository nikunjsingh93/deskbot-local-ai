# DeskBot Ollama Starter — Minimal Safe Rewrite

A minimal React + Vite + Node + SQLite starter for a cute desktop robot assistant.

This rewrite is intentionally conservative so it does not overload your Ubuntu Ollama server.

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
- Automatic memory saving for phrases like:
  - `Remember that I prefer simple Docker setups.`
  - `Note that my server IP is 192.168.1.213.`
  - `My favorite model is qwen3:8b.`

## Why this version is safer

This version avoids the overload pattern that can freeze a small local server:

- No streaming
- No Ollama polling during normal chat
- No `/api/tags` call before every chat
- One LLM request at a time only
- Cooldown after failed Ollama requests so the app cannot queue retries
- Tiny context by default: `num_ctx=1024`
- Small reply cap: `num_predict=160`
- Limited chat history sent to model
- `keep_alive=0` so the model is not kept loaded by this app
- Blocks Llama/vision/large model names by default
- Blocks models above 2.5 GB by default when model size is known
- Manual panic unload button in Settings → Model

## Install

```bash
cd deskbot-ollama-starter
cp .env.example .env
npm install
npm run dev
```

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
Model: qwen2.5:0.5b
```

Click **Fetch model list**. Blocked models will be listed but not selectable.

## Recommended Ollama service safety settings

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
Environment="OLLAMA_KEEP_ALIVE=0"
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

## Safe models to start with

Start with:

```text
qwen2.5:0.5b
qwen3:0.6b
qwen2.5:1.5b
qwen3:1.7b
```

Llama models are blocked by default because your server froze after `llama3.2:1b` even though it was not a large model.

## Changing safety rules

Edit `.env` only after the app is stable:

```env
BLOCKED_OLLAMA_MODEL_PATTERNS=llama,llava,vision,moondream,minicpm,70b,65b,34b,32b,30b,27b,24b,22b,14b,13b,12b,11b,10b,8x
MAX_MODEL_SIZE_GB=2.5
OLLAMA_NUM_CTX=1024
OLLAMA_NUM_PREDICT=160
```

Then restart:

```bash
npm run dev
```

## Important

Do not expose Ollama directly to the internet. Use LAN or Tailscale. Keep `ALLOWED_LLM_HOSTS` restrictive.
