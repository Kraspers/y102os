const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const blockedHeaders = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-length',
  'content-encoding',
  'set-cookie',
]);

function proxyUrl(url) {
  return `/proxy?url=${encodeURIComponent(url)}`;
}

function decodeHtml(body, contentEncoding) {
  try {
    switch (String(contentEncoding || '').toLowerCase()) {
      case 'br': return zlib.brotliDecompressSync(body);
      case 'gzip': return zlib.gunzipSync(body);
      case 'deflate': return zlib.inflateSync(body);
      default: return body;
    }
  } catch {
    return body;
  }
}

function isAllowedTarget(target) {
  if (!['http:', 'https:'].includes(target.protocol)) return false;
  const host = target.hostname.toLowerCase();
  return host !== 'localhost' && host !== '::1' && host !== '127.0.0.1' && !host.endsWith('.localhost');
}

function injectNavigation(html, target) {
  const base = `<base href="${target.href}">`;
  const script = `<script>(function(){const p=${JSON.stringify('/proxy?url=')};const u=v=>p+encodeURIComponent(new URL(v,document.baseURI).href);const navigate=v=>{location.href=u(v)};document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a||a.hasAttribute('download')||e.defaultPrevented)return;e.preventDefault();navigate(a.href)},true);document.addEventListener('submit',e=>{const f=e.target;if(!f.action||e.defaultPrevented)return;e.preventDefault();f.target='_self';f.action=u(f.action);HTMLFormElement.prototype.submit.call(f)},true);window.open=(url)=>{if(url)navigate(url);return window};if(window.parent!==window){const send=(event,e)=>window.parent.postMessage({type:'yos-proxy-event',event,x:e.clientX,y:e.clientY},location.origin);const style=document.createElement('style');style.id='yos-hide-system-cursor';style.textContent='*{cursor:none !important}';(document.head||document.documentElement).appendChild(style);document.addEventListener('pointermove',e=>send('pointermove',e),true);document.addEventListener('pointerdown',e=>send('pointerdown',e),true);document.addEventListener('pointerleave',e=>send('pointerleave',e),true)}})();</script>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${base}${script}`);
  return `${base}${script}${html}`;
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(root, requested);
  if (!filePath.startsWith(`${root}${path.sep}`)) return res.writeHead(403).end();
  fs.readFile(filePath, (error, file) => {
    if (error) return res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
    const type = path.extname(filePath).toLowerCase();
    const contentType = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' }[type] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': contentType });
    res.end(file);
  });
}

function handleProxy(req, res, target, attempt = 0) {
  const client = target.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: target.host, 'accept-encoding': 'identity' };
  delete headers.origin;
  const upstream = client.request(target, { method: req.method, headers }, upstreamRes => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (!blockedHeaders.has(name.toLowerCase())) responseHeaders[name] = value;
    }
    if (upstreamRes.headers.location) responseHeaders.location = proxyUrl(new URL(upstreamRes.headers.location, target).href);
    const contentType = String(upstreamRes.headers['content-type'] || '');
    if (!contentType.includes('text/html')) {
      if (upstreamRes.headers['content-encoding']) responseHeaders['content-encoding'] = upstreamRes.headers['content-encoding'];
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      return upstreamRes.pipe(res);
    }
    const chunks = [];
    upstreamRes.on('data', chunk => chunks.push(chunk));
    upstreamRes.on('end', () => {
      const html = decodeHtml(Buffer.concat(chunks), upstreamRes.headers['content-encoding']).toString('utf8');
      responseHeaders['content-type'] = contentType || 'text/html; charset=utf-8';
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      res.end(injectNavigation(html, target));
    });
  });
  upstream.setTimeout(20_000, () => upstream.destroy(new Error('ETIMEDOUT')));
  upstream.on('error', error => {
    const transient = new Set(['ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT']);
    if (!res.headersSent && attempt === 0 && ['GET', 'HEAD'].includes(req.method) && transient.has(error.code)) {
      return handleProxy(req, res, target, attempt + 1);
    }
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Не удалось подключиться к сайту.');
  });
  if (attempt === 0) req.pipe(upstream); else upstream.end();
}

http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname !== '/proxy') return serveStatic(req, res, requestUrl.pathname);
  const value = requestUrl.searchParams.get('url');
  let target;
  try { target = new URL(value); } catch { return res.writeHead(400).end('Некорректная ссылка.'); }
  if (!isAllowedTarget(target)) return res.writeHead(400).end('Недопустимая ссылка.');
  handleProxy(req, res, target);
}).listen(port, () => console.log(`Y102OS is running on port ${port}`));
