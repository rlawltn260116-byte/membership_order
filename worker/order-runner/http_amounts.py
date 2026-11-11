"""제출 없는 금액 조회와 화면 계산 대조. 금액·토큰·배송지는 메모리에만 둔다."""
import copy
import gzip
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request

from http_cart import Document, controls, one, replace, serialize, values
from http_login_draft import LoginError, check_stop_signal


def money(value, *, empty=False):
    if empty and value == '':
        return 0
    if isinstance(value, bool) or not re.fullmatch(r'\d+(?:\.0+)?', str(value)):
        raise LoginError('금액 형식 미확인')
    result = int(str(value).split('.')[0])
    if result > 2**53 - 1:
        raise LoginError('금액 범위 초과')
    return result


def display_money(source, target):
    nodes = [n for n in Document(source).root.all() if n.attrs.get('id') == target]
    if len(nodes) != 1:
        raise LoginError('화면 금액 구조 변경')
    text = nodes[0].text()
    if not re.fullmatch(r'(?:\d{1,3}(?:,\d{3})+|\d+)\s*원?', text):
        raise LoginError('화면 금액 형식 미확인')
    return money(text.replace(',', '').replace('원', '').strip())


def render(source, fields, *, vendor='eroum', obj=None, quotes=None):
    node = shutil.which('node')
    if not node:
        raise LoginError('화면 계산 실행기 없음')
    # 업체 자격증명·NODE_OPTIONS 등은 렌더러 자식에게 상속하지 않는다.
    child_env = {key: value for key, value in os.environ.items() if key.upper() in ('PATH', 'SYSTEMROOT', 'WINDIR')}
    try:
        result = subprocess.run([node, '--max-old-space-size=64', str(Path(__file__).with_name('amount_renderer.mjs'))],
            input=json.dumps(dict(source=source, fields=fields, vendor=vendor, obj=obj, quotes=quotes)),
            text=True, encoding='utf-8', capture_output=True, timeout=10, env=child_env)
    except (subprocess.TimeoutExpired, OSError):
        raise LoginError('화면 계산 시간 초과 또는 실행 실패: HOLD') from None
    if result.returncode:
        raise LoginError('화면 계산 소스 변경 또는 계산 대조 실패')
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise LoginError('화면 계산 응답 미확인') from None


def check_render_fields(before, after, mutable):
    from collections import Counter
    if (not isinstance(after, list) or
            any(not isinstance(pair, (list, tuple)) or len(pair) != 2 or
                any(not isinstance(value, str) for value in pair) for pair in after)):
        raise LoginError('렌더 결과 필드 형식 변경')
    if (Counter(k for k, _ in before) != Counter(k for k, _ in after) or
            [(k,v) for k,v in before if k not in mutable] != [(k,v) for k,v in after if k not in mutable]):
        raise LoginError('렌더 뒤 상품·옵션·수량·배송지·결제·동의 필드 변경')


def quote_request(session, path, fields):
    """계산 전용 주소와 정확한 필드 집합만 허용. 주문 처리 주소는 없다."""
    allowed = {
        'eroum': {
            '/shop/ajax.od_send_cost.php': {'it_id[]', 'qty[]', 'it_price[]', 'it_line_price[]', 'io_id[]', 'ca_id22[]', 'ca_id_raw[]', 'ca_id2_raw[]', 'ca_id3_raw[]'},
            '/shop/ajax.installation_cost.php': {'it_ids[]', 'ct_qtys[]'},
            '/shop/ordersendcost_new.php': {'address', 'it_ids[]'},
        },
        'bofeel': {'/order/cart_ps.php': {'mode', 'cartSno[]', 'receiverAddress', 'receiverAddressSub', 'totalCouponOrderDcPrice'}},
    }
    expected = allowed.get(session.vendor, {}).get(path)
    if not session.authenticated or not expected or {k for k, _ in fields} != expected:
        raise LoginError('금액 조회 허용 목록 불일치')
    if session.vendor == 'bofeel' and one(fields, 'mode') != 'check_area_delivery':
        raise LoginError('배송비 조회 외 mode 금지')
    if any(not isinstance(v, str) for _, v in fields):
        raise LoginError('금액 조회 필드 형식 미확인')
    request = urllib.request.Request(session.origin + path,
        data=urllib.parse.urlencode(fields).encode(),
        headers={'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                 'Origin': session.origin, 'X-Requested-With': 'XMLHttpRequest',
                 'Referer': session.origin + ('/shop/simple_order.php' if session.vendor == 'eroum' else '/order/order.php')})
    # 재시도하지 않으며 리다이렉트도 기존 세션의 NoRedirect 정책으로 차단한다.
    with session.opener.open(request, timeout=30) as response:
        session.trace.append({'method': 'POST', 'path': path, 'status': response.code})
        if response.code != 200:
            raise LoginError('금액 조회 응답 실패')
        raw = response.read()
        if response.headers.get('Content-Encoding', '').lower() == 'gzip':
            raw = gzip.decompress(raw)
        text = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
        check_stop_signal(text)
        try:
            return json.loads(text)
        except ValueError:
            raise LoginError('금액 조회 JSON 미확인') from None


def assert_recipient(vendor, fields, recipient):
    mapping = ({'od_b_name': 'name', 'od_b_tel': 'phone', 'od_b_hp': 'phone', 'od_b_zip': 'postcode',
                'od_b_addr1': 'address', 'od_b_addr2': 'detail', 'od_memo': 'memo'} if vendor == 'eroum' else
               {'receiverName': 'name', 'receiverPhone': 'phone', 'receiverCellPhone': 'phone',
                'receiverZonecode': 'postcode', 'receiverAddress': 'address', 'receiverAddressSub': 'detail', 'orderMemo': 'memo'})
    if any(one(fields, k) != recipient[v] for k, v in mapping.items()):
        raise LoginError('승인된 신규 배송지·비고 불일치')
    if not re.fullmatch(r'\d{5}', recipient['postcode']):
        raise LoginError('신규 우편번호 미확인')


def expected_price(row, unit):
    expected = row.get('expectedPrice', '')
    if expected not in ('', None):
        if money(str(expected).replace(',', '').replace('원', '').strip()) != unit:
            raise LoginError('승인 예상 단가 불일치')


def mark_verified(vendor, draft):
    from http_submission import ENDPOINTS, validate_request
    validate_request(vendor, ENDPOINTS[vendor], 'POST', draft.fields, draft.fields, totals_verified=True)
    draft.expected_fields = copy.deepcopy(draft.fields)
    draft.amount_snapshot = tuple(draft.fields)
    draft.amount_verified_at = time.monotonic()
    draft.report.update(submission_ready=True, totals_recalculated=True, totals_match=True,
                        payment_verified=True, consent_verified=True, address_verified=True)


def validate_amount_snapshot(draft):
    if (getattr(draft, 'amount_snapshot', None) != tuple(draft.fields) or
            not 0 <= time.monotonic() - getattr(draft, 'amount_verified_at', float('-inf')) <= 300 or
            not all(draft.report.get(k) is True for k in ('submission_ready', 'totals_match', 'payment_verified', 'consent_verified', 'address_verified'))):
        raise LoginError('금액·결제·동의 검증 만료 또는 초안 변경')


def verify_eroum(session, draft, group, source, objects):
    draft.report['submission_ready'] = False
    rows = group['rows']
    if len(rows) != 1:
        raise LoginError('최종 금액 검증은 승인된 단일 행만 허용')
    row = rows[0]; mapping = row['mapping']; fields = draft.fields
    if type(row['quantity']) is not int or not 1 <= row['quantity'] <= 1000:
        raise LoginError('금액 검증 수량 범위 밖')
    if any(n.attrs.get('type') == 'checkbox' for n in Document(source).form('simple_order').all('input')):
        raise LoginError('기존에 없던 동의·저장 체크박스: 구조 재확인 필요')
    if (values(fields, 'it_id[]') != [mapping['productId']] or values(fields, 'io_id[]') != [mapping['optionId']] or
            mapping['optionName'] != '' or values(fields, 'ct_qty[]') != [str(row['quantity'])]):
        raise LoginError('승인 상품·옵션·수량 불일치')
    obj = objects[mapping['productId']]
    unit = money(obj['it_price']); subtotal = unit * row['quantity']
    expected_price(row, unit)
    assert_recipient('eroum', fields, row['recipient'])
    if one(fields, 'od_settle_case') != '월 마감 정산' or one(fields, 'pen_type') != '0' or one(fields, 'od_delivery_type') != 'delivery1':
        raise LoginError('월 마감·일반주문·택배 분기 미확인')
    if money(one(fields, 'od_cp_price'), empty=True) or values(fields, 'od_temp_point'):
        raise LoginError('쿠폰·포인트는 검증 전 보류')
    for key in ('cp_id[]', 'od_cp_id', 'sc_cp_id', 'dc_id', 'cp_price[]'):
        if any(value not in ('', '0') for value in values(fields, key)):
            raise LoginError('쿠폰·할인 식별자 또는 상품 할인 미검증')
    first = render(source, fields, obj=obj)
    mutable = {'od_price','org_od_price','od_send_cost','od_installation_cost','ct_price[]'}
    check_render_fields(fields, first['fields'], mutable)
    if values(first['fields'], 'ct_price[]') != [str(subtotal)] or values(fields, 'it_price[]') != [str(unit), str(unit)]:
        raise LoginError('화면 단가·할인·상품 합계 불일치')
    category = one(fields, 'ca_id_delivery[]')
    expected = [
        {'path': './ajax.od_send_cost.php', 'data': {'it_id': [mapping['productId']], 'qty': [row['quantity']], 'it_price': [unit], 'it_line_price': [subtotal],
            'io_id': [''], 'ca_id22': [category], 'ca_id_raw': [one(fields,'ca_id[]')], 'ca_id2_raw': [one(fields,'ca_id2[]')], 'ca_id3_raw': [one(fields,'ca_id3[]')]}},
        {'path': './ajax.installation_cost.php', 'data': {'it_ids': [mapping['productId']], 'ct_qtys': [row['quantity']]}},
    ]
    if first['requests'] != expected:
        raise LoginError('화면 계산 조회 상품·수량 불일치')
    quotes = {}
    for request in expected:
        payload = [(k+'[]', str(v)) for k, vals in request['data'].items() for v in vals]
        quotes[request['path']] = money(session.read_amount('/shop/'+request['path'][2:], payload))
    extra = money(session.read_amount('/shop/ordersendcost_new.php', [('address', row['recipient']['address'])] +
        [('it_ids[]', mapping['productId']) for _ in range(row['quantity'])]))
    # 현재 화면 공식은 추가배송비를 총액에 더하지 않는다. 비영이면 과소청구를 피하여 HOLD.
    if extra:
        raise LoginError('추가 배송비 비영: 화면 총액 공식 미확정')
    rendered = render(source, fields, obj=obj, quotes=quotes)
    calculated = rendered['fields']; screen = rendered['display']
    check_render_fields(fields, calculated, mutable)
    delivery = quotes['./ajax.od_send_cost.php']; installation = quotes['./ajax.installation_cost.php']
    if (money(screen['#order_price']) != subtotal or money(screen['#delivery_price']) != delivery or
            money(screen['#add_installation_price']) != installation or money(screen['#total_price']) != subtotal + delivery + installation or
            money(one(calculated, 'od_price')) != subtotal or money(one(calculated, 'org_od_price')) != subtotal or
            money(one(calculated, 'od_send_cost')) != delivery or money(one(calculated, 'od_installation_cost')) != installation or
            values(calculated,'ct_price[]') != [str(subtotal)]):
        raise LoginError('서버 계산·화면·초안 합계 불일치')
    draft.fields = replace(calculated, 'od_send_cost2', str(extra))
    mark_verified('eroum', draft)


def verify_bofeel(session, draft, group, source):
    draft.report['submission_ready'] = False
    rows = group['rows']
    if len(rows) != 1:
        raise LoginError('최종 금액 검증은 승인된 단일 행만 허용')
    row = rows[0]; mapping = row['mapping']; fields = draft.fields
    if type(row['quantity']) is not int or not 1 <= row['quantity'] <= 1000:
        raise LoginError('금액 검증 수량 범위 밖')
    assert_recipient('bofeel', fields, row['recipient'])
    if values(fields, 'reflectApplyDelivery') or values(fields, 'shipping') != ['shippingNew']:
        raise LoginError('직접 입력·회원 배송지 반영 해제 미확인')
    if one(fields, 'receiverCountryCode') != 'kr' or any(values(fields, key) not in ([], [''], ['0'], ['n']) for key in ('deliveryVisit','deliveryFree')):
        raise LoginError('국내 택배·방문수령 미사용 분기 미확인')
    if values(fields,'simpleJoin') not in ([], [''], ['0'], ['n']):
        raise LoginError('회원 정보 저장·가입 분기 미확인')
    form = Document(source).form('frmOrder')
    if any(n.attrs.get('type') == 'checkbox' and n.attrs.get('id') not in ('reflectApplyDelivery','termAgree_orderCheck') for n in form.all('input')):
        raise LoginError('새 동의·정보 저장 체크박스: 구조 재확인 필요')
    payment = [n for n in controls(form) if n.attrs.get('name') == 'settleKind' and n.attrs.get('value') == 'gb' and n.attrs.get('type') == 'radio']
    if len(payment) != 1 or not any(n.attrs.get('for') == payment[0].attrs.get('id') and '무통장' in n.text() for n in form.all('label')):
        raise LoginError('무통장 입금 구조 미확인')
    bank = one(fields, 'bankAccount')
    banks = [o for n in form.all('select') if n.attrs.get('name') == 'bankAccount' for o in n.all('option') if o.attrs.get('value') == bank and 'selected' in o.attrs and 'disabled' not in o.attrs]
    if not bank or len(banks) != 1 or not one(fields, 'bankSender').strip():
        raise LoginError('서버 선택 입금 계좌·입금자 미확인')
    consent = [n for n in form.all('input') if n.attrs.get('id') == 'termAgree_orderCheck']
    if (len(consent) != 1 or consent[0].attrs.get('type') != 'checkbox' or consent[0].attrs.get('name') or
            not consent[0].has_class('require') or not any(n.attrs.get('for') == 'termAgree_orderCheck' and '(필수)' in n.text() for n in form.all('label'))):
        raise LoginError('필수 구매 동의 구조 변경')
    # 이 체크박스에는 name이 없어 실제 serialize에도 포함되지 않는다. 초안 검증 상태에만 동의.
    if values(fields, 'termAgree_orderCheck'):
        raise LoginError('관찰되지 않은 동의 POST 필드')
    key = 'priceInfo['+mapping['productId']+']['+mapping['optionId']+']'
    if [k for k, _ in fields if k.startswith('priceInfo[')] != [key]:
        raise LoginError('주문서 상품·옵션 연결 불일치')
    price = json.loads(one(fields, key))
    if money(price['goodsCnt']) != row['quantity'] or values(fields, 'cartSno[]') != [session.created_row.cart_id]:
        raise LoginError('주문서 수량·장바구니 연결 불일치')
    unit = money(price['goodsPrice']) + money(price['optionPrice'])
    expected_price(row, unit)
    subtotal = unit * row['quantity']
    if money(price['goodsPriceSum']) + money(price['optionPriceSum']) != subtotal or money(price['goodsPriceSubtotal']) != subtotal:
        raise LoginError('상품 행 가격 불일치')
    # 확인하지 않은 할인·추가상품·해외·방문수령 조합은 자동 허용하지 않는다.
    for key in ('goodsDcPrice','couponGoodsDcPrice','memberDcPrice','memberOverlapDcPrice','addGoodsPriceSum','optionTextPriceSum'):
        value = price[key]
        if key == 'memberOverlapDcPrice' and value is None:
            value = 0  # 현행 JSON의 중복 회원 할인 미적용 표지. 숨은 합계도 아래에서 대조한다.
        if money(value):
            raise LoginError('할인·추가상품 계산 미검증')
    for key in ('totalCouponGoodsDcPrice','totalMemberDcPrice','totalMemberOverlapDcPrice','deliveryInsuranceFee','totalCouponOrderDcPrice','totalCouponDeliveryDcPrice'):
        if money(one(fields,key),empty=True):
            raise LoginError('할인·해외 배송 계산 미검증')
    delivery = money(one(fields,'totalDeliveryCharge')); old_area=money(one(fields,'deliveryAreaCharge'))
    initial = subtotal + delivery + old_area
    if (display_money(source,'totalGoodsPrice') != subtotal or display_money(source,'totalDeliveryCharge') != delivery or
            display_money(source,'totalSettlePrice') != initial or display_money(source,'totalSettlePriceView') != initial or money(one(fields,'settlePrice')) != initial):
        raise LoginError('서버 화면 합계·초안 불일치')
    fields = replace(fields,'settleKind','gb')
    area = session.read_amount('/order/cart_ps.php', [('mode','check_area_delivery'), ('cartSno[]',session.created_row.cart_id),
        ('receiverAddress',row['recipient']['address']),('receiverAddressSub',row['recipient']['detail']),
        ('totalCouponOrderDcPrice',one(fields,'totalCouponOrderDcPrice'))])
    if not isinstance(area,dict) or 'areaDelivery' not in area or area.get('error') not in (None,False,0,'0'):
        raise LoginError('신규 배송지 배송비 응답 미확인')
    area = money(area['areaDelivery'])
    fields = replace(fields,'deliveryAreaCharge',str(area))
    rendered = render(source,fields,vendor='bofeel')
    check_render_fields(fields, rendered['fields'], {'settlePrice'})
    total = subtotal + delivery + area
    if (money(rendered['display']['#totalSettlePrice']) != total or money(rendered['display']['#totalSettlePriceView']) != total or
            money(one(rendered['fields'],'settlePrice')) != total or rendered['requests']):
        raise LoginError('신규 배송비·화면·초안 합계 불일치')
    draft.fields = rendered['fields']
    mark_verified('bofeel',draft)
