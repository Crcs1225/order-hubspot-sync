import { Store } from './store.js';
import { HubSpot } from './hubspot.js';
import { SyncService } from './sync.js';
import { createApp } from './app.js';

const required = (key: string) => {
  const value = process.env[key];
  if (!value || value.startsWith('replace-with-')) throw new Error(`Set ${key} in .env first. See README.md.`);
  return value;
};
const token = required('HUBSPOT_ACCESS_TOKEN');
const secret = required('WEBHOOK_SECRET');
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const store = new Store(process.env.DATABASE_PATH ?? 'data/sync.sqlite');
const crm = new HubSpot(token, process.env.HUBSPOT_PIPELINE ?? 'default', process.env.HUBSPOT_DEAL_STAGE ?? 'closedwon');
const server = createApp(store, new SyncService(store, crm), secret);
server.listen(port, host, () => console.log(`Order sync dashboard: http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(() => { store.close(); process.exit(0); }); });
}
