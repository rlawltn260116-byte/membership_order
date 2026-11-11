"""실제 취합 행의 HTTP 준비. 표준 입출력 파이프 외에는 원문을 보관하지 않는다."""
import argparse
import copy
import json
import os
from pathlib import Path
import sys
import time
import urllib.parse

from http_cart import (CartRow, Document, OrderDraft, build_order_draft, controls,
                       one, parse_cart, replace, serialize, values)
from http_login_draft import LoginError, StopSignalError
from http_preparation import PreparationSession, eroum_product_fields
from http_submission import submit_prepared
from http_amounts import quote_request, verify_eroum, verify_bofeel

CATALOG = json.loads((Path(__file__).parent / 'data' / 'b2b-product-map.json').read_text(encoding='utf-8'))


def check_mapping(vendor, row):
    mapping = row['mapping']
    matches = [item for item in CATALOG[vendor] if item['model'] == mapping['model'] and
               (item.get('it_id') or item.get('goodsNo')) == mapping['productId'] and
               any(option['name'] == mapping['optionName'] and
                   option.get('io_id', option.get('optionSno')) == mapping['optionId'] for option in item['options'])]
    if len(matches) != 1:
        raise LoginError('상품 연결표 대조 실패')
    if type(row['quantity']) is not int or row['quantity'] < 1:
        raise LoginError('주문수량 대조 실패')


class QueueSession(PreparationSession):
    def __init__(self, vendor):
        super().__init__(vendor)
        self.catalog_count = 0
        self.catalog_time = 0

    def read_amount(self, path, fields):
        return quote_request(self, path, fields)

    def catalog_object(self, mapping):
        key = mapping['productId']
        if key in self.read_once or self.catalog_count >= 30:
            raise LoginError('상품 검색 재요청 또는 한도 초과')
        time.sleep(max(0, 1 - (time.monotonic() - self.catalog_time)))
        self.catalog_count += 1
        self.catalog_time = time.monotonic()
        self.read_once.add(key)
        fields = [('keyword', mapping['model']), ('contain', 'true'), ('searchIn[]', 'it_name'),
                  ('searchIn[]', 'it_model'), ('searchIn[]', 'id'), ('searchIn[]', 'it_name_no_space')]
        # 기존 읽기 전용 get_item 요청과 같은 경로·키만 사용한다.
        text = self.read_catalog_response(fields)
        data = json.loads(text)
        candidates = data if isinstance(data, list) else data.get('data', []) if isinstance(data, dict) else []
        matches = [obj for obj in candidates if isinstance(obj, dict) and obj.get('it_id') == key]
        if len(matches) != 1:
            raise LoginError('정확한 상품 검색 객체 없음')
        obj = matches[0]
        if any(str(obj.get(k)) == '1' for k in ('is_buy', 'soldout_ck')):
            raise LoginError('상품 구매 불가 또는 품절')
        return obj

    def read_catalog_response(self, fields):
        # 고정 시험 준비 모듈의 송신 구현을 재사용하되 허용 검사를 확장한다.
        import gzip
        import urllib.error
        import urllib.request
        from http_login_draft import check_stop_signal
        if not self.authenticated or self.vendor != 'eroum':
            raise LoginError('상품 조회 인증 미확인')
        request = urllib.request.Request(self.origin + '/shop/ajax.get_item.php',
            data=urllib.parse.urlencode(fields).encode(),
            headers={'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                     'Origin': self.origin, 'Referer': self.origin + '/shop/simple_order.php',
                     'X-Requested-With': 'XMLHttpRequest'})
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            if response.code != 200:
                raise LoginError('상품 조회 실패: 재시도 없음')
            raw = response.read()
            if response.headers.get('Content-Encoding', '').lower() == 'gzip':
                raw = gzip.decompress(raw)
            text = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
            check_stop_signal(text)
            return text


def prepare_eroum_group(session, group, source, objects):
    form = Document(source).form('simple_order')
    defaults = serialize(form)
    if any(k in {'it_id[]', 'io_id[]', 'ct_qty[]', 'prodMemo[]'} for k, _ in defaults):
        raise LoginError('기존 주문서 상품이 있어 합치지 않음')
    if not any(n.has_class('ad_sel_addr') and n.attrs.get('data-value') == 'new' and n.text() == '신규 배송지' for n in form.all()):
        raise LoginError('신규 배송지 표지 없음')
    product_fields = []
    quantities = {}
    for row in group['rows']:
        key = row['mapping']['productId']
        quantities[key] = quantities.get(key, 0) + row['quantity']
    for key, quantity in quantities.items():
        maximum = str(objects[key].get('it_buy_max_qty', ''))
        if not maximum.isdigit() or (int(maximum) > 0 and quantity > int(maximum)):
            raise LoginError('배송지 묶음의 상품별 최대 수량 초과 또는 미확인')
    for row in group['rows']:
        check_mapping('eroum', row)
        obj = objects[row['mapping']['productId']]
        product_fields += eroum_product_fields(source, obj, product_id=row['mapping']['productId'],
            quantity=row['quantity'], memo=row['recipient']['memo'])
    recipient = group['rows'][0]['recipient'].copy()
    # 행별 비고는 prodMemo[]에 그대로 넣는다. 다른 비고를 합성해 배송 메모에 넣지 않는다.
    if any(row['recipient']['memo'] != recipient['memo'] for row in group['rows']):
        recipient['memo'] = ''
    mapping = {'od_b_name': 'name', 'od_b_tel': 'phone', 'od_b_hp': 'phone', 'od_b_zip': 'postcode',
               'od_b_addr1': 'address', 'od_b_addr2': 'detail', 'od_memo': 'memo'}
    names = {n.attrs['name'] for n in controls(form)}
    if not set(mapping) <= names:
        raise LoginError('배송지 필드 누락')
    if urllib.parse.urljoin(session.origin + '/shop/simple_order.php', form.attrs.get('action', '')) != session.origin + '/shop/orderformupdate.php':
        raise LoginError('주문서 action 변경')
    fields = defaults + product_fields
    for key, source_key in mapping.items():
        fields = replace(fields, key, recipient[source_key])
    # 회원 기본 주소의 지번/추가 주소가 혼합되지 않게 비운다. 배송지 저장은 수행하지 않는다.
    fields = replace(fields, 'od_b_addr_jibeon', '')
    report = {'valid': True, 'address_mode': 'new', 'submission_allowed': False,
              'submission_ready': False, 'totals_recalculated': False}
    draft = OrderDraft(fields, report)
    draft.expected_fields = copy.deepcopy(fields)
    try:
        verify_eroum(session, draft, group, source, objects)
    except StopSignalError:
        raise
    except LoginError:
        draft.report['validation_hold'] = True
    return draft


def cleanup_bofeel(session, mapping, quantity):
    session.retained_for_submit = False
    current = session.get_cart()
    row = current.require_single(mapping['productId'], mapping['model'], quantity)
    if row != session.created_row:
        raise LoginError('장바구니 행 변경: 삭제 중단')
    fields = [(k, v) for k, v in current.fields if k != 'cartSno[]']
    fields = replace(fields, 'mode', 'cartDelete') + [('cartSno[]', row.cart_id)]
    session._operation('/order/cart_ps.php', fields)
    session.get_cart().require_empty()
    session.created_row = None
    session.order_path = None
    session.mutations.discard(('/order/cart_ps.php', 'cartIn'))
    session.mutations.discard(('/order/cart_ps.php', 'cartDelete'))


def prepare_bofeel_group(session, group, *, retain_for_submit=False):
    rows = group['rows']
    for row in rows:
        check_mapping('bofeel', row)
    first = rows[0]
    if any(row['mapping'] != first['mapping'] or row['recipient']['memo'] != first['recipient']['memo'] for row in rows):
        raise LoginError('보필 다품목·상이한 행별 비고는 확인 전 보류')
    mapping = first['mapping']
    if mapping['model'] != 'BFSH10' or mapping['optionName'] != '':
        raise LoginError('보필 동적 옵션 폼은 확인 전 보류')
    quantity = sum(row['quantity'] for row in rows)
    session.get_cart().require_empty()
    source = session._operation('/goods/goods_view.php?goodsNo=' + mapping['productId'])
    form = Document(source).form('frmView')
    fields = serialize(form)
    if values(fields, 'goodsNo[]') != [mapping['productId']] or values(fields, 'optionSno[]') != [mapping['optionId']] or one(fields, 'optionFl') != 'n':
        raise LoginError('현재 사이트 상품·기본 옵션 불일치')
    # 구매불가 표지는 현재 상품 주문 폼 안에서만 확인한다.
    if any(marker in form.text() for marker in ('품절', '구매불가', '구매 불가', '판매중지', '판매 중지')):
        raise LoginError('구매 불가·품절 상품')
    fields = replace(replace(replace(fields, 'mode', 'cartIn'), 'cartMode', ''), 'goodsCnt[]', str(quantity))
    result = json.loads(session._operation('/order/cart_ps.php', fields))
    if not isinstance(result, dict) or str(result.get('error', '0')).lower() not in ('0', 'false', 'none', ''):
        raise LoginError('장바구니 담기 결과 미확인')
    snapshot = session.get_cart()
    session.created_row = snapshot.require_single(mapping['productId'], mapping['model'], quantity)
    draft = None
    cleanup = True
    try:
        source = session.open_order()
        draft = build_order_draft('bofeel', source, session.created_row, first['recipient'])
        if not draft.report['valid']:
            raise LoginError('보필 직접 입력 주문서 대조 실패')
        # 주소 저장·회원 반영 필드는 값이 없어야 한다. 선택된 상태를 보존해 제출하지 않는다.
        if values(draft.fields, 'reflectApplyDelivery'):
            raise LoginError('배송지 저장 선택 상태: 보류')
        draft.fields = replace(draft.fields, 'receiverZipcode', '')
        draft.report['submission_ready'] = False
        draft.expected_fields = copy.deepcopy(draft.fields)
        try:
            verify_bofeel(session, draft, group, source)
        except StopSignalError:
            raise
        except LoginError:
            draft.report['validation_hold'] = True
        if retain_for_submit and draft.report['submission_ready']:
            cleanup = False
            session.retained_for_submit = True
        return draft
    except StopSignalError:
        cleanup = False
        raise
    finally:
        # PREPARE 종료나 검증 실패 시 이 실행에서 담은 행만 삭제한다.
        if cleanup and session.created_row:
            cleanup_bofeel(session, mapping, quantity)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def run(vendor, groups, env, session_factory=QueueSession, execution_mode='PREPARE'):
    if env.get('ENABLE_B2B_HTTP_CART') != 'true':
        emit({'event': 'prepared', 'details': [], 'reason': 'HTTP 준비 기능이 꺼져 있습니다.', 'submissionReady': False})
        return
    prefix = 'EROUM' if vendor == 'eroum' else 'BOFEEL'
    username, password = env.get(prefix + '_LOGIN_ID'), env.get(prefix + '_LOGIN_PASSWORD')
    if not username or not password:
        raise LoginError('업체 로그인 설정 누락')
    if not groups or len(groups) > 30 or sum(len(g['rows']) for g in groups) > 30:
        raise LoginError('실행당 준비 범위 초과')
    session = session_factory(vendor)
    drafts = []
    stop_requested = False
    try:
        # 공급 업체당 이 프로세스 전체에서 한 번만 로그인한다.
        session.login(username, password)
        parse_cart(vendor, session.cart_html).require_empty()
        source, objects = None, {}
        if vendor == 'eroum':
            source = session.read_preparation('/shop/simple_order.php')
            if '로그아웃' not in source:
                raise LoginError('주문서 로그인 상태 미확인')
            for group in groups:
                for row in group['rows']:
                    check_mapping(vendor, row)
                    key = row['mapping']['productId']
                    if key not in objects:
                        objects[key] = session.catalog_object(row['mapping'])
        details = []
        interrupted = False
        for index, group in enumerate(groups):
            try:
                draft = (prepare_eroum_group(session, group, source, objects) if vendor == 'eroum'
                         else prepare_bofeel_group(session, group, retain_for_submit=execution_mode == 'SUBMIT' and len(groups) == 1))
                drafts.append(draft)
                if draft.report.get('submission_ready') is not True:
                    raise LoginError('금액·결제·동의 검증 보류')
                for row in group['rows']:
                    details.append({'lineNo': row['lineNo'], 'status': 'READY', 'productId': row['mapping']['productId'],
                        'quantity': row['quantity'], 'vendor': vendor, 'orderGroup': index + 1,
                        'addressMode': group['addressMode'], 'submissionReady': True,
                        'reason': 'HTTP 금액·배송비·결제·동의·신규 배송지 대조 완료. 실제 제출 잠금은 별도입니다.'})
            except Exception as error:
                interrupted = True
                stop_requested = isinstance(error, StopSignalError)
                # 실패 뒤 다음 그룹 요청을 보내지 않는다. 원문·예외에는 고객정보가 섞일 수 있다.
                for pending in groups[index:]:
                    for row in pending['rows']:
                        details.append({'lineNo': row['lineNo'], 'status': 'HOLD', 'vendor': vendor,
                                        'reason': 'HTTP 준비 대조 실패. 재시도 없이 중단했으며 장바구니 확인이 필요합니다.'})
                break
        if vendor == 'eroum' and not interrupted:
            session.get_cart().require_empty()
        submission_ready = (len(groups) == len(drafts) == 1 and len(groups[0]['rows']) == 1 and
                            drafts[0].report.get('submission_ready') is True)
        emit({'event': 'prepared', 'details': details, 'submissionReady': submission_ready,
              'sourceKey': groups[0]['rows'][0]['sourceKey'] if len(groups) == 1 and len(groups[0]['rows']) == 1 else '',
              'finalEmpty': not interrupted and session.created_row is None,
              'cartVerified': not interrupted})
        # 금액 검증 뒤에도 부모의 증명·원장·행 잠금 승인이 필요하다.
        if execution_mode == 'SUBMIT' and submission_ready and env.get('ENABLE_B2B_HTTP_SUBMIT') == 'true':
            command = json.loads(sys.stdin.readline(4097) or '{}')
            if command.get('submit') is True and command.get('sourceKey') == groups[0]['rows'][0]['sourceKey']:
                result = submit_prepared(session, drafts[0], authorized=True, environ=env)
                emit({'event': 'submitted', **result})
    finally:
        try:
            if vendor == 'bofeel' and getattr(session, 'retained_for_submit', False) and session.created_row and not getattr(session, 'submission_attempted', False) and not stop_requested:
                # 부모가 승인하지 않은 보관 행만 한 번 정리한다. 전송 뒤나 중단 신호 뒤에는 추가 요청하지 않는다.
                cleanup_bofeel(session, groups[0]['rows'][0]['mapping'], sum(r['quantity'] for r in groups[0]['rows']))
        finally:
            for draft in drafts:
                draft.clear()
                draft.expected_fields.clear()
            session.clear()


def main():
    parser = argparse.ArgumentParser(description='B2B 주문 행의 제출 없는 HTTP 준비')
    parser.add_argument('--vendor', choices=('eroum', 'bofeel'), required=True)
    args = parser.parse_args()
    try:
        payload = json.loads(sys.stdin.readline(1_000_001))
        run(args.vendor, payload['groups'], os.environ, execution_mode=payload.get('executionMode', 'PREPARE'))
        return 0
    except Exception:
        emit({'event': 'prepared', 'details': [], 'submissionReady': False,
              'reason': 'HTTP 준비 실패. 자동 재시도 없이 중단했으며 장바구니 확인이 필요합니다.'})
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
