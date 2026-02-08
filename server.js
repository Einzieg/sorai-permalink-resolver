#!/usr/bin/env node
/*
  Local server (no deps):
  - Serves ./web as a static site
  - Provides POST /api/resolve to proxy requests to the parse server (avoids CORS)

  Env:
    SORAI_PARSE_URL   (optional) default parse server base URL
    SORAI_PARSE_TOKEN (optional) default parse token
    PORT              (optional) default 3131
*/

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const FALLBACK_PORT = 3131;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HOST = '127.0.0.1';

function json(res, status, body) {
  const txt = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(txt);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.md') return 'text/markdown; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function normalizePermalink(input) {
  const s = String(input || '').trim();
  const m = s.match(/s_[a-f0-9]{32}/);
  if (m) return `https://sora.chatgpt.com/p/${m[0]}`;
  return s;
}

function buildParseEndpoint(parseUrl) {
  const base = String(parseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/get-sora-link')) return base;
  return `${base}/get-sora-link`;
}

function normalizeDownloadLink(input) {
  const s = String(input || '').trim();
  if (!s) return s;

  if (s.startsWith('/az/files')) return `https://videos.openai.com${s}`;
  if (s.startsWith('az/files')) return `https://videos.openai.com/${s}`;

  let u;
  try {
    u = new URL(s);
  } catch {
    return s;
  }

  if (u.pathname && u.pathname.startsWith('/az/files')) {
    u.protocol = 'https:';
    u.hostname = 'videos.openai.com';
    u.port = '';
    return u.toString();
  }

  return s;
}

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  let txt = '';
  try {
    txt = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
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

async function readBody(req, limitBytes = 256 * 1024) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function proxyResolve(payload) {
  const permalink = normalizePermalink(payload.permalink || payload.url || '');
  if (!permalink) throw new Error('missing_permalink');

  const lockConfig = String(process.env.SPR_LOCK_CONFIG || '').trim() === '1';
  const parseUrl = String(
    process.env.SORAI_PARSE_URL || (!lockConfig && (payload.parse_url || payload.parseUrl)) || ''
  ).trim();
  const token = String(process.env.SORAI_PARSE_TOKEN || (!lockConfig && payload.token) || '').trim();
  const timeoutMs = Number(payload.timeout_ms || payload.timeoutMs || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const endpoint = buildParseEndpoint(parseUrl);
  if (!endpoint) throw new Error('missing_parse_url');
  if (!token) throw new Error('missing_token');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // Force identity to avoid zstd/br handling differences in Node environments.
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'accept-encoding': 'identity',
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({ url: permalink, token }),
      signal: ctrl.signal,
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
      const err = new Error(`upstream_http_${res.status}`);
      err.status = 502;
      err.detail = hint || `HTTP ${res.status} ${res.statusText}`;
      throw err;
    }

    const out = data || {};
    if (out && typeof out === 'object' && typeof out.download_link === 'string') {
      const normalized = normalizeDownloadLink(out.download_link);
      if (normalized && normalized !== out.download_link) {
        out.download_link_raw = out.download_link;
        out.download_link = normalized;
      }
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

function serveStatic(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(u.pathname);
  if (pathname === '/') pathname = '/index.html';

  // Allow reading top-level docs when served (nice for the "Docs" link).
  if (pathname === '/README.md' || pathname === '/LICENSE') {
    const p = path.join(ROOT, pathname.slice(1));
    if (!p.startsWith(ROOT)) return send(res, 403, {}, 'Forbidden');
    if (!fs.existsSync(p)) return send(res, 404, {}, 'Not found');
    const buf = fs.readFileSync(p);
    return send(res, 200, { 'content-type': mimeFor(p), 'cache-control': 'no-store' }, buf);
  }

  // Only serve from WEB_DIR.
  const filePath = path.join(WEB_DIR, pathname.replace(/^\//, ''));
  if (!filePath.startsWith(WEB_DIR)) return send(res, 403, {}, 'Forbidden');
  if (!fs.existsSync(filePath)) return send(res, 404, {}, 'Not found');

  const buf = fs.readFileSync(filePath);
  return send(res, 200, { 'content-type': mimeFor(filePath), 'cache-control': 'no-store' }, buf);
}

function listenAsync(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function listenWithFallback(server, requestedPort, strictPort, host) {
  const MAX_TRIES = 10;
  const base = Number.isFinite(requestedPort) ? requestedPort : FALLBACK_PORT;

  // If requestedPort is 0, let the OS pick a free port immediately.
  if (base === 0) {
    await listenAsync(server, 0, host);
    return server.address().port;
  }

  for (let i = 0; i < MAX_TRIES; i++) {
    const port = base + i;
    try {
      await listenAsync(server, port, host);
      return port;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        if (strictPort) throw err;
        // eslint-disable-next-line no-console
        console.warn(`Port ${port} in use, trying ${port + 1}...`);
        continue;
      }
      throw err;
    }
  }

  // As a last resort, pick an ephemeral port.
  await listenAsync(server, 0, host);
  return server.address().port;
}

async function main() {
  loadDotEnv();

  const strictPort = String(process.env.SPR_STRICT_PORT || '').trim() === '1';
  const host = String(process.env.HOST || '').trim() || DEFAULT_HOST;
  const portEnv = String(process.env.PORT || '').trim();
  const requestedPortRaw = portEnv ? Number(portEnv) : FALLBACK_PORT;
  const requestedPort = Number.isFinite(requestedPortRaw) ? requestedPortRaw : FALLBACK_PORT;

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');

      if (u.pathname === '/api/config') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type',
            'access-control-allow-methods': 'GET, OPTIONS',
            'access-control-max-age': '600',
          });
          res.end();
          return;
        }

        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' });

        const lockConfig = String(process.env.SPR_LOCK_CONFIG || '').trim() === '1';
        const defaultModeRaw = String(process.env.SPR_DEFAULT_MODE || 'proxy').trim().toLowerCase();
        const defaultMode = defaultModeRaw === 'direct' ? 'direct' : 'proxy';

        const addr = server.address();
        const port = addr && typeof addr === 'object' ? addr.port : null;

        return json(res, 200, {
          port,
          parse_url: String(process.env.SORAI_PARSE_URL || '').trim(),
          has_token: !!String(process.env.SORAI_PARSE_TOKEN || '').trim(),
          lock_config: lockConfig,
          default_mode: defaultMode,
        });
      }

      if (u.pathname === '/api/resolve') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type',
            'access-control-allow-methods': 'POST, OPTIONS',
            'access-control-max-age': '600',
          });
          res.end();
          return;
        }

        if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' });

        const started = Date.now();
        const body = await readBody(req);
        let payload;
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          return json(res, 400, { error: 'invalid_json' });
        }

        try {
          const data = await proxyResolve(payload);
          json(res, 200, { ...data, duration_ms: Date.now() - started });
        } catch (e) {
          const status = Number(e && e.status) || 400;
          const detail = e && e.detail ? String(e.detail) : String(e && e.message ? e.message : e);
          json(res, status, { error: detail });
        }
        return;
      }

      // Static
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
      }
      serveStatic(req, res);
    } catch (e) {
      json(res, 500, { error: String(e && e.message ? e.message : e) });
    }
  });

  try {
    const port = await listenWithFallback(server, requestedPort, strictPort, host);
    const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    // eslint-disable-next-line no-console
    console.log(`Server running: http://${displayHost}:${port}`);
    // eslint-disable-next-line no-console
    console.log('Open: http://' + displayHost + ':' + port + '/');
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      // eslint-disable-next-line no-console
      console.error(`Port ${requestedPort} is already in use.`);
      // eslint-disable-next-line no-console
      console.error('Pick another port by setting PORT (for example in .env):');
      // eslint-disable-next-line no-console
      console.error('  PORT=3132');
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(String(err && err.message ? err.message : err));
  process.exit(1);
});
