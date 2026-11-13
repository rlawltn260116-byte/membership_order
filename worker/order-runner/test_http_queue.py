import io
import json
import unittest
from unittest.mock import Mock, patch

from http_cart import CartRow, CartSnapshot, OrderDraft, values
from http_login_draft import LoginError, StopSignalError
from http_queue import QueueSession, cleanup_bofeel, prepare_eroum_group, prepare_bofeel_group, run


def row(vendor='eroum', line=1, quantity=1, memo=''):
    eroum = vendor == 'eroum'
    return {'lineNo': line, 'sourceSheet': '발주', 'quantity': quantity, 'sourceKey': 'mock-source-' + str(line),
        'mapping': {'productId': 'PRO2022102700012' if eroum else '1000000025',
                    'model': 'DYJ-03' if eroum else 'BFSH10', 'optionName': '', 'optionId': '' if eroum else '31'},
        'recipient': {'name': '시험', 'phone': '01000000000', 'postcode': '04524', 'address': '시험로 1', 'detail': '', 'memo': memo}}


def group(vendor='eroum', rows=None):
    return {'vendor': vendor, 'addressMode': 'new' if vendor == 'eroum' else 'shippingNew', 'rows': rows or [row(vendor)],
            'filename': '모의 발주서.xlsx', 'selectedSheet': '발주',
            'sourceWorkbook': {'filename': '모의 발주서.xlsx', 'sheets': [{'name': '발주', 'state': 'visible'}]}}


def product():
    result = {k: '0' for k in ('it_sc_type', 'it_sc_qty', 'it_sc_minimum', 'it_sc_price', 'it_even_odd', 'it_even_odd_price')}
    result.update(it_id='PRO2022102700012', it_price='10', it_buy_min_qty='1', it_buy_max_qty='0',
                  it_buy_inc_qty='1', options=[], stock_status='normal')
    return result


def eroum_source():
    keys = list(product()) + ['io_type', 'io_price', 'ca_id', 'ca_id2', 'ca_id3', 'ca_id_delivery', 'cp_price', 'io_id', 'ct_qty', 'ct_price', 'prodMemo']
    source = '<script>function select_item(obj, io_id, ct_qty) {' + ','.join(k+'[]' for k in keys) + '}</script>'
    source += '<form id="simple_order" action="orderformupdate.php"><span class="ad_sel_addr" data-value="new">신규 배송지</span>'
    source += ''.join('<input name="'+k+'" value="default">' for k in ('od_b_name', 'od_b_tel', 'od_b_hp', 'od_b_zip', 'od_b_addr1', 'od_b_addr2', 'od_memo', 'od_b_addr_jibeon'))
    return source + '<input name="od_settle_case" value="월 마감 정산"></form>로그아웃'


class FakeBofeel:
    def __init__(self, stop=False):
        self.created_row = None
        self.order_path = None
        self.mutations = set()
        self.origin = 'https://bofeelmall.com'
        self.quantity = 0
        self.deleted = 0
        self.stop = stop
        self.cart_html = '<form id="frmCart">장바구니에 담겨있는 상품이 없습니다.</form>'
        self.login_count = 0

    def login(self, *args):
        self.login_count += 1

    def clear(self):
        pass

    def get_cart(self):
        rows = [CartRow('1000000025', 'BFSH10', '', self.quantity, 'cartSno[]', 'mock-row', 'mock-row')] if self.quantity else []
        return CartSnapshot('bofeel', rows, [('mode', ''), ('cartSno[]', 'mock-row')], not rows)

    def _operation(self, path, fields=None):
        if fields is None:
            return '<form id="frmView"><input name="goodsNo[]" value="1000000025"><input name="optionSno[]" value="31"><input name="optionFl" value="n"><input name="goodsCnt[]" value="1"></form>'
        if ('mode', 'cartIn') in fields:
            self.quantity = int(values(fields, 'goodsCnt[]')[0])
            return '{}'
        if ('mode', 'cartDelete') in fields:
            self.deleted += 1
            self.quantity = 0
            return '{}'
        raise AssertionError('모의 허용 범위 밖')

    def open_order(self):
        if self.stop:
            raise StopSignalError('캡차')
        source = '<form id="frmOrder" action="order_ps.php"><input name="cartSno[]" value="mock-row"><input id="shippingNew" name="shipping"><label for="shippingNew">직접 입력</label>'
        source += ''.join('<input name="'+k+'" value="default">' for k in ('receiverName', 'receiverZonecode', 'receiverAddress', 'receiverAddressSub', 'receiverPhone', 'receiverCellPhone', 'orderMemo'))
        return source + '</form>로그아웃'


class QueueTests(unittest.TestCase):
    def test_sheet_provenance_is_held_before_login_or_session_creation(self):
        from copy import deepcopy
        valid = group('bofeel')
        for change in ('missing-selection', 'wrong-name', 'hidden', 'other-row', 'missing-workbook', 'wrong-file'):
            value = deepcopy(valid)
            if change == 'missing-selection':
                value.pop('selectedSheet')
            elif change == 'wrong-name':
                value['selectedSheet'] = '없는시트'
            elif change == 'hidden':
                value['sourceWorkbook']['sheets'][0]['state'] = 'hidden'
            elif change == 'other-row':
                value['rows'][0]['sourceSheet'] = '다른시트'
            elif change == 'missing-workbook':
                value.pop('sourceWorkbook')
            else:
                value['filename'] = '다른파일.xlsx'
            factory = Mock(side_effect=AssertionError('사이트 접근 금지'))
            with self.subTest(change=change), patch('sys.stdout', new_callable=io.StringIO) as output:
                run('bofeel', [value], {'ENABLE_B2B_HTTP_CART': 'true'}, session_factory=factory)
                result = json.loads(output.getvalue())
                self.assertFalse(result['submissionReady'])
                self.assertEqual(result['details'][0]['status'], 'HOLD')
                factory.assert_not_called()

    def test_dynamic_rows_preserve_unit_price_quantities_and_only_source_memos(self):
        rows = [row(quantity=2, memo='문 앞'), row(line=2, quantity=3, memo='직접 전달')]
        draft = prepare_eroum_group(Mock(origin='https://eroumcare.com'), group(rows=rows), eroum_source(), {'PRO2022102700012': product()})
        self.assertEqual(values(draft.fields, 'ct_qty[]'), ['2', '3'])
        self.assertEqual(values(draft.fields, 'ct_price[]'), ['10', '10'])
        self.assertEqual(values(draft.fields, 'prodMemo[]'), ['문 앞', '직접 전달'])
        self.assertEqual(values(draft.fields, 'od_memo'), [''])
        self.assertEqual(values(draft.fields, 'od_b_addr_jibeon'), [''])
        self.assertFalse(draft.report['submission_ready'])
        self.assertNotIn('SO', str(values(draft.fields, 'od_memo')))

    def test_unknown_mapping_stock_action_and_missing_mode_are_rejected(self):
        session = Mock(origin='https://eroumcare.com')
        for source, obj in [(eroum_source().replace('orderformupdate.php', 'https://other.invalid/orderformupdate.php'), product()),
            (eroum_source().replace('data-value="new"', 'data-value="recent"'), product()),
            (eroum_source(), dict(product(), stock_status='unknown')),
            (eroum_source(), dict(product(), stock_status='soldout')),
            (eroum_source(), dict(product(), it_buy_max_qty='1'))]:
            with self.assertRaises(LoginError):
                prepare_eroum_group(session, group(rows=[row(quantity=2)]), source, {'PRO2022102700012': obj})

    def test_bofeel_same_product_aggregates_and_cleans_own_cart_then_empty(self):
        session = FakeBofeel()
        draft = prepare_bofeel_group(session, group('bofeel', [row('bofeel', quantity=2), row('bofeel', line=2, quantity=3)]))
        self.assertTrue(draft.report['valid'])
        self.assertEqual(values(draft.fields, 'shipping'), ['shippingNew'])
        self.assertEqual(session.deleted, 1)
        self.assertEqual(session.quantity, 0)
        session.get_cart().require_empty()

    def test_bofeel_distinct_notes_hold_and_stop_signal_prevents_cleanup_requests(self):
        session = FakeBofeel()
        with self.assertRaises(LoginError):
            prepare_bofeel_group(session, group('bofeel', [row('bofeel', memo='가'), row('bofeel', line=2, memo='나')]))
        self.assertEqual(session.quantity, 0)
        session = FakeBofeel(stop=True)
        with self.assertRaises(StopSignalError):
            prepare_bofeel_group(session, group('bofeel'))
        self.assertEqual(session.deleted, 0)

    def test_run_logs_in_once_for_multiple_groups_and_never_outputs_customer_fields(self):
        session = Mock()
        session.cart_html = '<form name="frmcartlist">장바구니가 비어 있습니다.</form>'
        session.origin = 'https://eroumcare.com'
        session.created_row = None
        session.read_preparation.return_value = eroum_source()
        session.catalog_object.return_value = product()
        session.get_cart.return_value = CartSnapshot('eroum', [], [], True)
        out = io.StringIO()
        def verified(session, draft, *args):
            draft.report['submission_ready'] = True
        with patch('sys.stdout', new=out), patch('http_queue.verify_eroum', side_effect=verified):
            run('eroum', [group(), group(rows=[row(line=2)])], {'ENABLE_B2B_HTTP_CART': 'true', 'EROUM_LOGIN_ID': 'mock-user', 'EROUM_LOGIN_PASSWORD': 'mock-password'}, session_factory=lambda vendor: session)
        session.login.assert_called_once()
        session.catalog_object.assert_called_once()
        session.clear.assert_called_once()
        result = json.loads(out.getvalue())
        self.assertEqual(len(result['details']), 2)
        self.assertEqual([d['orderGroup'] for d in result['details']], [1, 2])
        self.assertFalse(result['submissionReady'])
        self.assertNotIn('mock-password', out.getvalue())
        self.assertNotIn('시험로 1', out.getvalue())

    def test_prepare_mode_never_waits_for_submit_command_even_if_flag_is_set(self):
        session = Mock(origin='https://eroumcare.com', created_row=None)
        session.cart_html = '<form name="frmcartlist">장바구니가 비어 있습니다.</form>'
        session.read_preparation.return_value = eroum_source()
        session.catalog_object.return_value = product()
        value = OrderDraft([], {'submission_ready': True})
        value.expected_fields = []
        env = {'ENABLE_B2B_HTTP_CART': 'true', 'ENABLE_B2B_HTTP_SUBMIT': 'true', 'EROUM_LOGIN_ID': 'mock', 'EROUM_LOGIN_PASSWORD': 'mock'}
        with patch('http_queue.prepare_eroum_group', return_value=value), patch('sys.stdout', new=io.StringIO()), patch('sys.stdin') as stdin:
            run('eroum', [group()], env, session_factory=lambda vendor: session, execution_mode='PREPARE')
        stdin.readline.assert_not_called()

    def test_submit_intent_keeps_cart_until_parent_decision_then_cleans_if_not_sent(self):
        session = FakeBofeel()
        def verified(session, draft, *args):
            draft.report['submission_ready'] = True
        with patch('http_queue.verify_bofeel', side_effect=verified):
            value = prepare_bofeel_group(session, group('bofeel'), retain_for_submit=True)
        self.assertEqual(session.deleted, 0)
        self.assertEqual(session.quantity, 1)
        self.assertTrue(value.report['submission_ready'])
        cleanup_bofeel(session, row('bofeel')['mapping'], 1)
        self.assertEqual(session.deleted, 1)
        self.assertEqual(session.quantity, 0)

    def test_submit_protocol_uses_same_retained_cart_and_does_not_delete_after_attempt(self):
        session = FakeBofeel()
        def ready(session, group, **kwargs):
            session.quantity = 1
            session.created_row = session.get_cart().rows[0]
            session.retained_for_submit = True
            value = OrderDraft([], {'submission_ready': True})
            value.expected_fields = []
            return value
        def fake_submit(session, draft, **kwargs):
            self.assertEqual(session.quantity, 1)
            self.assertEqual(session.deleted, 0)
            session.submission_attempted = True
            return {'state': 'SUBMITTED', 'orderNumber': '20261111000001'}
        env = {'ENABLE_B2B_HTTP_CART': 'true', 'ENABLE_B2B_HTTP_SUBMIT': 'true', 'B2B_HTTP_SUBMIT_VENDORS': 'bofeel', 'BOFEEL_LOGIN_ID': 'mock', 'BOFEEL_LOGIN_PASSWORD': 'mock'}
        with patch('http_queue.prepare_bofeel_group', side_effect=ready), patch('http_queue.submit_prepared', side_effect=fake_submit), patch('sys.stdout', new=io.StringIO()) as out, patch('sys.stdin', new=io.StringIO('{"submit":true,"sourceKey":"mock-source-1"}\n')):
            run('bofeel', [group('bofeel')], env, session_factory=lambda vendor: session, execution_mode='SUBMIT')
        self.assertEqual(session.login_count, 1)
        self.assertEqual(session.deleted, 0)
        events = [json.loads(line) for line in out.getvalue().splitlines()]
        self.assertTrue(events[0]['cartVerified'])
        self.assertFalse(events[0]['finalEmpty'])
        self.assertEqual(events[1]['state'], 'SUBMITTED')

    def test_disabled_never_constructs_session(self):
        factory = Mock()
        with patch('sys.stdout', new=io.StringIO()):
            run('eroum', [group()], {}, session_factory=factory)
        factory.assert_not_called()

    def test_submit_protocol_refuses_disabled_wrong_source_nonboolean_and_multiple_orders_then_cleans(self):
        for mode in ('disabled','wrong-source','nonboolean','multiple-orders'):
            session=FakeBofeel()
            def ready(session, group, **kwargs):
                session.quantity=1;session.created_row=session.get_cart().rows[0];session.retained_for_submit=True
                value=OrderDraft([],{'submission_ready':True});value.expected_fields=[]
                return value
            env={'ENABLE_B2B_HTTP_CART':'true','B2B_HTTP_SUBMIT_VENDORS':'bofeel','BOFEEL_LOGIN_ID':'mock','BOFEEL_LOGIN_PASSWORD':'mock'}
            if mode!='disabled':env['ENABLE_B2B_HTTP_SUBMIT']='true'
            command={'submit':True,'sourceKey':'mock-source-1'}
            if mode=='wrong-source':command['sourceKey']='other'
            if mode=='nonboolean':command['submit']='true'
            groups=[group('bofeel')]
            if mode=='multiple-orders':groups.append(group('bofeel',[row('bofeel',line=2)]))
            with self.subTest(mode=mode),patch('http_queue.prepare_bofeel_group',side_effect=ready), \
                    patch('http_queue.submit_prepared') as send,patch('sys.stdout',new=io.StringIO()) as out, \
                    patch('sys.stdin',new=io.StringIO(json.dumps(command)+'\n')):
                run('bofeel',groups,env,session_factory=lambda vendor:session,execution_mode='SUBMIT')
            send.assert_not_called()
            self.assertEqual(session.deleted,0 if mode=='disabled' else 1)
            self.assertEqual(session.quantity,0)
            self.assertEqual(len(out.getvalue().splitlines()),1)

    def test_bofeel_amount_validation_failure_cleans_only_created_row(self):
        session=FakeBofeel()
        with patch('http_queue.verify_bofeel',side_effect=LoginError('모의 검증 실패')):
            draft=prepare_bofeel_group(session,group('bofeel'),retain_for_submit=True)
        self.assertFalse(draft.report['submission_ready'])
        self.assertEqual(session.deleted,1)
        session.get_cart().require_empty()

    def test_catalog_queries_are_once_bounded_and_one_second_apart(self):
        session = QueueSession('eroum')
        session.authenticated = True
        mapping = row()['mapping']
        with patch.object(session, 'read_catalog_response', return_value=json.dumps([product()])) as read, patch('http_queue.time.monotonic', return_value=10), patch('http_queue.time.sleep') as sleep:
            session.catalog_time = 9.5
            session.catalog_object(mapping)
            sleep.assert_called_once_with(0.5)
            with self.assertRaises(LoginError): session.catalog_object(mapping)
            session.read_once.clear()
            session.catalog_count = 30
            with self.assertRaises(LoginError): session.catalog_object(mapping)
            read.assert_called_once()


if __name__ == '__main__':
    unittest.main()
