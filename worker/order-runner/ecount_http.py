"""이카운트 거래처 포털의 HTTP 로그인·조회 어댑터와 검토용 주문 초안.

운영 큐와 연결하지 않았다. 표준 라이브러리만 쓴다. 쿠키는 세션 객체 메모리에만 있고
디스크에 저장하지 않으며, 로그인 POST는 객체당 한 번만 보낸다(자동 재시도 금지).
주문 저장·전송 기능은 없다.
"""
import base64
import copy
import datetime
from decimal import Decimal, InvalidOperation
import gzip
import http.cookiejar
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request

PORTAL = 'https://c-portal.ecount.com'
UA = 'Mozilla/5.0'
# 화면 스크립트(cs_login)가 쓰는 API. 모두 JSON 본문 POST이며 /ec56/api 경로는 본문 암호화가 없다.
ZONE_API = '/ec56/api/login/action/GetZoneAction'
TS_API = '/ec56/api/login/action/GetZoneInfoAction'
LOGIN_PROCESSOR = '/ec56/view/login/cs_login_processor'
ORDER_INPUT_PAGE = '/ECERP/SVC/CSA/ESD004M'
PRODUCT_SEARCH_API = '/ECAPI/SVC/Inventory/Basic/GetListProdForSearchPopup'
# 이 모듈이 보내는 POST의 전부다. 저장·전표·삭제 주소는 허용하지 않는다.
READ_POST_PATHS = {ZONE_API, TS_API, LOGIN_PROCESSOR, ORDER_INPUT_PAGE}
READ_POST_PATHS.add(PRODUCT_SEARCH_API)
SEARCH_CONTEXT_FIELDS = (
    'PARAM', 'CANCEL', 'INPUT_PROGRAM_ID', 'INPUT_CUST', 'INPUT_WH_CD',
    'INPUT_WH_CD_T', 'INPUT_IO_CODE', 'BARCODE_SEARCH', 'SERIAL_DATE',
    'PROD_SEARCH_TYPE', 'DecP', 'errorInfo', 'SerialList',
)
MYEONGSEONG_DELIVERY_FIELDS = {
    'recipient': 'remarks', 'phone': 'p_remarks1', 'address': 'p_remarks2',
    'memo': 'ADD_TXT_01',
}


class EcountError(Exception):
    pass


class StopSignalError(EcountError):
    """잠금·캡차·추가 인증 신호. 추가 요청 없이 멈춘다."""


def encode_password(password, token):
    """cs_login.js execCsLoginProc의 `ecProtHPr.AX`: UTF-8 바이트를 token 글자와 XOR한 16진수.

    서버로 가는 값은 `len(token) + token + hex`다.
    """
    if not token or not token.isdigit():
        raise EcountError('토큰 형식 오류')
    key = token.encode()
    data = password.encode('utf-8')
    payload = ''.join('%02x' % (b ^ key[i % len(key)]) for i, b in enumerate(data))
    return str(len(token)) + token + payload


def make_token(now_ms=None):
    """스크립트는 `(Date.now()+'').substring(0, 7)`을 쓴다."""
    return str(int(time.time() * 1000) if now_ms is None else int(now_ms))[:7]


def zone_host(zone, domain):
    """makeZoneHost: 현재 호스트가 c-portal이면 `c-portal` + zone + domain."""
    if not re.fullmatch(r'[A-Za-z]{1,2}', zone or '') or not re.fullmatch(r'\.[a-z0-9.-]+', domain or ''):
        raise EcountError('zone 형식 오류')
    return 'https://c-portal' + zone + domain


def build_login_fields(cs_com_code, com_code, user_id, password, ts, zone, domain, *, token=None):
    """loginForm hidden 필드(`passwd` 평문은 없다)."""
    return {
        'cs_com_code': cs_com_code, 'com_code': com_code, 'id': user_id,
        'spasswd': encode_password(password, token or make_token()),
        'loginck': '', 'ts': ts, 'login_type': 'C', 'domain': domain, 'lan_type': 'ko-KR',
        'zone': zone, 'error_code': '', 'error_msg': '', 'platformVersion': '',
    }


def check_stop_signal(text):
    lowered = text.lower()
    if any(m in lowered for m in ('captcha', 'recaptcha', 'otp', '2단계 인증', '추가 인증', '계정이 잠',
                                  '로그인 실패 횟수', '실패횟수', '계정 잠금', '계정잠금',
                                  '계정이 잠겼', '접근이 차단')):
        raise StopSignalError('실패 횟수·잠금·캡차·추가 인증 신호로 중단')


def response_kind(text):
    stripped = text.lstrip('﻿ \r\n\t')
    if stripped.startswith(('{', '[')):
        return 'json'
    if re.search(r'id\s*=\s*[\'"]loginForm[\'"]', text):
        return 'login_form_html'
    if re.search(r'name\s*=\s*[\'"]frmError[\'"]|id\s*=\s*[\'"]frmError[\'"]', text):
        return 'error_form_html'
    if re.search(r'<(?:html|!doctype|script)\b', stripped, re.I):
        return 'html'
    return 'empty' if not stripped else 'text'


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def _ecount_host(url):
    parts = urllib.parse.urlsplit(url)
    return (parts.scheme == 'https' and not parts.username and parts.port in (None, 443)
            and (parts.hostname or '').endswith('.ecount.com'))


def decode_api_response(text, *, compression=''):
    """관찰된 JSON 또는 Base64(UTF-8 JSON)를 해독한다. 실패 본문은 오류에 넣지 않는다."""
    if compression:
        raise EcountError('미검증 응답 압축 방식')
    try:
        try:
            result = json.loads(text)
        except (ValueError, TypeError):
            result = json.loads(base64.b64decode(text, validate=True).decode('utf-8'))
    except (ValueError, TypeError, UnicodeError):
        raise EcountError('조회 응답 형식 변경') from None
    if not isinstance(result, dict):
        raise EcountError('조회 응답 객체 없음')
    # 품목명이나 정적 스크립트가 아닌, 서버의 오류 메시지만 검사한다.
    error_text = json.dumps({k: result.get(k) for k in ('Error', 'Errors', 'Message')}, ensure_ascii=False)
    check_stop_signal(error_text)
    if str(result.get('Status', '200')) != '200' or result.get('Error') or result.get('Errors'):
        raise EcountError('조회 응답 오류로 중단')
    return result


def _decode_viewbag_xor(value):
    """String.decryptXor: 첫 글자=키 길이, 다음 글자들=키, 나머지=16진 바이트."""
    try:
        size = int(value[0])
        key, payload = value[1:1 + size], bytes.fromhex(value[1 + size:])
        if not key or len(key) != size:
            raise ValueError()
        raw = bytes(b ^ ord(key[i % size]) for i, b in enumerate(payload))
        result = json.loads(raw.decode('utf-8'))
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except (ValueError, TypeError, IndexError, UnicodeError):
        raise EcountError('화면 데이터 해독 실패') from None


def parse_order_input_page(html):
    """ESD004M의 $.xextend 첫 JSON과 _x_를 읽는다. JavaScript는 실행하지 않는다.

    반환값에는 거래처 문맥이 있으므로 메모리에서만 사용한다. 점이 들어간 전역 설정은
    브라우저의 전역 부수 효과에 해당하므로 반환하지 않는다.
    """
    match = re.search(r'window\s*\[\s*[\'"]viewBag[\'"]\s*\+\s*[\'"]ESD004M_[^\'"]+[\'"]\s*\]\s*=\s*\$\.xextend\(', html)
    if not match:
        raise EcountError('주문 입력 화면 데이터 없음')
    try:
        start = match.end()
        while start < len(html) and html[start].isspace():
            start += 1
        data, _ = json.JSONDecoder().raw_decode(html, start)
        if not isinstance(data, dict) or data.get('_e_'):
            raise ValueError()
        encrypted = data.pop('_x_', '')
        if encrypted:
            data.update({k: v for k, v in _decode_viewbag_xor(encrypted).items() if '.' not in k})
        view = data['InitDatas']['ViewData']
        if not isinstance(view['Master'], dict) or not isinstance(view['Details'], list):
            raise ValueError()
        return data
    except (ValueError, TypeError, KeyError):
        raise EcountError('주문 입력 화면 구조 변경') from None


def build_product_search_body(context, keyword):
    """화면에서 얻은 문맥을 복사한다. PARAM 등을 추측하거나 다른 업체에서 재사용하지 않는다."""
    if not isinstance(context, dict) or any(k not in context for k in SEARCH_CONTEXT_FIELDS):
        raise EcountError('품목 조회 문맥 누락')
    if not isinstance(keyword, str) or not keyword.strip():
        raise EcountError('검색어 없음')
    data = {k: copy.deepcopy(context[k]) for k in SEARCH_CONTEXT_FIELDS}
    data['keyword'] = keyword
    # 실제 본문은 Request.Data와 루트에 중복된다. CANCEL은 내부에만 있다.
    return {'Request': {'Data': data}, **{k: copy.deepcopy(v) for k, v in data.items() if k != 'CANCEL'}}


def create_order_draft(screen_data, product, quantity, *, order_date, due_date,
                       recipient, phone, address, memo='', delivery_fields=None):
    """네트워크 없는 검토용 초안. 저장 본문·URL·제출 함수는 만들지 않는다.

    배송 필드는 업체별 양식을 확인한 호출자가 명시해야 한다. 특히 ADD_TXT_01의
    AddDto 직렬화는 미검증이므로 저장 가능한 본문으로 취급하지 않는다.
    """
    if delivery_fields != MYEONGSEONG_DELIVERY_FIELDS:
        raise EcountError('검증된 업체별 배송 필드 매핑 필요')
    for value in (order_date, due_date):
        try:
            if not isinstance(value, str) or not re.fullmatch(r'\d{8}', value):
                raise ValueError()
            datetime.datetime.strptime(value, '%Y%m%d')
        except (ValueError, TypeError):
            raise EcountError('일자 형식 오류') from None
    try:
        qty = Decimal(str(quantity))
        if isinstance(quantity, bool) or not qty.is_finite() or qty <= 0:
            raise ValueError()
    except (InvalidOperation, ValueError, TypeError):
        raise EcountError('수량 형식 오류') from None
    if any(not isinstance(v, str) or not v.strip() for v in (recipient, phone, address)) or not isinstance(memo, str):
        raise EcountError('신규 배송 정보 누락')
    try:
        master = screen_data['InitDatas']['ViewData']['Master']
        if not isinstance(master, dict) or not isinstance(product, dict) or not product.get('PROD_CD'):
            raise ValueError()
    except (ValueError, TypeError, KeyError):
        raise EcountError('초안의 화면·품목 정보 누락') from None
    return {
        'kind': 'ecount_review_draft', 'submission_ready': False,
        'hold_reasons': ['저장 금지', '추가 필드 AddDto 직렬화와 업체별 양식 검증 필요'],
        'dates': {'REQ_DATE': order_date, 'TIME_DATE': due_date},
        'line': {'PROD_CD': product['PROD_CD'], 'PROD_DES': product.get('PROD_DES', ''),
                 'SIZE_DES': product.get('SIZE_DES', ''), 'QTY': str(qty)},
        'delivery': {delivery_fields[k]: v for k, v in {
            'recipient': recipient, 'phone': phone, 'address': address, 'memo': memo,
        }.items()},
        # 수취인 데이터와 거래처 기본 주소를 섞지 않는다. 메모도 원문만 유지한다.
        'address_source': 'new', 'amounts_verified': False,
    }


class EcountSession:
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cookies), _NoRedirect())
        self.trace = []  # 메서드·호스트·경로·상태만. 값은 넣지 않는다.
        self.login_sent = False
        self.login_attempted = False
        self.host = PORTAL
        self.authenticated = False
        self.stopped = False

    def _send(self, method, url, *, json_body=None, form=None, headers=None):
        if self.stopped:
            raise EcountError('중단된 세션')
        if not _ecount_host(url):
            raise EcountError('허용 범위 밖 주소')
        path = urllib.parse.urlsplit(url).path
        allowed_get = {'/', '/ec5/view/c_portal', ORDER_INPUT_PAGE}
        if (method == 'POST' and path not in READ_POST_PATHS) or (method == 'GET' and path not in allowed_get) or method not in {'GET', 'POST'}:
            raise EcountError('허용된 로그인·조회 요청이 아님')
        data, hdr = None, {'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'gzip'}
        if json_body is not None:
            data = json.dumps(json_body).encode()
            hdr.update({'Content-Type': 'application/json', 'Accept': 'application/json'})
        elif form is not None:
            data = urllib.parse.urlencode(form).encode()
            hdr['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
        hdr.update(headers or {})
        req = urllib.request.Request(url, data=data, headers=hdr, method=method)
        try:
            resp = self.opener.open(req, timeout=30)
        except urllib.error.HTTPError as exc:
            resp = exc
        except (urllib.error.URLError, OSError):
            self.stopped = True
            raise EcountError('요청 전송 실패로 중단, 재시도 금지') from None
        with resp:
            raw = resp.read()
            if resp.headers.get('Content-Encoding', '').lower() == 'gzip':
                raw = gzip.decompress(raw)
            parts = urllib.parse.urlsplit(url)
            self.trace.append({'method': method, 'host': parts.hostname, 'path': parts.path, 'status': resp.code})
            return resp.code, resp.headers, raw.decode('utf-8', errors='replace')

    def load_login_page(self):
        status, _, text = self._send('GET', PORTAL + '/')
        if status != 200 or 'loginForm' not in text:
            raise EcountError('로그인 화면 구조 변경')
        return text

    def get_zone(self, cs_com_code):
        status, _, text = self._send('POST', PORTAL + ZONE_API, json_body={'com_code': cs_com_code, 'service': 'CS'})
        if status != 200:
            raise EcountError('zone 조회 실패')
        data = (self._decode_response(text).get('Data') or {})
        if not data or data.get('EMPTY_ZONE') or not data.get('ZONE') or not data.get('COM_CODE'):
            raise EcountError('회사코드 조회 결과 없음')
        return {k: data.get(k, '') for k in ('ZONE', 'COM_CODE', 'DOMAIN')}

    def get_ts(self):
        status, _, text = self._send('POST', PORTAL + TS_API, json_body={})
        ts = ((self._decode_response(text).get('Data') or {}) if status == 200 else {}).get('ts')
        if not ts:
            raise EcountError('로그인 ts 발급 실패')
        return ts

    def login(self, cs_com_code, user_id, password):
        """로그인 POST 한 번. 결과는 구조 요약만 돌려준다(본문·쿠키 값 없음)."""
        if self.login_attempted:
            raise EcountError('자동 재시도 금지')
        self.login_attempted = True
        self.load_login_page()
        zone = self.get_zone(cs_com_code)
        ts = self.get_ts()
        fields = build_login_fields(cs_com_code, zone['COM_CODE'], user_id, password, ts,
                                    zone['ZONE'], zone['DOMAIN'])
        base = zone_host(zone['ZONE'], zone['DOMAIN'])
        self.login_sent = True  # 요청 전에 표시: 실패해도 재전송하지 않는다.
        status, headers, text = self._send('POST', base + LOGIN_PROCESSOR, form=fields,
                                           headers={'Origin': PORTAL, 'Referer': PORTAL + '/'})
        self.host = base
        try:
            check_stop_signal(text)
        except StopSignalError:
            self.stopped = True
            raise
        location = headers.get('Location', '')
        if status != 302 or not _ecount_host(location) or urllib.parse.urlsplit(location).path != '/ec5/view/c_portal':
            self.stopped = True
            raise EcountError('로그인 실패로 중단, 재시도 금지')
        self.login_location = location  # 메모리에만. 쿼리에 세션 의존 값이 있을 수 있다.
        self.login_body = text  # 메모리에만. 호출자가 구조 분석에 쓴다.
        self.authenticated = True
        return {'status': status, 'kind': response_kind(text),
                'location_host': urllib.parse.urlsplit(location).hostname,
                'location_path': urllib.parse.urlsplit(location).path,
                'cookie_names': sorted(c.name for c in self.cookies)}

    def follow_login_location(self):
        """로그인 응답이 가리킨 첫 화면을 그대로 GET한다(같은 이카운트 호스트만)."""
        return self.get(self.login_location)

    def sid_param(self):
        """화면 스크립트(getSessionParam)와 같이 모든 요청 쿼리에 `ec_req_sid`를 붙인다."""
        values = urllib.parse.parse_qs(urllib.parse.urlsplit(getattr(self, 'login_location', '')).query)
        sid = (values.get('ec_req_sid') or [''])[0]
        return ('ec_req_sid=' + urllib.parse.quote(sid)) if sid else ''

    def get(self, url_or_path):
        """로그인 후 조회 GET. `ec_req_sid`를 붙이고 리다이렉트는 따라가지 않는다."""
        url = urllib.parse.urljoin(self.host + '/', url_or_path)
        if 'ec_req_sid=' not in url and self.sid_param():
            url += ('&' if '?' in url else '?') + self.sid_param()
        status, headers, text = self._send('GET', url)
        if status != 200:
            self.stopped = True
            raise EcountError('조회 실패로 중단')
        return status, headers.get('Location', ''), text

    def load_order_input_data(self, navigation_context):
        """브라우저 메뉴 이동의 조회 POST 형식. HTTP 단독 실서버 재현은 아직 미검증이다.

        화면 정의 JSON은 HTML의 viewBag에 들어 있다. 메뉴 문맥은 현재 세션에서 얻은
        것을 전달하며 초기화·다시 작성·저장 요청을 보내지 않는다.
        """
        self._require_login()
        fields = ('alreadyIncludedLayout', 'requestKey', 'viewer_id', 'panel_id',
                  'is_from_left_menu', 'PRG_ID')
        if not isinstance(navigation_context, dict) or any(k not in navigation_context for k in fields):
            raise EcountError('메뉴 이동 문맥 누락')
        body = {k: copy.deepcopy(navigation_context[k]) for k in fields}
        _, _, html = self._read_post(ORDER_INPUT_PAGE, body)
        return parse_order_input_page(html)

    def lookup_products(self, keyword, context):
        """검색과 정확한 품목코드 선택에 쓰는 읽기 POST. 응답 원문을 기록하지 않는다."""
        self._require_login()
        _, headers, text = self._read_post(PRODUCT_SEARCH_API, build_product_search_body(context, keyword), xce=True)
        result = self._decode_response(text, compression=headers.get('X-Compression', ''))
        data = result.get('Data') or {}
        if not isinstance(data, dict) or not isinstance(data.get('Data'), list):
            raise EcountError('품목 조회 결과 구조 변경')
        return {'items': data['Data'], 'total_count': data.get('TotalCount')}

    def _decode_response(self, text, *, compression=''):
        try:
            return decode_api_response(text, compression=compression)
        except EcountError:
            self.stopped = True
            raise

    def _require_login(self):
        if not self.authenticated or self.stopped or not self.sid_param():
            raise EcountError('유효한 로그인 세션 필요')

    def _read_post(self, path, body, *, xce=False):
        url = self.host + path + '?' + self.sid_param()
        if xce:
            url += '&xce=none'
        status, headers, text = self._send('POST', url, json_body=body)
        if status != 200:
            self.stopped = True
            raise EcountError('조회 실패로 중단, 재시도 금지')
        return status, headers, text
