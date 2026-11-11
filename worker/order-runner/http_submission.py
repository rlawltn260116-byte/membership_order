"""명시적 승인 뒤 동일 메모리 세션의 주문서 한 건만 제출하는 잠금 전송기.

외부 호출은 queue 브리지에서만 연결한다. 모의 시험 외에는 실행하지 않는다.
"""
import gzip
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from http_cart import Document, one, values
from http_login_draft import LoginError, check_stop_signal

ENDPOINTS = {'eroum': 'https://eroumcare.com/shop/orderformupdate.php',
             'bofeel': 'https://bofeelmall.com/order/order_ps.php'}

# 저장된 주문 폼에서 확인한 필드 이름만 사용한다. 새로운 필드는 자동으로 허용하지 않는다.
EROUM_FIELDS = set('''checkUnload cp_id[] dc_id form_mb_id mb_order_approve od_addr1 od_addr2 od_addr3
od_addr_jibeon od_b_addr1 od_b_addr2 od_b_addr_jibeon od_b_hp od_b_name od_b_tel od_b_zip
od_cp_id od_cp_price od_delivery_type od_email od_hp od_installation_cost od_memo od_name
od_price od_send_cost od_send_cost2 od_settle_case od_tel od_zip org_od_price ot_location_addr1
ot_location_addr2 ot_location_jibeon ot_location_zip ot_typereceipt pen_id pen_nm pen_type
sc_cp_id typereceipt_bname typereceipt_bnum typereceipt_boss_name typereceipt_btel typereceipt_bupjong
typereceipt_buptae typereceipt_email typereceipt_manager_name it_id[] it_price[] it_buy_min_qty[]
it_buy_max_qty[] it_buy_inc_qty[] it_sc_type[] it_sc_qty[] it_sc_minimum[] it_sc_price[] it_even_odd[]
it_even_odd_price[] io_type[] io_price[] ca_id[] ca_id2[] ca_id3[] ca_id_delivery[] cp_price[]
stock_status[] io_id[] prodMemo[] ct_qty[] ct_price[]'''.split())
BOFEEL_FIELDS = set('''bankAccount bankSender cartAddGoodsCnt cartGoodsCnt cartSno[] chooseCouponMemberUseType
chooseMileageCoupon couponApplyOrderNo csrfToken deliveryAreaCharge deliveryFree deliveryInsuranceFee
deliveryVisit orderAddress orderAddressSub orderCellPhone orderCellPhonePrefix orderCellPhonePrefixCode
orderChannelFl orderCity orderCountryCode orderEmail orderMemo orderName orderPhone orderPhonePrefix
orderPhonePrefixCode orderState orderZipcode orderZonecode overseasSettleCurrency overseasSettlePrice
productCouponChangeLimitType receiverAddress receiverAddressSub receiverCellPhone receiverCellPhonePrefix
receiverCellPhonePrefixCode receiverCity receiverCountryCode receiverName receiverPhone receiverPhonePrefix
receiverPhonePrefixCode receiverState receiverZipcode receiverZonecode returnUrl settlePrice simpleJoin
totalCouponDeliveryDcPrice totalCouponDeliveryPrice totalCouponGoodsDcPrice totalCouponGoodsMileage
totalCouponOrderDcPrice totalCouponOrderMileage totalCouponOrderPrice totalDeliveryCharge totalDeliveryFreePrice
totalMemberDcPrice totalMemberOverlapDcPrice visitAddress visitMemo visitName visitPhone shipping settleKind
'''.split())


def parse_order_numbers(vendor, html, *, completion=False):
    """주문서의 임시 od_id는 제외한다. 고객정보와 본문은 반환·저장하지 않는다."""
    numbers = set()
    document = Document(html)
    path = '/shop/orderinquiryview.php' if vendor == 'eroum' else '/mypage/order_view.php'
    origin = 'https://eroumcare.com' if vendor == 'eroum' else 'https://bofeelmall.com'
    key = 'od_id' if vendor == 'eroum' else 'orderNo'
    for anchor in (() if completion else document.root.all('a')):
        url = urllib.parse.urlsplit(urllib.parse.urljoin(origin, anchor.attrs.get('href', '')))
        if url.scheme != 'https' or url.netloc != urllib.parse.urlsplit(origin).netloc or url.path != path:
            continue
        vals = urllib.parse.parse_qs(url.query).get(key, [])
        numbers.update(v for v in vals if re.fullmatch(r'\d{12,24}', v))
    if completion:
        text = document.root.text()
        if re.search(r'주문(?:이|이 정상적으로)?\s*(?:완료|접수)', text):
            numbers.update(re.findall(r'주문\s*번호\s*[:：]?\s*(\d{12,24})(?!\d)', text))
    return numbers


def validate_request(vendor, url, method, fields, expected_fields, *, totals_verified=False):
    if vendor not in ENDPOINTS or url != ENDPOINTS[vendor] or method != 'POST':
        raise LoginError('최종 제출 주소·메서드 허용 목록 불일치')
    if fields != expected_fields or not totals_verified:
        raise LoginError('준비한 필드·금액 대조 미완료')
    allowed = EROUM_FIELDS if vendor == 'eroum' else BOFEEL_FIELDS
    for name, value in fields:
        if name not in allowed and not (vendor == 'bofeel' and re.fullmatch(r'(?:memberDcInfo|mileageInfo|priceInfo)\[\d+\]\[\d+\]', name)):
            raise LoginError('최종 제출 필드 허용 목록 불일치')
        if not isinstance(value, str):
            raise LoginError('제출 필드 형식 불일치')
    counts = {k: len(values(fields, k)) for k, _ in fields}
    # 배열 이외 중복 필드를 막는다. 이로움 it_price[] 두 개는 학습한 렌더 결과다.
    if any(count > 1 and not k.endswith('[]') for k, count in counts.items()):
        raise LoginError('단일 필드 중복')
    if vendor == 'eroum':
        if len(values(fields, 'it_id[]')) != 1 or len(values(fields, 'io_id[]')) != 1 or len(values(fields, 'ct_qty[]')) != 1:
            raise LoginError('최종 제출은 한 상품 행만 허용')
        if one(fields, 'od_settle_case') != '월 마감 정산' or one(fields, 'pen_type') != '0':
            raise LoginError('결제·일반주문 분기 미확인')
        required = ('od_b_name', 'od_b_tel', 'od_b_hp', 'od_b_zip', 'od_b_addr1')
    else:
        if len(values(fields, 'cartSno[]')) != 1 or one(fields, 'shipping') != 'shippingNew':
            raise LoginError('직접 입력·단일 장바구니 행 미확인')
        if one(fields, 'settleKind') != 'gb' or not one(fields, 'bankAccount').strip() or not one(fields, 'bankSender').strip():
            raise LoginError('무통장 입금·계좌·입금자 미확인')
        required = ('receiverName', 'receiverPhone', 'receiverCellPhone', 'receiverZonecode', 'receiverAddress')
    if any(not one(fields, k).strip() for k in required):
        raise LoginError('신규 배송지 필수값 누락')


def submit_prepared(session, draft, *, authorized=False, environ=None, transport=None):
    """부모의 증명·원장·행 잠금 확인 뒤 호출한다. 불명확하면 UNKNOWN, 재전송 없음."""
    env = os.environ if environ is None else environ
    if env.get('ENABLE_B2B_HTTP_SUBMIT') != 'true' or not authorized:
        raise LoginError('HTTP 최종 제출 잠금')
    if not session.authenticated or getattr(session, 'submission_attempted', False):
        raise LoginError('인증 미확인 또는 제출 재시도 금지')
    from http_amounts import validate_amount_snapshot
    validate_amount_snapshot(draft)
    url = ENDPOINTS[session.vendor]
    validate_request(session.vendor, url, 'POST', draft.fields, draft.expected_fields,
                     totals_verified=draft.report.get('submission_ready') is True)
    # 전송 전에 예약한다. 전송 후 어떤 예외도 재시도하지 않는다.
    session.submission_attempted = True
    request = urllib.request.Request(url, data=urllib.parse.urlencode(draft.fields).encode(),
        method='POST', headers={'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                                'Origin': session.origin, 'Referer': session.origin + ('/shop/simple_order.php' if session.vendor == 'eroum' else '/order/order.php')})
    try:
        try:
            response = (transport or session.opener.open)(request, timeout=30)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            # 리다이렉트를 따르거나 주문내역의 최신 번호를 이번 주문이라고 추측하지 않는다.
            if response.code != 200:
                return {'state': 'UNKNOWN'}
            raw = response.read()
            if response.headers.get('Content-Encoding', '').lower() == 'gzip':
                raw = gzip.decompress(raw)
            text = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
            check_stop_signal(text)
            numbers = parse_order_numbers(session.vendor, text, completion=True)
            if len(numbers) == 1 and re.search(r'주문(?:이|이 정상적으로)?\s*(?:완료|접수)', Document(text).root.text()):
                return {'state': 'SUBMITTED', 'orderNumber': next(iter(numbers))}
            return {'state': 'UNKNOWN'}
    except Exception:
        return {'state': 'UNKNOWN'}
