import io
import unittest
from unittest.mock import Mock, patch

from http_preparation import (PreparationSession, eroum_draft, main,
                              product_object, eroum_product_fields, prepare_bofeel)
from http_login_draft import LoginError, StopSignalError
from http_cart import CartRow, CartSnapshot, OrderDraft


class PreparationTests(unittest.TestCase):
    def bofeel_session(self):
        row = CartRow('1000000025', 'BFSH10', '', 1, 'cartSno[]', 'mock-row', 'mock-row')
        session = Mock()
        session.cart_html = '<form id="frmCart">장바구니에 담겨있는 상품이 없습니다.</form>'
        session.created_row = row
        session.add_one.return_value = CartSnapshot('bofeel', [row], [], False)
        session.get_cart.side_effect = [session.add_one.return_value, CartSnapshot('bofeel', [], [], True)]
        return session

    def test_bofeel_preparation_clears_draft_deletes_only_created_row_and_checks_empty(self):
        session = self.bofeel_session()
        draft = OrderDraft([('mock-token', 'sensitive')], {'valid': True, 'submission_allowed': False})
        session.order_draft.return_value = draft
        result = prepare_bofeel(session, {})
        self.assertTrue(result['final_empty'])
        session.delete_row.assert_called_once_with(session.add_one.return_value, session.created_row)
        self.assertEqual(session.get_cart.call_count, 2)
        self.assertEqual(draft.fields, [])

    def test_bofeel_invalid_draft_cleans_up_but_never_reports_success(self):
        session = self.bofeel_session()
        session.order_draft.return_value = OrderDraft([], {'valid': False})
        with self.assertRaises(LoginError):
            prepare_bofeel(session, {})
        session.delete_row.assert_called_once()
        self.assertEqual(session.get_cart.call_count, 2)

    def test_bofeel_stop_signal_does_not_even_request_cleanup(self):
        session = self.bofeel_session()
        session.order_draft.side_effect = StopSignalError('중단 신호')
        with self.assertRaises(StopSignalError):
            prepare_bofeel(session, {})
        session.get_cart.assert_not_called()
        session.delete_row.assert_not_called()

    def test_bofeel_changed_row_is_not_deleted(self):
        session = self.bofeel_session()
        session.order_draft.return_value = OrderDraft([], {'valid': True})
        other = CartRow('1000000025', 'BFSH10', '', 1, 'cartSno[]', 'other', 'other')
        session.get_cart.side_effect = [CartSnapshot('bofeel', [other], [], False)]
        with self.assertRaises(LoginError):
            prepare_bofeel(session, {})
        session.delete_row.assert_not_called()

    def test_disabled_has_no_session_or_site_request_even_with_credentials(self):
        for flag in (None, '', 'false', '1', 'TRUE'):
            env = {'EROUM_LOGIN_ID': 'mock', 'EROUM_LOGIN_PASSWORD': 'mock'}
            if flag is not None:
                env['ENABLE_B2B_HTTP_CART'] = flag
            with patch('http_preparation.PreparationSession') as session, patch('sys.stdout', new=io.StringIO()):
                self.assertEqual(main([], env), 0)
                session.assert_not_called()

    def test_enabled_without_credentials_does_not_construct_session(self):
        with patch('http_preparation.PreparationSession') as session, patch('sys.stdout', new=io.StringIO()):
            self.assertEqual(main(['--vendor', 'bofeel'], {'ENABLE_B2B_HTTP_CART': 'true'}), 1)
            session.assert_not_called()

    def test_catalog_requests_and_forbidden_endpoints_are_bounded(self):
        session = PreparationSession('eroum')
        session.authenticated = True
        fields = [('it_id', 'PRO2022102700012')]
        with patch.object(session.opener, 'open', side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError):
                session.read_preparation('/shop/ajax.get_item.php', fields)
            with self.assertRaises(LoginError):
                session.read_preparation('/shop/ajax.get_item.php', fields)
            for path in ('/shop/ajax.simple_order.php', '/shop/orderformupdate.php',
                         'https://other.invalid/shop/orderinquiry.php'):
                with self.assertRaises(LoginError):
                    session.read_preparation(path)
            with self.assertRaises(LoginError):
                session.read_preparation('/shop/ajax.get_item.php', [('it_id', 'OTHER')])
            self.assertEqual(request.call_count, 1)

    def test_search_cannot_be_resent_or_changed(self):
        session = PreparationSession('eroum')
        session.authenticated = True
        fields = [('keyword', 'DYJ-03'), ('contain', 'true'), ('searchIn[]', 'it_name'),
                  ('searchIn[]', 'it_model'), ('searchIn[]', 'id'), ('searchIn[]', 'it_name_no_space')]
        with patch.object(session.opener, 'open', side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError): session.read_preparation('/shop/ajax.get_item.php', fields)
            with self.assertRaises(LoginError): session.read_preparation('/shop/ajax.get_item.php', fields)
            with self.assertRaises(LoginError): session.read_preparation('/shop/ajax.get_item.php', [('keyword', 'OTHER')])
            self.assertEqual(request.call_count, 1)

    def test_product_lookup_rejects_missing_wrong_and_ambiguous_objects(self):
        obj = {'it_id': 'PRO2022102700012', 'options': []}
        self.assertIsNone(product_object({'is_buy': 0, 'soldout_ck': 0}))
        self.assertIsNone(product_object([dict(obj, it_id='OTHER')]))
        self.assertIsNone(product_object([obj, obj]))
        self.assertEqual(product_object([obj]), obj)

    def test_dynamic_draft_preserves_duplicate_prices_and_payment_defaults(self):
        keys = ('it_price', 'it_buy_min_qty', 'it_buy_max_qty', 'it_buy_inc_qty', 'it_sc_type',
                'it_sc_qty', 'it_sc_minimum', 'it_sc_price', 'it_even_odd', 'it_even_odd_price', 'io_price')
        obj = {key: '1' for key in keys}
        obj.update(it_id='PRO2022102700012', options=[], stock_status='available', ca_id='mock')
        dynamic = set(keys) | {'it_id', 'io_type', 'ca_id', 'ca_id2', 'ca_id3', 'ca_id_delivery',
                              'cp_price', 'stock_status', 'io_id', 'prodMemo', 'ct_qty', 'ct_price'}
        source = '<script>function select_item(obj, io_id, ct_qty) {' + ','.join(k+'[]' for k in dynamic) + '}</script>'
        source += '<form id="simple_order" action="orderformupdate.php"><span class="ad_sel_addr" data-value="new">신규 배송지</span>'
        source += ''.join('<input name="'+k+'">' for k in ('od_b_name','od_b_tel','od_b_hp','od_b_zip','od_b_addr1','od_b_addr2','od_memo'))
        source += '<input name="settleKind" value="mock-payment"><input name="token" value="mock-secret"></form>'
        draft = eroum_draft(source, obj, dict(name='mock',phone='mock',postcode='mock',address='mock',detail='mock',memo='mock'))
        self.assertTrue(draft.safe_summary()['valid'])
        self.assertFalse(draft.safe_summary()['submission_allowed'])
        self.assertFalse(draft.safe_summary()['totals_recalculated'])
        self.assertEqual([v for k,v in draft.fields if k == 'it_price[]'], ['1','1'])
        self.assertIn(('token', 'mock-secret'), draft.fields)
        self.assertNotIn('mock-secret', str(draft.safe_summary()))
        # 기본 상품 검색 응답에는 io_price가 없으며 JS는 문자열 undefined를 렌더링한다.
        without_price = {k: v for k, v in obj.items() if k != 'io_price'}
        self.assertIn(('io_price[]', 'undefined'), eroum_product_fields(source, without_price))
        self.assertIn(('io_price[]', '0'), eroum_product_fields(source, dict(obj, io_price=0)))
        self.assertIn(('io_price[]', 'null'), eroum_product_fields(source, dict(obj, io_price=None)))
        self.assertIn(('it_sc_price[]', '0'), eroum_product_fields(source, dict(obj, it_sc_price=0)))
        # JS 문자열 연결은 io_type 누락을 '0'으로 바꾸고 ct_price는 parseInt 결과다.
        self.assertIn(('io_type[]', '0'), eroum_product_fields(source, without_price))
        self.assertIn(('ct_price[]', '1'), eroum_product_fields(source, dict(obj, it_price='01')))
        for invalid in (dict(obj, options=[{}]), dict(obj, stock_status='soldout'), dict(obj, it_buy_inc_qty='2'),
                        dict(obj, it_price='1,000'), dict(obj, it_price='1.5'), dict(obj, it_price=True),
                        {k: v for k, v in obj.items() if k != 'it_sc_price'}):
            with self.assertRaises(LoginError): eroum_product_fields(source, invalid)
        draft.clear()
        self.assertEqual(draft.fields, [])


if __name__ == '__main__':
    unittest.main()
