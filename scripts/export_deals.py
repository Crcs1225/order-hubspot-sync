"""Export all HubSpot deals created in the last seven days. Standard library only."""
import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

FIELDS = ['id', 'dealname', 'amount', 'createdate', 'closedate', 'pipeline', 'dealstage']


def load_env():
    """Read the project's simple KEY=VALUE .env without replacing shell variables."""
    path = Path(__file__).resolve().parents[1] / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                os.environ.setdefault(key.strip(), value.strip().strip('\"\''))


def request_page(token, body):
    for attempt in range(4):
        request = Request('https://api.hubapi.com/crm/v3/objects/deals/search',
                          data=json.dumps(body).encode(),
                          headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'},
                          method='POST')
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if error.code != 429 and error.code < 500:
                raise RuntimeError(f'HubSpot HTTP {error.code}. Check your token and deal read scope.') from None
            if attempt == 3:
                raise RuntimeError(f'HubSpot HTTP {error.code} after four attempts.') from None
            header = error.headers.get('Retry-After')
            delay = 2 ** attempt
            if header:
                try:
                    delay = max(0, float(header))
                except ValueError:
                    try:
                        delay = max(0, (parsedate_to_datetime(header) - datetime.now(timezone.utc)).total_seconds())
                    except (TypeError, ValueError):
                        pass
            error.close()
            time.sleep(delay)
        except (URLError, TimeoutError):
            if attempt == 3:
                raise RuntimeError('HubSpot network error after four attempts.') from None
            time.sleep(2 ** attempt)


def fetch_deals(request, now=None):
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(days=7)
    after = None
    while True:
        body = {
            'filterGroups': [{'filters': [
                {'propertyName': 'createdate', 'operator': 'GTE', 'value': str(int(start.timestamp() * 1000))},
                {'propertyName': 'createdate', 'operator': 'LTE', 'value': str(int(now.timestamp() * 1000))},
            ]}],
            'properties': FIELDS[1:], 'sorts': ['createdate'], 'limit': 200,
        }
        if after is not None:
            body['after'] = after
        page = request(body)
        yield from page['results']
        after = page.get('paging', {}).get('next', {}).get('after')
        if after is None:
            break
        if int(after) >= 10000:
            raise RuntimeError('HubSpot search limit reached. Split the seven-day window into smaller date ranges.')
        time.sleep(0.25)


def write_csv(deals, path):
    # Write atomically so a failed export does not leave a misleading partial report.
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    count = 0
    try:
        with temporary.open('w', newline='', encoding='utf-8-sig') as output:
            writer = csv.DictWriter(output, fieldnames=FIELDS)
            writer.writeheader()
            for deal in deals:
                row = {'id': deal['id'], **{key: deal.get('properties', {}).get(key, '') for key in FIELDS[1:]}}
                # Prevent text fields from being treated as spreadsheet formulas.
                for key in ('dealname', 'pipeline', 'dealstage'):
                    value = row[key]
                    if isinstance(value, str) and value.lstrip().startswith(('=', '+', '-', '@')):
                        row[key] = "'" + value
                writer.writerow(row)
                count += 1
        temporary.replace(path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='deals-last-7-days.csv')
    args = parser.parse_args()
    load_env()
    token = os.getenv('HUBSPOT_ACCESS_TOKEN', '')
    if not token or token.startswith('replace-with-'):
        raise RuntimeError('Set HUBSPOT_ACCESS_TOKEN in .env first.')
    count = write_csv(fetch_deals(lambda body: request_page(token, body)), args.output)
    print(f'Exported {count} deals to {args.output}')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, ValueError) as error:
        print(f'Export failed: {error}', file=sys.stderr)
        sys.exit(1)
