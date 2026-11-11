import base64
import json
import subprocess
import io
import urllib.request
import urllib.response
import urllib.parse
from email.message import Message
import unittest
from unittest.mock import patch
from http_login_draft import (LoginError, VendorHttpSession, encrypt_bofeel,
                             LoginForm, NoRedirect, response_kind, LoginRejectedError,
                             LoginVerificationError, LoginProtocolError, LoginTransportError,
                             StopSignalError, login_response_summary)


class LoginTests(unittest.TestCase):
    def bofeel_form(self):
        return '<form id="formLogin">' + ''.join(
            f'<input name="{key}" value="{value}">' for key, value in
            [('mode', 'login'), ('returnUrl', '/'), ('secretKey', 'mock'), ('encryptFl', 'Y')]) + '</form>'

    def test_failure_stage_and_response_types_never_contain_server_values(self):
        session = VendorHttpSession('bofeel')
        body = json.dumps({'code': 'private-code', 'message': 'private-server-message'})
        with patch.object(session, 'request', side_effect=[self.bofeel_form(), body]) as request:
            with self.assertRaises(LoginRejectedError):
                session.login('mock', 'mock')
            self.assertEqual(request.call_count, 2)
        self.assertEqual(session.diagnostics, [dict(code_type='string', message_type='string'),
                         dict(login_stage='authentication_response', error_kind='server_rejected')])
        self.assertNotIn('private-', json.dumps(session.diagnostics))

    def test_ambiguous_post_and_verification_failure_are_not_server_rejection(self):
        for verification in ['로그인', LoginError('허용 범위 밖 리다이렉트 중단'), LoginTransportError('조회 실패')]:
            session = VendorHttpSession('bofeel')
            with patch.object(session, 'request', side_effect=[self.bofeel_form(), '<script>location.href="/"</script>', verification]) as request:
                with self.assertRaises(LoginVerificationError):
                    session.login('mock', 'mock')
                self.assertEqual(request.call_count, 3)
                with self.assertRaisesRegex(LoginError, '자동 재시도 금지'):
                    session.login('mock', 'mock')
                self.assertEqual(request.call_count, 3)
            self.assertEqual(session.diagnostics[-1], dict(login_stage='session_verification', error_kind='verification_failed'))

    def test_verification_stop_signal_is_preserved_without_followup(self):
        session = VendorHttpSession('bofeel')
        with patch.object(session, 'request', side_effect=[self.bofeel_form(), '{}', StopSignalError('중단')]) as request:
            with self.assertRaises(StopSignalError):
                session.login('mock', 'mock')
            self.assertEqual(request.call_count, 3)
        self.assertEqual(session.diagnostics[-1]['error_kind'], 'stop_signal')

    def test_malformed_json_is_protocol_error_not_denial(self):
        for body in ['{', '[]']:
            session = VendorHttpSession('bofeel')
            with patch.object(session, 'request', side_effect=[self.bofeel_form(), body]) as request:
                with self.assertRaises(LoginProtocolError):
                    session.login('mock', 'mock')
                self.assertEqual(request.call_count, 2)

    def test_response_summary_records_only_types(self):
        for value, kind in [(None, 'null'), (False, 'boolean'), (0, 'number'), ('mock', 'string'), ([], 'array'), ({}, 'object')]:
            self.assertEqual(login_response_summary({'code': value}), dict(code_type=kind, message_type='absent'))

    def test_http_and_connection_failures_are_transport_errors_without_retry(self):
        for failure in [urllib.error.URLError('private-network-detail'), TimeoutError('private-network-detail')]:
            session = VendorHttpSession('bofeel')
            with patch.object(session.opener, 'open', side_effect=failure) as request:
                with self.assertRaises(LoginTransportError):
                    session.login('mock', 'mock')
                self.assertEqual(request.call_count, 1)
            self.assertEqual(session.diagnostics[-1], dict(login_stage='login_form', error_kind='transport_failed'))
            self.assertNotIn('private-', json.dumps(session.diagnostics))
        session = VendorHttpSession('bofeel')
        response = io.BytesIO(b'private-server-detail')
        response.code = 503
        response.headers = Message()
        with patch.object(session.opener, 'open', return_value=response) as request:
            with self.assertRaises(LoginTransportError):
                session.login('mock', 'mock')
            self.assertEqual(request.call_count, 1)
        self.assertEqual(session.trace[-1]['status'], 503)

    def test_catalog_override_can_fail_confirmation_after_successful_post(self):
        # 이전 로컬 경로 재현: 상품 페이지에 인증 확인용 문구가 없을 수 있다.
        class CatalogOverride(VendorHttpSession):
            def request(self, path, fields=None):
                if path == self.cart_path:
                    return '<form id="frmView">mock-authenticated-product</form>'
                return super().request(path, fields)
        original = VendorHttpSession.request
        with patch.object(VendorHttpSession, 'request', side_effect=[self.bofeel_form(), '{}']):
            session = CatalogOverride('bofeel')
            with self.assertRaises(LoginVerificationError):
                session.login('mock', 'mock')
        self.assertIs(VendorHttpSession.request, original)
        session = VendorHttpSession('bofeel')
        with patch.object(session, 'request', side_effect=[self.bofeel_form(), '{}', '로그아웃']):
            self.assertTrue(session.login('mock', 'mock')['authenticated'])

    def test_special_characters_survive_encryption_and_form_encoding(self):
        session = VendorHttpSession('bofeel')
        with patch.object(session, 'request', side_effect=[self.bofeel_form(), '{}', '로그아웃']) as request, patch('http_login_draft.encrypt_bofeel', side_effect=['fake+encoded/id=', 'fake+encoded/pwd=']) as encrypt:
            session.login('mock+user', 'mock!@#$%^&*()+/=한글')
            self.assertEqual(encrypt.call_args_list[1].args[0], 'mock!@#$%^&*()+/=한글')
            fields = request.call_args_list[1].args[1]
            self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlencode(fields))['loginPwd'], ['fake+encoded/pwd='])

    def test_encryption_against_node_crypto(self):
        # 고정된 가짜 입력만 Node의 독립 AES/PBKDF2 구현과 대조한다.
        script = """
const c=require('node:crypto');
const iv=Buffer.alloc(16,1),salt=Buffer.alloc(256,2);
const key=c.pbkdf2Sync('mock-secret',salt,999,32,'sha512');
const e=c.createCipheriv('aes-256-cbc',key,iv);
const ciphertext=Buffer.concat([e.update('mock-user-한글','utf8'),e.final()]).toString('base64');
console.log(Buffer.from(JSON.stringify({ciphertext,iv:iv.toString('hex'),salt:salt.toString('hex'),iterations:999})).toString('base64'));
"""
        expected = subprocess.check_output(['node', '-e', script], text=True).strip()
        self.assertEqual(encrypt_bofeel('mock-user-한글', 'mock-secret', iv=bytes([1])*16,
                                       salt=bytes([2])*256), expected)
        first = json.loads(base64.b64decode(encrypt_bofeel('x', 's')))
        second = json.loads(base64.b64decode(encrypt_bofeel('x', 's')))
        self.assertNotEqual(first['iv'], second['iv'])
        self.assertNotEqual(first['salt'], second['salt'])

    def test_eroum_sequence_and_no_retry(self):
        s = VendorHttpSession('eroum')
        form = '<form name="flogin"><input name="mb_id"><input name="mb_password"><input name="url"></form>'
        with patch.object(s, 'request', side_effect=[form, '로그아웃', '로그아웃']) as req:
            self.assertTrue(s.login('mock', 'mock')['authenticated'])
            self.assertEqual([x.args[0] for x in req.call_args_list],
                             ['/bbs/login.php', '/bbs/login_check.php', '/shop/cart.php'])
            with self.assertRaises(LoginError):
                s.login('mock', 'mock')

    def test_bofeel_success_and_error_branches(self):
        form = '<form id="formLogin">' + ''.join(
            f'<input name="{k}" value="{v}">' for k,v in
            [('mode','login'),('returnUrl','/'),('secretKey','mock'),('encryptFl','Y')]) + '</form>'
        for data, success in [('{}', True), ('{"code":0,"message":"mock"}', False),
                              ('{"code":null,"message":null}', False)]:
            s = VendorHttpSession('bofeel')
            with patch.object(s, 'request', side_effect=[form, data, '로그아웃']) as req:
                if success:
                    self.assertTrue(s.login('mock', 'mock')['authenticated'])
                else:
                    with self.assertRaises(LoginError): s.login('mock', 'mock')
                    self.assertEqual(req.call_count, 2)

    def test_request_scope_guard(self):
        s = VendorHttpSession('bofeel')
        for path, fields in [('https://other.invalid/', None), ('/order/cart_ps.php?mode=remove', None),
                             ('/order/cart_ps.php', {'mode':'cartIn'}), ('/', None),
                             ('/main/index.php', None)]:
            with self.assertRaises(LoginError): s.request(path, fields)
        self.assertEqual(len(s.cookies), 0)

    def test_empty_path_and_default_https_port(self):
        s = VendorHttpSession('eroum')
        response = io.BytesIO('로그아웃'.encode())
        response.code = 200
        response.headers = Message()
        response.headers['Content-Type'] = 'text/html; charset=utf-8'
        response.code = 302
        response.headers['Location'] = 'https://eroumcare.com:443'
        with patch.object(s.opener, 'open', return_value=response) as request:
            self.assertEqual(s.request(s.post_path, {'mb_id': 'mock'}), '')
            self.assertEqual(request.call_count, 1)
            self.assertEqual(s.diagnostics[-1]['redirect_path'], '/')
            self.assertFalse(s.diagnostics[-1]['redirect_followed'])

    def test_html_response_requires_cart_proof(self):
        s = VendorHttpSession('bofeel')
        form = '<form id="formLogin">' + ''.join(
            f'<input name="{k}" value="{v}">' for k,v in
            [('mode','login'),('returnUrl','/'),('secretKey','mock'),('encryptFl','Y')]) + '</form>'
        with patch.object(s, 'request', side_effect=[form, '<html>mock</html>', '로그아웃']) as request:
            self.assertTrue(s.login('mock', 'mock')['authenticated'])
            self.assertEqual(request.call_args.args[0], '/order/cart.php')
        s = VendorHttpSession('bofeel')
        with patch.object(s, 'request', side_effect=[form, '<html>mock</html>', '로그인']):
            with self.assertRaisesRegex(LoginError, '장바구니'):
                s.login('mock', 'mock')

    def test_relative_redirect_never_fetches_home(self):
        for target in ('../../', '/', 'https://eroumcare.com'):
            s = VendorHttpSession('eroum')
            response = io.BytesIO(b'')
            response.code = 302
            response.headers = Message()
            response.headers['Location'] = target
            with patch.object(s.opener, 'open', return_value=response) as request:
                self.assertEqual(s.request(s.post_path, {'mb_id': 'mock'}), '')
                self.assertEqual(request.call_count, 1)
                self.assertEqual(s.diagnostics[-1]['redirect_path'], '/')

    def test_post_redirect_cannot_resend_or_leave_site(self):
        for status, target in ((307, '/'), (308, '/'), (302, 'https://other.invalid/')):
            s = VendorHttpSession('eroum')
            response = io.BytesIO(b'')
            response.code = status
            response.headers = Message()
            response.headers['Location'] = target
            with patch.object(s.opener, 'open', return_value=response) as request:
                with self.assertRaises(LoginError):
                    s.request(s.post_path, {'mb_id': 'mock'})
                self.assertEqual(request.call_count, 1)

    def test_form_successful_controls_and_classification(self):
        form = LoginForm('formLogin')
        form.feed('<form id="formLogin"><input name="saveId" type="checkbox" checked>'
                  '<input name="unchecked" type="checkbox"><input name="disabled" disabled>'
                  '<input name="button" type="submit"></form>')
        self.assertEqual(form.fields, {'saveId': 'on'})
        self.assertEqual(response_kind('<form id="formLogin"></form>'), 'login_form_html')
        self.assertEqual(response_kind('<script>location.href="/"</script>'), 'navigation_html')

    def test_bofeel_headers_encoding_and_cookies(self):
        session = VendorHttpSession('bofeel')
        requests = []
        form = '<form id="formLogin">' + ''.join(
            f'<input name="{k}" value="{v}">' for k,v in
            [('mode','login'),('returnUrl','/'),('secretKey','mock'),('encryptFl','Y'),
             ('loginId',''),('loginPwd','')]) + '<input name="saveId" type="checkbox" value="y" checked></form>'

        class FakeHttps(urllib.request.HTTPSHandler):
            def https_open(self, req):
                requests.append(req)
                index = len(requests)
                headers = Message()
                headers['Content-Type'] = 'text/html; charset=utf-8'
                if index == 1:
                    headers['Set-Cookie'] = 'mocksession=fake; Path=/; Secure'
                body = (form if index == 1 else '<html></html>' if index == 2 else '로그아웃')
                response = urllib.response.addinfourl(io.BytesIO(body.encode()), headers, req.full_url, 200)
                response.msg = 'OK'
                return response

        session.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(session.cookies), NoRedirect(), FakeHttps())
        self.assertTrue(session.login('fake+user', 'fake/password')['authenticated'])
        self.assertEqual([urllib.parse.urlsplit(r.full_url).path for r in requests],
                         ['/member/login.php', '/member/login_ps.php', '/order/cart.php'])
        post = requests[1]
        self.assertEqual(post.full_url, 'https://bofeelmall.com/member/login_ps.php')
        self.assertEqual(post.get_header('X-requested-with'), 'XMLHttpRequest')
        self.assertEqual(post.get_header('Accept'), '*/*')
        self.assertEqual(post.get_header('Origin'), session.origin)
        self.assertEqual(post.get_header('Referer'), session.origin + session.login_path)
        self.assertEqual(post.get_header('Content-type'), 'application/x-www-form-urlencoded; charset=UTF-8')
        payload = urllib.parse.parse_qs(post.data.decode())
        self.assertEqual(payload['saveId'], ['y'])
        self.assertEqual(payload['secretKey'], ['mock'])
        self.assertEqual(set(json.loads(base64.b64decode(payload['loginId'][0]))),
                         {'ciphertext', 'iv', 'salt', 'iterations'})
        self.assertTrue(all(r.get_header('Cookie') == 'mocksession=fake' for r in requests[1:]))
        session.clear()
        self.assertEqual(len(session.cookies), 0)

    def test_stop_signals_prevent_followup(self):
        for marker in ('로그인 실패 횟수', '계정이 잠겼습니다', '캡차', '추가 인증이 필요',
                       '비밀번호 오류 5회'):
            session = VendorHttpSession('bofeel')
            response = io.BytesIO(marker.encode())
            response.code = 200
            response.headers = Message()
            response.headers['Content-Type'] = 'text/html; charset=utf-8'
            with patch.object(session.opener, 'open', return_value=response) as request:
                with self.assertRaisesRegex(LoginError, '신호로 중단'):
                    session.login('mock', 'mock')
                self.assertEqual(request.call_count, 1)

    def test_post_stop_signal_prevents_cart(self):
        form = '<form name="flogin"><input name="mb_id"><input name="mb_password"><input name="url"></form>'
        responses = []
        for body in (form, '계정 잠금 안내'):
            response = io.BytesIO(body.encode())
            response.code = 200
            response.headers = Message()
            response.headers['Content-Type'] = 'text/html; charset=utf-8'
            responses.append(response)
        session = VendorHttpSession('eroum')
        with patch.object(session.opener, 'open', side_effect=responses) as request:
            with self.assertRaisesRegex(LoginError, '신호로 중단'):
                session.login('mock', 'mock')
            self.assertEqual(request.call_count, 2)


if __name__ == '__main__': unittest.main()
