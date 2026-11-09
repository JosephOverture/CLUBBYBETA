import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};
export function websiteServer(root, apiOrigin, association = null) {
  const origin = new URL(apiOrigin);
  if (origin.origin !== apiOrigin || origin.protocol !== 'https:')
    throw new Error('Set a public HTTPS API origin.');
  const directory = resolve(root);
  return createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('strict-transport-security', 'max-age=31536000');
    response.setHeader(
      'permissions-policy',
      'camera=(self), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com")',
    );
    response.setHeader(
      'content-security-policy',
      [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "script-src 'self' https://js.stripe.com https://appleid.cdn-apple.com",
        "style-src 'self' 'unsafe-inline'",
        `connect-src 'self' ${apiOrigin} https://api.stripe.com https://*.stripe.com https://appleid.apple.com`,
        `img-src 'self' data: blob: ${apiOrigin} https://*.stripe.com`,
        "font-src 'self' data:",
        'frame-src https://js.stripe.com https://hooks.stripe.com https://appleid.apple.com',
        "form-action 'self' https://appleid.apple.com",
        'upgrade-insecure-requests',
      ].join('; '),
    );
    response.setHeader('cache-control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method ?? '')) {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'https://website.invalid').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname === '/health/ready' || pathname === '/health/live') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(request.method === 'HEAD' ? undefined : '{"status":"ready"}');
      return;
    }
    if (pathname === '/.well-known/apple-app-site-association') {
      response
        .writeHead(association ? 200 : 404, { 'content-type': 'application/json' })
        .end(request.method === 'HEAD' ? undefined : JSON.stringify(association ?? {}));
      return;
    }
    if (
      pathname.includes('\\') ||
      pathname.includes('\0') ||
      pathname.split('/').some((p) => p.startsWith('.'))
    ) {
      response.writeHead(404).end();
      return;
    }
    let path = resolve(directory, '.' + pathname);
    if (!path.startsWith(directory + sep) && path !== directory) {
      response.writeHead(404).end();
      return;
    }
    try {
      const file = await stat(path).catch(() => null);
      if (!file?.isFile()) {
        // Only known navigation paths get the SPA; missing assets never receive HTML.
        if (
          !/^\/(?:|bookings\/[a-f0-9-]{36}|tickets\/[a-f0-9-]{36}|groups\/[a-f0-9-]{36}|support\/[a-f0-9-]{36})\/?$/i.test(
            pathname,
          )
        ) {
          response.writeHead(404).end();
          return;
        }
        path = resolve(directory, 'index.html');
      }
      if (extname(path) === '.map') {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(path);
      const immutable = pathname.startsWith('/_expo/') && /-[a-f0-9]{16,}\./i.test(pathname);
      response.writeHead(200, {
        'content-type': types[extname(path)] ?? 'application/octet-stream',
        'content-length': body.length,
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(503).end();
    }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve('apps/mobile/dist/web');
  await stat(resolve(root, 'index.html'));
  const association = await readFile(resolve(root, '.well-known/apple-app-site-association'), 'utf8')
    .then(JSON.parse)
    .catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
  const server = websiteServer(root, process.env.PUBLIC_API_URL, association);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '0.0.0.0');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close());
}
