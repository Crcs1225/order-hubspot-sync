# Stage 2 implementation answers

This document explains what we built for each Stage 2 requirement. The implementation uses TypeScript on Node.js 24+, SQLite, plain HTML/CSS/browser JavaScript, and Python. It keeps dependencies and setup small so the code is easier to explain.

**Verification status:** The last completed checks passed 11 TypeScript tests, 3 Python tests and TypeScript type checking. Tests mock HubSpot; a live HubSpot test-account run has not been completed. These notes describe the implementation, not proof of a successful live submission.

## 22. Webhook receiver

**What we implemented:** `POST /webhooks/orders` receives the order JSON. It checks the event, order ID, date, customer details, items, currency and total. It rejects bodies larger than 1 MB.

The receiver calculates a SHA-256 HMAC over the exact raw request body using `WEBHOOK_SECRET`. It compares this with the hexadecimal `X-Webhook-Signature` header using a constant-time comparison. Invalid signatures return 401; invalid JSON or order data returns 400.

**Code:** [HTTP routes](src/app.ts), [validation and signature verification](src/order.ts), [signed sample sender](scripts/send-order.ts).

**Simple explanation:** We check that the request was signed with our shared secret and contains valid order information before processing it.

## 23. HubSpot sync

**What we implemented:** Search Contacts by email. Update an existing Contact or create a new one with email, first name, last name and phone. Then create the Deal and associate it with the Contact.

| Order or configuration value | HubSpot Deal property |
| --- | --- |
| `order_id` | `dealname`: `Order <order_id>` |
| `total` | `amount` |
| `created_at` | `closedate`, converted to UTC |
| `HUBSPOT_PIPELINE` | `pipeline` |
| `HUBSPOT_DEAL_STAGE` | `dealstage` |

**Code:** [HubSpot client](src/hubspot.ts), [deal mapping](src/order.ts), [sync orchestration](src/sync.ts).

**Simple explanation:** We find the customer first, create the sale record, and link the two records in HubSpot.

**Assumption:** The HubSpot account currency matches the order currency. The app validates the currency code but does not perform currency conversion or set a separate Deal currency property.

## 24. Idempotency

**What we implemented:** SQLite stores each order under a unique `order_id`. The first accepted payload is retained. A completed order returns a `duplicate` attempt without creating another Deal. An in-process lock rejects simultaneous processing of the same order.

The app saves Contact and Deal IDs as processing progresses. An association failure can therefore retry using the saved Deal. It also searches for the exact Deal name before creation. Before sending a create request, it saves an uncertainty flag; a timeout or ambiguous failure does not permit another blind create. This includes HTTP 408 responses, covered by a regression test.

**Code:** [sync orchestration](src/sync.ts), [database storage](src/store.ts).

**Simple explanation:** We remember which order has already been synced and reuse its Deal instead of creating another one.

**Limits:** Run one app process per database, retain the SQLite file, and keep the generated Deal names unchanged. If creation has an uncertain outcome, retry searches for the Deal; manual recovery may be needed as explained in the [README](README.md#reliability-and-duplicate-protection).

## 25. Reliability

**What we implemented:** Safe HubSpot requests retry rate limits, server errors and network failures up to three times after the initial request. Backoff is one, two and four seconds, or the supplied `Retry-After` delay. Each fetch has a 15-second timeout. Failures are recorded in SQLite and logged to the console.

**Code:** [HubSpot request handling](src/hubspot.ts), [sync failure handling](src/sync.ts).

**Simple explanation:** Temporary failures get another chance after a delay, and failed syncs remain visible for retry.

**Important distinction:** Create requests retry explicit 429 rejections, but ambiguous 5xx, HTTP 408 and network failures are not automatically resubmitted. A create may already have succeeded remotely. Deal recovery searches for that existing record instead, favoring duplicate prevention over automatic completion.

## 26. Database storage

**What we implemented:** SQLite has an `orders` table for the original payload, saved HubSpot IDs and recovery state, and an `attempts` table for order ID, status, Contact ID, Deal ID, error and UTC start timestamp.

Accepted valid webhook deliveries and manual retries create attempt records. Statuses include `processing`, `success`, `failed` and `duplicate`. On startup, interrupted processing attempts become failed attempts that can be retried. Invalid signatures and invalid payloads are rejected before database storage.

**Code:** [SQLite store](src/store.ts).

**Simple explanation:** The database keeps the order's progress and a history of each accepted sync attempt.

## 27. Dashboard

**What we implemented:** A plain HTML page lists the latest 50 attempts, newest first, with statuses, HubSpot IDs, local display times and errors. Failed attempts have a Retry button. The page refreshes every ten seconds and also has a Refresh button.

`GET /api/sync-attempts` supplies the history. `POST /api/sync-attempts/:id/retry` retries the saved order rather than requiring the user to submit it again.

**Code:** [page](public/index.html), [browser behavior](public/app.js), [styles](public/style.css), [HTTP routes](src/app.ts).

**Simple explanation:** The sales team can see which orders synced and retry failures from one page.

**Limit:** This is a local dashboard without a login. The server binds to `127.0.0.1`.

## 28. Second-language CSV export

**What we implemented:** A Python script uses the standard library to search HubSpot Deals created during the previous seven days, ending at the export's start time in UTC. It follows pagination and retries temporary API failures. It exports all matching account Deals, not only those created by this integration.

CSV columns are `id`, `dealname`, `amount`, `createdate`, `closedate`, `pipeline` and `dealstage`. The script handles CSV quoting, writes an empty report with headers, protects formula-like text fields, and replaces the output only after a complete export.

```powershell
python scripts/export_deals.py --output accounting.csv
```

**Code:** [Python exporter](scripts/export_deals.py).

**Simple explanation:** Accounting can run a separate Python script to get the last seven days of newly created Deals in a spreadsheet-friendly file.

**Limit:** HubSpot search pagination has a 10,000-result ceiling. The current script reports an error rather than producing a partial export beyond that ceiling. Splitting the time window is a future improvement. HubSpot's actual Deal creation date determines export inclusion; the sample order date maps to the Deal close date.

## 29. README

**What we implemented:** The [README](README.md) includes Windows setup commands, environment variables, required HubSpot scopes, pipeline/stage configuration, an architecture diagram, endpoint documentation, retry and recovery behavior, export instructions, tests, assumptions and future improvements.

**Simple explanation:** Another developer can use the README to understand, configure, run and test the project.

## Optional bonuses

| Bonus | What we did |
| --- | --- |
| n8n workflow and error notification | Not implemented. |
| Docker Compose | Not implemented. |
| Mapping and idempotency tests | Implemented, alongside signature, retry, HTTP flow, recovery and Python export tests. |

## Validation and remaining steps

Run the automated checks:

```powershell
cmd /c npm test
cmd /c npm run typecheck
python -m unittest discover -s tests -p "test_*.py"
```

Before submission:

1. Configure `.env` with a HubSpot developer test-account token, webhook secret and valid pipeline/stage IDs.
2. Start the app and send the signed sample order twice.
3. Verify one Deal exists in HubSpot with the correct properties and associated Contact, and confirm `success` then `duplicate` on the dashboard.
4. Verify a failed sync can be retried after correcting its configuration.
5. Run the Python exporter and compare the CSV with the test account's recent Deals.
6. Create or update the submission repository, exclude secrets and local data, and share its GitHub link.

The automated tests do not establish live HubSpot behavior or browser rendering. The HTTP dashboard route and retry flow have automated coverage; real account verification remains outstanding.
