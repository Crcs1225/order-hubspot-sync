# Store → HubSpot order sync

A small Stage 2 assessment project: a TypeScript webhook receiver, SQLite sync history, a plain HTML dashboard, and a Python CSV exporter. No frontend framework, ORM, or Python packages are needed.

## Try it without credentials

With Node.js 24+ and Python 3.10+ installed:

```powershell
cmd /c npm ci
cmd /c npm run simulate
```

Open **http://127.0.0.1:3000**. The demo sends signed synthetic orders through the real app with a simulated HubSpot API. It creates its own SQLite database and leaves a failed order available to retry. No account or `.env` is needed. Stop it before starting the real integration on the same port.

Project documentation:

- [Stage 2 requirements](STAGE-2-REQUIREMENTS.md)
- [Implementation answers and limitations](STAGE-2-IMPLEMENTATION.md)
- [Simulation, CSV export and database tables](SIMULATION.md)

For the real HubSpot integration, follow the setup below. Live account verification remains outstanding; automated tests and simulations use synthetic API responses.

## Setup (Windows PowerShell)

Install **Node.js 24+** and **Python 3.10+**, then open this folder:

```powershell
cmd /c npm install
Copy-Item .env.example .env
```

Edit `.env` and replace the token and webhook secret. Generate a secret if needed:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use a **HubSpot developer test account**, with a private app access token granting:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.objects.deals.read`
- `crm.objects.deals.write`

Set `HUBSPOT_PIPELINE` and `HUBSPOT_DEAL_STAGE` to your account's **internal IDs**. The example uses `default` and `closedwon`; verify these in your account's deal pipeline settings. Use PHP as the account currency for the supplied sample. Never use real customer data or commit `.env`.

```powershell
cmd /c npm start
```

Open **http://127.0.0.1:3000**. In a second terminal:

```powershell
cmd /c npm run send-order
```

The sample creates or updates Maria's contact, creates `Order ORD-10482`, and links them. Send it again: the dashboard records `duplicate` without another deal. To send a different order ID:

```powershell
cmd /c npm run send-order -- ORD-10483
```

`npm start` and the sender load `.env` automatically. Use `cmd /c` in PowerShell if execution policy blocks `npm.ps1`. Node may emit an experimental SQLite warning; SQLite is built into Node 24.

## How it works

To try the app without credentials, run `cmd /c npm run simulate`. See the [simulation and SQLite guide](SIMULATION.md) for the scenarios, persistent database, table descriptions and synthetic CSV export.

```text
Store / signed sample sender
         |
         v
TypeScript HTTP server --> validate raw-body HMAC + order
         |                         |
         v                         v
SQLite: orders + attempts     HubSpot: contact --> deal --> association
         ^                         |
         +------ IDs / status -----+
         |
Plain HTML dashboard --> retry failed attempt

Python exporter --> HubSpot deal search --> CSV
```

- `src/order.ts`: order types, payload validation, HMAC verification, deal mapping.
- `src/hubspot.ts`: a small fetch-based HubSpot API client with timeouts and backoff.
- `src/store.ts`: SQLite persistence; `orders.order_id` is the primary key.
- `src/sync.ts`: orchestrates syncs, duplicate protection and recovery.
- `src/app.ts`: HTTP routes; `src/server.ts`: configuration and startup.
- `public/`: dashboard; `scripts/`: signed sample sender and Python exporter.

The server handles syncs directly, so the sender receives the final status. Each accepted, valid webhook or manual retry creates an attempt with its order ID, status, contact ID, deal ID, error, and UTC start timestamp. Invalid signatures or payloads receive errors before touching the database. The dashboard displays the latest 50 attempts and refreshes every ten seconds.

## Endpoints and signature contract

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/webhooks/orders` | Receive a signed order |
| GET | `/api/sync-attempts` | Last 50 attempts, newest first |
| POST | `/api/sync-attempts/:id/retry` | Retry a failed attempt using its saved order |
| GET | `/` | Dashboard |

Send `Content-Type: application/json`. `X-Webhook-Signature` must contain the **hex SHA-256 HMAC of the exact raw body**, using `WEBHOOK_SECRET`. The sample sender demonstrates this contract; this header belongs to the mock store, not HubSpot's inbound webhook format. The receiver uses a constant-time comparison and limits bodies to 1 MB.

Successful or duplicate syncs return HTTP 200; sync failures return 502 and remain retryable in the dashboard. Bad signatures return 401, invalid payloads 400, and concurrent processing of the same order 409.

## Reliability and duplicate protection

- The first accepted payload for an order ID wins. Repeated deliveries use the stored payload.
- The completed flag prevents repeat deal creation. A process-local lock prevents simultaneous processing of the same order.
- Contact and deal IDs are saved immediately. If association fails, retry reuses the deal.
- Before creating a deal, the app searches for the exact name `Order <order_id>`, helping recover from previous uncertain requests. Do not rename these deals or create unrelated deals with this naming convention.
- Safe API calls retry 429, 5xx, and network failures up to three times after the first call. Backoff is 1, 2, and 4 seconds; `Retry-After` overrides this when supplied.
- Creation calls retry explicit 429 rejections, but do **not** blindly retry 5xx, HTTP 408, or network timeouts: the record may already exist. Contact retries recover through email lookup; deals persist an uncertain flag before creation. Failed attempts store a readable error and are also logged to the console.
- If a deal create has an uncertain result, wait for HubSpot's search index, then click **Retry**. A discovered deal is reused. If none appears, the app refuses another create to avoid duplicates. If HubSpot confirms no deal was created, stop the server, back up `data/sync.sqlite`, and clear that order's `uncertain` flag using a SQLite editor (`UPDATE orders SET uncertain=0 WHERE order_id='YOUR-ORDER-ID';`). Restart and retry. Never clear it without checking HubSpot.
- On restart, unfinished attempts are marked failed for manual retry. Start only **one app process per database**.

This deliberately favors preventing duplicate deals over automatically repeating an ambiguous create. Local storage must be retained. This is a local assessment app: it binds to `127.0.0.1`, and its dashboard has no login. Do not expose the dashboard to the internet as-is.

## Python accounting export

```powershell
python scripts/export_deals.py
python scripts/export_deals.py --output accounting.csv
```

The script reads the same `.env`, searches **all deals in the account created during the previous seven days**, follows pagination, and exports:

`id, dealname, amount, createdate, closedate, pipeline, dealstage`

The window ends at the export's start time, using UTC. The CSV includes a header even when empty, supports Excel UTF-8, escapes formula-like text, and replaces the output only after a complete export. Temporary API errors use retry and backoff. HubSpot search has a 10,000-result limit; the script reports an error rather than silently exporting a partial dataset beyond this assessment's small-account scope.

The supplied sample's September 20 creation date maps to the deal's **close date**. HubSpot sets the deal's actual creation timestamp when the API creates it, so a newly synced sample appears in today's seven-day export.

## Tests

```powershell
cmd /c npm test
cmd /c npm run typecheck
python -m unittest discover -s tests -p "test_*.py"
```

Tests use in-memory SQLite and mocked HubSpot responses. They cover HMAC, payload validation, mapping, retries, duplicate deliveries, concurrency, ambiguous creates, the HTTP/dashboard retry flow, export date filtering and pagination, and CSV quoting. They do not need a token or make HubSpot requests.

For a live smoke test: send the sample twice, confirm one deal with the correct amount and associated contact in HubSpot, and confirm `success` then `duplicate` on the dashboard. Test retry by temporarily setting an invalid stage, sending a new order ID, restoring the stage and restarting the server, then retrying the failed attempt. Run the Python exporter and check the CSV against the account.

## Assumptions and improvements

- One store, one Node process, one test account; order IDs are stable and unique.
- Close date is the order timestamp; total is authoritative, without recalculating taxes or discounts from items.
- Account currency matches the order currency; multi-currency conversion is outside scope.
- HMAC header format is defined here because the brief does not prescribe it.
- Keep the SQLite database and credentials local. Payloads contain test customer details.
- With more time: a durable background job queue, authenticated dashboard, distributed locking, a unique HubSpot order-ID property for stronger remote idempotency, timestamped webhook signatures, automatic reconciliation, date-window splitting for large exports, and hosted HTTPS deployment.
- Optional n8n and Docker bonuses are omitted to keep the project simple. Focused automated tests are included.

API references: [HubSpot deals](https://developers.hubspot.com/docs/api-reference/crm-deals-v3/guide), [CRM search](https://developers.hubspot.com/docs/api-reference/search/guide), [associations v4](https://developers.hubspot.com/docs/api-reference/crm-associations-v4/guide), [Node SQLite](https://nodejs.org/api/sqlite.html).
