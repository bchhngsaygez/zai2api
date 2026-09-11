# zai2api

<p align="left">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node.js-%3E%3D22.0.0-339933?logo=node.js&logoColor=white" alt="Node.js Version"></a>
  <a href="https://github.com/apify/camoufox-js"><img src="https://img.shields.io/badge/engine-Camoufox%20(Gecko)-E66000?logo=firefox-browser&logoColor=white" alt="Engine"></a>
  <a href="#api-endpoints"><img src="https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai&logoColor=white" alt="OpenAI Compatible"></a>
  <a href="#docker-deployment"><img src="https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white" alt="Docker Ready"></a>
  <img src="https://img.shields.io/badge/license-MIT-gray.svg" alt="License">
</p>

High-performance, OpenAI-compatible proxy (`/v1/chat/completions`) for Z.ai web chat (GLM-5.3-Flash / GLM-5.3) powered by a stealth Gecko browser engine (Camoufox). Engineered for coding agents like Cline and Cursor with full tool-calling support, low RAM consumption, and zero TLS fingerprinting blocks.

---

## Web Studio Preview

`zai2api` includes a built-in, full-width minimalist dashboard at `http://127.0.0.1:3000` for managing tokens, testing completions, inspecting thought traces, and monitoring live stdout logs.

<p align="center">
  <img src="assets/preview_chat.png" alt="Chat Interface & Thought Drawer" width="100%" />
</p>

| API Playground & cURL Generator | Token Management & Live Logs |
| :---: | :---: |
| <img src="assets/preview_playground.png" width="100%" alt="API Playground" /> | <img src="assets/preview_tokens.png" width="100%" alt="Token Manager" /> |

---

## Key Features

- **OpenAI Compatible**: Drop-in endpoint for `/v1/chat/completions` supporting streaming (`text/event-stream`), non-streaming, and `/v1/models`.
- **Camoufox Stealth Engine**: Bypasses Cloudflare Turnstile and Alibaba Cloud WAF without JA3/JA4 TLS fingerprint issues.
- **Agent Tool Calling (Cline / Cursor)**:
  - **Flat Parameter Auto-Grouping**: Handles models generating root-level tool arguments (`path`, `new_text`, `content`) for `editor` and `write_to_file`.
  - **JSON Repair State Machine**: Automatically escapes raw newlines and control characters in multiline code blocks.
  - **Multi-Format XML Parser**: Supports `<editor>`, `<write_to_file>`, `<execute_command>`, and `<invoke>`.
  - **Hallucination Truncation**: Strips simulated tool results (`[Tool Result ...]`) to prevent model loops.
- **Automatic Token Rotation (Anti-Rate-Limit)**: Automatically detects HTTP 429/402 quota exhaustion and DOM error banners, marks tokens with a cooldown timer, and rotates seamlessly to the next available token in `tokens.json` without aborting active client requests.
- **"Money Saved" Stats Tracking**: Real-time persistent usage statistics (`stats.json`) calculating tokens, requests, and estimated money saved compared to frontier models ($3/1M prompt, $15/1M completion).
- **Thinking Mode**: Supports `low`, `high`, and `max` reasoning efforts, streaming thinking traces via `reasoning_content`.
- **Low RAM Footprint (< 900MB)**: Single-process content mode (`dom.ipc.processCount: 1`), 16MB memory cache cap, zero-bfcache, and decorative image blocking.
- **Web Studio Dashboard**: Edge-to-edge UI at `http://127.0.0.1:3000` with live stats ribbon, dark/light themes, token management, interactive playground, and live stdout terminal.
- **Docker & Tunnel Ready**: Pre-built Dockerfile and 1-command public tunnel via Cloudflare (`npm run tunnel`).

---

## Quick Start

### 1. Installation

```bash
git clone https://github.com/bchhngsaygez/zai2api.git
cd zai2api
npm install
```

> **Requirement**: Node.js `>= 22.0.0`

### 2. Configuration

Copy the sample environment file:
```bash
cp .env.example .env
```

Key environment variables:

| Variable | Default | Description |
| :--- | :---: | :--- |
| `PORT` | `3000` | Server listening port |
| `HOST` | `127.0.0.1` | Host address (`0.0.0.0` for Docker/LAN) |
| `DEFAULT_MODEL` | `glm-5.3-flash` | Default model (`glm-5.3-flash`, `glm-5.3`, `glm-5.2`) |
| `HEADLESS` | `true` | Run browser in headless mode |
| `OPTIMIZE_RAM` | `true` | Low-memory profile (single process, 16MB cache cap) |
| `BLOCK_IMAGES` | `true` | Block image downloads to minimize RAM usage |
| `ZAI_AUTH_TOKEN` | `""` | Optional Z.ai account JWT token (or set via Web UI) |

### 3. Run Server

```bash
npm start
```

Access the Web Studio at **`http://127.0.0.1:3000`**.

---

## Client Integration

### Cline (VS Code Extension)

1. Open Cline Settings (`Settings` -> `API Provider`).
2. Set **API Provider**: `OpenAI Compatible`
3. Set **Base URL**: `http://127.0.0.1:3000/v1`
4. Set **API Key**: `sk-zai2api` (or any non-empty string)
5. Set **Model ID**: `glm-5.3-flash`
6. Enable **Streaming**.

### Cursor

1. Open Cursor Settings -> **Models** -> **OpenAI API Key**.
2. Override Base URL: `http://127.0.0.1:3000/v1`
3. Add Model: `glm-5.3-flash`

### cURL

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.3-flash",
    "messages": [{"role": "user", "content": "Write a quicksort in Rust."}],
    "stream": true
  }'
```

---

## Public Sharing (Cloudflare Tunnel)

Expose port 3000 publicly with free SSL:

```bash
npm run tunnel
```

Cloudflare outputs a public HTTPS address (e.g. `https://random-name.trycloudflare.com`). Use this URL as the base URL (`/v1`) from any remote device or share it with others.

---

## Docker Deployment

### Docker Compose (Recommended)

```bash
# Start in background
docker compose up -d --build

# View logs
docker compose logs -f

# Stop container
docker compose down
```

### Docker CLI

```bash
docker build -t zai2api:latest .

docker run -d \
  --name zai2api \
  -p 3000:3000 \
  --shm-size=1g \
  -v $(pwd)/user-data-camoufox:/app/user-data-camoufox \
  -v $(pwd)/tokens.json:/app/tokens.json \
  -v $(pwd)/stats.json:/app/stats.json \
  --restart unless-stopped \
  zai2api:latest
```

---

## API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (streaming, tools, reasoning) |
| `GET` | `/v1/models` | Lists available models |
| `GET` | `/v1/stats` | Cumulative tokens, requests, and cost savings (`/api/stats`) |
| `POST` | `/api/stats/reset` | Resets usage and savings metrics |
| `GET` | `/v1/tokens` | Lists configured auth tokens and cooldown statuses |
| `POST` | `/v1/tokens` | Adds a new auth token |
| `POST` | `/api/tokens/rotate` | Manually rotate active token to next available |
| `POST` | `/api/tokens/clear-cooldowns` | Clears all active token cooldown timers |
| `DELETE`| `/v1/tokens/:id` | Deletes an auth token |
| `POST` | `/v1/tokens/:id/activate` | Sets active auth token |
| `GET` | `/v1/queue/status` | Current request queue state |
| `POST` | `/v1/subagent/task` | Multi-file subagent code generator |
| `GET` | `/health` | Health check endpoint |

---

## Troubleshooting

- **`EADDRINUSE: address already in use`**: Another instance of `zai2api` is already running on port 3000. Run:
  ```bash
  pkill -f "node src/index.js"
  ```
- **Camoufox profile locked**: Stale browser process detected. Stop all instances:
  ```bash
  pkill -f "node src/index.js"
  pkill -f camoufox
  rm -f user-data-camoufox/lock user-data-camoufox/.parentlock
  ```

---

## License

MIT
