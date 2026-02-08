# sorai-permalink-resolver

Resolve a Sora permalink (or `s_...` id) to a direct `download_link` by calling your custom parse server:

- `POST {PARSE_URL}/get-sora-link`
- JSON body: `{ "url": "<permalink>", "token": "<parse_token>" }`

## Install

This is a standalone folder. No dependencies.

### Install as a command (optional)

```powershell
cd d:\sorai-permalink-resolver
npm link
sorai-permalink "https://sora.chatgpt.com/p/s_..." --parse-url "https://api.sorai.me" --token "YOUR_TOKEN"
```

## Usage

### .env (recommended)

Copy `d:\sorai-permalink-resolver\.env.example` to `.env` and edit:

```text
PORT=3131
SORAI_PARSE_URL=https://api.sorai.me
SORAI_PARSE_TOKEN=YOUR_TOKEN
SPR_LOCK_CONFIG=1
```

### Web UI

Start the local server (serves the page and provides a local proxy endpoint to avoid CORS):

```powershell
cd d:\sorai-permalink-resolver
npm start
```

Then open:

- `http://127.0.0.1:3131/` (if 3131 is busy, the server will auto-pick the next free port unless `SPR_STRICT_PORT=1`)

You can also force a port:

```powershell
$env:PORT=3132; npm start
```

## Docker

This project can run as a small Docker service (serves the web UI + `/api/resolve`).

Notes:

- Windows: you need Docker Desktop running (otherwise `npipe:////./pipe/dockerDesktopLinuxEngine` connect errors).

### 1) Build

```bash
docker build -t sorai-permalink-resolver:latest .
```

### 2) Run

Option A: pass env vars directly:

```bash
docker run -d --name sorai-permalink-resolver --restart unless-stopped \
  -p 3131:3131 \
  -e SORAI_PARSE_URL="https://api.sorai.me" \
  -e SORAI_PARSE_TOKEN="YOUR_PARSE_TOKEN_HERE" \
  sorai-permalink-resolver:latest
```

Option B: use an env file:

```bash
docker run -d --name sorai-permalink-resolver --restart unless-stopped \
  -p 3131:3131 \
  --env-file ./.env \
  sorai-permalink-resolver:latest
```

Then open:

- `http://<server-ip>:3131/`

### 3) Docker Compose

1. Put `SORAI_PARSE_URL` and `SORAI_PARSE_TOKEN` into a `.env` file (see `.env.example`).
2. Run:

```bash
docker compose up -d --build
```

### 1) With args

```powershell
node .\bin\sorai-permalink.js "https://sora.chatgpt.com/p/s_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" --parse-url "https://api.sorai.me" --token "YOUR_TOKEN"
```

### 2) With env

```powershell
$env:SORAI_PARSE_URL = "https://api.sorai.me"
$env:SORAI_PARSE_TOKEN = "YOUR_TOKEN"
node .\bin\sorai-permalink.js "s_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

### 3) Output full JSON

```powershell
node .\bin\sorai-permalink.js "s_..." --raw
```

## Notes

- If you see `content-encoding: zstd` errors, this tool forces `Accept-Encoding: identity`.
- If your parse server returns links like `https://api.sorai.me/az/files/...`, the tool will normalize them to `https://videos.openai.com/az/files/...`.
