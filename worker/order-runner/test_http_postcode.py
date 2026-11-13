import json
import unittest
from unittest.mock import Mock

from http_postcode import lookup
from http_login_draft import LoginError, StopSignalError
from test_http_submission import response


class PostcodeTests(unittest.TestCase):
    def test_disabled_or_invalid_scope_never_requests(self):
        opener = Mock()
        self.assertEqual(lookup(['모의 주소'], {}, opener), [])
        for keywords in ([], ['중복', '중복'], [''] * 31, [None]):
            with self.assertRaises(LoginError):
                lookup(keywords, {'ENABLE_B2B_HTTP_CART': 'true'}, opener)
        opener.open.assert_not_called()

    def test_only_search_endpoint_and_keyword_sent_and_response_is_minimal(self):
        item = {'roadAddress': '서울 모의구 가상로 1', 'groundAddress': '서울 모의구 가상동 1', 'zoneCode': '00000', 'other': '출력 금지'}
        opener = Mock(open=Mock(side_effect=[response('postcode_search_ps.php'), response(json.dumps({'resultData': {'codeData': {'code': '0'}, 'addressData': [item]}}))]))
        result = lookup(['서울 모의구 가상로 1'], {'ENABLE_B2B_HTTP_CART': 'true'}, opener, pause=Mock())
        self.assertEqual(result[0]['resultData']['addressData'][0], {key: item[key] for key in ('roadAddress', 'groundAddress', 'zoneCode')})
        self.assertEqual(opener.open.call_count, 2)
        req = opener.open.call_args.args[0]
        self.assertEqual(req.full_url, 'https://bofeelmall.com/share/postcode_search_ps.php')
        self.assertEqual(req.get_method(), 'POST')
        self.assertNotIn('출력 금지', json.dumps(result))

    def test_failure_stop_signal_and_bad_response_stop_without_retry(self):
        for payload in ('응답 불명', 'captcha', '{"resultData":{"codeData":{"code":"1"},"addressData":[]}}'):
            opener = Mock(open=Mock(side_effect=[response('postcode_search_ps.php'), response(payload)]))
            with self.assertRaises((ValueError, LoginError, StopSignalError)):
                lookup(['서울 모의구 가상로 1', '서울 모의구 가상로 2'], {'ENABLE_B2B_HTTP_CART': 'true'}, opener, pause=Mock())
            self.assertEqual(opener.open.call_count, 2)


if __name__ == '__main__':
    unittest.main()
