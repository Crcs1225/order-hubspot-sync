import { createServer, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { validateOrder, verifySignature } from './order.js';
import { Store } from './store.js';
import { SyncService } from './sync.js';

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Payload exceeds 1 MB.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createApp(store: Store, sync: SyncService, secret: string) {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(url.pathname)) {
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(await readFile(new URL(`../public/${file}`, import.meta.url))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sync-attempts') { json(200, store.latest()); return; }
      if (req.method === 'POST' && url.pathname === '/webhooks/orders') {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Use application/json.');
        const body = await readBody(req);
        const signature = req.headers['x-webhook-signature'];
        if (typeof signature !== 'string' || !verifySignature(body, signature, secret)) throw new HttpError(401, 'Invalid webhook signature.');
        let order;
        try { order = validateOrder(JSON.parse(body.toString('utf8'))); }
        catch (error) { throw new HttpError(400, error instanceof SyntaxError ? 'Invalid JSON.' : (error as Error).message); }
        const attempt = await sync.process(order);
        json(attempt.status === 'failed' ? 502 : 200, attempt); return;
      }
      const retry = url.pathname.match(/^\/api\/sync-attempts\/(\d+)\/retry$/);
      if (req.method === 'POST' && retry) {
        const origin = req.headers.origin;
        if ((origin && origin !== `http://${req.headers.host}`) || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Use the local dashboard to retry.');
        const attempt = store.attempt(Number(retry[1]));
        if (!attempt) throw new HttpError(404, 'Attempt not found.');
        if (attempt.status !== 'failed') throw new HttpError(409, 'Only failed attempts can be retried.');
        const saved = store.get(attempt.order_id)!;
        const result = await sync.process(JSON.parse(saved.payload));
        json(result.status === 'failed' ? 502 : 200, result); return;
      }
      json(404, { error: 'Not found.' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected server error.';
      const status = error instanceof HttpError ? error.status : message.includes('already processing') ? 409 : 500;
      if (status === 500) console.error(message);
      if (!res.headersSent) json(status, { error: status === 500 ? 'Unexpected server error. Check server logs.' : message });
      else res.end();
    }
  });
}
