import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

const load = async (file: string) => JSON.parse(await readFile(new URL(`../n8n/${file}`, import.meta.url), 'utf8'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('n8n validates raw-body HMAC and rejects invalid signatures and payloads', async () => {
  const workflow = await load('order-sync.json');
  const code = workflow.nodes.find((n: { name: string }) => n.name === 'Validate order').parameters.jsCode;
  const evaluate = new AsyncFunction('$input', '$env', 'require', code);
  const payload = {
    event: 'order.created', order_id: 'BONUS-1', created_at: '2026-09-20T14:32:00+08:00',
    customer: { email: 'demo@example.com', first_name: 'Demo', last_name: 'User', phone: '+639170000000' },
    items: [{ sku: 'A', name: 'Shirt', qty: 1, price: 900 }], currency: 'PHP', total: 900,
  };
  const run = async (body: string, signature?: string) => {
    const raw = Buffer.from(body);
    const sig = signature ?? createHmac('sha256', 'test-secret').update(raw).digest('hex');
    return evaluate.call({ helpers: { getBinaryDataBuffer: async () => raw } },
      { first: () => ({ json: { headers: { 'x-webhook-signature': sig } } }) },
      { WEBHOOK_SECRET: 'test-secret' }, createRequire(import.meta.url));
  };
  assert.equal((await run(JSON.stringify(payload)))[0].json.valid, true);
  assert.equal((await run(JSON.stringify(payload), 'bad'))[0].json.statusCode, 401);
  assert.equal((await run('{'))[0].json.statusCode, 400);
  assert.equal((await run(JSON.stringify({ ...payload, total: -1 })))[0].json.statusCode, 400);
});

test('n8n exports use retryable unique upserts, association, and an error notifier', async () => {
  const workflow = await load('order-sync.json');
  const nodes = new Map<string, any>(workflow.nodes.map((n: any) => [n.name, n]));
  for (const name of ['Upsert contact', 'Upsert deal', 'Associate contact']) {
    assert.equal(nodes.get(name).retryOnFail, true);
    assert.equal(nodes.get(name).maxTries, 4);
  }
  assert.match(nodes.get('Upsert contact').parameters.jsonBody, /idProperty.*email/);
  assert.match(nodes.get('Upsert deal').parameters.jsonBody, /store_order_id/);
  assert.equal(nodes.get('Order webhook').parameters.options.rawBody, true);
  const names = new Set(workflow.nodes.map((n: any) => n.name));
  for (const outputs of Object.values(workflow.connections) as any[]) {
    for (const branch of outputs.main) for (const edge of branch) assert.ok(names.has(edge.node));
  }
  const errors = await load('error-notification.json');
  assert.ok(errors.nodes.some((n: any) => n.type === 'n8n-nodes-base.errorTrigger'));
  assert.ok(errors.nodes.some((n: any) => n.name === 'Notify failure'));
  assert.equal(workflow.active, false);
  assert.equal(errors.active, false);
});

test('n8n expressions map the order and use stable unique keys for duplicates', async () => {
  const workflow = await load('order-sync.json');
  const payload = {
    order_id: 'BONUS-1', created_at: '2026-09-20T14:32:00+08:00', total: 900,
    customer: { email: 'DEMO@example.com', first_name: 'Demo', last_name: 'User', phone: '+639170000000' },
  };
  const previous: Record<string, unknown> = {
    'Validate order': { order: payload }, 'Check contact': { contactId: '123' }, 'Check deal': { dealId: '456' },
  };
  const reference = (name: string) => ({ first: () => ({ json: previous[name] }) });
  const expression = (source: string) => new Function('$', '$env', `return (${source.slice(3, -2)});`)(reference, {});
  const nodes = new Map<string, any>(workflow.nodes.map((n: any) => [n.name, n]));
  const contact = JSON.parse(expression(nodes.get('Upsert contact').parameters.jsonBody)).inputs[0];
  assert.equal(contact.id, 'demo@example.com'); assert.equal(contact.idProperty, 'email');
  const source = nodes.get('Upsert deal').parameters.jsonBody;
  const first = JSON.parse(expression(source)).inputs[0];
  const duplicate = JSON.parse(expression(source)).inputs[0];
  assert.equal(first.id, duplicate.id); assert.equal(first.id, payload.order_id);
  assert.equal(first.idProperty, 'store_order_id');
  assert.equal(first.properties.store_order_id, payload.order_id);
  assert.equal(first.properties.amount, '900');
  assert.equal(first.properties.closedate, '2026-09-20T06:32:00.000Z');
  assert.equal(first.properties.pipeline, 'default');
  assert.match(expression(nodes.get('Associate contact').parameters.url), /deals\/456\/associations\/default\/contacts\/123$/);
  for (const name of ['Check contact', 'Check deal']) {
    const evaluate = new Function('$input', nodes.get(name).parameters.jsCode);
    assert.throws(() => evaluate({ first: () => ({ json: { numErrors: 1, results: [] } }) }));
  }
});
