"""격리된 HTTP 로그인 초안. 운영 큐 연결 없음. cryptography가 필요하다.

쿠키는 세션 객체 메모리에만 보관하며 디스크 저장·자동 재시도는 하지 않는다.
"""
import base64
import hashlib
import http.cookiejar
import json
import os
import gzip
import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


class LoginError(Exception):
    pass


class LoginForm(HTMLParser):
    def __init__(self, target):
        super().__init__()
        self.target, self.active, self.fields = target, False, {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'form':
            self.active = self.target in (attrs.get('id'), attrs.get('name'))
        if tag == 'input' and self.active and attrs.get('name'):
            kind = attrs.get('type', '').lower()
            if 'disabled' in attrs or kind in ('submit', 'button', 'reset', 'file', 'image'):
                return
            if kind in ('checkbox', 'radio') and 'checked' not in attrs:
                return
            self.fields[attrs['name']] = attrs.get('value', 'on' if kind in ('checkbox', 'radio') else '')

    def handle_endtag(self, tag):
        if tag == 'form':
            self.active = False


def encrypt_bofeel(value, secret, *, iv=None, salt=None):
    iv = os.urandom(16) if iv is None else iv
    salt = os.urandom(256) if salt is None else salt
    key = hashlib.pbkdf2_hmac('sha512', secret.encode(), salt, 999, 32)
    padder = padding.PKCS7(128).padder()
    padded = padder.update(value.encode()) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    ciphertext = encryptor.update(padded) + encryptor.finalize()
    payload = dict(ciphertext=base64.b64encode(ciphertext).decode(),
                   iv=iv.hex(), salt=salt.hex(), iterations=999)
    return base64.b64encode(json.dumps(payload, separators=(',', ':')).encode()).decode()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def response_kind(text):
    """본문이나 토큰을 저장하지 않고 구조만 분류한다."""
    stripped = text.lstrip('\ufeff \r\n\t')
    if stripped.startswith(('{', '[')):
        return 'json'
    if re.search(r'<form\b[^>]*(?:id|name)\s*=\s*[\'"]formLogin[\'"]', text, re.I):
        return 'login_form_html'
    if re.search(r'location\s*(?:\.\s*href\s*)?=|location\s*\.\s*replace\s*\(', text):
        return 'navigation_html'
    if re.search(r'<(?:html|!doctype|script)\b', stripped, re.I):
        return 'other_html'
    return 'empty' if not stripped else 'other_text'


def check_stop_signal(text):
    markers = ('g-recaptcha', 'h-captcha', 'cf-chl-', 'captcha_word',
               '추가 인증이 필요', '접근이 차단', '로그인 실패 횟수', '계정이 잠',
               '계정 잠금', '잠긴 계정', '캡차', '자동입력 방지문자')
    if any(marker in text.lower() for marker in markers) or re.search(
            r'(?:로그인|비밀번호|인증)[^<>\n]{0,30}(?:실패|오류)[^<>\n]{0,20}(?:횟수|\d+\s*회)', text):
        raise LoginError('실패 횟수·잠금·캡차·추가 인증 또는 차단 신호로 중단')


class VendorHttpSession:
    PATHS = {
        'eroum': ('https://eroumcare.com', '/bbs/login.php', '/bbs/login_check.php', '/shop/cart.php'),
        'bofeel': ('https://bofeelmall.com', '/member/login.php', '/member/login_ps.php', '/order/cart.php'),
    }

    def __init__(self, vendor):
        self.vendor = vendor
        self.origin, self.login_path, self.post_path, self.cart_path = self.PATHS[vendor]
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies), NoRedirect())
        self.attempted = False
        self.trace = []
        self.diagnostics = []

    def request(self, path, fields=None):
        # 로그인 페이지와 장바구니만 조회한다. POST 뒤 홈 이동은 실행하지 않는다.
        allowed = {self.login_path, self.cart_path}
        method = 'POST' if fields is not None else 'GET'
        url = urllib.parse.urljoin(self.origin, path)
        body = urllib.parse.urlencode(fields).encode() if fields is not None else None
        for _ in range(6):
            parts = urllib.parse.urlsplit(url)
            if not parts.path:
                url = urllib.parse.urlunsplit(parts._replace(path='/'))
                parts = urllib.parse.urlsplit(url)
            origin = urllib.parse.urlsplit(self.origin)
            if (parts.scheme != 'https' or parts.hostname != origin.hostname or
                    parts.port not in (None, 443) or parts.username or parts.password or parts.query or
                    (method == 'GET' and parts.path not in allowed) or
                    (method == 'POST' and parts.path != self.post_path)):
                raise LoginError('허용 범위 밖 요청 중단')
            headers = {'User-Agent': 'Mozilla/5.0', 'Referer': self.origin + self.login_path,
                       'Accept': '*/*'}
            if body is not None:
                headers.update({'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                'Origin': self.origin})
                if self.vendor == 'bofeel':
                    headers['X-Requested-With'] = 'XMLHttpRequest'
            req = urllib.request.Request(url, data=body, headers=headers, method=method)
            try:
                response = self.opener.open(req, timeout=30)
            except urllib.error.HTTPError as exc:
                response = exc
            with response:
                status = response.code
                self.trace.append({'method': method, 'path': parts.path, 'status': status})
                if status in (301, 302, 303, 307, 308):
                    if method == 'POST' and status in (307, 308):
                        raise LoginError('인증 POST 재전송 중단')
                    url = urllib.parse.urljoin(url, response.headers.get('Location', ''))
                    target = urllib.parse.urlsplit(url)
                    target = target._replace(path=target.path or '/')
                    if (target.scheme != 'https' or target.hostname != origin.hostname or
                            target.port not in (None, 443) or target.username or target.password or
                            target.query or target.path not in {'/', '/main/index.php', self.cart_path, self.login_path}):
                        raise LoginError('허용 범위 밖 리다이렉트 중단')
                    self.diagnostics.append({'redirect_host': target.hostname,
                                             'redirect_path': target.path,
                                             'redirect_followed': False})
                    check_stop_signal(response.read().decode('utf-8', errors='replace'))
                    if method != 'POST':
                        raise LoginError('추가 조회 리다이렉트 중단')
                    return ''
                if status != 200:
                    raise LoginError('비정상 HTTP 응답으로 중단')
                raw = response.read()
                if response.headers.get('Content-Encoding', '').lower() == 'gzip':
                    raw = gzip.decompress(raw)
                text = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
                if method == 'POST' and self.vendor == 'bofeel':
                    self.diagnostics.append({'content_type': response.headers.get_content_type(),
                                             'bom': text.startswith('\ufeff'),
                                             'json_like': text.lstrip('\ufeff \r\n\t').startswith(('{', '[')),
                                             'response_kind': response_kind(text)})
                check_stop_signal(text)
                return text
        raise LoginError('리다이렉트 한도 초과')

    def login(self, username, password):
        if self.attempted:
            raise LoginError('자동 재시도 금지')
        self.attempted = True
        html = self.request(self.login_path)
        form = LoginForm('flogin' if self.vendor == 'eroum' else 'formLogin')
        form.feed(html)
        if self.vendor == 'eroum':
            if not {'mb_id', 'mb_password', 'url'} <= form.fields.keys():
                raise LoginError('로그인 폼 변경')
            result = self.request(self.post_path, dict(mb_id=username, mb_password=password, url='/'))
            outcome = {'login_response_kind': response_kind(result)}
        else:
            if not {'mode', 'returnUrl', 'secretKey', 'encryptFl'} <= form.fields.keys():
                raise LoginError('로그인 폼 변경')
            if not form.fields['secretKey'] or form.fields['encryptFl'] != 'Y':
                raise LoginError('암호화 설정 변경')
            fields = dict(form.fields)
            fields['loginId'] = encrypt_bofeel(username, fields['secretKey'])
            fields['loginPwd'] = encrypt_bofeel(password, fields['secretKey'])
            result = self.request(self.post_path, fields)
            kind = response_kind(result)
            # $.post에는 dataType 지정이 없다. HTML은 성공도 실패도 확정하지 않는다.
            if kind == 'json':
                try:
                    data = json.loads(result.lstrip('\ufeff \r\n\t'))
                except ValueError:
                    raise LoginError('로그인 JSON 응답 형식 미확인') from None
                check_stop_signal(json.dumps(data, ensure_ascii=False))
                if not isinstance(data, dict) or 'code' in data or 'message' in data:
                    raise LoginError('로그인 JSON 실패 분기')
            outcome = {'login_response_kind': kind}
        cart = self.request(self.cart_path)
        if '로그아웃' not in cart:
            raise LoginError('장바구니 로그인 상태 미확인')
        return dict(outcome, cart_logout=True, authenticated=True)

    def clear(self):
        self.cookies.clear()
