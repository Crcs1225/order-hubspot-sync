// Deterministically generates the importable exports. Run: node n8n/build-workflows.mjs
import { writeFile } from 'node:fs/promises';

async function validateOrder() {
  const { createHmac, timingSafeEqual } = require('crypto');
  const secret = $env.WEBHOOK_SECRET;
  if (!secret || secret.startsWith('replace-with-')) throw new Error('Configure WEBHOOK_SECRET before activating this workflow.');
  const raw = await this.helpers.getBinaryDataBuffer(0, 'data');
  const reject = (statusCode, error) => [{ json: { valid: false, statusCode, error } }];
  if (raw.length > 1024 * 1024) return reject(413, 'Payload exceeds 1 MB.');
  const signature = $input.first().json.headers['x-webhook-signature'];
  if (typeof signature !== 'string' || !/^[a-fA-F0-9]{64}$/.test(signature)) return reject(401, 'Invalid signature.');
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return reject(401, 'Invalid signature.');
  let o;
  try { o = JSON.parse(raw.toString('utf8')); } catch { return reject(400, 'Invalid JSON.'); }
  const text = v => typeof v === 'string' && v.trim().length > 0;
  const money = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!o || o.event !== 'order.created' || !text(o.order_id) || o.order_id.length > 100 ||
      !text(o.created_at) || !Number.isFinite(Date.parse(o.created_at)) ||
      !o.customer || !text(o.customer.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.customer.email) ||
      !text(o.customer.first_name) || !text(o.customer.last_name) || !text(o.customer.phone) ||
      !Array.isArray(o.items) || !o.items.length ||
      !o.items.every(i => i && text(i.sku) && text(i.name) && Number.isInteger(i.qty) && i.qty > 0 && money(i.price)) ||
      !text(o.currency) || !/^[A-Z]{3}$/.test(o.currency) || !money(o.total)) return reject(400, 'Invalid order payload.');
  return [{ json: { valid: true, order: o } }];
}

const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: name.toLowerCase().replaceAll(' ', '-'), name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra,
});
const http = (name, position, method, url, jsonBody) => node(name, 'httpRequest', 4.2, position, {
  method, url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  ...(jsonBody ? { sendBody: true, specifyBody: 'json', jsonBody } : {}),
  options: { timeout: 15000 },
}, { retryOnFail: true, maxTries: 4, waitBetweenTries: 2000 });
const edge = name => ({ node: name, type: 'main', index: 0 });
const nodes = [
  node('Order webhook', 'webhook', 2, [0, 0], {
    httpMethod: 'POST', path: 'stage2-orders', responseMode: 'responseNode', options: { rawBody: true },
  }, { webhookId: 'stage2-orders' }),
  node('Validate order', 'code', 2, [220, 0], { jsCode: `return await (${validateOrder.toString()}).call(this);` }),
  node('Valid request', 'if', 2, [440, 0], {
    conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id: 'valid', leftValue: '={{ $json.valid }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {},
  }),
  node('Reject request', 'respondToWebhook', 1.4, [660, 220], {
    respondWith: 'json', responseBody: '={{ JSON.stringify({ error: $json.error }) }}', options: { responseCode: '={{ $json.statusCode }}' },
  }),
  http('Upsert contact', [660, -80], 'POST', 'https://api.hubapi.com/crm/v3/objects/0-1/batch/upsert',
    `={{ JSON.stringify({ inputs: [{ idProperty: 'email', id: $('Validate order').first().json.order.customer.email.toLowerCase(), properties: { email: $('Validate order').first().json.order.customer.email.toLowerCase(), firstname: $('Validate order').first().json.order.customer.first_name, lastname: $('Validate order').first().json.order.customer.last_name, phone: $('Validate order').first().json.order.customer.phone } }] }) }}`),
  node('Check contact', 'code', 2, [880, -80], {
    jsCode: "const r = $input.first().json; if (r.numErrors || r.errors?.length || !r.results?.[0]?.id) throw new Error('Contact upsert failed; inspect execution.'); return [{json: {contactId: r.results[0].id}}];",
  }),
  http('Upsert deal', [1100, -80], 'POST', 'https://api.hubapi.com/crm/v3/objects/0-3/batch/upsert',
    `={{ JSON.stringify({ inputs: [{ idProperty: 'store_order_id', id: $('Validate order').first().json.order.order_id, properties: { store_order_id: $('Validate order').first().json.order.order_id, dealname: 'Order ' + $('Validate order').first().json.order.order_id, amount: String($('Validate order').first().json.order.total), closedate: new Date($('Validate order').first().json.order.created_at).toISOString(), pipeline: $env.HUBSPOT_PIPELINE || 'default', dealstage: $env.HUBSPOT_DEAL_STAGE || 'closedwon' } }] }) }}`),
  node('Check deal', 'code', 2, [1320, -80], {
    jsCode: "const r = $input.first().json; if (r.numErrors || r.errors?.length || !r.results?.[0]?.id) throw new Error('Deal upsert failed; inspect execution.'); return [{json: {dealId: r.results[0].id}}];",
  }),
  http('Associate contact', [1540, -80], 'PUT',
    `={{ 'https://api.hubapi.com/crm/v4/objects/deals/' + encodeURIComponent($('Check deal').first().json.dealId) + '/associations/default/contacts/' + encodeURIComponent($('Check contact').first().json.contactId) }}`),
  node('Success response', 'respondToWebhook', 1.4, [1760, -80], {
    respondWith: 'json', responseBody: `={{ JSON.stringify({ status: 'success', order_id: $('Validate order').first().json.order.order_id, contact_id: $('Check contact').first().json.contactId, deal_id: $('Check deal').first().json.dealId }) }}`, options: { responseCode: 200 },
  }),
];
const chain = ['Order webhook', 'Validate order', 'Valid request', 'Upsert contact', 'Check contact', 'Upsert deal', 'Check deal', 'Associate contact', 'Success response'];
const connections = {};
for (let i = 0; i < chain.length - 1; i++) connections[chain[i]] = { main: [[edge(chain[i + 1])]] };
connections['Valid request'].main.push([edge('Reject request')]);
const workflow = { name: 'Stage 2 - Signed orders to HubSpot', active: false, nodes, connections,
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' } };
const errors = { name: 'Stage 2 - Failure notification', active: false, nodes: [
  node('Workflow failure', 'errorTrigger', 1, [0, 0], {}),
  node('Notify failure', 'httpRequest', 4.2, [240, 0], {
    method: 'POST', url: '={{ $env.N8N_FAILURE_WEBHOOK_URL }}', sendBody: true, specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({ event: 'order_sync.failed', workflow: $json.workflow.name, execution_id: $json.execution.id || null, execution_url: $json.execution.url || null, failed_node: $json.execution.lastNodeExecuted || null }) }}`,
    options: { timeout: 10000 },
  }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),
], connections: { 'Workflow failure': { main: [[edge('Notify failure')]] } }, settings: { executionOrder: 'v1' } };
await writeFile(new URL('order-sync.json', import.meta.url), JSON.stringify(workflow, null, 2) + '\n');
await writeFile(new URL('error-notification.json', import.meta.url), JSON.stringify(errors, null, 2) + '\n');
console.log('Generated n8n/order-sync.json and n8n/error-notification.json');
