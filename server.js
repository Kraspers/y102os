const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const browserUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const blockedHeaders = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'content-length',
  'content-encoding',
  'set-cookie',
]);

function proxyUrl(url, proxyOrigin = '') {
  return `${proxyOrigin}/proxy?url=${encodeURIComponent(url)}`;
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

function getProxiedRoute(req, requestUrl) {
  try {
    const referer = new URL(req.headers.referer);
    if (referer.pathname !== '/proxy') return null;
    const target = new URL(referer.searchParams.get('url'));
    return new URL(`${requestUrl.pathname}${requestUrl.search}`, target);
  } catch {
    return null;
  }
}

function proxyCookies(cookies) {
  return cookies.map(cookie => cookie
    .replace(/;\s*domain=[^;]*/ig, '')
    .replace(/;\s*path=[^;]*/ig, '; Path=/proxy'));
}

function proxyTargetUrl(value, target, proxyOrigin) {
  if (!value || value.startsWith('#') || /^(?:data|blob|javascript|mailto|tel):/i.test(value)) return value;
  try {
    const url = new URL(value, target);
    return isAllowedTarget(url) ? proxyUrl(url.href, proxyOrigin) : value;
  } catch {
    return value;
  }
}

function rewriteHtmlUrls(html, target, proxyOrigin) {
  return html.replace(/\b(src|href|action|poster)\s*=\s*(["'])(.*?)\2/gi, (match, name, quote, value) => {
    return `${name}=${quote}${proxyTargetUrl(value, target, proxyOrigin)}${quote}`;
  }).replace(/\bsrcset\s*=\s*(["'])(.*?)\1/gi, (match, quote, value) => {
    const srcset = value.split(',').map(candidate => {
      const parts = candidate.trim().split(/\s+/, 2);
      return [proxyTargetUrl(parts[0], target, proxyOrigin), parts[1]].filter(Boolean).join(' ');
    }).join(', ');
    return `srcset=${quote}${srcset}${quote}`;
  }).replace(/(<meta\s+[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*content\s*=\s*["']?\s*\d+\s*;\s*url\s*=\s*)([^"' >]+)/gi,
    (match, prefix, value) => `${prefix}${proxyTargetUrl(value, target, proxyOrigin)}`);
}

function injectNavigation(html, target) {
  const base = `<base href="${target.href}">`;
  const script = `<script>(function(){
    const p=location.origin+'/proxy?url=';
    const proxy=v=>{try{const url=new URL(v,document.baseURI);return /^https?:$/.test(url.protocol)?p+encodeURIComponent(url.href):v}catch{return v}};
    const notify=loading=>{if(window.parent!==window)window.parent.postMessage({type:'yos-proxy-loading',loading},location.origin)};
    const navigate=v=>{notify(true);location.href=proxy(v)};
    const nativeSubmit=HTMLFormElement.prototype.submit;
    document.addEventListener('click',e=>{const a=e.target.closest('a[href]');if(!a||a.hasAttribute('download')||e.defaultPrevented)return;e.preventDefault();navigate(a.href)},true);
    document.addEventListener('submit',e=>{const f=e.target;if(!f.action||e.defaultPrevented)return;e.preventDefault();f.target='_self';f.action=proxy(f.action);notify(true);nativeSubmit.call(f)},true);
    HTMLFormElement.prototype.submit=function(){this.target='_self';this.action=proxy(this.action);notify(true);return nativeSubmit.call(this)};
    window.open=(url)=>{if(url)navigate(url);return window};
    for(const method of ['assign','replace']){const original=Location.prototype[method];if(original)Location.prototype[method]=function(url){notify(true);return original.call(this,proxy(url))}};
    const fetch=window.fetch;window.fetch=(input,init)=>{if(typeof input==='string'||input instanceof URL)return fetch(proxy(input),init);if(input instanceof Request)return fetch(new Request(proxy(input.url),input),init);return fetch(input,init)};
    const open=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){return open.call(this,method,proxy(url),...args)};
    if(window.parent!==window){const send=(event,e)=>window.parent.postMessage({type:'yos-proxy-event',event,x:e.clientX,y:e.clientY},location.origin);const style=document.createElement('style');style.id='yos-hide-system-cursor';style.textContent='*{cursor:none!important}';(document.head||document.documentElement).appendChild(style);document.addEventListener('pointermove',e=>send('pointermove',e),true);document.addEventListener('pointerdown',e=>send('pointerdown',e),true);document.addEventListener('pointerleave',e=>send('pointerleave',e),true);notify(true);window.addEventListener('load',()=>notify(false),{once:true})}
  })();</script>`;
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

function proxyErrorPage(target, message) {
  const safeTarget = target.href.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const safeMessage = message.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff;font:16px Arial,sans-serif;color:#000}.box{max-width:520px;padding:24px;text-align:center}.url{margin-top:12px;overflow-wrap:anywhere;color:#555}</style><script>window.parent&&window.parent.postMessage({type:'yos-proxy-loading',loading:false},location.origin)</script></head><body><div class="box"><strong>${safeMessage}</strong><div class="url">${safeTarget}</div></div></body></html>`;
}

function handleProxy(req, res, target, attempt = 0) {
  const client = target.protocol === 'https:' ? https : http;
  const headers = {
    ...req.headers,
    host: target.host,
    'accept-encoding': 'identity',
    'user-agent': req.headers['user-agent'] || browserUserAgent,
    accept: req.headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': req.headers['accept-language'] || 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  delete headers.origin;
  const upstream = client.request(target, { method: req.method, headers }, upstreamRes => {
    const responseHeaders = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (!blockedHeaders.has(name.toLowerCase())) responseHeaders[name] = value;
    }
    if (upstreamRes.headers.location) responseHeaders.location = proxyUrl(new URL(upstreamRes.headers.location, target).href);
    if (upstreamRes.headers['set-cookie']) responseHeaders['set-cookie'] = proxyCookies(upstreamRes.headers['set-cookie']);
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
      const forwardedProtocol = String(req.headers['x-forwarded-proto'] || '').split(',')[0];
      const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
      const proxyOrigin = `${protocol}://${req.headers.host}`;
      res.end(injectNavigation(rewriteHtmlUrls(html, target, proxyOrigin), target));
    });
  });
  upstream.setTimeout(20_000, () => upstream.destroy(new Error('ETIMEDOUT')));
  upstream.on('error', error => {
    const transient = new Set(['ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT']);
    if (!res.headersSent && attempt === 0 && ['GET', 'HEAD'].includes(req.method) && transient.has(error.code)) {
      return handleProxy(req, res, target, attempt + 1);
    }
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
    res.end(proxyErrorPage(target, 'Не удалось подключиться к сайту. Возможно, сайт не опубликован, временно недоступен или блокирует загрузку через прокси.'));
  });
  if (attempt === 0) req.pipe(upstream); else upstream.end();
}

http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname !== '/proxy') {
    const target = getProxiedRoute(req, requestUrl);
    if (target && isAllowedTarget(target)) return res.writeHead(302, { location: proxyUrl(target.href) }).end();
    return serveStatic(req, res, requestUrl.pathname);
  }
  const value = requestUrl.searchParams.get('url');
  let target;
  try { target = new URL(value); } catch { return res.writeHead(400).end('Некорректная ссылка.'); }
  if (!isAllowedTarget(target)) return res.writeHead(400).end('Недопустимая ссылка.');
  handleProxy(req, res, target);
}).listen(port, () => console.log(`Y102OS is running on port ${port}`));
