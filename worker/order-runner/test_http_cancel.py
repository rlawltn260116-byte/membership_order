import io
import unittest
import urllib.parse
from email.message import Message
from types import SimpleNamespace
from unittest.mock import Mock

from http_cancel import cancel_bofeel_order, cancel_fields, order_rows
from http_login_draft import LoginError, StopSignalError

NUMBER = '2600000000000001'
SCRIPT = """<script>$('.js_btn_order_cancel').click(function (e) { var params = { mode: 'cancelRegist',
orderNo: 1 }; $.post('../mypage/order_ps.php', params, function (data) {}); });</script>"""
ON = {'ENABLE_B2B_HTTP_CANCEL': 'true'}


def view(statuses, button=True, number=NUMBER):
    rows = ''.join(f'<tr data-order-no="{number}" data-order-goodsno="{100 + i}" data-order-status="{s}">'
                   f'<td>{"<a class=\"js_btn_order_cancel\">주문취소</a>" if button and i == 0 else ""}</td></tr>'
                   for i, s in enumerate(statuses))
    return '<table>' + rows + '</table>' + SCRIPT


def response(text, code=200):
    result = io.BytesIO(text.encode())
    result.code = code
    result.headers = Message()
    return result


def session():
    return SimpleNamespace(vendor='bofeel', authenticated=True)


class CancelTests(unittest.TestCase):
    def test_fields_use_first_button_row_only(self):
        fields = cancel_fields(view(['o1', 'o1']), NUMBER)
        self.assertEqual(fields, [('mode', 'cancelRegist'), ('orderNo', NUMBER), ('orderGoodsNo', '100'), ('orderStatus', 'o1')])

    def test_other_order_rows_are_ignored(self):
        html = view(['o1']) + view(['o1'], number='2600000000000002')
        self.assertEqual(len(order_rows(html, NUMBER)), 1)

    def test_not_waiting_or_missing_button_is_not_sent(self):
        for html in (view(['c4']), view(['o1', 'p1']), view(['o1'], button=False), view(['o1']).replace('cancelRegist', 'x')):
            with self.assertRaises(LoginError):
                cancel_fields(html, NUMBER)

    def test_locked_by_default_and_requires_own_number(self):
        send = Mock()
        read = Mock(return_value=view(['o1']))
        for env in ({}, {'ENABLE_B2B_HTTP_CANCEL': 'TRUE'}):
            with self.assertRaises(LoginError):
                cancel_bofeel_order(session(), NUMBER, [NUMBER], authorized=True, environ=env, read=read, transport=send)
        with self.assertRaises(LoginError):
            cancel_bofeel_order(session(), NUMBER, [NUMBER], environ=ON, read=read, transport=send)
        with self.assertRaises(LoginError):
            cancel_bofeel_order(session(), NUMBER, ['2600000000000009'], authorized=True, environ=ON, read=read, transport=send)
        send.assert_not_called()
        read.assert_not_called()

    def test_success_sends_once_and_verifies_all_rows_cancelled(self):
        s = session()
        read = Mock(side_effect=[view(['o1', 'o1']), view(['c4', 'c4'], button=False)])
        send = Mock(return_value=response('{"code":200,"message":"ok"}'))
        result = cancel_bofeel_order(s, NUMBER, [NUMBER], authorized=True, environ=ON, read=read, transport=send)
        self.assertEqual(result['state'], 'CANCELLED')
        request = send.call_args[0][0]
        self.assertEqual(request.full_url, 'https://bofeelmall.com/mypage/order_ps.php')
        self.assertEqual(urllib.parse.parse_qsl(request.data.decode()),
                         [('mode', 'cancelRegist'), ('orderNo', NUMBER), ('orderGoodsNo', '100'), ('orderStatus', 'o1')])
        with self.assertRaises(LoginError):
            cancel_bofeel_order(s, NUMBER, [NUMBER], authorized=True, environ=ON, read=read, transport=send)
        self.assertEqual(send.call_count, 1)

    def test_unclear_results_are_unknown_without_resend(self):
        cases = [(response('{"code":400,"message":"x"}'), view(['c4'], button=False)),
                 (response('not json'), view(['c4'], button=False)),
                 (response('{"code":200}'), view(['o1']))]
        for reply, after in cases:
            send = Mock(return_value=reply)
            read = Mock(side_effect=[view(['o1']), after])
            result = cancel_bofeel_order(session(), NUMBER, [NUMBER], authorized=True, environ=ON, read=read, transport=send)
            self.assertEqual(result['state'], 'UNKNOWN')
            self.assertEqual(send.call_count, 1)
        send = Mock(side_effect=TimeoutError())
        result = cancel_bofeel_order(session(), NUMBER, [NUMBER], authorized=True, environ=ON,
                                     read=Mock(return_value=view(['o1'])), transport=send)
        self.assertEqual(result['state'], 'UNKNOWN')

    def test_precheck_hold_is_not_sent_and_stop_signal_propagates(self):
        send = Mock()
        result = cancel_bofeel_order(session(), NUMBER, [NUMBER], authorized=True, environ=ON,
                                     read=Mock(return_value=view(['c4'])), transport=send)
        self.assertEqual(result['state'], 'NOT_SENT')
        send.assert_not_called()
        with self.assertRaises(StopSignalError):
            cancel_bofeel_order(session(), NUMBER, [NUMBER], authorized=True, environ=ON,
                                read=Mock(side_effect=StopSignalError('x')), transport=send)


if __name__ == '__main__':
    unittest.main()
