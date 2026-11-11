"""현재 상품 폼과 읽기 전용 옵션 응답을 대조해 장바구니 필드를 만든다."""
import html
import re
import time
from http_cart import Document, one, replace, serialize, values
from http_login_draft import LoginError


def option_label(value):
    # 수량 구간 뒤의 가격 안내는 상품 옵션 식별에 포함하지 않는다.
    return re.sub(r'\s*\(개당\s*:?.*$', '', value).strip()


def product_fields(session, source, mapping, quantity):
    form = Document(source).form('frmView')
    fields = serialize(form)
    if any(marker in form.text() for marker in ('구매불가', '구매 불가', '판매중지', '판매 중지')) or values(fields, 'orderPossible') == ['n']:
        raise LoginError('구매 불가 상품')
    if not 1 <= quantity <= 1000:
        raise LoginError('장바구니 수량 범위 밖')
    tier = re.fullmatch(r'(\d+)개\s*~\s*(\d+)개', mapping['optionName'].split(' / ')[-1])
    minimum = re.fullmatch(r'(\d+)개 이상', mapping['optionName'].split(' / ')[-1])
    if (tier and not int(tier[1]) <= quantity <= int(tier[2])) or (minimum and quantity < int(minimum[1])):
        raise LoginError('합산 수량과 승인 옵션 구간 불일치')
    if one(fields, 'optionFl') == 'n':
        if '품절' in form.text():
            raise LoginError('기본 상품 품절')
        if (values(fields, 'goodsNo[]') != [mapping['productId']] or values(fields, 'optionSno[]') != [mapping['optionId']] or mapping['optionName']):
            raise LoginError('현재 상품·기본 옵션 불일치')
    elif one(fields, 'optionFl') == 'y':
        if values(fields, 'goodsNo[]') or values(fields, 'optionSno[]'):
            raise LoginError('이미 선택된 상품 옵션')
        choices = [n for n in form.all('select') if n.attrs.get('name') == 'optionSnoInput']
        if choices:
            selected = [o for n in choices for o in n.all('option') if 'disabled' not in o.attrs and
                        o.attrs.get('value', '').split('||')[0] == mapping['optionId'] and option_label(o.text()) == mapping['optionName']]
            if len(selected) != 1:
                raise LoginError('현재 옵션명·식별자 불일치')
            encoded = selected[0].attrs['value'].split('^|^')[0]
        else:
            parts = mapping['optionName'].split(' / ')
            if len(parts) != 2:
                raise LoginError('분리 옵션 구조 미확인')
            colors = [o for n in form.all('select') if n.attrs.get('name') == 'optionNo_0' for o in n.all('option')
                      if o.attrs.get('value') == parts[0] and 'disabled' not in o.attrs]
            if len(colors) != 1:
                raise LoginError('현재 색상 선택값 미확인')
            first = session.bofeel_option(mapping['productId'], [parts[0]], one(fields, 'mileageFl'))
            options = first.get('nextOption', [])
            indexes = [i for i, name in enumerate(options) if option_label(name) == parts[1]]
            if len(indexes) != 1:
                raise LoginError('현재 수량 구간 미확인')
            idx = indexes[0]
            if first.get('optionSellFl', [])[idx] != 'y' or first.get('optionViewFl', [])[idx] != 'y':
                raise LoginError('옵션 품절·판매중지')
            if re.search(r"'setStockFl'\s*:\s*'y'", source):
                stock = str(first.get('stockCnt', [])[idx])
                if not stock.isdigit() or int(stock) < quantity:
                    raise LoginError('옵션 재고 수량 미확인·부족')
            second = session.bofeel_option(mapping['productId'], [parts[0], options[idx]], one(fields, 'mileageFl'))
            encoded = second.get('optionSno', '')
        values_encoded = encoded.split('||')
        if len(values_encoded) < 2 or values_encoded[0] != mapping['optionId'] or not re.fullmatch(r'\d+(?:\.0+)?', values_encoded[1]):
            raise LoginError('현재 옵션 식별자·옵션가 미확인')
        # 사이트의 optionTemplate 입력 필드만 만든다. 스크립트를 실행하지 않는다.
        templates = [n for n in Document(source).root.all('script') if n.attrs.get('id') == 'optionTemplate']
        if len(templates) != 1:
            raise LoginError('옵션 템플릿 구조 변경')
        template = ''.join(c for c in templates[0].children if isinstance(c, str))
        replacements = {'optionSno': mapping['optionId'], 'displayOptionkey': mapping['optionId'] + '_' + str(int(time.time()*1000)),
                        'optionPrice': values_encoded[1], 'optionName': mapping['optionName'], 'optionStock': '',
                        'optionSellCodeValue': '', 'optionDeliveryCodeValue': ''}
        for key, value in replacements.items():
            template = template.replace('<%=' + key + '%>', html.escape(value, quote=True))
        dynamic = serialize(Document('<form id="f">' + template + '</form>').form('f'))
        if any('<%' in k + v for k, v in dynamic):
            raise LoginError('옵션 템플릿 미확인 입력값')
        if values(dynamic, 'goodsNo[]') != [mapping['productId']] or values(dynamic, 'optionSno[]') != [mapping['optionId']]:
            raise LoginError('옵션 템플릿 상품·식별자 불일치')
        unit = one(fields, 'set_goods_price')
        if not re.fullmatch(r'\d+(?:\.0+)?', unit):
            raise LoginError('서버 상품 단가 형식 미확인')
        dynamic = replace(dynamic, 'goodsPriceSum[]', str(int(unit.split('.')[0]) * quantity))
        dynamic = replace(dynamic, 'optionPriceSum[]', str(int(values_encoded[1].split('.')[0]) * quantity))
        # 선택 드롭다운은 선택 직후 초기화된다. 선택 결과는 동적 행에만 남긴다.
        fields = [(k, '' if k == 'optionSnoInput' or k.startswith('optionNo_') else v) for k,v in fields]
        fields += dynamic
    else:
        raise LoginError('미확인 옵션 분기')
    return replace(replace(replace(fields, 'mode', 'cartIn'), 'cartMode', ''), 'goodsCnt[]', str(quantity))
