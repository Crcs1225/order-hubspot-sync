# Simulation and SQLite guide

## Run without HubSpot credentials

```powershell
cmd /c npm run simulate
```

Open **http://127.0.0.1:3000**. This runs the actual HTTP app, validation, HMAC verification, sync service, HubSpot client and SQLite storage. Only the HubSpot API transport is replaced with synthetic responses. It does not load `.env` or make real HubSpot requests.

The command checks the scenarios below and then keeps the dashboard running. One failed order is left for you to try the **Retry** button. Each run uses new order IDs and adds a new history batch; it does not erase previous simulation data. Mock CRM records exist only in memory and reset on restart. This is a demonstration, not a durable replacement CRM.

For a one-off verification that stops the server afterward:

```powershell
cmd /c npm run simulate -- --once
python scripts/simulate_export.py
```

If port 3000 is occupied, set `$env:SIMULATION_PORT='3001'` before running the dashboard. `--once` automatically chooses an available port.

## Checked scenarios

| Scenario | Expected result |
| --- | --- |
| New signed order | Contact and Deal created and associated; HTTP 200 |
| Duplicate order | Same Deal ID; no extra Deal; HTTP 200 |
| Association failure | Failed attempt with saved Deal ID; HTTP 502 |
| Manual retry | Existing Deal reused; success |
| Contact search returns 429 then 503 | Client schedules two 2-second backoffs and completes successfully |
| Deal created but its response is 503 | Failed attempt marked uncertain |
| Retry uncertain creation | Existing Deal found; no second create |
| A further association failure | Failed row available to retry from the dashboard |
| Incorrect signature | HTTP 401; no stored order or attempt |
| Invalid order payload | HTTP 400; no stored order or attempt |
| Python CSV export | Five synthetic Deals, two pages, 429/503 retries and valid CSV |

The scripted HTTP run asserts **5 orders, 8 attempts, 1 mock Contact, 5 mock Deals and 4 associations per run**. Attempt statuses are 4 successes, 3 failures and 1 duplicate. Historical failed attempts stay in the history even after a later retry succeeds. Clicking Retry afterward adds another attempt.

Backoff durations are captured and checked rather than actually slept in the simulation. The normal client still uses real delays. The Python simulation exercises the real exporter using the generated Deal fixtures; it supplies synthetic creation timestamps for the seven-day window. It writes `data/simulation-deals.csv`.

## Database location

- **Simulation:** `data/simulation.sqlite`, created by `npm run simulate`.
- **Normal app:** `data/sync.sqlite` by default, created after `npm start` passes configuration validation. `DATABASE_PATH` in `.env` can override this.
- **Automated tests:** `:memory:` SQLite, which does not create a file.
- **Run report:** `data/simulation-report.json`, containing the last scripted run's results, counts, schema and synthetic Deals.

The whole `data/` directory is ignored by Git. It still exists on disk and can be opened in your editor or a SQLite viewer. SQLite may also create `simulation.sqlite-wal` and `simulation.sqlite-shm` while the app is running; these are normal files used by write-ahead logging. Stop the app before copying the database alone.

## Tables

### `orders`: one row per unique order

| Column | Type | Meaning |
| --- | --- | --- |
| `order_id` | TEXT, primary key | Unique store order ID |
| `payload` | TEXT, required | First accepted order payload as JSON |
| `contact_id` | TEXT, nullable | Saved HubSpot Contact ID; synthetic ID in simulation |
| `deal_id` | TEXT, nullable | Saved HubSpot Deal ID; synthetic ID in simulation |
| `synced` | INTEGER, default 0 | `1` after Deal association succeeds |
| `uncertain` | INTEGER, default 0 | `1` while a Deal create may have happened but is not yet confirmed |

### `attempts`: sync history

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | INTEGER, auto-increment primary key | Attempt ID used by the Retry endpoint |
| `order_id` | TEXT, required | Order involved in this attempt |
| `status` | TEXT, required | `processing`, `success`, `failed` or `duplicate` |
| `contact_id` | TEXT, nullable | Contact ID available at completion |
| `deal_id` | TEXT, nullable | Deal ID available at completion |
| `error` | TEXT, nullable | Failure message |
| `timestamp` | TEXT, required | UTC attempt start time |

An order can have many attempts. `attempts.order_id` is a logical reference to `orders.order_id`; the current schema does not declare a foreign-key constraint. There are no separate local Contacts, Deals or items tables: the app saves IDs and the original order JSON. Real CRM records belong in HubSpot.

### `sqlite_sequence`: SQLite internal table

SQLite creates this automatically for the `attempts` auto-increment counter. Its columns are `name` and `seq`. Application code does not manage it directly.

## Inspect the database

Open `data/simulation.sqlite` in a SQLite viewer, or use Python, which includes SQLite:

```powershell
python -c "import sqlite3; db=sqlite3.connect('file:data/simulation.sqlite?mode=ro', uri=True); print(db.execute('SELECT name FROM sqlite_master WHERE type = ?', ('table',)).fetchall()); print(db.execute('SELECT status, COUNT(*) FROM attempts GROUP BY status').fetchall()); db.close()"
```

Useful SQL queries:

```sql
SELECT * FROM orders;
SELECT * FROM attempts ORDER BY id DESC LIMIT 50;
SELECT status, COUNT(*) FROM attempts GROUP BY status;
PRAGMA table_info(orders);
PRAGMA table_info(attempts);
```

These simulations verify the app's local behavior and API mapping, not actual HubSpot account configuration, API compatibility against a live account, or rendered browser interactions. Live testing remains a separate step in the README.
