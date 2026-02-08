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

const DEFAULT_TIMEOUT_MS = 30_000;

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
  --raw               Print full JSON response instead of only download_link
  -h, --help          Show this help

Examples:
  node .\\bin\\sorai-permalink.js https://sora.chatgpt.com/p/s_... --parse-url https://api.sorai.me --token YOUR_TOKEN
  node .\\bin\\sorai-permalink.js s_... --parse-url https://api.sorai.me --token YOUR_TOKEN
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

    if (opts.raw) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const dl = data && typeof data === 'object' ? data.download_link : null;
    if (typeof dl === 'string' && dl.trim()) {
      console.log(dl.trim());
      return;
    }

    console.error('No download_link in response.');
    console.error(text);
    process.exit(2);
  } catch (err) {
    const msg = err && typeof err === 'object' && err.name === 'AbortError' ? 'Request timeout' : String(err);
    console.error(msg);
    process.exit(1);
  } finally {
    clearTimeout(timeout);
  }
}

main();
