#!/usr/bin/env node
/*
  sorai-permalink-resolver

  Resolve a Sora permalink (or s_... id) to a direct download link by calling:

    POST {PARSE_URL}/get-sora-link
    Body: { url: <permalink>, token: <parse_token> }

  Config:
    --parse-url / env SORAI_PARSE_URL
    --token     / env SORAI_PARSE_TOKEN

  Examples:
    node .\bin\sorai-permalink.js https://sora.chatgpt.com/p/s_xxx --parse-url https://api.sorai.me --token TOKEN
    node .\bin\sorai-permalink.js s_xxx --raw
*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HEAD_TIMEOUT_MS = 8_000;
const DEFAULT_FFPROBE_TIMEOUT_MS = 15_000;

function loadDotEnv() {
  const envPaths = Array.from(
    new Set([
      path.join(process.cwd(), '.env'),
      // Useful when installed via `npm link` and invoked from another folder.
      path.join(path.resolve(__dirname, '..'), '.env'),
    ])
  );

  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;

    let txt = '';
    try {
      txt = fs.readFileSync(envPath, 'utf8');
    } catch {
      continue;
    }

    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      if (!key) continue;
      if (process.env[key] !== undefined) continue;

      let val = line.slice(idx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

function usage(exitCode = 0) {
  const msg = `
Usage:
  sorai-permalink <permalink-or-s_id> [options]

Options:
  --parse-url <url>   Parse server base URL. Env: SORAI_PARSE_URL
  --token <token>     Parse server token. Env: SORAI_PARSE_TOKEN
  --timeout <ms>      Request timeout in ms (default: ${DEFAULT_TIMEOUT_MS})
  --head-timeout <ms> Media HEAD timeout in ms (default: ${DEFAULT_HEAD_TIMEOUT_MS})
  --ffprobe-timeout <ms> ffprobe timeout in ms (default: ${DEFAULT_FFPROBE_TIMEOUT_MS})
  --download <path>   Download the video to a file (or directory)
  --overwrite         Overwrite existing download file
  --meta              Print media metadata JSON (HEAD + ffprobe if available)
  --raw               Print full JSON response instead of only download_link
  -h, --help          Show this help

Examples:
  node .\\bin\\sorai-permalink.js https://sora.chatgpt.com/p/s_... --parse-url https://api.sorai.me --token YOUR_TOKEN
  node .\\bin\\sorai-permalink.js s_... --parse-url https://api.sorai.me --token YOUR_TOKEN
  node .\\bin\\sorai-permalink.js s_... --download .\\out\\ --meta
`;
  (exitCode === 0 ? console.log : console.error)(msg.trimStart());
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = {
    permalink: null,
    parseUrl: process.env.SORAI_PARSE_URL || null,
    token: process.env.SORAI_PARSE_TOKEN || null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    download: null,
    overwrite: false,
    meta: false,
    headTimeoutMs: DEFAULT_HEAD_TIMEOUT_MS,
    ffprobeTimeoutMs: DEFAULT_FFPROBE_TIMEOUT_MS,
    raw: false,
  };

  const args = [...argv];
  while (args.length) {
    const a = args.shift();

    if (a === '-h' || a === '--help') usage(0);

    if (a === '--raw') {
      out.raw = true;
      continue;
    }

    if (a === '--meta') {
      out.meta = true;
      continue;
    }

    if (a === '--overwrite') {
      out.overwrite = true;
      continue;
    }

    if (a === '--download') {
      out.download = args.shift() || '';
      continue;
    }

    if (a === '--parse-url') {
      out.parseUrl = args.shift() || '';
      continue;
    }

    if (a === '--token') {
      out.token = args.shift() || '';
      continue;
    }

    if (a === '--timeout') {
      const v = args.shift();
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --timeout: ${v}`);
        usage(1);
      }
      out.timeoutMs = Math.floor(n);
      continue;
    }

    if (a === '--head-timeout') {
      const v = args.shift();
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --head-timeout: ${v}`);
        usage(1);
      }
      out.headTimeoutMs = Math.floor(n);
      continue;
    }

    if (a === '--ffprobe-timeout') {
      const v = args.shift();
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        console.error(`Invalid --ffprobe-timeout: ${v}`);
        usage(1);
      }
      out.ffprobeTimeoutMs = Math.floor(n);
      continue;
    }

    if (a.startsWith('-')) {
      console.error(`Unknown option: ${a}`);
      usage(1);
    }

    if (!out.permalink) {
      out.permalink = a;
      continue;
    }

    console.error(`Unexpected extra arg: ${a}`);
    usage(1);
  }

  return out;
}

function normalizePermalink(input) {
  const s = String(input || '').trim();
  const sIdMatch = s.match(/s_[a-f0-9]{32}/);
  if (sIdMatch) return `https://sora.chatgpt.com/p/${sIdMatch[0]}`;
  return s;
}

function buildEndpoint(parseUrl) {
  const base = String(parseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/get-sora-link')) return base;
  return `${base}/get-sora-link`;
}

function normalizeDownloadLink(input) {
  const s = String(input || '').trim();
  if (!s) return s;

  // Some parsers return a relative path.
  if (s.startsWith('/az/files')) return `https://videos.openai.com${s}`;
  if (s.startsWith('az/files')) return `https://videos.openai.com/${s}`;

  let u;
  try {
    u = new URL(s);
  } catch {
    return s;
  }

  // Some parse servers proxy the Azure blob link under their own domain:
  //   https://api.sorai.me/az/files/...  -> https://videos.openai.com/az/files/...
  if (u.pathname && u.pathname.startsWith('/az/files')) {
    u.protocol = 'https:';
    u.hostname = 'videos.openai.com';
    u.port = '';
    return u.toString();
  }

  return s;
}

function suggestFilenameFromUrl(link) {
  const fallback = 'video.mp4';
  let u;
  try {
    u = new URL(link);
  } catch {
    return fallback;
  }

  // /az/files/<fileId>%2Fraw
  const p = u.pathname || '';
  const idx = p.indexOf('/az/files/');
  if (idx >= 0) {
    const tail = p.slice(idx + '/az/files/'.length);
    try {
      const decoded = decodeURIComponent(tail); // "<id>/raw"
      const id = decoded.replace(/\/raw$/, '');
      if (id && id !== decoded) return `${id}.mp4`;
      if (decoded && decoded !== 'raw') return `${decoded.replaceAll('/', '_')}.mp4`;
    } catch {
      // ignore
    }
  }

  const base = path.basename(p);
  if (base && base.includes('.')) return base;
  return fallback;
}

function pickMediaHeaders(headers) {
  const keys = [
    'content-type',
    'content-length',
    'accept-ranges',
    'content-range',
    'last-modified',
    'etag',
    'cache-control',
    'expires',
    'content-disposition',
  ];
  const out = {};
  for (const k of keys) {
    const v = headers.get(k);
    if (v != null && String(v).trim()) out[k.replaceAll('-', '_')] = String(v);
  }
  return out;
}

async function headInfo(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { accept: '*/*' },
      signal: ctrl.signal,
    });

    return {
      ok: res.ok,
      status: res.status,
      status_text: res.statusText,
      url: res.url || url,
      headers: pickMediaHeaders(res.headers),
    };
  } finally {
    clearTimeout(t);
  }
}

async function ffprobeJson(input, timeoutMs) {
  const bin = String(process.env.SPR_FFPROBE_PATH || 'ffprobe').trim() || 'ffprobe';
  const args = [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    input,
  ];

  return await new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    const killTimer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        // ignore
      }
      reject(new Error('ffprobe_timeout'));
    }, timeoutMs);

    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));

    p.on('error', (e) => {
      clearTimeout(killTimer);
      reject(e);
    });

    p.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        const e = new Error('ffprobe_failed');
        e.detail = err || `ffprobe exited with code ${code}`;
        reject(e);
        return;
      }

      let json;
      try {
        json = out ? JSON.parse(out) : null;
      } catch {
        json = null;
      }
      if (!json || typeof json !== 'object') {
        const e = new Error('ffprobe_invalid_json');
        e.detail = out || err;
        reject(e);
        return;
      }
      resolve(json);
    });
  });
}

function resolveDownloadPath(downloadOpt, url) {
  const raw = String(downloadOpt || '').trim();
  if (!raw) return null;

  const abs = path.resolve(raw);
  const endsWithSep = raw.endsWith('/') || raw.endsWith('\\');

  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return path.join(abs, suggestFilenameFromUrl(url));
  } catch {
    // ignore
  }

  if (endsWithSep) return path.join(abs, suggestFilenameFromUrl(url));
  return abs;
}

async function downloadToFile(url, destPath, { overwrite }) {
  const targetDir = path.dirname(destPath);
  fs.mkdirSync(targetDir, { recursive: true });

  if (!overwrite && fs.existsSync(destPath)) {
    const e = new Error('download_exists');
    e.detail = `File exists: ${destPath}`;
    throw e;
  }

  const tmpPath = `${destPath}.part`;
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  } catch {
    // ignore
  }

  const res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { accept: '*/*' } });
  if (!res.ok) {
    const e = new Error(`download_http_${res.status}`);
    e.detail = `HTTP ${res.status} ${res.statusText}`;
    throw e;
  }

  if (!res.body) throw new Error('download_no_body');
  const file = fs.createWriteStream(tmpPath);
  try {
    await pipeline(Readable.fromWeb(res.body), file);
  } catch (err) {
    try {
      file.destroy();
    } catch {
      // ignore
    }
    throw err;
  }

  fs.renameSync(tmpPath, destPath);
}

async function readStdinIfAny() {
  if (process.stdin.isTTY) return '';
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  // Optional: load SORAI_PARSE_URL / SORAI_PARSE_TOKEN from .env (no dependency).
  loadDotEnv();

  const opts = parseArgs(process.argv.slice(2));

  if (!opts.permalink) {
    const stdin = (await readStdinIfAny()).trim();
    if (stdin) opts.permalink = stdin;
  }

  if (!opts.permalink) usage(1);

  const permalink = normalizePermalink(opts.permalink);
  const endpoint = buildEndpoint(opts.parseUrl);

  if (!endpoint) {
    console.error('Missing parse server URL. Provide --parse-url or set env SORAI_PARSE_URL.');
    process.exit(1);
  }

  if (!opts.token) {
    console.error('Missing parse server token. Provide --token or set env SORAI_PARSE_TOKEN.');
    process.exit(1);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        // Avoid zstd/br auto-compression edge cases; we only need JSON.
        'accept-encoding': 'identity',
        // Some CF setups are picky about UA.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ url: permalink, token: opts.token }),
      signal: controller.signal,
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!res.ok) {
      const hint = data && typeof data === 'object' ? JSON.stringify(data) : text;
      console.error(`HTTP ${res.status} ${res.statusText}`);
      if (hint) console.error(hint);
      process.exit(1);
    }

    // Normalize download_link host if needed.
    if (data && typeof data === 'object' && typeof data.download_link === 'string') {
      const normalized = normalizeDownloadLink(data.download_link);
      if (normalized && normalized !== data.download_link) {
        data.download_link_raw = data.download_link;
        data.download_link = normalized;
      }
    }

    const dl = data && typeof data === 'object' ? data.download_link : null;
    if (typeof dl !== 'string' || !dl.trim()) {
      console.error('No download_link in response.');
      console.error(text);
      process.exit(2);
    }

    const downloadPath = resolveDownloadPath(opts.download, dl);
    let savedPath = null;

    if (downloadPath) {
      try {
        await downloadToFile(dl, downloadPath, { overwrite: opts.overwrite });
        savedPath = downloadPath;
        console.error(`Downloaded: ${savedPath}`);
      } catch (e) {
        const detail = e && e.detail ? String(e.detail) : String(e && e.message ? e.message : e);
        console.error(`Download failed: ${detail}`);
        process.exit(1);
      }
    }

    if (opts.meta) {
      let head = null;
      try {
        head = await headInfo(dl, opts.headTimeoutMs);
      } catch (e) {
        head = {
          ok: false,
          status: null,
          status_text: null,
          url: dl,
          error: String(e && e.message ? e.message : e),
        };
      }

      let ffprobe = null;
      let ffprobe_error = null;
      try {
        ffprobe = await ffprobeJson(savedPath || dl, opts.ffprobeTimeoutMs);
      } catch (e) {
        ffprobe_error = e && e.detail ? String(e.detail) : String(e && e.message ? e.message : e);
      }

      const out = {
        permalink,
        download_link: dl.trim(),
        download_path: savedPath,
        head,
        ffprobe,
        ffprobe_error,
      };
      if (opts.raw) out.resolve = data;
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (opts.raw) {
      if (savedPath && data && typeof data === 'object') data.download_path = savedPath;
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(dl.trim());
    return;
  } catch (err) {
    const msg = err && typeof err === 'object' && err.name === 'AbortError' ? 'Request timeout' : String(err);
    console.error(msg);
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

main();
