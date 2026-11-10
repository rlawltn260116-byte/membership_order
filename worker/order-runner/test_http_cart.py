import pathlib
import unittest
import io
from email.message import Message
from unittest.mock import patch
from http_cart import (CartSession, Document, LoginError, build_order_draft, deletion_fields, parse_cart, serialize)


def eroum_row(index=0, product='PRO2022102700012', name='DYJ-03', qty=1):
    # 고객·계정·금액·세션 값 없는 실제 행 구조의 고정 자료.
    return f'''<tr class="tr-line"><td><input type="checkbox" name="ct_chk[{index}]"
        value="1" data-ctid="{index + 1}" data-qty="{qty}" checked></td><td></td><td>
        <input name="it_id[{index}]" value="{product}"><input name="it_name[{index}]" value="{name}">
        <input class="cart_qty" value="{qty}"><a>{name}</a><div class="well well-sm">
        <ul style="display:none"><li>{name} {qty}개<input class="io_reserve_yn" value=""></li></ul></div>
        </td><td>{qty}</td></tr>'''


def eroum_cart(rows):
    return '<form name="frmcartlist"><input name="act" value=""><table>' + rows + '</table></form>'


class CartTests(unittest.TestCase):
    def test_order_navigation_accepts_only_same_site_draft_redirect(self):
        snapshot = parse_cart('eroum', eroum_cart(eroum_row()))
        for target, accepted in (('simple_order.php?od_id=123', True),
                                 ('orderformupdate.php', False),
                                 ('https://other.invalid/shop/simple_order.php?od_id=123', False),
                                 ('simple_order.php?od_id=123&submit=1', False),
                                 ('simple_order.php', False)):
            session = CartSession('eroum')
            session.authenticated = True
            session.created_row = snapshot.rows[0]
            from http_cart import replace
            fields = replace(deletion_fields(snapshot, session.created_row), 'act', 'buy') + [('only_recipient','0')]
            response = io.BytesIO(b'')
            response.code = 302
            response.headers = Message()
            response.headers['Location'] = target
            with patch.object(session.opener, 'open', return_value=response) as request:
                if accepted:
                    session._operation('/shop/cartupdate.php', fields)
                    self.assertEqual(session.order_path, '/shop/simple_order.php?od_id=123')
                else:
                    with self.assertRaises(LoginError): session._operation('/shop/cartupdate.php', fields)
                self.assertEqual(request.call_count, 1)
                with self.assertRaises(LoginError): session._operation('/shop/cartupdate.php', fields)
                self.assertEqual(request.call_count, 1)

    def test_order_get_without_selection_and_unknown_source_stop_before_network(self):
        s = CartSession('eroum')
        s.authenticated = True
        s.created_row = parse_cart('eroum', eroum_cart(eroum_row())).rows[0]
        s.cart_html = eroum_cart(eroum_row())
        with patch.object(s.opener, 'open') as request:
            with self.assertRaises(LoginError): s._operation('/shop/simple_order.php')
            with self.assertRaises(LoginError): s.open_order()
            request.assert_not_called()

    def test_real_structure_has_no_named_option_or_quantity(self):
        snapshot = parse_cart('eroum', eroum_cart(eroum_row()))
        row = snapshot.require_single('PRO2022102700012', 'DYJ-03')
        self.assertEqual((row.quantity, row.option, row.cart_id), (1, '', '1'))
        self.assertEqual(row.selector, 'ct_chk[0]')
        fields = deletion_fields(snapshot, row)
        self.assertEqual([p for p in fields if p[0].startswith('ct_chk[')], [('ct_chk[0]', '1')])
        self.assertIn(('act', 'seldelete'), fields)

    def test_unknown_or_multiple_products_cannot_be_deleted(self):
        for body in (eroum_row() + eroum_row(1, 'OTHER', '다른 상품'),
                     eroum_row(product='OTHER'), eroum_row(qty=2)):
            snapshot = parse_cart('eroum', eroum_cart(body))
            with self.assertRaises(LoginError):
                snapshot.require_single('PRO2022102700012', 'DYJ-03')
            with self.assertRaises(LoginError):
                deletion_fields(snapshot, snapshot.rows[0])

    def test_quantity_and_option_mismatch_stop(self):
        cases = [eroum_row().replace('data-qty="1"', 'data-qty="2"'),
                 eroum_row().replace('<td>1</td>', '<td>2</td>'),
                 eroum_row().replace('DYJ-03 1개', 'DYJ-03 2개'),
                 eroum_row().replace('</ul>', '<li>다른 옵션 1개</li></ul>'),
                 eroum_row().replace('data-ctid="1"', '')]
        for body in cases:
            with self.subTest(body=body), self.assertRaises(LoginError):
                parse_cart('eroum', eroum_cart(body))

    def test_bofeel_ids_and_display_quantity(self):
        html = '''<form id="frmCart"><table><tr><td><input name="cartSno[]" value="mock-row"
        data-goods-no="1000000025" data-goods-nm="BFSH10" data-option-nm=""
        data-default-goods-cnt="1" type="checkbox" checked></td>
        <td><div class="order_goods_num"><strong>1개</strong></div></td></tr></table></form>'''
        snapshot = parse_cart('bofeel', html)
        row = snapshot.require_single('1000000025', 'BFSH10')
        self.assertIn(('cartSno[]', 'mock-row'), deletion_fields(snapshot, row))
        with self.assertRaises(LoginError): parse_cart('bofeel', html.replace('1개', '2개'))

    def test_empty_requires_marker_and_form(self):
        parse_cart('eroum', eroum_cart('장바구니가 비어 있습니다.')).require_empty()
        with self.assertRaises(LoginError): parse_cart('eroum', eroum_cart('')).require_empty()
        with self.assertRaises(LoginError): parse_cart('eroum', '장바구니가 비어 있습니다.')

    def test_submission_and_cross_site_requests_never_open_network(self):
        for vendor in ('eroum', 'bofeel'):
            s = CartSession(vendor)
            s.authenticated = True
            with patch.object(s.opener, 'open') as request:
                for path, fields in [('/shop/orderformupdate.php', [('x', 'y')]),
                                     ('/order/order_ps.php', [('mode', 'order')]),
                                     ('/order/cart_ps.php?mode=remove', None),
                                     ('https://other.invalid/', None),
                                     ('/shop/cartupdate.php', [('act', 'buy')]),
                                     ('/order/cart_ps.php', [('mode', 'orderSelect')])]:
                    with self.assertRaises(LoginError): s._operation(path, fields)
                request.assert_not_called()

    def test_form_serialization_preserves_defaults_and_duplicates(self):
        form = Document('''<form id="f"><input name="a" value="1"><input name="a" value="2">
        <input type="checkbox" name="off"><input type="checkbox" name="on" checked>
        <select name="s"><option value="x">X</option><option selected value="y">Y</option></select>
        <textarea name="memo">시험</textarea></form>''').form('f')
        self.assertEqual(serialize(form), [('a', '1'), ('a', '2'), ('on', 'on'), ('s', 'y'), ('memo', '시험')])

    def test_draft_reports_missing_product_fields_without_fabricating(self):
        row = parse_cart('eroum', eroum_cart(eroum_row())).rows[0]
        html = '<form id="simple_order" action="orderformupdate.php"><span class="ad_sel_addr" data-value="new">신규 배송지</span>'
        html += ''.join(f'<input name="{k}">' for k in ('od_b_name','od_b_tel','od_b_hp','od_b_zip','od_b_addr1','od_b_addr2','od_memo'))
        html += '<input name="od_settle_case" value="mock-payment"><input name="mockToken" value="mock-secret"></form>'
        recipient = dict(name='mock', phone='mock', postcode='mock', address='mock', detail='mock', memo='mock')
        draft = build_order_draft('eroum', html, row, recipient)
        report = draft.safe_summary()
        self.assertFalse(report['valid'])
        self.assertFalse(report['product_binding_matches'])
        self.assertEqual(report['missing_fields'], ['ct_qty[]', 'io_id[]', 'it_id[]', 'prodMemo[]'])
        self.assertIn(('od_settle_case', 'mock-payment'), draft.fields)
        self.assertTrue(report['defaults_preserved'])
        self.assertNotIn('mock-secret', str(report))
        draft.clear()
        self.assertEqual(draft.fields, [])

    def test_uncertain_delete_is_never_resent(self):
        snapshot = parse_cart('eroum', eroum_cart(eroum_row()))
        s = CartSession('eroum')
        s.authenticated = True
        s.created_row = snapshot.rows[0]
        with patch.object(s.opener, 'open', side_effect=TimeoutError) as request:
            with self.assertRaises(TimeoutError): s.delete_row(snapshot, s.created_row)
            with self.assertRaisesRegex(LoginError, '재전송'): s.delete_row(snapshot, s.created_row)
            self.assertEqual(request.call_count, 1)

    def test_delete_rejects_extra_or_duplicate_target_before_network(self):
        snapshot = parse_cart('eroum', eroum_cart(eroum_row()))
        s = CartSession('eroum')
        s.authenticated = True
        s.created_row = snapshot.rows[0]
        fields = deletion_fields(snapshot, s.created_row)
        with patch.object(s.opener, 'open') as request:
            for extra in ([('ct_chk[1]', '1')], [('it_id[0]', 'OTHER')], [('act', 'buy')]):
                with self.assertRaises(LoginError): s._operation('/shop/cartupdate.php', fields + extra)
            request.assert_not_called()

    def test_bofeel_draft_matches_cart_and_preserves_token_payment_consent(self):
        from http_cart import CartRow
        row = CartRow('1000000025', 'BFSH10', '', 1, 'cartSno[]', 'mock-row', 'mock-row')
        html = '''<form id="frmOrder" action="./order_ps.php">
        <input name="cartSno[]" value="mock-row"><input name="csrfToken" value="mock-token">
        <input type="radio" name="shipping" id="shippingNew"><label for="shippingNew">직접 입력</label>
        <input name="settleKind" value="mock-bank"><input type="checkbox" name="agree">
        <input type="checkbox" name="reflectApplyDelivery">'''
        html += ''.join(f'<input name="{k}">' for k in ('receiverName','receiverZonecode','receiverAddress',
                        'receiverAddressSub','receiverPhone','receiverCellPhone','orderMemo')) + '</form>'
        recipient = dict(name='mock', phone='mock', postcode='mock', address='mock', detail='mock', memo='mock')
        draft = build_order_draft('bofeel', html, row, recipient)
        self.assertTrue(draft.safe_summary()['valid'])
        self.assertIn(('shipping', 'shippingNew'), draft.fields)
        self.assertIn(('csrfToken', 'mock-token'), draft.fields)
        self.assertIn(('settleKind', 'mock-bank'), draft.fields)
        self.assertFalse(any(k in ('agree', 'reflectApplyDelivery') for k,v in draft.fields))
        self.assertFalse(build_order_draft('bofeel', html.replace('value="mock-row"', 'value="other"'), row, recipient).safe_summary()['valid'])


if __name__ == '__main__': unittest.main()
