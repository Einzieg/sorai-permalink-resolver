/* global fetch */

'use strict';

const STORAGE = {
  timeoutMs: 'spr_timeout_ms',
  proxyEndpoint: 'spr_proxy_endpoint',
};

const DEFAULT_TIMEOUT_MS = 30_000;

let SERVER_CONFIG = null;

function $(id) {
  return document.getElementById(id);
}

function safeText(s) {
  return String(s == null ? '' : s);
}

function normalizePermalink(input) {
  const s = safeText(input).trim();
  const m = s.match(/s_[a-f0-9]{32}/);
  if (m) return `https://sora.chatgpt.com/p/${m[0]}`;
  return s;
}

function normalizeDownloadLink(input) {
  const s = safeText(input).trim();
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

function suggestFilenameFromUrl(link) {
  const fallback = 'sora.mp4';
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
  return fallback;
}

function guessProxyEndpoint() {
  if (location.protocol === 'file:') return 'http://127.0.0.1:3131/api/resolve';
  return `${location.origin}/api/resolve`;
}

async function loadServerConfig() {
  if (location.protocol === 'file:') return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1200);
  try {
    const res = await fetch('/api/config', {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || typeof json !== 'object') return null;
    return json;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function applyServerConfig(cfg) {
  SERVER_CONFIG = cfg;

  const parseUrlFromServer = safeText(cfg.parse_url).trim();
  const hasToken = !!cfg.has_token;
  const port = cfg.port;

  if (parseUrlFromServer && hasToken) {
    setStatus(`已从服务端加载配置。`, 'info');
    return;
  }

  const miss = [];
  if (!parseUrlFromServer) miss.push('SORAI_PARSE_URL');
  if (!hasToken) miss.push('SORAI_PARSE_TOKEN');
  setStatus(`缺少配置：${miss.join(' 和 ')}。`, 'error');
}

function setStatus(msg, kind = 'info') {
  const el = $('status');
  if (!el) return;
  el.textContent = msg;
  el.style.color =
    kind === 'error'
      ? 'var(--danger)'
      : kind === 'ok'
        ? 'var(--ok)'
        : 'var(--muted)';
}

function setSource(source) {
  const p = $('sourcePill');
  if (!p) return;
  p.textContent = source ? String(source) : '-';
}

function setResult(link, raw) {
  const box = $('resultBox');
  const rawEl = $('rawJson');
  const copyBtn = $('copyBtn');
  const openBtn = $('openBtn');
  const downloadBtn = $('downloadBtn');
  const previewWrap = $('previewWrap');
  const video = $('videoPreview');
  const videoHint = $('videoHint');

  if (!box) return;

  box.classList.remove('success');
  box.innerHTML = '';

  if (typeof link === 'string' && link.trim()) {
    const a = document.createElement('a');
    a.href = link;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = link;
    box.appendChild(a);
    box.classList.add('success');

    if (copyBtn) copyBtn.disabled = false;
    if (openBtn) openBtn.disabled = false;
    if (downloadBtn) downloadBtn.disabled = false;

    // Preview: best-effort. If it fails, user can still open/download.
    if (previewWrap) previewWrap.hidden = false;
    if (videoHint) videoHint.textContent = '正在加载预览...';
    if (video) {
      video.src = link;
      try {
        video.load();
      } catch {
        // ignore
      }
    }
  } else {
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = '响应中未找到 download_link。';
    box.appendChild(p);

    if (copyBtn) copyBtn.disabled = true;
    if (openBtn) openBtn.disabled = true;
    if (downloadBtn) downloadBtn.disabled = true;

    if (previewWrap) previewWrap.hidden = true;
    if (videoHint) videoHint.textContent = '';
    if (video) {
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignore
      }
    }
  }

  if (rawEl) rawEl.textContent = raw ? JSON.stringify(raw, null, 2) : '';
}

function loadSettings() {
  const timeoutMs = localStorage.getItem(STORAGE.timeoutMs);
  const proxyEndpoint = localStorage.getItem(STORAGE.proxyEndpoint) || '';

  const timeoutEl = $('timeoutMs');
  if (timeoutEl) {
    timeoutEl.value = timeoutMs
      ? String(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
      : String(DEFAULT_TIMEOUT_MS);
  }

  const proxyEl = $('proxyEndpoint');
  if (proxyEl) {
    proxyEl.value = proxyEndpoint || guessProxyEndpoint();
  }
}

function saveSettings() {
  const timeoutEl = $('timeoutMs');
  const proxyEl = $('proxyEndpoint');

  localStorage.setItem(
    STORAGE.timeoutMs,
    String(Number(timeoutEl ? timeoutEl.value : DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  );
  localStorage.setItem(STORAGE.proxyEndpoint, safeText(proxyEl ? proxyEl.value : '').trim());
}

async function clipboardPaste() {
  try {
    const txt = await navigator.clipboard.readText();
    if (txt) $('permalink').value = txt.trim();
    onPermalinkInput();
  } catch (e) {
    setStatus(`读取剪贴板失败：${String(e)}`, 'error');
  }
}

async function clipboardCopy(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('已复制。', 'ok');
  } catch (e) {
    setStatus(`复制失败：${String(e)}`, 'error');
  }
}

function onPermalinkInput() {
  const v = $('permalink').value;
  const n = normalizePermalink(v);
  const help = $('normalizedHelp');
  if (!help) return;
  if (!v.trim()) {
    help.textContent = '';
    return;
  }
  help.innerHTML = `规范化：<code>${escapeHtml(n)}</code>`;
}

function escapeHtml(s) {
  return safeText(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function resolveProxy({ permalink, timeoutMs, proxyEndpoint }) {
  const endpoint = safeText(proxyEndpoint).trim() || guessProxyEndpoint();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const payload = { permalink, timeout_ms: timeoutMs };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const hint = json && typeof json === 'object' ? JSON.stringify(json) : text;
      throw new Error(`代理请求失败：HTTP ${res.status} ${res.statusText}${hint ? `: ${hint}` : ''}`);
    }
    return json || {};
  } finally {
    clearTimeout(t);
  }
}

async function onResolve() {
  saveSettings();

  const permalink = normalizePermalink($('permalink').value);
  const timeoutMs = Number($('timeoutMs').value) || DEFAULT_TIMEOUT_MS;
  const proxyEndpoint = $('proxyEndpoint').value.trim();

  if (!permalink) {
    setStatus('请输入永久链接或 s_...。', 'error');
    return;
  }

  $('resolveBtn').classList.add('loading');
  $('resolveBtn').disabled = true;
  setStatus('解析中...');
  setSource('-');

  const started = performance.now();
  try {
    const json = await resolveProxy({ permalink, timeoutMs, proxyEndpoint });

    let dl = json && typeof json === 'object' ? json.download_link : null;
    const source = json && typeof json === 'object' ? json.source : null;

    if (typeof dl === 'string' && dl.trim()) {
      const normalized = normalizeDownloadLink(dl);
      if (normalized && normalized !== dl && json && typeof json === 'object') {
        json.download_link_raw = dl;
        json.download_link = normalized;
        dl = normalized;
      }
    }

    setSource(source);
    setResult(dl, json);

    const ms = Math.round(performance.now() - started);
    setStatus(`成功（${ms} ms）`, 'ok');
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    setResult(null, { error: msg });
    setStatus(msg, 'error');
  } finally {
    $('resolveBtn').classList.remove('loading');
    $('resolveBtn').disabled = false;
  }
}

function onClear() {
  $('permalink').value = '';
  const help = $('normalizedHelp');
  if (help) help.textContent = '';
  setResult(null, null);
  setSource('-');
  setStatus('已清空。');
}

function init() {
  loadSettings();
  onPermalinkInput();

  loadServerConfig().then((cfg) => {
    if (cfg) applyServerConfig(cfg);
  });

  $('permalink').addEventListener('input', onPermalinkInput);
  $('timeoutMs').addEventListener('change', saveSettings);
  $('proxyEndpoint').addEventListener('change', saveSettings);

  $('pasteBtn').addEventListener('click', clipboardPaste);

  $('resolveBtn').addEventListener('click', onResolve);
  $('clearBtn').addEventListener('click', onClear);

  $('copyBtn').addEventListener('click', async () => {
    const a = $('resultBox').querySelector('a');
    if (!a) return;
    await clipboardCopy(a.href);
  });

  $('openBtn').addEventListener('click', () => {
    const a = $('resultBox').querySelector('a');
    if (!a) return;
    window.open(a.href, '_blank', 'noopener,noreferrer');
  });

  $('downloadBtn').addEventListener('click', () => {
    const a = $('resultBox').querySelector('a');
    if (!a) return;
    const href = a.href;
    const dl = document.createElement('a');
    dl.href = href;
    dl.download = suggestFilenameFromUrl(href);
    dl.rel = 'noreferrer noopener';
    document.body.appendChild(dl);
    dl.click();
    dl.remove();
  });

  // Preview status
  const video = $('videoPreview');
  const hint = $('videoHint');
  video.addEventListener('loadedmetadata', () => {
    const dur = Number.isFinite(video.duration) ? Math.round(video.duration) : null;
    hint.textContent = dur ? `已就绪（${dur}s）` : '已就绪';
  });
  video.addEventListener('error', () => {
    hint.textContent = '预览失败，请尝试“打开/下载”（链接可能已过期或被拦截）。';
  });

  $('openReadme').addEventListener('click', (e) => {
    e.preventDefault();
    const url = location.protocol === 'file:' ? '../README.md' : `${location.origin}/README.md`;
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  // Ctrl/Cmd + Enter resolves.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') onResolve();
  });
}

init();
