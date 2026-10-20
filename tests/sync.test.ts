import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { validateOrder, verifySignature, dealProperties } from '../src/order.js';
import { Store } from '../src/store.js';
import { SyncService } from '../src/sync.js';
import { HubSpot } from '../src/hubspot.js';
import { HubSpotError } from '../src/hubspot.js';

export const order = {
  event: 'order.created', order_id: 'ORD-10482', created_at: '2026-09-20T14:32:00+08:00',
  customer: { email: 'maria.santos@example.com', first_name: 'Maria', last_name: 'Santos', phone: '+639171234567' },
  items: [{ sku: 'TSH-BLK-M', name: 'Black Tee (M)', qty: 2, price: 450 }], currency: 'PHP', total: 900,
};

test('validates payload and maps deal values', () => {
  assert.deepEqual(validateOrder(order), order);
  assert.throws(() => validateOrder({ ...order, total: -1 }));
  assert.throws(() => validateOrder({ ...order, customer: {} }));
  assert.throws(() => validateOrder({ ...order, items: [] }));
  const props = dealProperties(order, 'default', 'closedwon');
  assert.equal(props.amount, '900');
  assert.equal(props.dealname, 'Order ORD-10482');
  assert.equal(props.closedate, '2026-09-20T06:32:00.000Z');
});

test('HMAC checks exact raw bytes and rejects malformed signatures', () => {
  const body = Buffer.from(JSON.stringify(order));
  const signature = createHmac('sha256', 'secret').update(body).digest('hex');
  assert.equal(verifySignature(body, signature, 'secret'), true);
  assert.equal(verifySignature(Buffer.from('{}'), signature, 'secret'), false);
  assert.equal(verifySignature(body, 'bad', 'secret'), false);
});

test('duplicate delivery and association retry create only one deal', async () => {
  const store = new Store(':memory:');
  let creates = 0; let associations = 0;
  const crm = {
    upsertContact: async () => 'contact-1', findDeal: async () => undefined,
    createDeal: async () => { creates++; return 'deal-1'; },
    associate: async () => { if (++associations === 1) throw new Error('association failed'); },
  };
  const service = new SyncService(store, crm);
  assert.equal((await service.process(order)).status, 'failed');
  assert.equal((await service.process(order)).status, 'success');
  assert.equal((await service.process(order)).status, 'duplicate');
  assert.equal(creates, 1);
  assert.equal(store.latest().length, 3);
  store.close();
});

test('concurrent delivery is rejected while original is processing', async () => {
  const store = new Store(':memory:');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const service = new SyncService(store, {
    upsertContact: async () => { await gate; return 'c'; }, findDeal: async () => undefined,
    createDeal: async () => 'd', associate: async () => {},
  });
  const first = service.process(order);
  await assert.rejects(service.process(order), /already processing/);
  release(); await first; store.close();
});

test('ambiguous creation is never blindly repeated', async () => {
  const store = new Store(':memory:'); let creates = 0;
  const service = new SyncService(store, {
    upsertContact: async () => 'c', findDeal: async () => undefined,
    createDeal: async () => { creates++; throw new Error('timeout'); }, associate: async () => {},
  });
  assert.equal((await service.process(order)).status, 'failed');
  assert.equal((await service.process(order)).status, 'failed');
  assert.equal(creates, 1); store.close();
});

test('HubSpot retries 429 and 5xx, but not permanent errors', async () => {
  const waits: number[] = []; let calls = 0;
  const client = new HubSpot('test', 'default', 'closedwon', async () => {
    calls++;
    if (calls === 1) return new Response('{}', { status: 429, headers: { 'Retry-After': '2' } });
    if (calls === 2) return new Response('{}', { status: 503 });
    return Response.json({ results: [] });
  }, async ms => { waits.push(ms); });
  await client.findDeal(order.order_id);
  assert.equal(calls, 3); assert.deepEqual(waits, [2000, 2000]);
  const denied = new HubSpot('test', 'default', 'closedwon', async () => new Response('{}', { status: 401 }));
  await assert.rejects(denied.findDeal('x'), /401/);
});

test('HTTP 408 during deal creation remains uncertain and cannot create duplicates', async () => {
  const store = new Store(':memory:'); let creates = 0;
  const service = new SyncService(store, {
    upsertContact: async () => 'c', findDeal: async () => undefined,
    createDeal: async () => { creates++; throw new HubSpotError(408, 'Request timed out'); }, associate: async () => {},
  });
  try {
    await service.process(order);
    await service.process(order);
    assert.equal(creates, 1);
    assert.equal(store.get(order.order_id)!.uncertain, 1);
  } finally { store.close(); }
});

test('HubSpot creates or updates contacts and sends mapped deals and associations', async () => {
  const calls: { url: string; method: string; body: any }[] = [];
  let existing = false;
  const client = new HubSpot('test', 'default', 'closedwon', async (url, init) => {
    calls.push({ url: String(url), method: init!.method!, body: init!.body ? JSON.parse(String(init!.body)) : undefined });
    if (String(url).endsWith('/contacts/search')) return Response.json({ results: existing ? [{ id: 'c' }] : [] });
    return Response.json({ id: String(url).endsWith('/deals') ? 'd' : 'c' });
  });
  assert.equal(await client.upsertContact(order), 'c');
  assert.equal(calls[1].body.properties.firstname, 'Maria');
  assert.equal(calls[1].method, 'POST');
  existing = true;
  await client.upsertContact(order);
  assert.equal(calls[3].method, 'PATCH');
  assert.equal(await client.createDeal(order), 'd');
  assert.equal(calls[4].body.properties.dealstage, 'closedwon');
  await client.associate('d', 'c');
  assert.equal(calls[5].method, 'PUT');
  assert.match(calls[5].url, /deals\/d\/associations\/default\/contacts\/c$/);
});

test('uncertain deal is recovered from search without another create', async () => {
  const store = new Store(':memory:'); let found = false; let creates = 0;
  const service = new SyncService(store, {
    upsertContact: async () => 'c', findDeal: async () => found ? 'recovered-deal' : undefined,
    createDeal: async () => { creates++; throw new Error('Lost response'); }, associate: async () => {},
  });
  await service.process(order); found = true;
  const result = await service.process(order);
  assert.equal(result.status, 'success'); assert.equal(result.deal_id, 'recovered-deal');
  assert.equal(creates, 1); store.close();
});

test('history returns only the latest 50 and permanent create rejection allows retry', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 55; i++) store.begin(`order-${i}`);
  assert.equal(store.latest().length, 50);
  assert.equal(store.latest()[0].order_id, 'order-54');
  let creates = 0;
  const { HubSpotError } = await import('../src/hubspot.js');
  const service = new SyncService(store, {
    upsertContact: async () => 'c', findDeal: async () => undefined,
    createDeal: async () => { if (++creates === 1) throw new HubSpotError(400, 'Bad stage'); return 'd'; },
    associate: async () => {},
  });
  assert.equal((await service.process(order)).status, 'failed');
  assert.equal((await service.process(order)).status, 'success');
  assert.equal(creates, 2); store.close();
});
