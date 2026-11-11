import copy
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from http_cart import OrderDraft, CartRow, build_order_draft, replace, values, one
from http_login_draft import LoginError
from http_preparation import eroum_product_fields
from http_amounts import (money, mark_verified, quote_request, validate_amount_snapshot,
                          verify_eroum, verify_bofeel, render)
from http_submission import submit_prepared
from test_http_queue import group, product, eroum_source, prepare_eroum_group


def eroum_case():
    g = group(rows=None); obj = product(); source = eroum_source()
    with patch('http_queue.verify_eroum'):
        draft = prepare_eroum_group(Mock(origin='https://eroumcare.com'), g, source, {obj['it_id']:obj})
    for k,v in {'pen_type':'0','od_delivery_type':'delivery1','od_cp_price':'0','od_price':'0','org_od_price':'0',
                'od_send_cost':'0','od_send_cost2':'0','od_installation_cost':'0'}.items():
        draft.fields = replace(draft.fields,k,v)
    request = [
        {'path':'./ajax.od_send_cost.php','data':{'it_id':[obj['it_id']],'qty':[1],'it_price':[10],'it_line_price':[10],
            'io_id':[''],'ca_id22':[''],'ca_id_raw':[''],'ca_id2_raw':[''],'ca_id3_raw':['']}},
        {'path':'./ajax.installation_cost.php','data':{'it_ids':[obj['it_id']],'ct_qtys':[1]}},
    ]
    final = list(draft.fields)
    for k,v in {'od_price':'10','org_od_price':'10','od_send_cost':'2','od_installation_cost':'3'}.items():
        final = replace(final,k,v)
    rendered = [{'fields':list(draft.fields),'requests':request},
        {'fields':final,'requests':request,'display':{'#order_price':'10','#delivery_price':'2','#add_installation_price':'3','#total_price':'15'}}]
    session = Mock(read_amount=Mock(side_effect=[2,3,0]))
    return session,draft,g,source,{obj['it_id']:obj},rendered


def bofeel_case():
    g = group('bofeel'); r = g['rows'][0]; r['quantity'] = 2
    price = {k:0 for k in ('optionPrice','optionPriceSum','goodsDcPrice','couponGoodsDcPrice','memberDcPrice',
        'memberOverlapDcPrice','addGoodsPriceSum','optionTextPriceSum')}
    price.update(goodsCnt=2,goodsPrice=10,goodsPriceSum=20,goodsPriceSubtotal=20)
    source = '<form id="frmOrder" action="order_ps.php"><input name="cartSno[]" value="mock-row">'
    source += '<input id="shippingNew" name="shipping" type="radio" value="shippingNew"><label for="shippingNew">직접 입력</label>'
    for k in ('receiverName','receiverPhone','receiverCellPhone','receiverZonecode','receiverAddress','receiverAddressSub','orderMemo'):
        source += '<input name="'+k+'" value="">'
    for k,v in {'receiverCountryCode':'kr','totalDeliveryCharge':'1','deliveryAreaCharge':'0','settlePrice':'21',
        'totalCouponGoodsDcPrice':'0','totalMemberDcPrice':'0','totalMemberOverlapDcPrice':'0','deliveryInsuranceFee':'0',
        'totalCouponOrderDcPrice':'','totalCouponDeliveryDcPrice':'','bankSender':'모의 입금자'}.items():
        source += '<input name="'+k+'" value="'+v+'">'
    import html
    source += '<input name="priceInfo[1000000025][31]" value="'+html.escape(json.dumps(price),quote=True)+'">'
    source += '<input type="radio" name="settleKind" id="settleKind_gb" value="gb"><label for="settleKind_gb">무통장 입금</label>'
    source += '<select name="bankAccount"><option value=""></option><option value="mock-bank" selected>모의 계좌</option></select>'
    source += '<input type="checkbox" id="termAgree_orderCheck" class="require"><label for="termAgree_orderCheck">(필수) 구매 동의</label>'
    source += '<strong id="totalGoodsPrice">20원</strong><span id="totalDeliveryCharge">1</span><strong id="totalSettlePrice">21</strong><strong id="totalSettlePriceView">21</strong></form>'
    cart = CartRow('1000000025','BFSH10','',2,'cartSno[]','mock-row','mock-row')
    draft = build_order_draft('bofeel',source,cart,r['recipient'])
    session = Mock(created_row=cart,read_amount=Mock(return_value={'areaDelivery':3}))
    def rendered(source,fields,**kwargs):
        return {'fields':replace(fields,'settlePrice','24'),'requests':[],
                'display':{'#totalSettlePrice':'24','#totalSettlePriceView':'24'}}
    return session,draft,g,source,rendered


class AmountTests(unittest.TestCase):
    def test_strict_money_rejects_ambiguous_negative_noninteger_and_overflow(self):
        for value in (True,False,None,'1,000','-1','1.5','NaN','1e3','',2**53):
            with self.subTest(value=value), self.assertRaises(LoginError): money(value)
        self.assertEqual(money('10.00'),10)
        self.assertEqual(money('',empty=True),0)

    def test_eroum_server_screen_and_draft_match_then_snapshot_is_bound(self):
        s,d,g,source,objects,renders = eroum_case()
        with patch('http_amounts.render',side_effect=renders): verify_eroum(s,d,g,source,objects)
        self.assertTrue(d.report['submission_ready'])
        self.assertEqual(s.read_amount.call_count,3)
        self.assertEqual(one(d.fields,'od_price'),'10')
        validate_amount_snapshot(d)
        d.fields = replace(d.fields,'od_send_cost','9')
        with self.assertRaises(LoginError): validate_amount_snapshot(d)

    def test_eroum_wrong_product_option_quantity_recipient_payment_and_expected_price_hold_before_quotes(self):
        for key,value in [('it_id[]','other'),('io_id[]','색상'),('ct_qty[]','2'),('od_b_addr1','다른 주소'),
                          ('od_settle_case','신용카드'),('od_delivery_type','delivery2'),('od_cp_price','1')]:
            s,d,g,source,objects,renders=eroum_case(); d.fields=replace(d.fields,key,value)
            with self.subTest(key=key),patch('http_amounts.render',side_effect=renders),self.assertRaises(LoginError): verify_eroum(s,d,g,source,objects)
            s.read_amount.assert_not_called()
        s,d,g,source,objects,renders=eroum_case();g['rows'][0]['expectedPrice']='11'
        with self.assertRaises(LoginError): verify_eroum(s,d,g,source,objects)
        s.read_amount.assert_not_called()

    def test_eroum_changed_server_total_and_additional_shipping_hold(self):
        for mode in ('screen','hidden','quote','area','line','request'):
            s,d,g,source,objects,renders=eroum_case()
            if mode=='screen': renders[1]['display']['#total_price']='99'
            if mode=='hidden': renders[1]['fields']=replace(renders[1]['fields'],'od_send_cost','99')
            if mode=='quote': s.read_amount.side_effect=[-1,3,0]
            if mode=='area': s.read_amount.side_effect=[2,3,1]
            if mode=='line': renders[0]['fields']=replace(renders[0]['fields'],'ct_price[]','9')
            if mode=='request': renders[0]['requests'][0]['data']['qty']=[9]
            with self.subTest(mode=mode),patch('http_amounts.render',side_effect=renders),self.assertRaises(LoginError): verify_eroum(s,d,g,source,objects)
            self.assertFalse(d.report.get('submission_ready',False))

    def test_bofeel_live_shape_consent_without_name_bank_and_new_area_price(self):
        s,d,g,source,rendered=bofeel_case()
        with patch('http_amounts.render',side_effect=rendered): verify_bofeel(s,d,g,source)
        self.assertTrue(d.report['submission_ready'])
        self.assertTrue(d.report['consent_verified'])
        self.assertEqual(values(d.fields,'termAgree_orderCheck'),[])
        self.assertEqual(one(d.fields,'settleKind'),'gb')
        self.assertEqual(one(d.fields,'settlePrice'),'24')
        self.assertEqual(dict(s.read_amount.call_args.args[1])['receiverAddress'],g['rows'][0]['recipient']['address'])

    def test_bofeel_renderer_json_lists_become_encodable_pairs(self):
        import json as _json, urllib.parse as _parse
        s,d,g,source,rendered=bofeel_case()
        as_json=lambda *a,**k: _json.loads(_json.dumps(rendered(*a,**k)))
        with patch('http_amounts.render',side_effect=as_json): verify_bofeel(s,d,g,source)
        self.assertTrue(all(isinstance(p,tuple) for p in d.fields))
        _parse.urlencode(d.fields)

    def test_bofeel_bad_consent_shape_bank_save_mode_country_binding_quantity_and_totals_hold(self):
        for mode in ('consent','name','bank','save','shipping','country','option','quantity','source_total','draft_total'):
            s,d,g,source,rendered=bofeel_case()
            if mode=='consent': source=source.replace('class="require"','class="optional"')
            if mode=='name': source=source.replace('id="termAgree_orderCheck"','name="termAgree_orderCheck" id="termAgree_orderCheck"')
            if mode=='bank': d.fields=replace(d.fields,'bankAccount','different')
            if mode=='save': d.fields += [('reflectApplyDelivery','y')]
            if mode=='shipping': d.fields=replace(d.fields,'shipping','shippingBasic')
            if mode=='country': d.fields=replace(d.fields,'receiverCountryCode','us')
            if mode=='option': d.fields=[(k.replace('[31]','[32]'),v) for k,v in d.fields]
            if mode=='quantity': g['rows'][0]['quantity']=3
            if mode=='source_total': source=source.replace('id="totalSettlePrice">21','id="totalSettlePrice">22')
            if mode=='draft_total': d.fields=replace(d.fields,'settlePrice','99')
            with self.subTest(mode=mode),patch('http_amounts.render',side_effect=rendered),self.assertRaises(LoginError): verify_bofeel(s,d,g,source)
            s.read_amount.assert_not_called()

    def test_bofeel_area_failure_or_renderer_mismatch_never_ready(self):
        for mode in ('error','missing','negative','renderer'):
            s,d,g,source,rendered=bofeel_case()
            if mode=='error': s.read_amount.return_value={'areaDelivery':3,'error':1}
            if mode=='missing': s.read_amount.return_value={}
            if mode=='negative': s.read_amount.return_value={'areaDelivery':-1}
            def result(*args,**kwargs):
                r=rendered(*args,**kwargs)
                if mode=='renderer': r['display']['#totalSettlePrice']='99'
                return r
            with self.subTest(mode=mode),patch('http_amounts.render',side_effect=result),self.assertRaises(LoginError): verify_bofeel(s,d,g,source)
            self.assertFalse(d.report.get('submission_ready',False))

    def test_expired_or_forged_ready_draft_stops_before_transport(self):
        s,d,g,source,objects,renders=eroum_case()
        with patch('http_amounts.render',side_effect=renders): verify_eroum(s,d,g,source,objects)
        session=SimpleNamespace(vendor='eroum',authenticated=True)
        send=Mock()
        for mode in ('expired','missing_snapshot','missing_consent'):
            value=copy.deepcopy(d)
            if mode=='expired': value.amount_verified_at-=301
            if mode=='missing_snapshot': del value.amount_snapshot
            if mode=='missing_consent': value.report['consent_verified']=False
            with self.subTest(mode=mode),self.assertRaises(LoginError):
                submit_prepared(session,value,authorized=True,environ={'ENABLE_B2B_HTTP_SUBMIT':'true'},transport=send)
        send.assert_not_called()

    def test_amount_request_allowlist_refuses_order_processing_and_wrong_modes_without_network(self):
        session=SimpleNamespace(vendor='bofeel',authenticated=True,opener=Mock())
        for path,fields in [('/order/order_ps.php',[('mode','set_recalculation')]),
                            ('/order/cart_ps.php',[('mode','cartIn')]),('/shop/ajax.simple_order.php',[])]:
            with self.assertRaises(LoginError): quote_request(session,path,fields)
        session.opener.open.assert_not_called()

    def test_renderer_rejects_changed_source_before_execution(self):
        module=Path(__file__).with_name('amount_renderer.mjs')
        source='function is_part_ca_id(a){return false;} function calculate_order_price(){throw Error("외부 코드");} var addr1_timer=null;'
        r=subprocess.run(['node',str(module)],input=json.dumps({'source':source,'fields':[]}),text=True,encoding='utf-8',capture_output=True)
        self.assertNotEqual(r.returncode,0)
        self.assertEqual(r.stdout,'')
        self.assertNotIn('외부 코드',r.stderr)

    def test_renderer_child_receives_only_platform_environment(self):
        with patch.dict('os.environ', {'PATH':'mock-path','SystemRoot':'mock-root',
                'EROUM_LOGIN_ID':'mock-id','EROUM_LOGIN_PASSWORD':'mock-password',
                'NODE_OPTIONS':'--mock-option','ENABLE_B2B_HTTP_SUBMIT':'true'}, clear=True), \
                patch('http_amounts.shutil.which',return_value='mock-node'), \
                patch('http_amounts.subprocess.run',return_value=SimpleNamespace(returncode=0,stdout='{}')) as run:
            render('mock-source',[])
        self.assertEqual({k.upper():v for k,v in run.call_args.kwargs['env'].items()},
                         {'PATH':'mock-path','SYSTEMROOT':'mock-root'})
        self.assertEqual(run.call_args.args[0][0],'mock-node')
        self.assertIn('--max-old-space-size=64',run.call_args.args[0])
        self.assertEqual(run.call_args.kwargs['encoding'],'utf-8')

    def test_renderer_timeout_is_safe_hold_without_raw_child_output(self):
        with patch('http_amounts.shutil.which',return_value='mock-node'), \
                patch('http_amounts.subprocess.run',side_effect=subprocess.TimeoutExpired('mock-node',10,output='민감 원문')):
            with self.assertRaises(LoginError) as error: render('mock-source',[])
        self.assertIn('HOLD',str(error.exception))
        self.assertNotIn('민감 원문',str(error.exception))

    def test_eroum_renderer_cannot_change_protected_fields_in_either_pass(self):
        for phase in (0,1):
            for key in ('it_id[]','io_id[]','ct_qty[]','od_b_addr1','od_settle_case','pen_type'):
                s,d,g,source,objects,renders=eroum_case()
                renders[phase]['fields']=replace(renders[phase]['fields'],key,'변조')
                with self.subTest(phase=phase,key=key),patch('http_amounts.render',side_effect=renders),self.assertRaises(LoginError):
                    verify_eroum(s,d,g,source,objects)
                self.assertFalse(d.report['submission_ready'])
                if phase==0:s.read_amount.assert_not_called()

    def test_bofeel_renderer_cannot_change_address_payment_binding_consent_or_area(self):
        for key in ('cartSno[]','receiverAddress','shipping','settleKind','bankAccount','termAgree_orderCheck','deliveryAreaCharge'):
            s,d,g,source,rendered=bofeel_case()
            def changed(*args,**kwargs):
                result=rendered(*args,**kwargs)
                result['fields']=replace(result['fields'],key,'변조')
                return result
            with self.subTest(key=key),patch('http_amounts.render',side_effect=changed),self.assertRaises(LoginError):
                verify_bofeel(s,d,g,source)
            self.assertFalse(d.report['submission_ready'])

    def test_eroum_coupon_ids_and_discount_amount_hold_before_quote_or_render(self):
        for key in ('cp_id[]','od_cp_id','sc_cp_id','dc_id','cp_price[]'):
            for value in ('coupon-id','1','00'):
                s,d,g,source,objects,renders=eroum_case();d.fields=replace(d.fields,key,value)
                with self.subTest(key=key,value=value),patch('http_amounts.render') as renderer,self.assertRaises(LoginError):
                    verify_eroum(s,d,g,source,objects)
                renderer.assert_not_called();s.read_amount.assert_not_called()


if __name__=='__main__': unittest.main()
