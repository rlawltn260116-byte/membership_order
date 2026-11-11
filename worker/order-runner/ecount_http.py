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
import uuid

PORTAL = 'https://c-portal.ecount.com'
UA = 'Mozilla/5.0'
# 화면 스크립트(cs_login)가 쓰는 API. 모두 JSON 본문 POST이며 /ec56/api 경로는 본문 암호화가 없다.
ZONE_API = '/ec56/api/login/action/GetZoneAction'
TS_API = '/ec56/api/login/action/GetZoneInfoAction'
LOGIN_PROCESSOR = '/ec56/view/login/cs_login_processor'
ORDER_INPUT_PAGE = '/ECERP/SVC/CSA/ESD004M'
ORDER_LIST_PAGE = '/ECERP/SVC/CSA/ESD005M'
ORDER_LIST_API = '/ECAPI/SVC/Common/SlipTransfer/GetListXFormSlipCommon'
FORM_VIEW_API = '/ECAPI/Common/Form/GetFormView'
PRODUCT_SEARCH_API = '/ECAPI/SVC/Inventory/Basic/GetListProdForSearchPopup'
# 이 모듈이 보내는 POST의 전부다. 저장·전표·삭제 주소는 허용하지 않는다.
READ_POST_PATHS = {ZONE_API, TS_API, LOGIN_PROCESSOR, ORDER_INPUT_PAGE}
READ_POST_PATHS.add(PRODUCT_SEARCH_API)
READ_POST_PATHS.update({ORDER_LIST_PAGE, ORDER_LIST_API, FORM_VIEW_API})
SEARCH_CONTEXT_FIELDS = (
    'PARAM', 'CANCEL', 'INPUT_PROGRAM_ID', 'INPUT_CUST', 'INPUT_WH_CD',
    'INPUT_WH_CD_T', 'INPUT_IO_CODE', 'BARCODE_SEARCH', 'SERIAL_DATE',
    'PROD_SEARCH_TYPE', 'DecP', 'errorInfo', 'SerialList',
)
MYEONGSEONG_DELIVERY_FIELDS = {
    'recipient': 'remarks', 'phone': 'p_remarks1', 'address': 'p_remarks2',
    'memo': 'ADD_TXT_01',
}
# 세비앙: 기존 주문서 20건의 상단 필드 형태(P_DES4 전화 20/20, P_DES5 주소 19/20, P_DES6 장문,
# P_DES3 값 14종)에서 추정한 매핑이다. 화면 라벨은 확인하지 못했으므로 추정 상태다.
SEBIAN_DELIVERY_FIELDS = {
    'recipient': 'P_DES3', 'phone': 'P_DES4', 'address': 'P_DES5', 'memo': 'P_DES6',
}
HEADER_DELIVERY_MAPPINGS = (SEBIAN_DELIVERY_FIELDS,)


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
    if compression not in ('', 'ecbzip'):
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
    return parse_screen_page(html, 'ESD004M')


def parse_screen_page(html, screen_name):
    """조회 화면 JSON만 해독한다. 독립 HTTP 응답은 화면 ID가 비어 있다."""
    if screen_name not in ('ESD004M', 'ESD005M'):
        raise EcountError('허용하지 않은 화면')
    match = re.search(r'window\s*\[\s*[\'"]viewBag[\'"]\s*\+\s*[\'"](' +
                      screen_name + r'_[^\'"]+|)[\'"]\s*\]\s*=\s*\$\.xextend\(', html)
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
            decoded = _decode_viewbag_xor(encrypted)
            inventory = decoded.get('ecount.config.inventory', {})
            data['LookupConfig'] = {k: inventory[k] for k in (
                'OUT_DEC_P', 'OUT_DEC_Q', 'CS_MIN_ORDER_QTY') if k in inventory}
            data['LookupConfig']['MIN_ORDER_POLICY_BY_ID'] = decoded.get('ecount.user', {}).get('CS_MIN_ORDER_QTY')
            data.update({k: v for k, v in decoded.items() if '.' not in k})
        if not match.group(1) and data.get('ProgramInfo', {}).get('PROGRAM_ID') != {
                'ESD004M': 'E040203', 'ESD005M': 'E040204'}[screen_name]:
            raise ValueError()
        if screen_name == 'ESD004M':
            view = data['InitDatas']['ViewData']
            if not isinstance(view['Master'], dict) or not isinstance(view['Details'], list):
                raise ValueError()
            # 품목 조회·초안 작성에는 계정의 암호 필드가 필요하지 않다.
            for account in data['InitDatas'].get('CustPassModifyData') or []:
                if isinstance(account, dict):
                    account.pop('PASSWORD', None)
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
    # c04.setRequestParameter와 copyParamToRequestData: 실제 검색 조건은 PARAM이다.
    data['PARAM'] = keyword
    # 실제 본문은 Request.Data와 루트에 중복된다. CANCEL은 내부에만 있다.
    return {'Request': {'Data': data}, **{k: copy.deepcopy(v) for k, v in data.items() if k != 'CANCEL'}}


def product_context_from_screen(screen_data):
    """신규 주문 화면과 해당 업체 설정에서 빈 그리드 검색 문맥을 만든다."""
    try:
        opt, init = screen_data['DefaultOption'], screen_data['InitDatas']
        master, warehouse = init['ViewData']['Master'], init.get('CustWhData') or {}
        if opt['PROGRAM_ID'] != 'E040203' or not opt['isFromCS']:
            raise ValueError()
        return {
            'PARAM': '', 'CANCEL': 'N', 'INPUT_PROGRAM_ID': opt['PROGRAM_ID'],
            'INPUT_CUST': master['CUST'], 'INPUT_WH_CD': warehouse.get('WH_CD', ''),
            'INPUT_WH_CD_T': '', 'INPUT_IO_CODE': master.get('IO_TYPE', ''),
            'BARCODE_SEARCH': 'N', 'SERIAL_DATE': opt['serialTime'],
            'PROD_SEARCH_TYPE': '', 'DecP': screen_data['LookupConfig']['OUT_DEC_P'],
            'errorInfo': {'programId': opt['PROGRAM_ID'], 'pageId': '', 'menuTitle': '주문서입력'},
            'SerialList': [],
        }
    except (KeyError, TypeError, ValueError):
        raise EcountError('신규 주문 화면의 검색 문맥 변경') from None


def order_query_context(screen_data):
    """조회 화면의 기본 기간·양식만 사용한다. 검색 결과와 수취인 값은 복사하지 않는다."""
    try:
        opt = screen_data['DefaultOption']
        if opt['PROGRAM_ID'] != 'E040204':
            raise ValueError()
        return {
            'MENU_SEQ': opt['MENU_SEQ'], 'FORM_SER': 1, 'PRG_ID': opt['PROGRAM_ID'],
            'FORM_TYPE': opt['outputFormType'], 'FORM_SEQ': opt['basicFormSeq'],
            'BASE_DATE_FROM': opt['BASE_DATE_FROM'], 'BASE_DATE_TO': opt['BASE_DATE_TO'],
            'PAGE_CURRENT': 1, 'PAGE_SIZE': 20, 'P_FLAG': '', 'GB_TYPE': '', 'PARAM': '',
            'SEARCH_CRITERIA': {}, 'QUICK_SEARCH_TYPE': '', 'PROD_CD': '', 'REMARKS': '',
        }
    except (KeyError, TypeError, ValueError):
        raise EcountError('주문 조회 화면 문맥 변경') from None


def serialize_add_text_dto(order_date, *, master_text=None, detail_text=()):
    """화면 이벤트의 추가문자 직렬화를 오프라인으로 재현한다. 요청을 보내지 않는다.

    빈 추가문자는 이벤트에서 제외된다. BizzClasCds는 빈 배열 행을 정리한 뒤에도
    헤더와 그리드 행마다 추가한 순서를 유지하는 화면 코드의 동작을 따른다.
    """
    dto = {k: [] for k in ('AddTxt', 'AddLTxt', 'AddNum', 'AddDate', 'AddCd', 'BizzClasCds')}
    rows = [('M', '0', master_text or {}), *[('T', str(no), values) for no, values in detail_text]]
    seen = set()
    for scope, number, values in rows:
        if not isinstance(values, dict) or (scope == 'T' and (
                not re.fullmatch(r'[1-9]\d*', number) or number in seen)):
            raise EcountError('추가문자 행 구조 오류')
        seen.add(number)
        dto['BizzClasCds'].append('ORD')
        entry = {}
        for field, value in values.items():
            if not re.fullmatch(r'ADD_TXT_0[1-6]', field) or not isinstance(value, str):
                raise EcountError('미검증 추가문자 필드')
            if value:
                entry[field] = value
        if entry:
            entry.update(SLIP_CLAS_CD=scope, Key={
                'BIZZ_CLAS_CD': 'ORD', 'ADD_ITEM_ID': order_date,
                'ADD_ITEM_NO': 0, 'ADD_ITEM_SNO': number,
            })
            dto['AddTxt'].append(entry)
    return dto


def create_order_draft(screen_data, product, quantity, *, order_date, due_date,
                       recipient, phone, address, memo='', delivery_fields=None):
    """네트워크 없는 검토용 초안. 저장 본문·URL·제출 함수는 만들지 않는다.

    배송 필드는 업체별 양식을 확인한 호출자가 명시해야 한다. 금액과 전체 저장
    본문은 미검증이므로 반환 객체를 전송 가능한 요청으로 취급하지 않는다.
    """
    if delivery_fields != MYEONGSEONG_DELIVERY_FIELDS and delivery_fields not in HEADER_DELIVERY_MAPPINGS:
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
        'hold_reasons': ['저장 금지', '전체 저장 본문과 금액·정책 검증 필요'],
        'dates': {'REQ_DATE': order_date, 'TIME_DATE': due_date},
        'line': {'PROD_CD': product['PROD_CD'], 'PROD_DES': product.get('PROD_DES', ''),
                 'SIZE_DES': product.get('SIZE_DES', ''), 'QTY': str(qty)},
        'delivery_target': 'master' if delivery_fields in HEADER_DELIVERY_MAPPINGS else 'detail',
        'delivery': {delivery_fields[k]: v for k, v in {
            'recipient': recipient, 'phone': phone, 'address': address, 'memo': memo,
        }.items()},
        # 수취인 데이터와 거래처 기본 주소를 섞지 않는다. 메모도 원문만 유지한다.
        'address_source': 'new', 'amounts_verified': False,
    }


def create_order_review(screen_data, product, quantity, *, order_date, due_date,
                        recipient, phone, address, memo='', delivery_fields=None):
    """세 업체 공통 검토 초안. 매핑 미확정이면 배송값을 필드에 배치하지 않고 보류한다."""
    draft = create_order_draft(screen_data, product, quantity, order_date=order_date,
        due_date=due_date, recipient=recipient, phone=phone, address=address, memo=memo,
        delivery_fields=delivery_fields or MYEONGSEONG_DELIVERY_FIELDS)
    draft['delivery_mapping_verified'] = delivery_fields == MYEONGSEONG_DELIVERY_FIELDS
    if not draft['delivery_mapping_verified']:
        draft.pop('delivery')
        draft['unmapped_delivery'] = dict(recipient=recipient, phone=phone, address=address, memo=memo)
        draft['hold_reasons'].append('업체 입력 화면의 배송 필드 매핑 미확정')
    return draft


def draft_save_projection(draft):
    """저장 스크립트와 비교할 일부 필드만 투영한다. 전체 요청·주소·메서드는 만들지 않는다."""
    if draft.get('kind') != 'ecount_review_draft' or draft.get('submission_ready') is not False:
        raise EcountError('검토용 초안 필요')
    detail = copy.deepcopy(draft['line'])
    master = copy.deepcopy(draft['dates'])
    add_text = {}
    for field, value in draft.get('delivery', {}).items():
        if draft.get('delivery_target') == 'master':
            master[field] = value
        elif field.startswith('ADD_TXT_'):
            add_text[field] = value
        else:
            detail[field.upper()] = value
    detail['Key'] = {'SER_NO': '1'}
    dto = serialize_add_text_dto(draft['dates']['REQ_DATE'], detail_text=[('1', add_text)])
    return {
        'Master': master, 'Details': [detail], 'AddDto': dto,
        'complete': False,
        'hold_reasons': ['전체 Request·Master·Details 미구현', '금액·세금·업체별 정책 미검증'] +
                        ([] if 'delivery' in draft else ['배송 필드 미배치']),
    }


def compute_line_amounts(product, quantity, decimals=0):
    """조회된 단가·세금 필드로 한 행의 금액을 오프라인 계산한다. 서버 검증이 아니다.

    부가세 별도·포함 단가가 같은 세율로 서로 맞는지 확인하고, 어긋나면 중단한다.
    """
    try:
        qty, rate = Decimal(str(quantity)), Decimal(str(product['VAT_RATE_BY'])) / 100
        price, gross = Decimal(str(product['PRICE'])), Decimal(str(product['PRICE_VAT_INCLUDE']))
        if product['VAT_YN'] not in ('Y', 'N') or qty <= 0 or not 0 <= rate < 1 or price < 0:
            raise ValueError()
    except (KeyError, TypeError, ValueError, InvalidOperation):
        raise EcountError('금액 계산 필드 누락') from None
    unit = Decimal(1).scaleb(-decimals)
    expected_gross = (price * (1 + rate)).quantize(unit)
    if product['VAT_YN'] == 'N' and abs(expected_gross - gross) > unit:
        raise EcountError('단가와 부가세 포함 단가 불일치')
    supply = (price * qty).quantize(unit)
    vat = (supply * rate).quantize(unit)
    return {'supply_amt': supply, 'vat_amt': vat, 'total': supply + vat,
            'server_verified': False}


def review_product_policy(screen_data, product, quantity):
    """조회값의 형식·최소수량만 판정한다. 단가·금액 원문이나 전체 검증 성공을 반환하지 않는다."""
    price_fields = ('PRICE', 'PRICE_VAT_INCLUDE', 'PRICE_VAT_YN', 'VAT_YN', 'VAT_RATE_BY')
    result = {'price_fields_present': all(k in product for k in price_fields),
              'minimum_quantity_valid': False, 'minimum_satisfied': None,
              'minimum_policy_resolved': False, 'amounts_verified': False}
    try:
        qty, minimum = Decimal(str(quantity)), Decimal(str(product['CS_MIN_ORDER_QTY']))
        if not qty.is_finite() or qty <= 0 or not minimum.is_finite() or minimum < 0:
            raise ValueError()
        config = screen_data['LookupConfig']
        mode = config.get('MIN_ORDER_POLICY_BY_ID')
        if mode in (None, 'B'):
            mode = config.get('CS_MIN_ORDER_QTY')
        result['minimum_quantity_valid'] = True
        result['minimum_policy_resolved'] = mode in ('Y', 'N')
        if mode in ('Y', 'N'):
            result['minimum_satisfied'] = mode == 'N' or qty >= minimum
    except (KeyError, TypeError, ValueError, InvalidOperation):
        pass
    return result


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

    def load_order_input_data(self, navigation_context=None):
        """관찰한 메뉴 이동 POST로 초기 데이터를 읽는다. 저장 요청은 보내지 않는다.

        화면 정의 JSON은 HTML의 viewBag에 들어 있다. 관찰한 여섯 필드에 새 화면
        식별자를 넣고 초기화·다시 작성·저장 요청을 보내지 않는다.
        """
        self._require_login()
        if navigation_context is None:
            navigation_context = self.navigation_context('E040203')
        fields = ('alreadyIncludedLayout', 'requestKey', 'viewer_id', 'panel_id',
                  'is_from_left_menu', 'PRG_ID')
        if not isinstance(navigation_context, dict) or any(k not in navigation_context for k in fields):
            raise EcountError('메뉴 이동 문맥 누락')
        body = {k: copy.deepcopy(navigation_context[k]) for k in fields}
        _, _, html = self._read_post(ORDER_INPUT_PAGE, body)
        return parse_order_input_page(html)

    @staticmethod
    def navigation_context(program_id):
        if program_id not in ('E040203', 'E040204'):
            raise EcountError('허용하지 않은 메뉴')
        page = {'E040203': 'ESD004M', 'E040204': 'ESD005M'}[program_id]
        return {'alreadyIncludedLayout': True, 'requestKey': page + '_' + uuid.uuid4().hex,
                'viewer_id': '', 'panel_id': '', 'is_from_left_menu': True, 'PRG_ID': program_id}

    def load_order_list_data(self):
        self._require_login()
        _, _, html = self._read_post(ORDER_LIST_PAGE, self.navigation_context('E040204'))
        return parse_screen_page(html, 'ESD005M')

    def query_orders(self, context):
        """현재 화면의 검색 조건을 복사해 읽기 조회한다. 반환 원문은 메모리 전용이다."""
        self._require_login()
        required = ('PRG_ID', 'BASE_DATE_FROM', 'BASE_DATE_TO', 'PAGE_CURRENT', 'PAGE_SIZE')
        if not isinstance(context, dict) or any(k not in context for k in required):
            raise EcountError('주문 조회 문맥 누락')
        if context['PRG_ID'] != 'E040204':
            raise EcountError('허용하지 않은 조회 프로그램')
        _, headers, text = self._read_post(ORDER_LIST_API, {'Request': {'Data': copy.deepcopy(context)}}, xce=True)
        data = self._decode_response(text, compression=headers.get('X-Compression', '')).get('Data')
        if not isinstance(data, dict) or not isinstance(data.get('Data'), list):
            raise EcountError('주문 조회 결과 구조 변경')
        return {'items': data['Data'], 'total_count': data.get('TotalCount')}

    def lookup_products(self, keyword, context):
        """검색과 정확한 품목코드 선택에 쓰는 읽기 POST. 응답 원문을 기록하지 않는다."""
        self._require_login()
        _, headers, text = self._read_post(PRODUCT_SEARCH_API, build_product_search_body(context, keyword), xce=True)
        result = self._decode_response(text, compression=headers.get('X-Compression', ''))
        data = result.get('Data') or {}
        if not isinstance(data, dict) or not isinstance(data.get('Data'), list):
            raise EcountError('품목 조회 결과 구조 변경')
        return {'items': data['Data'], 'total_count': data.get('TotalCount')}

    def load_input_form(self, screen_data):
        """화면이 지정한 입력 양식의 열 정의를 조회한다."""
        self._require_login()
        try:
            key = screen_data['DefaultOption']['FormKey']
            if key['FORM_TYPE'] != 'OI020':
                raise ValueError()
            body = dict(FormType=key['FORM_TYPE'], FormSeq=key['FORM_SEQ'],
                        FormTypeMaster=None, ReturnType=None, BasicType=None,
                        IsConvertColumnCode=None, ViewType=None)
        except (KeyError, TypeError, ValueError):
            raise EcountError('주문 입력 양식 문맥 변경') from None
        _, headers, text = self._read_post(FORM_VIEW_API, body, xce=True)
        data = self._decode_response(text, compression=headers.get('X-Compression', '')).get('Data')
        if not isinstance(data, dict) or not isinstance(data.get('columns'), list):
            raise EcountError('주문 입력 양식 구조 변경')
        return data

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
