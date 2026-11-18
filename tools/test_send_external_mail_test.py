import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import urllib.request

import send_external_mail_test as mail


class ExternalMailTests(unittest.TestCase):
    def setUp(self):
        self.env = {'EXTERNAL_MAIL_TOKEN': 'x' * 40, 'EXTERNAL_MAIL_TEST_TO': 'self@example.invalid'}

    def test_default_and_explicit_send(self):
        self.assertTrue(mail.build_payload(self.env)['dryRun'])
        self.assertFalse(mail.build_payload(self.env, send=True)['dryRun'])

    def test_missing_and_multiple_recipients(self):
        for value in ('', 'a@example.invalid,b@example.invalid', 'a@example.invalid\nBcc: b@example.invalid'):
            with self.assertRaises(ValueError):
                mail.build_payload({**self.env, 'EXTERNAL_MAIL_TEST_TO': value})
        with self.assertRaises(ValueError):
            mail.build_payload({**self.env, 'EXTERNAL_MAIL_TOKEN': ''})

    def test_attachment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.txt'
            path.write_bytes(b'hi')
            attachment = mail.build_payload(self.env, attachments=[path])['attachments'][0]
            self.assertEqual(attachment, {'filename': 'test.txt', 'mimeType': 'text/plain', 'base64': 'aGk='})

    def test_url_restriction(self):
        mail.validate_url('https://script.google.com/macros/s/example/exec')
        for url in ('http://script.google.com/macros/s/example/exec', 'https://evil.invalid/exec',
                    'https://script.google.com/macros/s/example/dev',
                    'https://script.google.com/macros/s/example/exec?token=secret'):
            with self.assertRaises(ValueError):
                mail.validate_url(url)

    def test_redirect_strips_post_and_token(self):
        req = urllib.request.Request('https://script.google.com', data=b'private')
        handler = mail.GoogleRedirectHandler()
        redirected = handler.redirect_request(req, None, 302, '', {}, 'https://script.googleusercontent.com/result')
        self.assertIsNone(redirected.data)
        self.assertEqual(redirected.get_method(), 'GET')
        with self.assertRaises(ValueError):
            handler.redirect_request(req, None, 302, '', {}, 'https://evil.invalid/result')

    def test_mocked_http_request(self):
        response = io.BytesIO(json.dumps({'ok': True, 'sent': False}).encode())
        with patch.object(mail.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = response
            result = mail.send_request('https://script.google.com/macros/s/example/exec', mail.build_payload(self.env))
            self.assertTrue(result['ok'])
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.get_method(), 'POST')
            self.assertTrue(json.loads(request.data)['dryRun'])

    def test_error_never_prints_input(self):
        with patch.dict(mail.os.environ, self.env, clear=True), patch.object(mail, 'send_request', side_effect=ValueError('秘密')), patch('sys.stderr', new_callable=io.StringIO) as err:
            self.assertEqual(mail.main([]), 1)
            self.assertNotIn('秘密', err.getvalue())
            self.assertNotIn(self.env['EXTERNAL_MAIL_TOKEN'], err.getvalue())

    def test_only_known_codes_and_typed_status_are_printed(self):
        for code in ('SEND_DISABLED', 'arbitrary-private-value', ['private']):
            result = {'ok': False, 'code': code, 'messageBytes': 'private', 'sent': 'private'}
            with patch.dict(mail.os.environ, self.env, clear=True), patch.object(mail, 'send_request', return_value=result), patch('sys.stdout', new_callable=io.StringIO) as out, patch('sys.stderr', new_callable=io.StringIO):
                self.assertEqual(mail.main([]), 1)
                printed = json.loads(out.getvalue())
                self.assertEqual(printed.get('code'), 'SEND_DISABLED' if code == 'SEND_DISABLED' else None)
                self.assertIsNone(printed['messageBytes'])
                self.assertIsNone(printed['sent'])
                self.assertNotIn('private', out.getvalue())


if __name__ == '__main__':
    unittest.main()
