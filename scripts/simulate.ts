// Runs the real HTTP app and HubSpot client with a synthetic API transport.
// No .env, HubSpot credentials, or external network calls are used.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { HubSpot } from '../src/hubspot.js';
import { Store } from '../src/store.js';
import { SyncService } from '../src/sync.js';
import type { Order } from '../src/order.js';

const path = resolve('data/simulation.sqlite');
const store = new Store(path);
const secret = 'synthetic-orders-only';
const run = `SIM-${Date.now()}-${randomUUID().slice(0, 6)}`;
const contacts = new Map<string, { id: string; properties: Record<string, string> }>();
const deals = new Map<string, { id: string; properties: Record<string, string> }>();
const associations = new Map<string, string>();
const delays: number[] = [];
let contactUpdates = 0;
let transientSearchFailures = 0;
let failAssociation = false;
let ambiguousCreate = false;

const fakeFetch: typeof fetch = async (input, options) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://api.hubapi.com');
  const body = options?.body ? JSON.parse(String(options.body)) : undefined;
  if (url.pathname === '/crm/v3/objects/contacts/search') {
    if (transientSearchFailures > 0) {
      const status = transientSearchFailures-- === 2 ? 429 : 503;
      return new Response('{}', { status, headers: status === 429 ? { 'Retry-After': '2' } : {} });
    }
    const contact = contacts.get(body.filterGroups[0].filters[0].value);
    return Response.json({ results: contact ? [contact] : [] });
  }
  if (url.pathname === '/crm/v3/objects/contacts' && options?.method === 'POST') {
    const contact = { id: `sim-contact-${run}-${contacts.size + 1}`, properties: body.properties };
    contacts.set(body.properties.email, contact);
    return Response.json(contact, { status: 201 });
  }
  if (url.pathname.startsWith('/crm/v3/objects/contacts/') && options?.method === 'PATCH') {
    contactUpdates++;
    const contact = [...contacts.values()].find(c => c.id === decodeURIComponent(url.pathname.split('/').at(-1)!));
    assert.ok(contact);
    contact.properties = body.properties;
    return Response.json(contact);
  }
  if (url.pathname === '/crm/v3/objects/deals/search') {
    const deal = deals.get(body.filterGroups[0].filters[0].value);
    return Response.json({ results: deal ? [deal] : [] });
  }
  if (url.pathname === '/crm/v3/objects/deals' && options?.method === 'POST') {
    const deal = { id: `sim-deal-${run}-${deals.size + 1}`, properties: body.properties };
    deals.set(body.properties.dealname, deal);
    if (ambiguousCreate) { ambiguousCreate = false; return new Response('{}', { status: 503 }); }
    return Response.json(deal, { status: 201 });
  }
  const association = url.pathname.match(/^\/crm\/v4\/objects\/deals\/([^/]+)\/associations\/default\/contacts\/([^/]+)$/);
  if (association && options?.method === 'PUT') {
    if (failAssociation) { failAssociation = false; return new Response('{}', { status: 400 }); }
    associations.set(decodeURIComponent(association[1]), decodeURIComponent(association[2]));
    return Response.json({ results: [] });
  }
  throw new Error(`Unexpected simulated API call: ${options?.method} ${url.pathname}`);
};

const crm = new HubSpot('synthetic-token-never-sent', 'default', 'closedwon', fakeFetch,
  async ms => { delays.push(ms); }); // Verify scheduled backoff without waiting in the demo.
const server = createApp(store, new SyncService(store, crm), secret);
const once = process.argv.includes('--once');
const port = once ? 0 : Number(process.env.SIMULATION_PORT ?? 3000);
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const template: Order = JSON.parse(await readFile(new URL('./sample-order.json', import.meta.url), 'utf8'));
  const order = (name: string): Order => ({ ...template, order_id: `${run}-${name}`, created_at: new Date().toISOString(),
    customer: { email: 'synthetic.customer@example.com', first_name: 'Synthetic', last_name: 'Customer', phone: '+639170000000' } });
  const results: { scenario: string; http: number; status: string }[] = [];
  async function send(scenario: string, payload: unknown, expectedHttp: number, expectedStatus: string, badSignature = false) {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    const response = await fetch(`${base}/webhooks/orders`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': badSignature ? 'bad' : signature }, body });
    const data = await response.json();
    assert.equal(response.status, expectedHttp, scenario);
    if (expectedHttp !== 400 && expectedHttp !== 401) assert.equal(data.status, expectedStatus, scenario);
    results.push({ scenario, http: response.status, status: data.status ?? 'rejected' });
    return data;
  }
  async function retry(scenario: string, id: number) {
    const response = await fetch(`${base}/api/sync-attempts/${id}/retry`, { method: 'POST' });
    const data = await response.json();
    assert.equal(response.status, 200, scenario); assert.equal(data.status, 'success', scenario);
    results.push({ scenario, http: response.status, status: data.status });
    return data;
  }
  assert.equal((await fetch(base)).status, 200);
  const successful = order('SUCCESS');
  const first = await send('New contact and deal', successful, 200, 'success');
  const duplicate = await send('Duplicate delivery', successful, 200, 'duplicate');
  assert.equal(first.deal_id, duplicate.deal_id);
  assert.equal(deals.size, 1);
  failAssociation = true;
  const failed = await send('Association failure', order('RETRY'), 502, 'failed');
  const retried = await retry('Manual retry reuses saved deal', failed.id);
  assert.equal(failed.deal_id, retried.deal_id);
  assert.equal(deals.size, 2);
  transientSearchFailures = 2;
  await send('429 and 503 recover with backoff', order('BACKOFF'), 200, 'success');
  assert.deepEqual(delays, [2000, 2000]);
  ambiguousCreate = true;
  const uncertain = await send('Deal created but API returns 503', order('RECOVERY'), 502, 'failed');
  const beforeRecovery = deals.size;
  await retry('Find uncertain deal without duplicate', uncertain.id);
  assert.equal(deals.size, beforeRecovery);
  failAssociation = true;
  await send('Failed attempt available for dashboard retry', order('FAILURE'), 502, 'failed');
  await send('Invalid signature', order('UNSIGNED'), 401, 'rejected', true);
  await send('Invalid payload', { event: 'order.created' }, 400, 'rejected');
  assert.equal(contacts.size, 1);
  assert.ok(contactUpdates > 0);
  assert.equal(deals.size, 5);
  assert.equal(associations.size, 4);
  const dashboard = await (await fetch(`${base}/api/sync-attempts`)).json();
  assert.ok(dashboard.some((a: { id: number }) => a.id === first.id));

  const db = new DatabaseSync(path, { readOnly: true });
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const counts = db.prepare('SELECT status, COUNT(*) AS count FROM attempts WHERE order_id LIKE ? GROUP BY status').all(`${run}-%`);
  const orderCount = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE order_id LIKE ?').get(`${run}-%`)!;
  assert.equal(orderCount.count, 5);
  const attempts = db.prepare('SELECT COUNT(*) AS count FROM attempts WHERE order_id LIKE ?').get(`${run}-%`)!;
  assert.equal(attempts.count, 8);
  db.close();
  const report = { run, database: path, scenarios: results, counts, orders: orderCount.count,
    attempts: attempts.count, simulatedContacts: contacts.size, simulatedDeals: deals.size,
    associations: associations.size, scheduledBackoffMs: delays, tables, deals: [...deals.values()] };
  await writeFile('data/simulation-report.json', JSON.stringify(report, null, 2));
  console.table(results);
  console.log(`Verified: 5 stored orders, 8 attempts, 5 simulated deals, 4 associations.\nSQLite: ${path}\nReport: data/simulation-report.json`);
  if (!once) console.log(`Simulation dashboard: ${base}\nOne failed order is ready for the Retry button. Press Ctrl+C to stop.\nNo real HubSpot requests are made. Mock CRM data resets on restart; SQLite history remains.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (once || process.exitCode) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
}
if (!once && !process.exitCode) {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
  }
}
