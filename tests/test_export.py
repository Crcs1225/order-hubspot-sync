import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from datetime import datetime, timezone

spec = importlib.util.spec_from_file_location('export_deals', Path(__file__).parents[1] / 'scripts' / 'export_deals.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExportTests(unittest.TestCase):
    def test_retries_rate_limits_and_server_errors(self):
        from io import BytesIO
        response = BytesIO(b'{"results": []}')
        errors = [HTTPError('https://api.hubapi.com', 429, 'Rate limit', {'Retry-After': '2'}, None),
                  HTTPError('https://api.hubapi.com', 503, 'Unavailable', {}, None), response]
        with patch.object(module, 'urlopen', side_effect=errors), patch.object(module.time, 'sleep') as wait:
            self.assertEqual(module.request_page('test', {}), {'results': []})
            self.assertEqual([call.args[0] for call in wait.call_args_list], [2, 2])

    def test_empty_export_has_header_and_failed_export_keeps_previous_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'deals.csv'
            self.assertEqual(module.write_csv([], path), 0)
            original = path.read_bytes()

            def broken():
                yield {'id': '1', 'properties': {}}
                raise RuntimeError('API failed')

            with self.assertRaises(RuntimeError):
                module.write_csv(broken(), path)
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse(path.with_suffix('.csv.tmp').exists())

    def test_pagination_time_window_and_csv(self):
        calls = []

        def request(body):
            calls.append(body)
            record = {'id': str(len(calls)), 'properties': {'dealname': 'A, "quoted" deal', 'amount': '900'}}
            return {'results': [record], **({'paging': {'next': {'after': '1'}}} if len(calls) == 1 else {})}

        rows = list(module.fetch_deals(request, datetime(2026, 10, 20, tzinfo=timezone.utc)))
        self.assertEqual(len(rows), 2)
        self.assertEqual(calls[1]['after'], '1')
        filters = calls[0]['filterGroups'][0]['filters']
        self.assertEqual(filters[0]['value'], str(int(datetime(2026, 10, 13, tzinfo=timezone.utc).timestamp() * 1000)))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'deals.csv'
            module.write_csv(rows, path)
            self.assertIn('"A, ""quoted"" deal"', path.read_text(encoding='utf-8-sig'))


if __name__ == '__main__':
    unittest.main()
