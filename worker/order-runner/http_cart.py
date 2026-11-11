"""브라우저 없는 시험 장바구니. 주문·결제 전송 기능은 제공하지 않는다."""
from dataclasses import dataclass, field
from html.parser import HTMLParser
import gzip
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import urlsplit, parse_qs

from http_login_draft import VendorHttpSession, LoginError, check_stop_signal


def normal(value):
    return ' '.join(value.split())


@dataclass(eq=False)
class Element:
    tag: str
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)
    parent: object = None

    def all(self, tag=None):
        for child in self.children:
            if isinstance(child, Element):
                if tag is None or child.tag == tag:
                    yield child
                yield from child.all(tag)

    def text(self):
        return normal(' '.join(c.text() if isinstance(c, Element) else c
                               for c in self.children if not isinstance(c, Element) or c.tag not in ('script', 'style')))

    def has_class(self, name):
        return name in self.attrs.get('class', '').split()


class Document(HTMLParser):
    VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}

    def __init__(self, html):
        super().__init__(convert_charrefs=True)
        self.root = Element('document')
        self.stack = [self.root]
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        node = Element(tag, dict(attrs), parent=self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in self.VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def form(self, target):
        forms = [n for n in self.root.all('form') if target in (n.attrs.get('id'), n.attrs.get('name'))]
        if len(forms) != 1:
            raise LoginError('폼 개수 또는 구조 변경')
        return forms[0]


def controls(form):
    return [n for n in form.all() if n.tag in ('input', 'select', 'textarea') and n.attrs.get('name')]


def serialize(form):
    pairs = []
    for n in controls(form):
        a = n.attrs
        kind = a.get('type', '').lower()
        if 'disabled' in a or kind in ('button', 'submit', 'reset', 'file', 'image'):
            continue
        if kind in ('checkbox', 'radio') and 'checked' not in a:
            continue
        if n.tag == 'select':
            options = [o for o in n.all('option') if 'disabled' not in o.attrs]
            selected = [o for o in options if 'selected' in o.attrs]
            if not selected and 'multiple' not in a:
                selected = options[:1]
            pairs.extend((a['name'], o.attrs.get('value', o.text())) for o in selected)
        else:
            pairs.append((a['name'], n.text() if n.tag == 'textarea' else a.get('value', 'on' if kind in ('checkbox', 'radio') else '')))
    return pairs


def values(pairs, name):
    return [v for k, v in pairs if k == name]


def one(pairs, name):
    found = values(pairs, name)
    if len(found) != 1:
        raise LoginError('필수 필드 누락 또는 중복')
    return found[0]


def replace(pairs, name, value):
    return [(k, v) for k, v in pairs if k != name] + [(name, value)]


def positive_int(value):
    if not re.fullmatch(r'[1-9]\d*', value):
        raise LoginError('수량 표시 미확인')
    return int(value)


@dataclass(frozen=True)
class CartRow:
    product_id: str
    name: str
    option: str
    quantity: int
    selector: str
    selector_value: str
    cart_id: str

    def safe_summary(self):
        return {'product_id': self.product_id, 'model': self.name, 'option': self.option,
                'quantity': self.quantity, 'row_identifier_present': bool(self.cart_id)}


@dataclass
class CartSnapshot:
    vendor: str
    rows: list
    fields: list
    empty_marker: bool

    def require_empty(self):
        if self.rows or not self.empty_marker:
            raise LoginError('빈 장바구니 미확인: 변경 없이 중단')

    def require_single(self, product_id, model, quantity=1, option=''):
        if len(self.rows) != 1:
            raise LoginError('승인된 단일 상품 행 아님: 변경 없이 중단')
        row = self.rows[0]
        if (row.product_id, row.name, row.quantity, row.option) != (product_id, model, quantity, option):
            raise LoginError('상품 ID·모델·옵션·수량 대조 실패: 변경 없이 중단')
        return row

    def require_items(self, expected):
        from collections import Counter
        actual = Counter((r.product_id, r.name, r.option, r.quantity) for r in self.rows)
        if not expected or actual != Counter(expected) or len(self.rows) != len(expected):
            raise LoginError('장바구니 전체 상품·옵션·수량 대조 실패')
        return self.rows


@dataclass(repr=False)
class OrderDraft:
    """민감 기본값은 메모리에만 둔다. 전송 메서드나 원문 출력은 없다."""
    fields: list
    report: dict

    def safe_summary(self):
        return self.report.copy()

    def clear(self):
        self.fields.clear()
        if hasattr(self, 'expected_fields'):
            self.expected_fields.clear()
        if hasattr(self, 'amount_snapshot'):
            self.amount_snapshot = ()


def build_order_draft(vendor, html, row, recipient):
    document = Document(html)
    form = document.form('simple_order' if vendor == 'eroum' else 'frmOrder')
    nodes = controls(form)
    names = {n.attrs['name'] for n in nodes}
    defaults = serialize(form)
    if vendor == 'eroum':
        mode_found = any(n.has_class('ad_sel_addr') and n.attrs.get('data-value') == 'new' and
                         n.text() == '신규 배송지' for n in form.all())
        mapping = {'od_b_name': 'name', 'od_b_tel': 'phone', 'od_b_hp': 'phone',
                   'od_b_zip': 'postcode', 'od_b_addr1': 'address',
                   'od_b_addr2': 'detail', 'od_memo': 'memo'}
        action = urllib.parse.urljoin('/shop/simple_order.php', form.attrs.get('action', ''))
        expected_action = '/shop/orderformupdate.php'
        product_required = {'it_id[]', 'io_id[]', 'ct_qty[]', 'prodMemo[]'}
        product_match = (values(defaults, 'it_id[]') == [row.product_id] and
                         values(defaults, 'ct_qty[]') == [str(row.quantity)] and
                         values(defaults, 'io_id[]') == [row.option])
    else:
        mode_found = any(n.attrs.get('id') == 'shippingNew' and n.attrs['name'] == 'shipping' for n in nodes)
        mode_found = mode_found and any(n.attrs.get('for') == 'shippingNew' and n.text() == '직접 입력'
                                        for n in form.all('label'))
        mapping = {'receiverName': 'name', 'receiverZonecode': 'postcode',
                   'receiverAddress': 'address', 'receiverAddressSub': 'detail',
                   'receiverPhone': 'phone', 'receiverCellPhone': 'phone', 'orderMemo': 'memo'}
        action = urllib.parse.urljoin('/order/order.php', form.attrs.get('action', ''))
        expected_action = '/order/order_ps.php'
        product_required = {'cartSno[]'}
        expected_rows = row if isinstance(row, list) else [row]
        product_match = (sorted(values(defaults, 'cartSno[]')) == sorted(r.cart_id for r in expected_rows) and
                         len(set(values(defaults, 'cartSno[]'))) == len(expected_rows))
    missing = sorted((set(mapping) | product_required) - names)
    fields = list(defaults)
    for name, source in mapping.items():
        if name in names:
            fields = replace(fields, name, recipient[source])
    if vendor == 'bofeel' and mode_found:
        fields = replace(fields, 'shipping', 'shippingNew')
    permitted = set(mapping) | ({'shipping'} if vendor == 'bofeel' else set())
    untouched = [(k, v) for k, v in fields if k not in permitted] == [(k, v) for k, v in defaults if k not in permitted]
    report = {'vendor': vendor, 'field_names': sorted(names), 'missing_fields': missing,
              'address_mode_found': mode_found, 'address_mode': 'new' if vendor == 'eroum' else 'shippingNew',
              'action_matches': action == expected_action, 'product_binding_matches': product_match,
              'defaults_preserved': untouched, 'changed_field_names': sorted(k for k in permitted if k in names),
              'submission_allowed': False}
    report['valid'] = not missing and mode_found and action == expected_action and product_match and untouched
    return OrderDraft(fields, report)


def parse_cart(vendor, html):
    document = Document(html)
    form = document.form('frmcartlist' if vendor == 'eroum' else 'frmCart')
    rows = []
    all_selectors = [n for n in form.all('input') if
                     (re.fullmatch(r'ct_chk\[\d+\]', n.attrs.get('name', '')) if vendor == 'eroum'
                      else n.attrs.get('name') == 'cartSno[]')]
    for checkbox in all_selectors:
        tr = checkbox.parent
        while tr and tr.tag != 'tr':
            tr = tr.parent
        if not tr:
            raise LoginError('상품 선택자의 행 연결 미확인')
        inputs = [n for n in tr.all('input')]
        a = checkbox.attrs
        if vendor == 'eroum':
            index = re.fullmatch(r'ct_chk\[(\d+)\]', a['name'])[1]
            pairs = [(n.attrs.get('name'), n.attrs.get('value', '')) for n in inputs]
            product = one(pairs, f'it_id[{index}]')
            name = one(pairs, f'it_name[{index}]')
            quantity = positive_int(a.get('data-qty', ''))
            hidden_qty = [n.attrs.get('value', '') for n in inputs if n.has_class('cart_qty')]
            cells = [c for c in tr.children if isinstance(c, Element) and c.tag == 'td']
            if hidden_qty != [str(quantity)] or len(cells) < 4 or cells[3].text() != str(quantity):
                raise LoginError('행 속성·숨은 수량·표시 수량 불일치')
            option_items = [li.text() for well in tr.all() if well.has_class('well') for li in well.all('li')]
            # 기본 옵션도 모델명과 수량으로 표시된다. 다중 옵션은 추측하지 않는다.
            if len(option_items) != 1:
                raise LoginError('단일 옵션 표시 미확인')
            match = re.fullmatch(r'(.+?)\s+(\d+)개', option_items[0])
            if not match or match[2] != str(quantity):
                raise LoginError('옵션 행 수량 미확인')
            option = '' if match[1] == name else match[1]
            cart_id = a.get('data-ctid', '')
        else:
            product, name = a.get('data-goods-no', ''), a.get('data-goods-nm', '')
            # 이 모델의 사이트 상품명 뒤에는 입고 예정 안내가 붙는다. 모델 표기만 분리한다.
            name = re.sub(r'^(동행\(sk-130\))\s+\[.*$', r'\1', name)
            quantity = positive_int(a.get('data-default-goods-cnt', ''))
            # 장바구니는 분리형 옵션을 '블루/1개 ~ 2개'처럼 공백 없는 '/'로 표시한다(2026-11-11 실제 확인).
            # 연결표 표기 '블루 / 1개 ~ 2개'와 같게 구분자 앞뒤 공백을 정규화한다.
            option = ' / '.join(re.sub(r'\s*\(개당\s*:?.*$', '', part).strip()
                                for part in re.split(r'\s*/\s*', normal(a.get('data-option-nm', ''))))
            cart_id = a.get('value', '')
            displays = [n.text() for n in tr.all('strong') if n.parent and n.parent.has_class('order_goods_num')]
            if displays != [str(quantity) + '개']:
                raise LoginError('장바구니 표시 수량 불일치')
        if not product or not name or not cart_id or not a.get('value'):
            raise LoginError('행 상품·삭제 식별자 누락')
        rows.append(CartRow(product, name, option, quantity, a['name'], a['value'], cart_id))
    if len({r.cart_id for r in rows}) != len(rows):
        raise LoginError('장바구니 행 식별자 중복')
    marker = ('장바구니가 비어 있습니다.' if vendor == 'eroum' else '장바구니에 담겨있는 상품이 없습니다.')
    return CartSnapshot(vendor, rows, serialize(form), marker in form.text())


PRODUCTS = {'eroum': ('PRO2022102700012', 'DYJ-03'), 'bofeel': ('1000000025', 'BFSH10')}


def deletion_fields(snapshot, row):
    if snapshot.rows != [row]:
        raise LoginError('선택 삭제는 검증된 단일 행만 허용')
    product, model = PRODUCTS[snapshot.vendor]
    snapshot.require_single(product, model)
    if snapshot.vendor == 'eroum':
        fields = [(k, v) for k, v in snapshot.fields if not k.startswith('ct_chk[') and k != 'ct_all']
        return replace(fields, 'act', 'seldelete') + [(row.selector, row.selector_value)]
    fields = [(k, v) for k, v in snapshot.fields if k != 'cartSno[]']
    return replace(fields, 'mode', 'cartDelete') + [('cartSno[]', row.cart_id)]


class CartSession(VendorHttpSession):
    """로그인 1회, 변경 재전송 없음. 고정 시험 상품 1행만 지원한다."""
    def __init__(self, vendor):
        super().__init__(vendor)
        self.authenticated = False
        self.created_row = None
        self.cart_html = ''
        self.mutations = set()
        self.order_path = None
        self.created_rows = []
        self.approved_bofeel_items = set()

    def request(self, path, fields=None):
        text = super().request(path, fields)
        if path == self.cart_path and fields is None:
            self.cart_html = text
        return text

    def login(self, username, password):
        result = super().login(username, password)
        self.authenticated = True
        return result

    def get_cart(self):
        if not self.authenticated:
            raise LoginError('인증 확인 전 장바구니 접근 금지')
        html = self.request(self.cart_path)
        if '로그아웃' not in html:
            raise LoginError('세션 만료: 재로그인하지 않고 중단')
        return parse_cart(self.vendor, html)

    def _operation(self, path, fields=None):
        if not self.authenticated:
            raise LoginError('인증 확인 전 작업 금지')
        product, _ = PRODUCTS[self.vendor]
        item_path = ('/shop/item.php?it_id=' if self.vendor == 'eroum' else '/goods/goods_view.php?goodsNo=') + product
        order_path = self.order_path
        if fields is None:
            scoped_item = (self.vendor == 'bofeel' and any(path == '/goods/goods_view.php?goodsNo=' + p for p, _ in self.approved_bofeel_items))
            if path not in (item_path, order_path) and not scoped_item:
                raise LoginError('허용 GET 범위 밖 요청')
        else:
            if self.vendor == 'eroum':
                if path == '/shop/itemcart.php':
                    if one(fields, 'sw_direct') != '0' or values(fields, 'it_id[]') != [product]:
                        raise LoginError('담기 payload 범위 밖 요청')
                elif path == '/shop/cartupdate.php':
                    if one(fields, 'act') not in ('seldelete', 'buy') or not self.created_row:
                        raise LoginError('선택 행 payload 범위 밖 요청')
                    index = re.fullmatch(r'ct_chk\[(\d+)\]', self.created_row.selector)[1]
                    checks = [(k, v) for k, v in fields if k.startswith('ct_chk[')]
                    if checks != [(self.created_row.selector, self.created_row.selector_value)] or one(fields, f'it_id[{index}]') != product:
                        raise LoginError('삭제 대상 불일치')
                    if one(fields, 'act') == 'buy' and (self.order_path is not None or
                            one(fields, 'only_recipient') != '0'):
                        raise LoginError('주문서 이동 범위 밖 요청')
                else:
                    raise LoginError('허용 POST 범위 밖 요청')
            elif path == '/order/cart_ps.php':
                mode = one(fields, 'mode')
                if mode == 'cartIn':
                    permitted = self.approved_bofeel_items or {(product, '31')}
                    if (one(fields, 'cartMode') != '' or len(values(fields, 'goodsNo[]')) != 1 or len(values(fields, 'optionSno[]')) != 1 or
                            (one(fields, 'goodsNo[]'), one(fields, 'optionSno[]')) not in permitted):
                        raise LoginError('담기 payload 범위 밖 요청')
                elif mode == 'cartDelete':
                    rows = self.created_rows or ([self.created_row] if self.created_row else [])
                    if not rows or sorted(values(fields, 'cartSno[]')) != sorted(r.cart_id for r in rows):
                        raise LoginError('삭제 대상 불일치')
                else:
                    raise LoginError('허용 mode 범위 밖 요청')
            else:
                raise LoginError('허용 POST 범위 밖 요청')
            # 요청 전에 예약한다. 응답 유실 후 같은 변경을 재전송하지 않는다.
            key = (path, one(fields, 'act') if self.vendor == 'eroum' and path.endswith('cartupdate.php')
                   else one(fields, 'mode') if self.vendor == 'bofeel' else 'add')
            if self.vendor == 'bofeel' and one(fields, 'mode') == 'cartIn':
                key += (one(fields, 'goodsNo[]'), one(fields, 'optionSno[]'))
            if key in self.mutations:
                raise LoginError('동일 변경 자동 재전송 금지')
            self.mutations.add(key)
        request = urllib.request.Request(self.origin + path,
            data=urllib.parse.urlencode(fields).encode() if fields is not None else None,
            headers={'User-Agent': 'Mozilla/5.0', 'Origin': self.origin,
                     'Referer': self.origin + self.cart_path, 'X-Requested-With': 'XMLHttpRequest',
                     'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'})
        try:
            response = self.opener.open(request, timeout=30)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            status = response.code
            self.trace.append({'method': request.get_method(), 'path': urllib.parse.urlsplit(path).path, 'status': status})
            raw = response.read()
            if response.headers.get('Content-Encoding', '').lower() == 'gzip':
                raw = gzip.decompress(raw)
            text = raw.decode(response.headers.get_content_charset() or 'utf-8', errors='replace')
            check_stop_signal(text)
            if (status == 302 and self.vendor == 'eroum' and path == '/shop/cartupdate.php' and
                    urllib.parse.urljoin(self.origin + path, response.headers.get('Location', '')) == self.origin + self.cart_path):
                if one(fields, 'act') != 'seldelete':
                    raise LoginError('주문서 대신 장바구니 이동: 중단')
                return ''
            if status in (302, 303) and self.vendor == 'eroum' and path == '/shop/cartupdate.php' and one(fields, 'act') == 'buy':
                target = urlsplit(urllib.parse.urljoin(self.origin + path, response.headers.get('Location', '')))
                query = parse_qs(target.query, keep_blank_values=True)
                if (target.scheme != 'https' or target.netloc != urlsplit(self.origin).netloc or
                        target.path != '/shop/simple_order.php' or target.fragment or
                        set(query) != {'od_id'} or len(query['od_id']) != 1 or
                        not re.fullmatch(r'\d+', query['od_id'][0])):
                    raise LoginError('주문서 이동 경로 미확인')
                self.order_path = target.path + '?' + target.query
                return ''
            if status != 200:
                raise LoginError('작업 HTTP 응답 미확인: 재전송 없이 중단')
            return text

    def delete_row(self, snapshot, row):
        if self.created_row != row:
            raise LoginError('이 실행의 승인된 행 아님')
        fields = deletion_fields(snapshot, row)
        return self._operation('/shop/cartupdate.php' if self.vendor == 'eroum' else '/order/cart_ps.php', fields)

    def add_one(self, snapshot):
        snapshot.require_empty()
        if snapshot.vendor != self.vendor or self.created_row:
            raise LoginError('중복 담기 또는 업체 불일치')
        product, model = PRODUCTS[self.vendor]
        path = ('/shop/item.php?it_id=' if self.vendor == 'eroum' else '/goods/goods_view.php?goodsNo=') + product
        html = self._operation(path)
        form = Document(html).form('fitem' if self.vendor == 'eroum' else 'frmView')
        fields = serialize(form)
        idkey = 'it_id[]' if self.vendor == 'eroum' else 'goodsNo[]'
        qtykey = f'ct_qty[{product}][]' if self.vendor == 'eroum' else 'goodsCnt[]'
        optionkey = f'io_id[{product}][]' if self.vendor == 'eroum' else 'optionSno[]'
        if values(fields, idkey) != [product] or values(fields, qtykey) != ['1'] or len(values(fields, optionkey)) != 1:
            raise LoginError('상품 폼 ID·수량·옵션 미확인')
        if self.vendor == 'eroum':
            if one(fields, optionkey) != '':
                raise LoginError('승인된 기본 옵션 아님')
            fields = replace(fields, 'sw_direct', '0')
        else:
            if one(fields, 'optionFl') != 'n' or not one(fields, optionkey):
                raise LoginError('승인된 단일 기본 옵션 아님')
            fields = replace(replace(fields, 'mode', 'cartIn'), 'cartMode', '')
        response = self._operation('/shop/itemcart.php' if self.vendor == 'eroum' else '/order/cart_ps.php', fields)
        if self.vendor == 'eroum':
            if response != 'OK':
                raise LoginError('담기 응답 미확인')
        else:
            try:
                data = json.loads(response)
            except ValueError:
                raise LoginError('담기 JSON 응답 미확인') from None
            if not isinstance(data, dict) or str(data.get('error', '0')).lower() not in ('0', 'false', 'none', ''):
                raise LoginError('담기 오류 응답')
        after = self.get_cart()
        self.created_row = after.require_single(product, model)
        return after

    def open_order(self):
        if not self.created_row:
            raise LoginError('검증된 상품 없이 주문서 조회 금지')
        if self.vendor == 'eroum':
            document = Document(self.cart_html)
            form = document.form('frmcartlist')
            action = urllib.parse.urljoin(self.origin + self.cart_path, form.attrs.get('action', ''))
            # 실제 단일 행 폼과 학습한 장바구니 선택 분기만 허용한다.
            if (action != self.origin + '/shop/cartupdate.php' or
                    not re.search(r'function\s+form_check\s*\(act\)', self.cart_html) or
                    not re.search(r'if\s*\(act\s*==\s*"buy"\)', self.cart_html) or
                    'f.act.value = act;' not in self.cart_html or 'f.submit();' not in self.cart_html):
                raise LoginError('장바구니 주문서 이동 스크립트 변경')
            snapshot = parse_cart(self.vendor, self.cart_html)
            fields = replace(deletion_fields(snapshot, self.created_row), 'act', 'buy')
            self._operation('/shop/cartupdate.php', fields)
        else:
            # 전체 상품 주문은 쿠폰이 없는 경우 order.php GET만 수행한다.
            if ('function gd_order_all()' not in self.cart_html or
                    "location.href='../order/order.php';" not in self.cart_html or
                    any(n.has_class('js_btn_coupon_cancel') for n in Document(self.cart_html).root.all())):
                raise LoginError('보필 전체 상품 주문 흐름 미확인 또는 쿠폰 적용 상태')
            if self.order_path is not None:
                raise LoginError('주문서 중복 이동 금지')
            self.order_path = '/order/order.php'
        html = self._operation(self.order_path)
        if '로그아웃' not in html:
            raise LoginError('주문서 인증 상태 미확인')
        return html

    def order_draft(self, recipient):
        html = self.open_order()
        return build_order_draft(self.vendor, html, self.created_row, recipient)

    def clear(self):
        super().clear()
        self.authenticated = False
        self.cart_html = ''
        self.created_row = None
        self.order_path = None
        self.created_rows.clear()
        self.approved_bofeel_items.clear()
