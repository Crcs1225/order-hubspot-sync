"""Exercise the real Python export with synthetic HubSpot responses only."""
import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import export_deals

root = Path(__file__).resolve().parents[1]
report_path = root / 'data' / 'simulation-report.json'
if not report_path.exists():
    raise SystemExit('Run cmd /c npm run simulate -- --once first.')
report = json.loads(report_path.read_text(encoding='utf-8'))
now = datetime.now(timezone.utc).isoformat()
deals = [{**deal, 'properties': {**deal['properties'], 'createdate': now}} for deal in report['deals']]
calls = []


def fake_urlopen(request, timeout):
    assert request.full_url == 'https://api.hubapi.com/crm/v3/objects/deals/search'
    body = json.loads(request.data)
    calls.append(body)
    if len(calls) <= 2:
        status = 429 if len(calls) == 1 else 503
        raise HTTPError(request.full_url, status, 'Synthetic temporary error', {'Retry-After': '2'}, None)
    if 'after' not in body:
        page = {'results': deals[:2], 'paging': {'next': {'after': '2'}}}
    else:
        assert body['after'] == '2'
        page = {'results': deals[2:]}
    return io.BytesIO(json.dumps(page).encode())


output = root / 'data' / 'simulation-deals.csv'
with patch.object(export_deals, 'urlopen', side_effect=fake_urlopen), patch.object(export_deals.time, 'sleep') as wait:
    count = export_deals.write_csv(export_deals.fetch_deals(lambda body: export_deals.request_page('synthetic-token', body)), output)
    assert count == 5
    assert len(calls) == 4
    assert [call.args[0] for call in wait.call_args_list] == [2, 2, 0.25]
with output.open(encoding='utf-8-sig', newline='') as source:
    rows = list(csv.DictReader(source))
assert len(rows) == 5
assert all(row['amount'] == '900' for row in rows)
print(f'PASS: 5 synthetic deals exported, two pages read, 429/503 retries verified.\nCSV: {output}\nNo real HubSpot requests were made.')
