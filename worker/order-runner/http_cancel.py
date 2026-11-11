"""보필 무통장 입금 대기 주문의 주문 단위 취소. 운영에서는 기본 꺼짐이다.

2026-11-11 2차 실제 시험에서 확인한 구조:
- 주문 상세 `/mypage/order_view.php?orderNo=<번호>`의 상품 행 `<tr data-order-no data-order-goodsno data-order-status>`.
- 입금대기(`o1`) 주문은 첫 상품 행에만 `js_btn_order_cancel`(주문취소) 버튼이 있다.
- 버튼 스크립트는 `POST /mypage/order_ps.php`에 `mode=cancelRegist`, `orderNo`, `orderGoodsNo`, `orderStatus` 네 값만 보낸다.
  취소 사유 입력 필드는 없다. 응답은 JSON `{code, message}`이며 성공은 `code == 200`이다.
- 다품목 주문도 한 번의 요청으로 모든 상품 행이 `c4`(취소)로 바뀐다. 즉 주문 단위 취소다.

이 실행에서 만든 주문번호 목록에 있는 번호만 취소한다. 요청은 주문당 한 번이며 결과가 불명확하면
UNKNOWN으로 돌려주고 다시 보내지 않는다. 주문 상세 원문·고객정보는 반환하지 않는다.
"""
import gzip
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from http_login_draft import LoginError, StopSignalError, check_stop_signal

ORIGIN = 'https://bofeelmall.com'
VIEW_PATH = '/mypage/order_view.php?orderNo='
CANCEL_PATH = '/mypage/order_ps.php'
WAITING = 'o1'
CANCELLED = 'c4'


def order_rows(html, order_number):
    """주문 상세의 이 주문 상품 행만 읽는다. 상품 번호·상태·취소 버튼 유무만 돌려준다."""
    if not re.fullmatch(r'\d{12,24}', order_number or ''):
        raise LoginError('주문번호 형식 불일치')
    rows = []
    for attrs, body in re.findall(r'<tr\b([^>]*)>(.*?)</tr>', html, re.S):
        found = dict(re.findall(r'data-(order-no|order-goodsno|order-status)="([^"]*)"', attrs))
        if found.get('order-no') != order_number:
            continue
        rows.append({'goodsNo': found.get('order-goodsno', ''), 'status': found.get('order-status', ''),
                     'cancel_button': 'js_btn_order_cancel' in body})
    return rows


def cancel_fields(html, order_number):
    """입금대기 상태에서 취소 버튼 행이 정확히 하나일 때만 요청 필드를 만든다."""
    rows = order_rows(html, order_number)
    if not rows or any(not re.fullmatch(r'\d+', r['goodsNo']) for r in rows):
        raise LoginError('주문 상품 행 미확인')
    if any(r['status'] != WAITING for r in rows):
        raise LoginError('입금대기 상태가 아님: 취소 요청하지 않음')
    targets = [r for r in rows if r['cancel_button']]
    if len(targets) != 1:
        raise LoginError('주문취소 버튼 행이 정확히 하나가 아님')
    if not re.search(r"mode:\s*'cancelRegist'", html) or "$.post('../mypage/order_ps.php'" not in html:
        raise LoginError('주문취소 스크립트 구조 변경')
    return [('mode', 'cancelRegist'), ('orderNo', order_number),
            ('orderGoodsNo', targets[0]['goodsNo']), ('orderStatus', targets[0]['status'])]


def _decode(response):
    raw = response.read()
    if response.headers.get('Content-Encoding', '').lower() == 'gzip':
        raw = gzip.decompress(raw)
    return raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')


def cancel_bofeel_order(session, order_number, own_numbers, *, authorized=False, environ=None,
                        read=None, transport=None):
    """한 주문을 취소한다. 반환 state: CANCELLED, NOT_SENT(요청 전 보류), UNKNOWN(전송 뒤 불명확)."""
    env = {} if environ is None else environ
    if env.get('ENABLE_B2B_HTTP_CANCEL') != 'true' or not authorized:
        raise LoginError('HTTP 주문취소 잠금')
    if getattr(session, 'vendor', None) != 'bofeel' or not getattr(session, 'authenticated', False):
        raise LoginError('보필 인증 세션 미확인')
    if order_number not in set(own_numbers):
        raise LoginError('이 실행에서 만든 주문번호가 아님: 취소 금지')
    attempted = session.__dict__.setdefault('cancel_attempted', set())
    if order_number in attempted:
        raise LoginError('같은 주문 취소 재전송 금지')
    if read is None:
        raise LoginError('주문 상세 조회 함수 필요')
    try:
        fields = cancel_fields(read(VIEW_PATH + order_number), order_number)
    except StopSignalError:
        raise
    except LoginError as error:
        return {'state': 'NOT_SENT', 'orderNumber': order_number, 'reason': str(error)}
    attempted.add(order_number)
    request = urllib.request.Request(ORIGIN + CANCEL_PATH, data=urllib.parse.urlencode(fields).encode(), method='POST',
        headers={'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest',
                 'Origin': ORIGIN, 'Referer': ORIGIN + VIEW_PATH + order_number})
    result = {'state': 'UNKNOWN', 'orderNumber': order_number}
    try:
        try:
            response = (transport or session.opener.open)(request, timeout=30)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            status = response.code
            text = _decode(response)
        check_stop_signal(text)
        data = json.loads(text.lstrip('﻿'))
        code = data.get('code') if isinstance(data, dict) else None
        result['responseCode'] = code
        if status != 200 or str(code) != '200':
            return result
    except StopSignalError:
        raise
    except Exception:
        return result
    try:
        after = order_rows(read(VIEW_PATH + order_number), order_number)
    except StopSignalError:
        raise
    except Exception:
        return result
    result['statusesAfter'] = [r['status'] for r in after]
    if after and all(r['status'] == CANCELLED and not r['cancel_button'] for r in after):
        result['state'] = 'CANCELLED'
    return result
