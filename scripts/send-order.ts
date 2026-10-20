import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

const secret = process.env.WEBHOOK_SECRET;
if (!secret || secret.startsWith('replace-with-')) throw new Error('Set WEBHOOK_SECRET in .env.');
const order = JSON.parse(await readFile(new URL('./sample-order.json', import.meta.url), 'utf8'));
if (process.argv[2]) order.order_id = process.argv[2];
const body = JSON.stringify(order);
const signature = createHmac('sha256', secret).update(body).digest('hex');
const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/webhooks/orders`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': signature },
  body, signal: AbortSignal.timeout(180000),
});
console.log(`HTTP ${response.status}\n${await response.text()}`);
if (!response.ok) process.exitCode = 1;
