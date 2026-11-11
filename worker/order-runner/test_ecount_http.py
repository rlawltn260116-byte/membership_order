import base64
import copy
import json
import unittest
import ecount_http as E


class FakeSession(E.EcountSession):
    """네트워크 없이 _send만 대체한다."""

    def __init__(self, replies):
        super().__init__()
        self.replies, self.sent = list(replies), []

    def _send(self, method, url, *, json_body=None, form=None, headers=None):
        self.sent.append((method, url, json_body, form))
        status, hdrs, text = self.replies.pop(0)
        return status, hdrs, text


class Headers(dict):
    def get(self, k, d=''):
        return super().get(k, d)


LOGIN_PAGE = (200, Headers(), '<form id="loginForm"></form>')
ZONE = (200, Headers(), '{"Data":{"ZONE":"CC","COM_CODE":"123456","DOMAIN":".ecount.com"}}')
TS = (200, Headers(), '{"Data":{"ts":"abc"}}')
OK_LOGIN = (302, Headers({'Location': 'https://c-portalcc.ecount.com/ec5/view/c_portal?ec_req_sid=SID1'}), '')


class EcountHttpTest(unittest.TestCase):
    def test_password_xor_matches_script(self):
        # AX: UTF-8 바이트 XOR 토큰 글자. 'a'^'1'=50, 'b'^'2'=50
        self.assertEqual(E.encode_password('ab', '1234567'), '7' + '1234567' + '5050')

    def test_password_key_cycles_and_utf8(self):
        out = E.encode_password('가', '1234567')
        self.assertEqual(len(out), 1 + 7 + 6)  # 한글 UTF-8 3바이트

    def test_token_rejects_non_digits(self):
        with self.assertRaises(E.EcountError):
            E.encode_password('x', 'abc')

    def test_make_token_is_first_seven_digits(self):
        self.assertEqual(E.make_token(1731300000123), '1731300')

    def test_zone_host(self):
        self.assertEqual(E.zone_host('CC', '.ecount.com'), 'https://c-portalCC.ecount.com')
        with self.assertRaises(E.EcountError):
            E.zone_host('../x', '.ecount.com')
        with self.assertRaises(E.EcountError):
            E.zone_host('CC', '.evil.com/')

    def test_login_fields_have_no_plain_password(self):
        f = E.build_login_fields('code', 'c', 'u', 'secretpw', 'ts', 'CC', '.ecount.com', token='1234567')
        self.assertNotIn('secretpw', ''.join(f.values()))
        self.assertEqual(f['login_type'], 'C')
        self.assertIn('spasswd', f)

    def test_stop_signals(self):
        with self.assertRaises(E.StopSignalError):
            E.check_stop_signal('<div>captcha</div>')
        E.check_stop_signal('<html>ok</html>')

    def test_host_allowlist(self):
        s = E.EcountSession()
        with self.assertRaises(E.EcountError):
            s._send('GET', 'https://example.com/')
        with self.assertRaises(E.EcountError):
            s._send('GET', 'http://c-portal.ecount.com/')

    def test_login_flow_posts_once_and_only_to_zone_host(self):
        s = FakeSession([LOGIN_PAGE, ZONE, TS, OK_LOGIN])
        r = s.login('code', 'user', 'pw')
        self.assertEqual(r['status'], 302)
        self.assertEqual(r['location_path'], '/ec5/view/c_portal')
        self.assertEqual(s.sent[-1][0], 'POST')
        self.assertTrue(s.sent[-1][1].endswith('/ec56/view/login/cs_login_processor'))
        self.assertIn('c-portalCC.ecount.com', s.sent[-1][1])
        self.assertEqual(s.sid_param(), 'ec_req_sid=SID1')
        with self.assertRaises(E.EcountError):
            s.login('code', 'user', 'pw')  # 자동 재시도 금지

    def test_failed_login_is_not_retried(self):
        s = FakeSession([LOGIN_PAGE, ZONE, TS, (200, Headers(), '<form id="loginForm"></form>')])
        with self.assertRaises(E.EcountError):
            s.login('code', 'user', 'wrong')
        self.assertTrue(s.stopped)
        with self.assertRaises(E.EcountError):
            s.login('code', 'user', 'wrong')

    def test_unknown_company_stops_before_login_post(self):
        s = FakeSession([LOGIN_PAGE, (200, Headers(), '{"Data":{"EMPTY_ZONE":true}}')])
        with self.assertRaises(E.EcountError):
            s.login('nope', 'u', 'p')
        self.assertFalse(s.login_sent)

    def test_get_appends_sid(self):
        s = FakeSession([LOGIN_PAGE, ZONE, TS, OK_LOGIN, (200, Headers(), 'x')])
        s.login('c', 'u', 'p')
        s.get(E.ORDER_INPUT_PAGE + '?mode=read')
        self.assertTrue(s.sent[-1][1].endswith('&ec_req_sid=SID1'))


def xor_viewbag(data, key='1234567'):
    raw = json.dumps(data, ensure_ascii=False).encode()
    return str(len(key)) + key + ''.join('%02x' % (b ^ ord(key[i % len(key)])) for i, b in enumerate(raw))


SCREEN_DATA = {'InitDatas': {'ViewData': {'Master': {'CUST': '모의거래처', 'ADDR': '기본주소금지'}, 'Details': []}}}
SCREEN_HTML = '<script>window["viewBag" + "ESD004M_mock"] = $.xextend( ' + json.dumps({
    'CacheInfo': {}, '_x_': xor_viewbag(SCREEN_DATA),
}) + ', {});</script>'
SEARCH_CONTEXT = {k: '' for k in E.SEARCH_CONTEXT_FIELDS}
SEARCH_CONTEXT.update(DecP=6, errorInfo={'programId': '모의프로그램', 'pageId': '모의화면', 'menuTitle': '모의메뉴'}, SerialList=[])
NAV_CONTEXT = {'alreadyIncludedLayout': True, 'requestKey': '모의키', 'viewer_id': '',
               'panel_id': '', 'is_from_left_menu': True, 'PRG_ID': '모의프로그램'}


class EcountReadAndDraftTest(unittest.TestCase):
    def logged_in(self, replies=()):
        s = FakeSession([LOGIN_PAGE, ZONE, TS, OK_LOGIN, *replies])
        s.login('모의회사', '모의사용자', '모의비밀번호%')
        return s

    def test_screen_xor_is_decoded_without_executing_script(self):
        result = E.parse_order_input_page(SCREEN_HTML + '<script>throw new Error("실행금지")</script>')
        self.assertEqual(result['InitDatas'], SCREEN_DATA['InitDatas'])
        self.assertNotIn('_x_', result)

    def test_missing_changed_or_error_screen_is_rejected(self):
        for html in ('<form id="loginForm"></form>', SCREEN_HTML.replace('_x_', '_e_'),
                     SCREEN_HTML.replace('ESD004M_mock', '다른화면'), SCREEN_HTML.replace('1234567', '')):
            with self.subTest(html_length=len(html)), self.assertRaises(E.EcountError):
                E.parse_order_input_page(html)

    def test_screen_loader_only_uses_read_route_and_copied_navigation(self):
        s = self.logged_in([(200, Headers(), SCREEN_HTML)])
        original = copy.deepcopy(NAV_CONTEXT)
        self.assertEqual(s.load_order_input_data(NAV_CONTEXT)['InitDatas'], SCREEN_DATA['InitDatas'])
        method, url, body, form = s.sent[-1]
        self.assertEqual(method, 'POST')
        self.assertIn(E.ORDER_INPUT_PAGE + '?ec_req_sid=', url)
        self.assertEqual(body, original)
        self.assertEqual(NAV_CONTEXT, original)
        self.assertIsNone(form)

    def test_search_preserves_session_context_and_observed_duplicate_fields(self):
        original = copy.deepcopy(SEARCH_CONTEXT)
        body = E.build_product_search_body(SEARCH_CONTEXT, '모의품목%')
        self.assertEqual(body['keyword'], '모의품목%')
        self.assertEqual(body['Request']['Data']['keyword'], body['keyword'])
        self.assertIn('CANCEL', body['Request']['Data'])
        self.assertNotIn('CANCEL', body)
        body['Request']['Data']['SerialList'].append('변경')
        self.assertEqual(SEARCH_CONTEXT, original)

    def test_unknown_context_stops_before_request(self):
        s = self.logged_in()
        with self.assertRaises(E.EcountError):
            s.lookup_products('품목', {})
        with self.assertRaises(E.EcountError):
            s.load_order_input_data({})
        self.assertEqual(len(s.sent), 4)

    def test_product_response_base64_and_plain_json(self):
        response = {'Status': '200', 'Data': {'TotalCount': 1, 'Data': [{'PROD_CD': '모의품목', 'PRICE': '100'}]}}
        raw = json.dumps(response)
        for text in (raw, base64.b64encode(raw.encode()).decode()):
            with self.subTest(encoded=text != raw):
                s = self.logged_in([(200, Headers(), text)])
                self.assertEqual(s.lookup_products('모의품목', SEARCH_CONTEXT)['items'], response['Data']['Data'])
                self.assertTrue(s.sent[-1][1].endswith('&xce=none'))
                self.assertEqual(s.sent[-1][0], 'POST')

    def test_lookup_requires_login(self):
        with self.assertRaises(E.EcountError):
            FakeSession([]).lookup_products('품목', SEARCH_CONTEXT)

    def test_auth_redirect_stops_without_retry(self):
        s = self.logged_in([(302, Headers({'Location': '/login'}), '')])
        with self.assertRaises(E.EcountError):
            s.lookup_products('품목', SEARCH_CONTEXT)
        with self.assertRaises(E.EcountError):
            s.lookup_products('품목', SEARCH_CONTEXT)
        self.assertEqual(len(s.sent), 5)

    def test_api_security_message_stops_session(self):
        s = self.logged_in([(200, Headers(), '{"Status":"500","Error":{"Message":"추가 인증"}}')])
        with self.assertRaises(E.StopSignalError):
            s.lookup_products('품목', SEARCH_CONTEXT)
        self.assertTrue(s.stopped)
        with self.assertRaises(E.EcountError):
            s.lookup_products('품목', SEARCH_CONTEXT)
        self.assertEqual(len(s.sent), 5)

    def test_compression_and_bad_response_do_not_disclose_body(self):
        for text, compression in [('비공개본문', ''), ('e30=', 'unknown'), ('[]', '')]:
            with self.subTest(compression=compression), self.assertRaises(E.EcountError) as err:
                E.decode_api_response(text, compression=compression)
            self.assertNotIn('비공개본문', str(err.exception))

    def test_save_print_delete_and_unknown_requests_are_rejected_before_network(self):
        s = E.EcountSession()
        for path in ('/ECAPI/SVC/Inventory/SaleOrder/Save', '/ECERP/SVC/ESD/ESD005R',
                     '/ECAPI/SVC/Inventory/SaleOrder/Delete', '/unknown'):
            for method in ('GET', 'POST'):
                with self.subTest(path=path, method=method), self.assertRaises(E.EcountError):
                    s._send(method, E.PORTAL + path)
        self.assertEqual(s.trace, [])

    def test_transport_failure_hides_session_url_and_stops(self):
        from unittest.mock import patch
        from urllib.error import URLError
        s = E.EcountSession()
        with patch.object(s.opener, 'open', side_effect=URLError('모의비공개세션주소')):
            with self.assertRaises(E.EcountError) as err:
                s._send('GET', E.PORTAL + '/')
        self.assertNotIn('모의비공개세션주소', str(err.exception))
        self.assertTrue(s.stopped)

    def draft(self, **overrides):
        args = dict(order_date='20261111', due_date='20261112', recipient='모의수취인',
                    phone='모의연락처', address='모의신규주소', memo='모의비고만',
                    delivery_fields=E.MYEONGSEONG_DELIVERY_FIELDS)
        args.update(overrides)
        return E.create_order_draft(SCREEN_DATA, {'PROD_CD': '모의품목'}, '1.5', **args)

    def test_draft_keeps_new_address_and_memo_without_invented_values(self):
        original = copy.deepcopy(SCREEN_DATA)
        draft = self.draft()
        self.assertFalse(draft['submission_ready'])
        self.assertEqual(draft['line']['QTY'], '1.5')
        self.assertEqual(draft['delivery']['ADD_TXT_01'], '모의비고만')
        self.assertEqual(draft['delivery']['p_remarks2'], '모의신규주소')
        self.assertNotIn('기본주소금지', json.dumps(draft, ensure_ascii=False))
        self.assertNotIn('Request', draft)
        self.assertNotIn('url', draft)
        self.assertEqual(SCREEN_DATA, original)
        self.assertEqual(self.draft(memo='')['delivery']['ADD_TXT_01'], '')

    def test_unknown_vendor_mapping_and_invalid_delivery_are_rejected(self):
        for override in ({'delivery_fields': None}, {'delivery_fields': {'memo': 'REMARKS'}},
                         {'recipient': ''}, {'address': ''}, {'phone': ''},
                         {'order_date': '20260230'}, {'due_date': '2026-11-12'}):
            with self.subTest(fields=list(override)), self.assertRaises(E.EcountError):
                self.draft(**override)

    def test_nonpositive_or_nonfinite_quantity_is_rejected(self):
        for qty in ('NaN', 'Infinity', '-1', '0', True, None):
            with self.subTest(qty=qty), self.assertRaises(E.EcountError):
                E.create_order_draft(SCREEN_DATA, {'PROD_CD': '모의품목'}, qty,
                    order_date='20261111', due_date='20261112', recipient='모의수취인',
                    phone='모의연락처', address='모의주소', delivery_fields=E.MYEONGSEONG_DELIVERY_FIELDS)

    def test_password_percent_survives_form_encoding(self):
        s = self.logged_in()
        from urllib.parse import parse_qs, urlencode
        form = s.sent[3][3]
        self.assertEqual(parse_qs(urlencode(form))['spasswd'][0], form['spasswd'])

    def test_failed_zone_preflight_cannot_be_retried(self):
        s = FakeSession([LOGIN_PAGE, (200, Headers(), '{"Data":{"EMPTY_ZONE":true}}')])
        for _ in range(2):
            with self.assertRaises(E.EcountError):
                s.login('모의회사', '모의사용자', '모의비밀번호')
        self.assertEqual(len(s.sent), 2)

    def test_ecbzip_header_with_observed_base64_json(self):
        value = {'Status': '200', 'Data': {'Data': [], 'TotalCount': 0}}
        encoded = base64.b64encode(json.dumps(value).encode()).decode()
        self.assertEqual(E.decode_api_response(encoded, compression='ecbzip'), value)
        with self.assertRaises(E.EcountError):
            E.decode_api_response('알수없는압축본문', compression='ecbzip')

    def test_param_is_actual_search_text_and_context_is_unchanged(self):
        original = copy.deepcopy(SEARCH_CONTEXT)
        body = E.build_product_search_body(SEARCH_CONTEXT, '모의품목')
        self.assertEqual(body['PARAM'], '모의품목')
        self.assertEqual(body['Request']['Data']['PARAM'], '모의품목')
        self.assertEqual(SEARCH_CONTEXT, original)

    def test_standalone_screen_id_requires_matching_program(self):
        data = copy.deepcopy(SCREEN_DATA)
        data['ProgramInfo'] = {'PROGRAM_ID': 'E040203'}
        html = '<script>window["viewBag" + ""] = $.xextend(' + json.dumps(data) + ', {});</script>'
        self.assertEqual(E.parse_order_input_page(html)['InitDatas'], data['InitDatas'])
        with self.assertRaises(E.EcountError):
            E.parse_order_input_page(html.replace('E040203', 'E040204'))

    def test_screen_parser_discards_unneeded_account_password_field(self):
        data = copy.deepcopy(SCREEN_DATA)
        data['InitDatas']['CustPassModifyData'] = [{'PASSWORD': '모의암호필드', 'CS_MIN_ORDER_QTY': 'B'}]
        html = '<script>window["viewBag" + "ESD004M_mock"] = $.xextend(' + json.dumps(data) + ', {});</script>'
        parsed = E.parse_order_input_page(html)
        self.assertNotIn('PASSWORD', parsed['InitDatas']['CustPassModifyData'][0])
        self.assertEqual(parsed['InitDatas']['CustPassModifyData'][0]['CS_MIN_ORDER_QTY'], 'B')

    def test_default_navigation_uses_matching_screen_prefix(self):
        s = self.logged_in([(200, Headers(), SCREEN_HTML)])
        s.load_order_input_data()
        body = s.sent[-1][2]
        self.assertEqual(body['PRG_ID'], 'E040203')
        self.assertTrue(body['requestKey'].startswith('ESD004M_'))
        with self.assertRaises(E.EcountError):
            E.EcountSession.navigation_context('저장프로그램')

    def test_order_list_loader_and_query_copy_read_context(self):
        list_data = {'DefaultOption': {
            'PROGRAM_ID': 'E040204', 'MENU_SEQ': '모의메뉴', 'outputFormType': 'OR020',
            'basicFormSeq': 1, 'BASE_DATE_FROM': '20261101', 'BASE_DATE_TO': '20261111',
        }}
        html = '<script>window["viewBag" + "ESD005M_mock"] = $.xextend(' + json.dumps(list_data) + ', {});</script>'
        response = json.dumps({'Status': '200', 'Data': {'TotalCount': 0, 'Data': []}})
        s = self.logged_in([(200, Headers(), html), (200, Headers(), response)])
        context = E.order_query_context(s.load_order_list_data())
        original = copy.deepcopy(context)
        self.assertEqual(s.query_orders(context), {'items': [], 'total_count': 0})
        self.assertEqual(context, original)
        self.assertEqual(s.sent[-1][2], {'Request': {'Data': original}})
        self.assertIn(E.ORDER_LIST_API, s.sent[-1][1])
        with self.assertRaises(E.EcountError):
            s.query_orders(dict(context, PRG_ID='다른프로그램'))
        self.assertEqual(len(s.sent), 6)

    def test_form_loader_uses_screen_form_and_never_copies_account_data(self):
        data = {'DefaultOption': {'FormKey': {'FORM_TYPE': 'OI020', 'FORM_SEQ': 3, 'COM_CODE': '모의비공개'}}}
        s = self.logged_in([(200, Headers({'X-Compression': 'ecbzip'}),
                            base64.b64encode(json.dumps({'Status': '200', 'Data': {'columns': []}}).encode()).decode())])
        self.assertEqual(s.load_input_form(data), {'columns': []})
        self.assertEqual(s.sent[-1][2]['FormSeq'], 3)
        self.assertNotIn('모의비공개', json.dumps(s.sent[-1][2]))
        with self.assertRaises(E.EcountError):
            s.load_input_form({'DefaultOption': {'FormKey': {'FORM_TYPE': '다른양식', 'FORM_SEQ': 1}}})
        self.assertEqual(len(s.sent), 5)

    def test_add_text_master_detail_keys_and_empty_cleanup(self):
        dto = E.serialize_add_text_dto('20261111', master_text={'ADD_TXT_02': '모의상단'},
            detail_text=[('1', {'ADD_TXT_01': '모의비고\n원문'}), ('2', {'ADD_TXT_01': ''})])
        self.assertEqual(dto['BizzClasCds'], ['ORD', 'ORD', 'ORD'])
        self.assertEqual(len(dto['AddTxt']), 2)
        self.assertEqual(dto['AddTxt'][0]['SLIP_CLAS_CD'], 'M')
        self.assertEqual(dto['AddTxt'][0]['Key']['ADD_ITEM_SNO'], '0')
        self.assertEqual(dto['AddTxt'][1]['SLIP_CLAS_CD'], 'T')
        self.assertEqual(dto['AddTxt'][1]['Key'],
            {'BIZZ_CLAS_CD': 'ORD', 'ADD_ITEM_ID': '20261111', 'ADD_ITEM_NO': 0, 'ADD_ITEM_SNO': '1'})
        self.assertEqual(dto['AddTxt'][1]['ADD_TXT_01'], '모의비고\n원문')
        self.assertEqual(dto['AddCd'], [])

    def test_add_text_rejects_unknown_fields_and_duplicate_rows(self):
        for rows in ([('1', {'ADDR': '모의주소'})], [('0', {})],
                     [('1', {}), ('1', {})], [('1', {'ADD_TXT_01': None})]):
            with self.subTest(rows=rows), self.assertRaises(E.EcountError):
                E.serialize_add_text_dto('20261111', detail_text=rows)

    def test_offline_projection_uses_adddto_and_uppercase_standard_fields(self):
        draft = self.draft()
        projection = E.draft_save_projection(draft)
        self.assertFalse(projection['complete'])
        self.assertEqual(projection['Details'][0]['REMARKS'], '모의수취인')
        self.assertEqual(projection['Details'][0]['P_REMARKS2'], '모의신규주소')
        self.assertNotIn('ADD_TXT_01', projection['Details'][0])
        self.assertEqual(projection['AddDto']['AddTxt'][0]['ADD_TXT_01'], '모의비고만')
        self.assertNotIn('Request', projection)
        self.assertNotIn('기본주소금지', json.dumps(projection, ensure_ascii=False))

    def test_unmapped_vendor_draft_remains_unbound(self):
        args = dict(order_date='20261111', due_date='20261112', recipient='모의수취인',
                    phone='모의연락처', address='모의신규주소', memo='')
        draft = E.create_order_review(SCREEN_DATA, {'PROD_CD': '모의품목'}, 1, **args)
        self.assertFalse(draft['delivery_mapping_verified'])
        self.assertNotIn('delivery', draft)
        self.assertEqual(draft['unmapped_delivery']['address'], '모의신규주소')
        projection = E.draft_save_projection(draft)
        self.assertNotIn('REMARKS', projection['Details'][0])
        self.assertEqual(projection['AddDto']['AddTxt'], [])

    def test_minimum_quantity_policy_is_resolved_without_exposing_amounts(self):
        product = dict(PRICE='모의단가', PRICE_VAT_INCLUDE='모의단가', PRICE_VAT_YN='N',
                       VAT_YN='1', VAT_RATE_BY='1', CS_MIN_ORDER_QTY='2')
        config = {'LookupConfig': {'MIN_ORDER_POLICY_BY_ID': 'B', 'CS_MIN_ORDER_QTY': 'Y'}}
        result = E.review_product_policy(config, product, 1)
        self.assertTrue(result['minimum_policy_resolved'])
        self.assertFalse(result['minimum_satisfied'])
        self.assertFalse(result['amounts_verified'])
        self.assertNotIn('모의단가', json.dumps(result))
        self.assertTrue(E.review_product_policy(config, product, 2)['minimum_satisfied'])
        self.assertIsNone(E.review_product_policy({}, product, 1)['minimum_satisfied'])

    def test_sebian_header_mapping_goes_to_master_and_stays_unsubmittable(self):
        args = dict(order_date='20261111', due_date='20261112', recipient='모의수취인',
                    phone='모의연락처', address='모의신규주소', memo='모의비고만')
        draft = E.create_order_draft(SCREEN_DATA, {'PROD_CD': '모의품목'}, 1,
                                     delivery_fields=E.SEBIAN_DELIVERY_FIELDS, **args)
        self.assertFalse(draft['submission_ready'])
        projection = E.draft_save_projection(draft)
        self.assertEqual(projection['Master']['P_DES5'], '모의신규주소')
        self.assertEqual(projection['Master']['P_DES6'], '모의비고만')
        self.assertNotIn('P_DES4', projection['Details'][0])
        self.assertEqual(projection['AddDto']['AddTxt'], [])
        self.assertFalse(projection['complete'])

    def test_line_amounts_are_computed_offline_and_mismatch_stops(self):
        product = dict(PRICE='1000', PRICE_VAT_INCLUDE='1100', VAT_YN='N', VAT_RATE_BY='10.000')
        result = E.compute_line_amounts(product, 3)
        self.assertEqual((result['supply_amt'], result['vat_amt'], result['total']), (3000, 300, 3300))
        self.assertFalse(result['server_verified'])
        with self.assertRaises(E.EcountError):
            E.compute_line_amounts(dict(product, PRICE_VAT_INCLUDE='1200'), 1)
        with self.assertRaises(E.EcountError):
            E.compute_line_amounts({'PRICE': '1'}, 1)

    def test_unverified_cache_and_temporary_save_routes_are_blocked(self):
        s = E.EcountSession()
        for path in ('/ECERP/SVC/Popup/GetXFormCache', '/ECAPI/SVC/TemporarySave/Save',
                     '/ECAPI/SVC/Inventory/SaleOrder/Save?mode=print'):
            with self.subTest(path=path), self.assertRaises(E.EcountError):
                s._send('GET', E.PORTAL + path)
        self.assertEqual(s.trace, [])


if __name__ == '__main__':
    unittest.main()
