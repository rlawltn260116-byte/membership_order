"""고정 시험 상품의 HTTP 주문서 초안. 주문 전송과 운영 큐 접근은 없다."""
import argparse
import gzip
import html as html_lib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from http_cart import (CartSession, CartRow, Document, PRODUCTS, build_order_draft,
                       controls, parse_cart, serialize)
from http_login_draft import LoginError, StopSignalError, check_stop_signal


class PreparationSession(CartSession):
    def __init__(self, vendor):
        super().__init__(vendor)
        self.read_once = set()

    def read_preparation(self, path, fields=None):
        """승인된 조회만 허용한다. 상품 검사·검색은 응답 유실에도 반복하지 않는다."""
        if not self.authenticated or self.vendor != 'eroum':
            raise LoginError('이로움 인증 확인 후 조회만 허용')
        if fields is None:
            if path not in ('/shop/simple_order.php', '/shop/orderinquiry.php'):
                raise LoginError('조회 경로 범위 밖')
        else:
            if path != '/shop/ajax.get_item.php':
                raise LoginError('조회 POST 경로 범위 밖')
            if fields == [('it_id', PRODUCTS['eroum'][0])]:
                key = 'item'
            elif fields == [('keyword', 'DYJ-03'), ('contain', 'true'),
                            ('searchIn[]', 'it_name'), ('searchIn[]', 'it_model'),
                            ('searchIn[]', 'id'), ('searchIn[]', 'it_name_no_space')]:
                key = 'search'
            else:
                raise LoginError('상품 검사·검색 필드 범위 밖')
            if key in self.read_once:
                raise LoginError('상품 조회 재전송 금지')
            self.read_once.add(key)
        request = urllib.request.Request(self.origin + path,
            data=urllib.parse.urlencode(fields).encode() if fields is not None else None,
            headers={'User-Agent': 'Mozilla/5.0', 'Referer': self.origin + '/shop/simple_order.php',
                     'Origin': self.origin, 'X-Requested-With': 'XMLHttpRequest',
                     'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'})
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            self.trace.append({'method': request.get_method(), 'path': path, 'status': response.code})
            if response.code != 200:
                raise LoginError('조회 응답 미확인: 재전송 없이 중단')
            raw = response.read()
            if response.headers.get('Content-Encoding', '').lower() == 'gzip':
                raw = gzip.decompress(raw)
            text = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
            check_stop_signal(text)
            return text

    def order_identifiers(self):
        text = self.read_preparation('/shop/orderinquiry.php')
        if '로그아웃' not in text:
            raise LoginError('주문내역 인증 미확인')
        ids = set()
        for node in Document(text).root.all('a'):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(node.attrs.get('href', '')).query)
            ids.update(query.get('od_id', []))
        if not ids:
            raise LoginError('주문내역 첫 페이지 식별자 미확인')
        return ids


def product_object(data):
    """검사 응답에 전체 객체가 없으면 None. 상품 선택은 승인된 ID 하나로 제한한다."""
    if isinstance(data, dict) and data.get('it_id') == PRODUCTS['eroum'][0] and 'options' in data:
        return data
    candidates = data if isinstance(data, list) else data.get('data', []) if isinstance(data, dict) else []
    if isinstance(candidates, list):
        matches = [x for x in candidates if isinstance(x, dict) and x.get('it_id') == PRODUCTS['eroum'][0]]
        if len(matches) == 1:
            return matches[0]
    return None


def eroum_product_fields(source, obj):
    """저장된 select_item의 기본 옵션 1개 분기만 재현한다. 단가·필드는 메모리에만 둔다."""
    if obj.get('it_id') != PRODUCTS['eroum'][0] or obj.get('options') != []:
        raise LoginError('승인 상품·기본 옵션 미확인')
    if obj.get('stock_status') in ('soldout', 'temp_soldout'):
        raise LoginError('품절 상품 중단')
    if str(obj.get('it_buy_inc_qty')) != '1':
        raise LoginError('증가 수량 1 미확인')
    if obj.get('io_type') not in (None, '', '0'):
        raise LoginError('기본 상품 유형 아님')
    # 소스의 hidden input 순서와 중복 it_price[]를 그대로 보존한다.
    keys = ['it_id', 'it_price', 'it_buy_min_qty', 'it_buy_max_qty', 'it_buy_inc_qty',
            'it_price', 'it_sc_type', 'it_sc_qty', 'it_sc_minimum', 'it_sc_price',
            'it_even_odd', 'it_even_odd_price', 'io_type', 'io_price',
            'ca_id', 'ca_id2', 'ca_id3', 'ca_id_delivery', 'cp_price', 'stock_status']
    required = set(keys) - {'io_type', 'io_price', 'ca_id', 'ca_id2', 'ca_id3', 'ca_id_delivery', 'cp_price'}
    if not required <= obj.keys():
        raise LoginError('상품 객체 필수 속성 누락')
    # JS ct_price는 parseInt(obj.it_price)다. 정수 문자열이 아니면 parseInt 결과를
    # 추측하지 않고 멈춘다. io_price는 기본 상품 분기에서 가격 계산에 쓰지 않는다.
    if isinstance(obj['it_price'], bool) or not re.fullmatch(r'\d+', str(obj['it_price'])):
        raise LoginError('단가 형식 미확인')
    if 'function select_item(obj, io_id, ct_qty)' not in source:
        raise LoginError('상품 렌더러 변경')
    for key in set(keys) | {'io_id', 'ct_qty', 'prodMemo', 'ct_price'}:
        if key + '[]' not in source:
            raise LoginError('상품 렌더러 필드 변경')
    category = next((obj.get(k) for k in ('ca_id2', 'ca_id3')
                     if re.match(r'^(70_0|70x0)', str(obj.get(k) or ''))), obj.get('ca_id') or '')
    # JS 문자열 연결은 누락 속성을 "undefined"로 만든다. 옵션 없는 기본
    # 상품은 이 숨은 값을 가격에 사용하지 않는다. 0이나 빈 값으로 보정하지 않는다.
    def js_string(value):
        if value is None:
            return 'null'
        if isinstance(value, bool):
            return str(value).lower()
        return str(value)

    derived = {'io_type': '0', 'ca_id_delivery': category, 'cp_price': '',
               **{k: obj.get(k) or '' for k in ('ca_id', 'ca_id2', 'ca_id3')}}
    fields = [(key + '[]', js_string(derived[key] if key in derived else obj[key])
               if key in derived or key in obj else 'undefined') for key in keys]
    fields += [('io_id[]', ''), ('prodMemo[]', ''), ('ct_qty[]', '1'), ('ct_price[]', str(int(str(obj['it_price']))))]
    return fields


def eroum_draft(source, obj, recipient):
    form = Document(source).form('simple_order')
    if any(n.attrs['name'] in {'it_id[]', 'io_id[]', 'ct_qty[]', 'prodMemo[]'} for n in controls(form)):
        raise LoginError('기존 상품 필드가 있는 주문서는 합치지 않음')
    fields = eroum_product_fields(source, obj)
    # 원문 대신 해당 폼의 직렬화된 기본값과 실제 소스에서 확인한 신규 배송지 표지만 사용한다.
    new_mode = any(n.has_class('ad_sel_addr') and n.attrs.get('data-value') == 'new'
                   and n.text() == '신규 배송지' for n in form.all())
    if not new_mode:
        raise LoginError('신규 배송지 구조 미확인')
    def input_tag(pair):
        return '<input name="{}" value="{}">'.format(*(html_lib.escape(str(v), quote=True) for v in pair))
    memory_form = '<form id="simple_order" action="{}">'.format(html_lib.escape(form.attrs.get('action', ''), quote=True))
    memory_form += '<span class="ad_sel_addr" data-value="new">신규 배송지</span>'
    memory_form += ''.join(map(input_tag, serialize(form) + fields)) + '</form>'
    row = CartRow(PRODUCTS['eroum'][0], 'DYJ-03', '', 1, '', '', '')
    draft = build_order_draft('eroum', memory_form, row, recipient)
    draft.report['dynamic_product_field_names'] = sorted({k for k, _ in fields})
    draft.report['totals_recalculated'] = False
    draft.report['scope'] = '상품·신규 배송지 필드 구조 대조 초안, 제출 불가'
    return draft


def prepare_eroum(session, recipient, save_response=None):
    initial = parse_cart('eroum', session.cart_html)
    initial.require_empty()
    before = session.order_identifiers()
    source = session.read_preparation('/shop/simple_order.php')
    if '로그아웃' not in source:
        raise LoginError('주문서 인증 미확인')
    raw = session.read_preparation('/shop/ajax.get_item.php', [('it_id', PRODUCTS['eroum'][0])])
    if save_response:
        save_response('item', raw)
    data = json.loads(raw)
    # 각 요청 직후 상태를 확인한다. 달라지면 다음 조회도 하지 않는다.
    session.get_cart().require_empty()
    if session.order_identifiers() != before:
        raise LoginError('상품 검사 후 주문내역 변경')
    if not isinstance(data, dict) or any(str(data.get(k)) == '1' for k in ('is_buy', 'soldout_ck')):
        raise LoginError('상품 구매 가능 여부 미확인 또는 제한')
    if not {'is_buy', 'soldout_ck'} <= data.keys():
        raise LoginError('상품 검사 응답 구조 미확인')
    obj = product_object(data)
    if obj is None:
        raw = session.read_preparation('/shop/ajax.get_item.php',
            [('keyword', 'DYJ-03'), ('contain', 'true'), ('searchIn[]', 'it_name'),
             ('searchIn[]', 'it_model'), ('searchIn[]', 'id'), ('searchIn[]', 'it_name_no_space')])
        if save_response:
            save_response('search', raw)
        obj = product_object(json.loads(raw))
        session.get_cart().require_empty()
        if session.order_identifiers() != before:
            raise LoginError('상품 검색 후 주문내역 변경')
    if obj is None:
        raise LoginError('승인 상품 검색 객체 미확인')
    draft = eroum_draft(source, obj, recipient)
    try:
        report = draft.safe_summary()
        if not report['valid']:
            raise LoginError('상품·신규 배송지 필드 대조 실패')
        session.get_cart().require_empty()
        return dict(draft=report, final_empty=True, history_unchanged=True,
                    history_identifier_count=len(before), catalog_requests=len(session.read_once))
    finally:
        draft.clear()


def prepare_bofeel(session, recipient):
    initial = parse_cart('bofeel', session.cart_html)
    initial.require_empty()
    cart = session.add_one(initial)
    draft = None
    cleanup_allowed = True
    try:
        draft = session.order_draft(recipient)
        report = draft.safe_summary()
        if not report['valid']:
            raise LoginError('보필 상품·직접 입력 필드 대조 실패')
    except StopSignalError:
        cleanup_allowed = False
        raise
    finally:
        if draft:
            draft.clear()
        if cleanup_allowed and session.created_row:
            current = session.get_cart()
            row = current.require_single(*PRODUCTS['bofeel'])
            if row != session.created_row:
                raise LoginError('시험 행 식별자 변경: 삭제 중단')
            session.delete_row(current, row)
            session.get_cart().require_empty()
    return dict(draft=report, final_empty=True, cart_matched=bool(cart.rows))


def main(argv=None, environ=None):
    env = os.environ if environ is None else environ
    if env.get('ENABLE_B2B_HTTP_CART') != 'true':
        print(json.dumps({'enabled': False, 'site_requests': 0}, ensure_ascii=False))
        return 0
    parser = argparse.ArgumentParser(description='고정 시험 상품의 제출 없는 HTTP 준비')
    parser.add_argument('--vendor', choices=('eroum', 'bofeel'), required=True)
    args = parser.parse_args(argv)
    prefix = 'EROUM' if args.vendor == 'eroum' else 'BOFEEL'
    username, password = env.get(prefix + '_LOGIN_ID'), env.get(prefix + '_LOGIN_PASSWORD')
    if not username or not password:
        print('로그인 secret 설정 누락: 요청 없이 중단')
        return 1
    recipient = dict(name='시험', phone='010-0000-0000', postcode='04524',
                     address='서울특별시 중구 세종대로 110', detail='시험', memo='시험 입력 제출 안 함')
    session = PreparationSession(args.vendor)
    try:
        session.login(username, password)
        result = (prepare_eroum if args.vendor == 'eroum' else prepare_bofeel)(session, recipient)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        # 서버 본문·secret이 예외에 포함될 수 있어 원문을 출력하지 않는다.
        print('HTTP 준비 실패: 재시도 없이 중단, 장바구니 상태 확인 필요')
        return 1
    finally:
        session.clear()


if __name__ == '__main__':
    raise SystemExit(main())
