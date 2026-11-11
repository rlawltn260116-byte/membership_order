import io
from email.message import Message
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from http_cart import OrderDraft
from http_login_draft import LoginError
from http_submission import ENDPOINTS, parse_order_numbers, submit_prepared, validate_request


def draft(vendor):
    if vendor == 'eroum':
        fields = [('it_id[]', 'PRO2022102700012'), ('io_id[]', ''), ('ct_qty[]', '1'),
                  ('od_settle_case', '월 마감 정산'), ('pen_type', '0')]
        fields += [(k, '모의값') for k in ('od_b_name', 'od_b_tel', 'od_b_hp', 'od_b_zip', 'od_b_addr1')]
    else:
        fields = [('cartSno[]', 'mock-row'), ('shipping', 'shippingNew'), ('settleKind', 'gb'), ('termAgree_orderCheck', 'y')]
        fields += [(k, '모의값') for k in ('receiverName', 'receiverPhone', 'receiverCellPhone', 'receiverZonecode', 'receiverAddress')]
    value = OrderDraft(fields, {'submission_ready': True})
    value.expected_fields = list(fields)
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
        for vendor in ('eroum', 'bofeel'):
            session = SimpleNamespace(vendor=vendor, authenticated=True, origin=ENDPOINTS[vendor].split('/shop/')[0] if vendor == 'eroum' else 'https://bofeelmall.com')
            sent = Mock(return_value=response('<p>주문이 완료되었습니다. 주문번호: 20261111000001</p>'))
            result = submit_prepared(session, draft(vendor), authorized=True, environ={'ENABLE_B2B_HTTP_SUBMIT': 'true'}, transport=sent)
            self.assertEqual(result, {'state': 'SUBMITTED', 'orderNumber': '20261111000001'})
            request = sent.call_args.args[0]
            self.assertEqual(request.full_url, ENDPOINTS[vendor])
            self.assertEqual(request.get_method(), 'POST')
            with self.assertRaises(LoginError):
                submit_prepared(session, draft(vendor), authorized=True, environ={'ENABLE_B2B_HTTP_SUBMIT': 'true'}, transport=sent)
            self.assertEqual(sent.call_count, 1)

    def test_timeout_redirect_empty_and_multiple_numbers_stay_unknown(self):
        for outcome in (TimeoutError(), response('이동', 302), response('응답 불명'),
                        response('주문 완료 주문번호: 20261111000001 주문번호: 20261111000002')):
            send = Mock(side_effect=outcome) if isinstance(outcome, Exception) else Mock(return_value=outcome)
            session = SimpleNamespace(vendor='eroum', authenticated=True, origin='https://eroumcare.com')
            self.assertEqual(submit_prepared(session, draft('eroum'), authorized=True,
                environ={'ENABLE_B2B_HTTP_SUBMIT': 'true'}, transport=send), {'state': 'UNKNOWN'})
            self.assertTrue(session.submission_attempted)
            self.assertEqual(send.call_count, 1)

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

    def test_new_address_and_one_item_are_mandatory(self):
        value = draft('bofeel')
        for fields in ([('shipping', 'shippingBasic') if k == 'shipping' else (k, v) for k, v in value.fields],
                       value.fields+[('cartSno[]', 'second')]):
            with self.assertRaises(LoginError):
                validate_request('bofeel', ENDPOINTS['bofeel'], 'POST', fields, fields, totals_verified=True)

    def test_parser_ignores_temporary_order_form_ids_external_links_and_body_without_success(self):
        text = '<a href="/shop/simple_order.php?od_id=20261111000001">임시</a><a href="https://other.invalid/shop/orderinquiryview.php?od_id=20261111000002">외부</a>주문번호: 20261111000003'
        self.assertEqual(parse_order_numbers('eroum', text, completion=True), set())
        self.assertEqual(parse_order_numbers('eroum', '<a href="/shop/orderinquiryview.php?od_id=20261111000004">상세</a>'), {'20261111000004'})
        self.assertEqual(parse_order_numbers('bofeel', '<a href="/mypage/order_view.php?orderNo=261111000001">상세</a>'), {'261111000001'})


if __name__ == '__main__':
    unittest.main()
