import io
from email.message import Message
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from http_cart import OrderDraft, values
from http_login_draft import LoginError
from http_submission import ENDPOINTS, bofeel_end_redirect, parse_order_numbers, submit_prepared, validate_request
from http_amounts import mark_verified

ENV = {'ENABLE_B2B_HTTP_SUBMIT': 'true', 'B2B_HTTP_SUBMIT_VENDORS': 'bofeel'}
OLD = '20261110000001'
NUMBER = '20261111000001'


def history(*numbers):
    return '로그아웃' + ''.join(f'<a href="/mypage/order_view.php?orderNo={number}">상세</a>' for number in numbers)


def bofeel_session():
    cart = Mock()
    return SimpleNamespace(vendor='bofeel', authenticated=True, origin='https://bofeelmall.com', get_cart=Mock(return_value=cart))


def submission_transport(text, *, end=None, after=None):
    return Mock(side_effect=[response(history(OLD)), response(text),
        response(end if end is not None else '로그아웃 주문 완료 주문번호: ' + NUMBER),
        response(after if after is not None else history(NUMBER, OLD))])


def draft(vendor):
    if vendor == 'eroum':
        fields = [('it_id[]', 'PRO2022102700012'), ('io_id[]', ''), ('ct_qty[]', '1'),
                  ('od_settle_case', '월 마감 정산'), ('pen_type', '0')]
        fields += [(k, '모의값') for k in ('od_b_name', 'od_b_tel', 'od_b_hp', 'od_b_zip', 'od_b_addr1')]
    else:
        fields = [('cartSno[]', 'mock-row'), ('shipping', 'shippingNew'), ('settleKind', 'gb'), ('bankAccount', 'mock-bank'), ('bankSender', '모의 입금자')]
        fields += [(k, '모의값') for k in ('receiverName', 'receiverPhone', 'receiverCellPhone', 'receiverZonecode', 'receiverAddress')]
    value = OrderDraft(fields, {'submission_ready': True})
    value.expected_fields = list(fields)
    mark_verified(vendor, value)
    return value


def response(text, code=200):
    result = io.BytesIO(text.encode())
    result.code = code
    result.headers = Message()
    return result


class SubmissionTests(unittest.TestCase):
    def test_disabled_never_calls_fake_transport(self):
        send = Mock()
        session = SimpleNamespace(vendor='eroum', authenticated=True)
        for env in ({}, {'ENABLE_B2B_HTTP_SUBMIT': 'TRUE'}, {'ENABLE_B2B_HTTP_SUBMIT': 'false'}):
            with self.assertRaises(LoginError):
                submit_prepared(session, draft('eroum'), authorized=True, environ=env, transport=send)
        with self.assertRaises(LoginError):
            submit_prepared(session, draft('eroum'), environ={'ENABLE_B2B_HTTP_SUBMIT': 'true'}, transport=send)
        send.assert_not_called()

    def test_only_fake_transport_receives_one_post_and_no_redirect_follow(self):
        session = bofeel_session()
        sent = submission_transport('<p>주문이 완료되었습니다. 주문번호: ' + NUMBER + '</p>')
        result = submit_prepared(session, draft('bofeel'), authorized=True, environ=ENV, transport=sent)
        self.assertEqual(result, {'state': 'SUBMITTED', 'orderNumber': NUMBER})
        self.assertEqual([call.args[0].get_method() for call in sent.call_args_list], ['GET', 'POST', 'GET', 'GET'])
        self.assertEqual(sent.call_args_list[1].args[0].full_url, ENDPOINTS['bofeel'])
        session.get_cart.return_value.require_empty.assert_called_once()
        with self.assertRaises(LoginError):
            submit_prepared(session, draft('bofeel'), authorized=True, environ=ENV, transport=sent)
        self.assertEqual(sent.call_count, 4)

    def test_vendor_list_and_eroum_are_blocked_before_any_request(self):
        sent = Mock()
        for vendor, vendors in [('bofeel', ''), ('bofeel', 'eroum'), ('bofeel', 'BOFEEL'), ('eroum', 'bofeel,eroum')]:
            with self.subTest(vendor=vendor, vendors=vendors), self.assertRaises(LoginError):
                submit_prepared(SimpleNamespace(vendor=vendor, authenticated=True), draft(vendor), authorized=True,
                    environ={**ENV, 'B2B_HTTP_SUBMIT_VENDORS': vendors}, transport=sent)
        sent.assert_not_called()

    def test_timeout_redirect_empty_and_multiple_numbers_stay_unknown(self):
        for outcome in (TimeoutError(), response('이동', 302), response('응답 불명'),
                        response('주문 완료 주문번호: 20261111000001 주문번호: 20261111000002')):
            send = Mock(side_effect=[response(history(OLD)), outcome])
            session = bofeel_session()
            self.assertEqual(submit_prepared(session, draft('bofeel'), authorized=True,
                environ=ENV, transport=send), {'state': 'UNKNOWN'})
            self.assertTrue(session.submission_attempted)
            self.assertEqual(send.call_count, 2)

    def test_url_method_field_drift_and_totals_are_checked_before_transport(self):
        for vendor in ('eroum', 'bofeel'):
            value = draft(vendor)
            for url, method, fields, ready in [(ENDPOINTS[vendor]+'?x=1', 'POST', value.fields, True),
                (ENDPOINTS[vendor], 'GET', value.fields, True), (ENDPOINTS[vendor], 'POST', value.fields+[('reflectApplyDelivery', 'y')], True),
                (ENDPOINTS[vendor], 'POST', value.fields, False)]:
                with self.assertRaises(LoginError):
                    validate_request(vendor, url, method, fields, value.expected_fields, totals_verified=ready)
            fields = value.fields+[('newUnknownField', 'x')]
            with self.assertRaises(LoginError):
                validate_request(vendor, ENDPOINTS[vendor], 'POST', fields, fields, totals_verified=True)

    def test_new_address_and_unique_cart_bindings_are_mandatory(self):
        value = draft('bofeel')
        for fields in ([('shipping', 'shippingBasic') if k == 'shipping' else (k, v) for k, v in value.fields],
                       value.fields+[('cartSno[]', values(value.fields, 'cartSno[]')[0])]):
            with self.assertRaises(LoginError):
                validate_request('bofeel', ENDPOINTS['bofeel'], 'POST', fields, fields, totals_verified=True)

    def test_parser_ignores_temporary_order_form_ids_external_links_and_body_without_success(self):
        text = '<a href="/shop/simple_order.php?od_id=20261111000001">임시</a><a href="https://other.invalid/shop/orderinquiryview.php?od_id=20261111000002">외부</a>주문번호: 20261111000003'
        self.assertEqual(parse_order_numbers('eroum', text, completion=True), set())
        self.assertEqual(parse_order_numbers('eroum', '<a href="/shop/orderinquiryview.php?od_id=20261111000004">상세</a>'), {'20261111000004'})
        self.assertEqual(parse_order_numbers('bofeel', '<a href="/mypage/order_view.php?orderNo=261111000001">상세</a>'), {'261111000001'})

    def test_bofeel_iframe_end_redirect_is_not_submitted_until_confirmed(self):
        ok = "<script type=\"text/javascript\">parent.location.replace('../order/order_end.php?orderNo=2611111234567890');</script>"
        self.assertEqual(bofeel_end_redirect(ok), '2611111234567890')
        self.assertEqual(bofeel_end_redirect("<script>parent.location.href='https://bofeelmall.com/order/order_end.php?orderNo=2611111234567890';</script>"), '2611111234567890')
        for bad in ("<script>alert('오류');parent.location.replace('../order/order_end.php?orderNo=2611111234567890');</script>",
                    "<script>parent.location.replace('https://evil.example/order/order_end.php?orderNo=2611111234567890');</script>",
                    "<script>parent.location.replace('../order/order_end.php?orderNo=2611111234567890&x=1');</script>",
                    "<script>parent.location.replace('../order/cart.php');</script>",
                    "<script>parent.location.replace('../order/order_end.php?orderNo=1');</script>",
                    "<script>location.replace('../order/order_end.php?orderNo=2611111234567890');location.replace('../order/order_end.php?orderNo=2611111234567891');</script>",
                    ''):
            self.assertIsNone(bofeel_end_redirect(bad))
        session = bofeel_session()
        sent = submission_transport(ok, end='로그아웃 주문번호 2611111234567890', after=history(OLD, '2611111234567890'))
        result = submit_prepared(session, draft('bofeel'), authorized=True, environ=ENV, transport=sent)
        self.assertEqual(result, {'state': 'SUBMITTED', 'orderNumber': '2611111234567890'})
        session = SimpleNamespace(vendor='eroum', authenticated=True, origin='https://eroumcare.com')
        with self.assertRaises(LoginError):
            submit_prepared(session, draft('eroum'), authorized=True, environ=ENV, transport=Mock())

    def test_confirmation_failure_or_unexpected_new_order_is_unknown_without_retry(self):
        for end, after in [('로그아웃 다른 번호', history(OLD, NUMBER)),
                           ('로그아웃 ' + NUMBER, history(OLD)),
                           ('로그아웃 ' + NUMBER, history(OLD, NUMBER, '20261111000002')),
                           ('로그인 필요 ' + NUMBER, history(OLD, NUMBER))]:
            session = bofeel_session()
            sent = submission_transport('주문 완료 주문번호: ' + NUMBER, end=end, after=after)
            self.assertEqual(submit_prepared(session, draft('bofeel'), authorized=True, environ=ENV, transport=sent), {'state': 'UNKNOWN'})
            self.assertEqual(sum(call.args[0].get_method() == 'POST' for call in sent.call_args_list), 1)
        session = bofeel_session()
        session.get_cart.side_effect = LoginError('모의 빈 장바구니 대조 실패')
        sent = submission_transport('주문 완료 주문번호: ' + NUMBER)
        self.assertEqual(submit_prepared(session, draft('bofeel'), authorized=True, environ=ENV, transport=sent), {'state': 'UNKNOWN'})

    def test_history_failure_before_post_keeps_submission_unattempted(self):
        for text in ('로그인 필요', '로그아웃 내역 구조 변경'):
            session = bofeel_session()
            sent = Mock(return_value=response(text))
            with self.assertRaises(LoginError):
                submit_prepared(session, draft('bofeel'), authorized=True, environ=ENV, transport=sent)
            self.assertFalse(getattr(session, 'submission_attempted', False))
            self.assertEqual(sent.call_count, 1)
    def test_list_pairs_hold_before_submission_marker(self):
        d = draft('bofeel')
        d.fields = [list(p) for p in d.fields]
        d.expected_fields = [list(p) for p in d.fields]
        d.amount_snapshot = tuple(d.fields)
        session = SimpleNamespace(vendor='bofeel', authenticated=True, origin='https://bofeelmall.com')
        sent = Mock()
        with self.assertRaises(LoginError):
            submit_prepared(session, d, authorized=True, environ=ENV, transport=sent)
        sent.assert_not_called()
        self.assertFalse(getattr(session, 'submission_attempted', False))


if __name__ == '__main__':
    unittest.main()
