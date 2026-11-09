import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png',
  '.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon','.txt':'text/plain; charset=utf-8'};
const hopHeaders = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization',
  'te','trailer','transfer-encoding','upgrade']);

// Browser requests and visitor cookies stay on one origin. The upstream is an
// operator-configured API, never a URL supplied by a browser request.
export function betaServer({root = resolve('web'), apiTarget = 'http://127.0.0.1:4100'} = {}) {
  const target = new URL(apiTarget);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) throw new Error('API_TARGET must be a plain HTTP(S) origin.');
  const directory = resolve(root);
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options','nosniff');
    response.setHeader('referrer-policy','strict-origin-when-cross-origin');
    response.setHeader('permissions-policy','camera=(), microphone=(), geolocation=(self), payment=()');
    response.setHeader('cache-control','no-store');
    response.setHeader('content-security-policy',[
      "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
      "script-src 'self' https://maps.googleapis.com https://maps.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.googleapis.com https://*.gstatic.com https://*.google.com",
      "connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com",
      "font-src 'self' https://fonts.gstatic.com", "form-action 'self'", "frame-src 'none'",
    ].join('; '));
    let pathname, parsed;
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error('Origin-form URL required.');
      parsed = new URL(request.url,'http://website.invalid');
      pathname = decodeURIComponent(parsed.pathname);
    }
    catch { response.writeHead(400).end(); return; }
    if (pathname.startsWith('/v1/') || ['/health/ready','/health/live'].includes(pathname)) {
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !hopHeaders.has(key)));
      headers.host = target.host;
      // Incoming forwarding headers are not trusted by this proxy.
      for (const key of Object.keys(headers)) if (key.startsWith('x-forwarded-') || key === 'forwarded') delete headers[key];
      const proxy = (target.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(parsed.pathname+parsed.search,target),
        {method:request.method,headers}, upstream => {
          const safe = Object.fromEntries(Object.entries(upstream.headers).filter(([key]) => !hopHeaders.has(key) && key !== 'content-security-policy'));
          response.writeHead(upstream.statusCode ?? 502,safe);
          upstream.pipe(response);
          upstream.on('error',() => response.destroy());
        });
      proxy.setTimeout(15000,() => proxy.destroy());
      proxy.on('error',() => {
        if (response.headersSent) { response.destroy(); return; }
        response.writeHead(502,{'content-type':'application/json'}).end(JSON.stringify({error:{code:'API_UNAVAILABLE',message:'Clubby is reconnecting. Please try again shortly.'}}));
      });
      request.on('aborted',() => proxy.destroy());
      response.on('close',() => { if (!response.writableFinished) proxy.destroy(); });
      request.pipe(proxy);
      return;
    }
    if (!['GET','HEAD'].includes(request.method ?? '')) { response.writeHead(405,{allow:'GET, HEAD'}).end(); return; }
    if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(p => p.startsWith('.'))) {
      response.writeHead(404).end(); return;
    }
    const file = resolve(directory,pathname === '/' ? 'index.html' : '.' + pathname);
    if (!file.startsWith(directory+sep) || !types[extname(file)]) { response.writeHead(404).end(); return; }
    try {
      const actual = await realpath(file);
      if (!actual.startsWith(directory+sep) || !(await stat(actual)).isFile()) { response.writeHead(404).end(); return; }
      const body = await readFile(actual);
      response.writeHead(200,{'content-type':types[extname(file)],'content-length':body.length});
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) { response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 503).end(); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = betaServer({root:process.env.WEB_ROOT ?? resolve('web'),apiTarget:process.env.API_TARGET});
  const port = Number(process.env.WEB_PORT ?? process.env.PORT ?? 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid website port.');
  server.listen(port,process.env.WEB_HOST ?? '127.0.0.1',() => console.log(`Clubby website: http://localhost:${port}`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,() => server.close());
}
