"""합성 자료로 옵션·다품목의 대조 실패와 정리 경계를 검사한다."""
import copy
import html
import json
import unittest
from unittest.mock import Mock, patch

from bofeel_products import product_fields
from http_cart import CartRow, CartSnapshot, Document, build_order_draft, one, replace, values, parse_cart
from http_login_draft import LoginError, StopSignalError
from http_queue import CATALOG, check_mapping, prepare_bofeel_group, cleanup_bofeel, run
from http_amounts import verify_bofeel
from test_http_amounts import bofeel_case
from test_http_queue import row, group, FakeBofeel


def option_source():
    return '''<form id="frmView"><input name="optionFl" value="y"><input name="mode" value="">
    <input name="cartMode" value=""><input name="set_goods_price" value="10">
    <select name="optionSnoInput"><option value=""></option><option value="6348||2||||0^|^파스텔블루">파스텔블루</option></select></form>
    <script id="optionTemplate" type="text/html"><input name="goodsNo[]" value="1000000674">
    <input name="optionSno[]" value="<%=optionSno%>"><input name="displayOptionkey[]" value="<%=displayOptionkey%>">
    <input name="goodsPriceSum[]" value="0"><input name="optionPriceSum[]" value="0">
    <input name="goodsCnt[]" value="1"><input name="option_price_<%=displayOptionkey%>" value="<%=optionPrice%>"></script>'''


def mapped_option(line=1):
    value=row('bofeel',line=line)
    value['mapping']=dict(productId='1000000674',model='BFMB20',optionName='파스텔블루',optionId='6348')
    return value


class MultiSession(FakeBofeel):
    def __init__(self):
        super().__init__();self.items=[];self.created_rows=[];self.operations=[];self.fail_second=False

    def get_cart(self):
        rows=[CartRow(m['productId'],m['model'],m['optionName'],q,'cartSno[]',str(i),str(i)) for i,(m,q) in enumerate(self.items,1)]
        return CartSnapshot('bofeel',rows,[('mode','')]+[('cartSno[]',r.cart_id) for r in rows],not rows)

    def _operation(self,path,fields=None):
        if fields is None:
            if self.fail_second and self.items:raise LoginError('두 번째 상품 폼 변경')
            return option_source() if '1000000674' in path else super()._operation(path)
        self.operations.append(copy.deepcopy(fields))
        if ('mode','cartIn') in fields:
            mapping=mapped_option()['mapping'] if values(fields,'goodsNo[]')==['1000000674'] else row('bofeel')['mapping']
            self.items.append((mapping,int(one(fields,'goodsCnt[]'))));return '{}'
        if ('mode','cartDelete') in fields:
            self.deleted+=1;self.items=[];return '{}'
        raise AssertionError('모의 허용 요청 밖')

    def open_order(self):
        source=super().open_order().replace('<input name="cartSno[]" value="mock-row">','')
        return source.replace('</form>',''.join('<input name="cartSno[]" value="'+r.cart_id+'">' for r in self.get_cart().rows)+'</form>')


class BofeelHoldsTests(unittest.TestCase):
    def test_verified_bucket_mapping_and_current_form_match_without_requests(self):
        candidate = next(i for i in CATALOG['bofeel'] if i['goodsNo'] == '1000000385')
        self.assertEqual(candidate['options'], [dict(name='', optionSno='1603')])
        self.assertNotIn('holdReason', candidate)
        value = row('bofeel')
        value['mapping'] = dict(productId=candidate['goodsNo'], model=candidate['model'], optionName='', optionId='1603')
        check_mapping('bofeel', value)
        source = '<form id="frmView"><input name="optionFl" value="n"><input name="goodsNo[]" value="1000000385"><input name="optionSno[]" value="1603"><input name="goodsCnt[]" value="1"></form>'
        session = Mock()
        fields = product_fields(session, source, value['mapping'], 2)
        self.assertEqual(values(fields, 'goodsNo[]'), ['1000000385'])
        self.assertEqual(values(fields, 'optionSno[]'), ['1603'])
        self.assertEqual(values(fields, 'goodsCnt[]'), ['2'])
        self.assertEqual(session.mock_calls, [])
        for changed in [source.replace('1603', '9999'), source.replace('1000000385', '1000000675')]:
            with self.assertRaises(LoginError):
                product_fields(session, changed, value['mapping'], 1)

    def test_unverified_bucket_mapping_is_rejected_before_any_cart_request(self):
        candidate = next(i for i in CATALOG['bofeel'] if i['goodsNo'] == '1000000385')
        value = row('bofeel')
        value['mapping'] = dict(productId=candidate['goodsNo'], model=candidate['model'], optionName='', optionId='추측금지')
        session = Mock()
        with self.assertRaises(LoginError):
            prepare_bofeel_group(session, group('bofeel', [value]))
        session.get_cart.assert_not_called()
        session._operation.assert_not_called()
        # 명시한 HOLD가 생기면 일치하는 식별자보다 우선한다.
        with patch.dict(candidate, holdReason='사람 검수 필요', options=[dict(name='', optionSno='추측금지')]):
            with self.assertRaises(LoginError):
                check_mapping('bofeel', value)

    def test_cart_option_quantity_tier_ignores_only_price_annotation_and_known_model_notice(self):
        source='''<form id="frmCart"><table><tr><td><input name="cartSno[]" value="mock-row"
          data-goods-no="1000000605" data-goods-nm="동행(sk-130) [ 입고 예정 안내)"
          data-option-nm="꽃무늬 / 3개 이상 (개당 : 10원)" data-default-goods-cnt="3" checked></td>
          <td><div class="order_goods_num"><strong>3개</strong></div></td></tr></table></form>'''
        snapshot=parse_cart('bofeel',source)
        snapshot.require_items([('1000000605','동행(sk-130)','꽃무늬 / 3개 이상',3)])
        for expected in [[('1000000605','동행(sk-130)','블루 / 3개 이상',3)],[('1000000605','동행(sk-130)','꽃무늬 / 3개 이상',2)]]:
            with self.assertRaises(LoginError):snapshot.require_items(expected)

    def test_option_template_preserves_server_identifiers_prices_and_quantity(self):
        fields=product_fields(Mock(),option_source(),mapped_option()['mapping'],2)
        self.assertEqual(values(fields,'optionSno[]'),['6348'])
        self.assertEqual(one(fields,'goodsCnt[]'),'2')
        self.assertEqual(one(fields,'goodsPriceSum[]'),'20')
        self.assertEqual(one(fields,'optionPriceSum[]'),'4')
        self.assertEqual(one(fields,'mode'),'cartIn')
        self.assertEqual(one(fields,'optionSnoInput'),'')

    def test_changed_option_id_disabled_option_and_template_are_rejected(self):
        for source in [option_source().replace('6348||','9999||'),option_source().replace('<option value="6348','<option disabled value="6348'),
                       option_source().replace('id="optionTemplate"','id="unknown"'),option_source().replace('value="1000000674"','value="1000000675"')]:
            with self.assertRaises(LoginError):product_fields(Mock(),source,mapped_option()['mapping'],1)

    def test_split_color_and_quantity_option_uses_both_server_responses_and_stock(self):
        source=option_source().replace('<select name="optionSnoInput"><option value=""></option><option value="6348||2||||0^|^파스텔블루">파스텔블루</option></select>',
            '<input name="mileageFl" value="c"><select name="optionNo_0"><option value="파스텔블루">파스텔블루</option></select>')
        source=source.replace('1000000674','1000000576')+"<script>var parameters={'setStockFl':'y'};</script>"
        mapping=dict(productId='1000000576',model='BOFEEL11',optionName='파스텔블루 / 1개 ~ 2개',optionId='4677')
        first=dict(nextOption=['1개 ~ 2개 (개당 : 모의가격)'],optionSellFl=['y'],optionViewFl=['y'],stockCnt=[2])
        session=Mock(bofeel_option=Mock(side_effect=[first,dict(optionSno='4677||2||||0')]))
        fields=product_fields(session,source,mapping,2)
        self.assertEqual(values(fields,'optionSno[]'),['4677'])
        self.assertEqual(session.bofeel_option.call_args_list[1].args[1],['파스텔블루','1개 ~ 2개 (개당 : 모의가격)'])
        for failure in [dict(first,optionSellFl=['n']),dict(first,optionViewFl=['n']),dict(first,stockCnt=[1])]:
            session=Mock(bofeel_option=Mock(return_value=failure))
            with self.assertRaises(LoginError):product_fields(session,source,mapping,2)
            self.assertEqual(session.bofeel_option.call_count,1)
        with self.assertRaises(LoginError):product_fields(Mock(),source,mapping,3)

    def test_multi_cart_compares_all_items_then_one_order_and_deletes_all_own_rows(self):
        session=MultiSession();g=group('bofeel',[mapped_option(),row('bofeel',line=2)])
        def verify(s,d,g,source):d.report['submission_ready']=True
        with patch('http_queue.verify_bofeel',side_effect=verify):draft=prepare_bofeel_group(session,g)
        self.assertTrue(draft.report['valid']);self.assertTrue(draft.report['submission_ready'])
        self.assertEqual(session.deleted,1)
        self.assertEqual([p for p in session.operations[-1] if p[0]=='cartSno[]'],[('cartSno[]','1'),('cartSno[]','2')])
        session.get_cart().require_empty()

    def test_cart_is_checked_before_any_add_and_foreign_rows_are_not_removed(self):
        session=MultiSession();session.items=[(row('bofeel')['mapping'],1)]
        with self.assertRaises(LoginError):prepare_bofeel_group(session,group('bofeel',[mapped_option()]))
        self.assertEqual(session.operations,[]);self.assertEqual(session.deleted,0)

    def test_partial_add_failure_cleans_confirmed_own_rows(self):
        session=MultiSession();session.fail_second=True
        with self.assertRaises(LoginError):prepare_bofeel_group(session,group('bofeel',[mapped_option(),row('bofeel',line=2)]))
        self.assertEqual(session.deleted,1);session.get_cart().require_empty()

    def test_changed_cart_during_cleanup_is_not_deleted(self):
        session=MultiSession();session.items=[(mapped_option()['mapping'],1)]
        session.created_row=session.get_cart().rows[0];session.created_rows=[session.created_row]
        session.items.append((row('bofeel')['mapping'],1))
        with self.assertRaises(LoginError):cleanup_bofeel(session)
        self.assertEqual(session.deleted,0)

    def test_all_recipients_and_source_memos_must_agree(self):
        for field in ('address','phone','name','memo'):
            session=MultiSession();second=row('bofeel',line=2);second['recipient'][field]='다른 모의값'
            with self.assertRaises(LoginError):prepare_bofeel_group(session,group('bofeel',[mapped_option(),second]))
            self.assertEqual(session.operations,[])

    def multi_amount(self):
        s,d,g,source,_=bofeel_case()
        second=mapped_option(line=2);g['rows'].append(second)
        price=json.loads(one(d.fields,'priceInfo[1000000025][31]'))
        price.update(goodsCnt=1,goodsPrice=10,optionPrice=2,goodsPriceSum=10,optionPriceSum=2,goodsPriceSubtotal=12)
        d.fields += [('priceInfo[1000000674][6348]',json.dumps(price)),('cartSno[]','second')]
        d.fields=replace(d.fields,'settlePrice','33')
        source=source.replace('id="totalGoodsPrice">20','id="totalGoodsPrice">32').replace('>21<','>33<')
        s.created_rows=[s.created_row,CartRow('1000000674','BFMB20','파스텔블루',1,'cartSno[]','second','second')]
        def render(_source,fields,**kwargs):return dict(fields=replace(fields,'settlePrice','36'),requests=[],display={'#totalSettlePrice':'36','#totalSettlePriceView':'36'})
        return s,d,g,source,render

    def test_multi_amount_checks_each_option_quantity_sum_and_cart_binding(self):
        s,d,g,source,renderer=self.multi_amount()
        with patch('http_amounts.render',side_effect=renderer):verify_bofeel(s,d,g,source)
        self.assertTrue(d.report['submission_ready'])
        self.assertEqual(values(s.read_amount.call_args.args[1],'cartSno[]'),['mock-row','second'])

    def test_multi_amount_missing_extra_changed_product_quantity_and_expected_price_hold(self):
        for mode in ('missing','extra','quantity','option','cart','price','screen'):
            s,d,g,source,renderer=self.multi_amount()
            if mode=='missing':d.fields=[(k,v) for k,v in d.fields if k!='priceInfo[1000000674][6348]']
            if mode=='extra':d.fields += [('priceInfo[999][999]',one(d.fields,'priceInfo[1000000674][6348]'))]
            if mode=='quantity':g['rows'][1]['quantity']=2
            if mode=='option':g['rows'][1]['mapping']['optionId']='6347'
            if mode=='cart':d.fields=replace(d.fields,'cartSno[]','mock-row')
            if mode=='price':g['rows'][1]['expectedPrice']='99'
            if mode=='screen':source=source.replace('id="totalGoodsPrice">32','id="totalGoodsPrice">31')
            with self.subTest(mode=mode),patch('http_amounts.render',side_effect=renderer),self.assertRaises(LoginError):verify_bofeel(s,d,g,source)
            self.assertFalse(d.report['submission_ready']);s.read_amount.assert_not_called()

    def test_multi_protocol_reports_all_source_keys_and_never_submits_in_prepare(self):
        session=MultiSession();out=Mock()
        def verify(s,d,*a):d.report['submission_ready']=True
        with patch('http_queue.verify_bofeel',side_effect=verify),patch('http_queue.emit',out),patch('http_queue.submit_prepared') as send:
            run('bofeel',[group('bofeel',[mapped_option(),row('bofeel',line=2)])],{'ENABLE_B2B_HTTP_CART':'true','BOFEEL_LOGIN_ID':'mock','BOFEEL_LOGIN_PASSWORD':'mock'},session_factory=lambda _:session)
        result=out.call_args.args[0]
        self.assertTrue(result['submissionReady']);self.assertEqual(len(result['sourceKeys']),2);send.assert_not_called()


if __name__=='__main__':unittest.main()
