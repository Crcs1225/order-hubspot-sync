import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { SyncService } from '../src/sync.js';

test('HTTP webhook, dashboard, duplicate and retry flow', async () => {
  const store = new Store(':memory:'); let fail = true;
  const service = new SyncService(store, {
    upsertContact: async () => 'c', findDeal: async () => undefined,
    createDeal: async () => 'd', associate: async () => { if (fail) throw new Error('Temporary failure'); },
  });
  const server = createApp(store, service, 'secret');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const order = {
    event: 'order.created', order_id: 'HTTP-1', created_at: '2026-09-20T14:32:00+08:00',
    customer: { email: 'test@example.com', first_name: 'Test', last_name: 'User', phone: '+639171234567' },
    items: [{ sku: 'A', name: 'Shirt', qty: 1, price: 100 }], currency: 'PHP', total: 100,
  };
  const body = JSON.stringify(order);
  const signature = createHmac('sha256', 'secret').update(body).digest('hex');
  const send = (sig: string) => fetch(`${base}/webhooks/orders`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig }, body,
  });
  try {
    assert.equal((await fetch(base)).status, 200);
    const oversized = await fetch(`${base}/webhooks/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await send('bad')).status, 401);
    assert.equal((await send(signature)).status, 502);
    const attempts = await (await fetch(`${base}/api/sync-attempts`)).json();
    assert.equal(attempts[0].status, 'failed');
    fail = false;
    const retryUrl = `${base}/api/sync-attempts/${attempts[0].id}/retry`;
    assert.equal((await fetch(retryUrl, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(retryUrl, { method: 'POST' })).status, 200);
    assert.equal((await (await send(signature)).json()).status, 'duplicate');
    assert.equal((await fetch(`${base}/api/sync-attempts/999/retry`, { method: 'POST' })).status, 404);
    const invalid = '{}';
    assert.equal((await fetch(`${base}/webhooks/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': createHmac('sha256', 'secret').update(invalid).digest('hex') }, body: invalid,
    })).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});
