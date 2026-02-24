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
PORT=13131
SPR_AUTH_KEY=YOUR_SITE_KEY
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

- `http://127.0.0.1:13131/` (if 13131 is busy, the server will auto-pick the next free port unless `SPR_STRICT_PORT=1`)

If you set `SPR_AUTH_KEY`, the site will ask for the key on entry.

You can also force a port:

```powershell
$env:PORT=3132; npm start
```

### Media metadata API (optional)

When you run the local server, you can inspect a direct media URL (typically the resolved `download_link`) via:

- `POST /api/media-info`
- Body: `{ "url": "https://videos.openai.com/az/files/...", "ffprobe": 1 }`

Notes:

- By default, `/api/media-info` only allows `videos.openai.com` (to reduce SSRF risk). Override with `SPR_MEDIA_ALLOW_HOSTS` (comma-separated hostnames, or `*`).
- When `ffprobe=1`, the server downloads the media to a temp file first, then runs `ffprobe` on the local file.
- The server will also try to extract C2PA fields (e.g. `ClaimGeneratorInfoName`, `ActionsSoftwareAgent`) via `exiftool` and return them in `c2pa` / `c2pa_error`.
- Temp download size is limited by `SPR_MEDIA_MAX_BYTES` (default 512 MiB).
- Use `SPR_MEDIA_TMP_DIR` to choose the temp directory, and `SPR_MEDIA_TMP_KEEP=1` to keep temp files for debugging.
- ffprobe is optional. If it is missing, the response will include `ffprobe_error`.
- You can set `SPR_FFPROBE_PATH` to point to a specific `ffprobe` binary.
- You can set `SPR_EXIFTOOL_PATH` to point to a specific `exiftool` binary.

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
  -p 13131:13131 \
  -e SORAI_PARSE_URL="https://api.sorai.me" \
  -e SORAI_PARSE_TOKEN="YOUR_PARSE_TOKEN_HERE" \
  sorai-permalink-resolver:latest
```

Option B: use an env file:

```bash
docker run -d --name sorai-permalink-resolver --restart unless-stopped \
  -p 13131:13131 \
  --env-file ./.env \
  sorai-permalink-resolver:latest
```

Then open:

- `http://<server-ip>:13131/`

### 3) Docker Compose

1. Put `SORAI_PARSE_URL` and `SORAI_PARSE_TOKEN` into a `.env` file (see `.env.example`).
2. Run:

```bash
docker compose up -d --build
```

Docker images install `ffmpeg` + `exiftool` so `/api/media-info` can return ffprobe + C2PA metadata.

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

### 4) Download and metadata

```powershell
node .\bin\sorai-permalink.js "s_..." --download .\out\ --meta
```

## Notes

- If you see `content-encoding: zstd` errors, this tool forces `Accept-Encoding: identity`.
- If your parse server returns links like `https://api.sorai.me/az/files/...`, the tool will normalize them to `https://videos.openai.com/az/files/...`.
