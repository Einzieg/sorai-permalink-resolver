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
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const FALLBACK_PORT = 3131;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_HOST = '127.0.0.1';

const AUTH_COOKIE = 'spr_auth';
const AUTH_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

function json(res, status, body) {
  const txt = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-spr-auth',
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

function parseCookies(req) {
  const header = String((req && req.headers && req.headers.cookie) || '');
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function hmacSha256Base64Url(secret, message) {
  const b64 = crypto.createHmac('sha256', secret).update(message).digest('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildAuthCookieValue(authKey, ttlSec = AUTH_TTL_SEC) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const expStr = String(exp);
  const sig = hmacSha256Base64Url(authKey, expStr);
  return `${expStr}.${sig}`;
}

function isValidAuthCookieValue(value, authKey) {
  const s = String(value || '');
  const idx = s.indexOf('.');
  if (idx <= 0) return false;
  const expStr = s.slice(0, idx);
  const sig = s.slice(idx + 1);
  if (!expStr || !sig) return false;

  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;

  const expected = hmacSha256Base64Url(authKey, expStr);
  return safeEqual(sig, expected);
}

function normalizeNextPath(next) {
  const s = String(next || '').trim();
  if (!s) return '/';
  if (!s.startsWith('/')) return '/';
  if (s.startsWith('//')) return '/';
  if (s.startsWith('/auth')) return '/';
  if (s.startsWith('/logout')) return '/';
  return s;
}

function renderAuthPage({ nextPath = '/', error = false } = {}) {
  const errHtml = error
    ? '<div class="err">Key 不正确，请重试。</div>'
    : '<div class="hint">请输入访问 Key（来自服务端 <code>SPR_AUTH_KEY</code>）。</div>';
  const nextEsc = String(nextPath).replaceAll('"', '&quot;');

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>鉴权 | Sora 直链解析工具</title>
    <style>
      :root{
        --bg0:#fbf6ee;--bg1:#e9f6f5;--ink:#0e1a2a;--muted:rgba(14,26,42,.72);
        --line:rgba(14,26,42,.16);--shadow:0 14px 42px rgba(14,26,42,.14);
        --accent:#0ea5a5;--danger:#b42318;--radius:20px;
        --mono:"Cascadia Mono","Cascadia Code",Consolas,"SFMono-Regular",Menlo,monospace;
        --sans:"Aptos","Segoe UI","Helvetica Neue","Noto Sans",sans-serif;
        --serif:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
      }
      *{box-sizing:border-box}
      html,body{height:100%}
      body{margin:0;color:var(--ink);font-family:var(--sans);
        background:linear-gradient(140deg,var(--bg0),var(--bg1));display:flex;align-items:center;justify-content:center;padding:18px}
      .card{width:min(520px,100%);background:rgba(255,255,255,.86);border:1px solid var(--line);
        border-radius:var(--radius);box-shadow:var(--shadow);padding:18px}
      .brand{display:flex;align-items:center;gap:12px;margin-bottom:10px}
      .mark{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,rgba(14,165,165,.95),rgba(245,158,11,.85))}
      h1{margin:0;font-family:var(--serif);font-size:20px;letter-spacing:.2px}
      .sub{color:var(--muted);font-size:13px;margin-top:4px}
      .hint{color:var(--muted);font-size:13px;margin:12px 0 10px}
      .err{color:var(--danger);font-size:13px;margin:12px 0 10px}
      code{font-family:var(--mono);background:rgba(255,255,255,.7);padding:2px 6px;border-radius:10px;border:1px solid rgba(14,26,42,.10)}
      form{display:flex;gap:10px;align-items:center;margin-top:8px}
      input{flex:1;border:1px solid rgba(14,26,42,.18);background:rgba(255,255,255,.92);color:var(--ink);
        border-radius:14px;padding:12px 12px;font-size:14px;outline:none}
      input:focus{border-color:rgba(14,165,165,.65)}
      button{border:1px solid rgba(14,165,165,.45);background:linear-gradient(135deg,rgba(14,165,165,.95),rgba(14,165,165,.72));
        color:white;border-radius:14px;padding:12px 14px;font-weight:650;cursor:pointer}
      .foot{display:flex;justify-content:space-between;gap:12px;margin-top:12px;color:var(--muted);font-size:12px}
      a{color:var(--ink);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;opacity:.9}
    </style>
  </head>
  <body>
    <div class="card">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div>
          <h1>需要鉴权</h1>
          <div class="sub">Sora 直链解析工具</div>
        </div>
      </div>

      ${errHtml}

      <form method="POST" action="/auth">
        <input type="password" name="key" placeholder="Access Key" autocomplete="current-password" autofocus required />
        <input type="hidden" name="next" value="${nextEsc}" />
        <button type="submit">进入</button>
      </form>

      <div class="foot">
        <span>未设置 <code>SPR_AUTH_KEY</code> 时不会启用鉴权。</span>
        <a href="/README.md" target="_blank" rel="noreferrer noopener">文档</a>
      </div>
    </div>
  </body>
</html>`;
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
  const authKey = String(process.env.SPR_AUTH_KEY || '').trim();
  const authEnabled = !!authKey;
  const host = String(process.env.HOST || '').trim() || DEFAULT_HOST;
  const portEnv = String(process.env.PORT || '').trim();
  const requestedPortRaw = portEnv ? Number(portEnv) : FALLBACK_PORT;
  const requestedPort = Number.isFinite(requestedPortRaw) ? requestedPortRaw : FALLBACK_PORT;

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');

      if (authEnabled && u.pathname === '/logout') {
        // Clear cookie and send to auth page.
        res.writeHead(303, {
          'set-cookie': `${AUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
          location: '/auth',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }

      if (authEnabled && u.pathname === '/auth') {
        const nextPath = normalizeNextPath(u.searchParams.get('next'));
        const hasError = u.searchParams.get('e') === '1';

        const cookies = parseCookies(req);
        const authed = isValidAuthCookieValue(cookies[AUTH_COOKIE], authKey);

        if (req.method === 'GET' || req.method === 'HEAD') {
          if (authed) {
            res.writeHead(303, { location: nextPath, 'cache-control': 'no-store' });
            res.end();
            return;
          }
          const html = renderAuthPage({ nextPath, error: hasError });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(req.method === 'HEAD' ? undefined : html);
          return;
        }

        if (req.method === 'POST') {
          const body = await readBody(req, 8 * 1024);
          const ct = String(req.headers['content-type'] || '').toLowerCase();

          let key = '';
          let next = nextPath;

          if (ct.includes('application/json')) {
            try {
              const parsed = body ? JSON.parse(body) : {};
              if (parsed && typeof parsed === 'object') {
                key = String(parsed.key || parsed.auth_key || '').trim();
                next = normalizeNextPath(parsed.next || nextPath);
              }
            } catch {
              // ignore
            }
          } else {
            // x-www-form-urlencoded (default for HTML forms)
            for (const part of String(body || '').split('&')) {
              const idx = part.indexOf('=');
              if (idx <= 0) continue;
              const k = part.slice(0, idx).replaceAll('+', ' ');
              const v = part.slice(idx + 1).replaceAll('+', ' ');
              const kk = decodeURIComponent(k);
              const vv = decodeURIComponent(v);
              if (kk === 'key') key = String(vv || '').trim();
              if (kk === 'next') next = normalizeNextPath(vv || nextPath);
            }
          }

          if (key && safeEqual(key, authKey)) {
            const cookieVal = buildAuthCookieValue(authKey);
            res.writeHead(303, {
              'set-cookie': `${AUTH_COOKIE}=${encodeURIComponent(cookieVal)}; Max-Age=${AUTH_TTL_SEC}; Path=/; HttpOnly; SameSite=Lax`,
              location: next,
              'cache-control': 'no-store',
            });
            res.end();
            return;
          }

          // Failed. Keep next to improve UX.
          res.writeHead(303, {
            location: `/auth?e=1&next=${encodeURIComponent(next)}`,
            'cache-control': 'no-store',
          });
          res.end();
          return;
        }

        return send(res, 405, { 'content-type': 'text/plain; charset=utf-8' }, 'Method Not Allowed');
      }

      if (authEnabled) {
        // Allow CORS preflight without auth. Actual request must still be authenticated.
        if (req.method !== 'OPTIONS') {
          const cookies = parseCookies(req);
          const authed =
            isValidAuthCookieValue(cookies[AUTH_COOKIE], authKey) ||
            safeEqual(String(req.headers['x-spr-auth'] || '').trim(), authKey);
          if (!authed) {
            if (u.pathname.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
            const next = `${u.pathname}${u.search || ''}`;
            res.writeHead(302, {
              location: `/auth?next=${encodeURIComponent(next)}`,
              'cache-control': 'no-store',
            });
            res.end();
            return;
          }
        }
      }

      if (u.pathname === '/api/config') {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type, x-spr-auth',
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
            'access-control-allow-headers': 'content-type, x-spr-auth',
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
