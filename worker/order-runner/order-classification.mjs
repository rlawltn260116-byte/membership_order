import { centerOrderContext } from './b2b-destination.mjs';
import supplierData from './data/supplier-map.json' with { type: 'json' };
import productData from './data/b2b-product-map.json' with { type: 'json' };
import { lookupSupplier } from './supplier-lookup.mjs';

export const PARTS_ORDER_LABEL = '부품 주문(발주처 미정)';
export const PARTS_ORDER_KIND = 'UNASSIGNED_PARTS';
const norm = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

// 파일명의 센터명이나 기존 sourceSystem을 발주처 근거로 삼지 않는다.
// 부품의 본체 모델을 부분 검색해 본체 발주처로 추정하지 않는다.
export function classifyOrderRow(row, suppliers = supplierData, products = productData) {
  const name = norm(row.productName ?? row['품명']);
  const learned = lookupSupplier(name, suppliers);
  const mappedVendors = Object.entries(products).filter(([vendor, items]) => Array.isArray(items) && items.some(item =>
    item.names.some(alias => name === alias || (!/부품|캡|발걸이|쿠션/.test(name) &&
      (name.startsWith(alias + ' / ') || (name.startsWith(alias + '(') && name.endsWith(')')) ||
      (vendor === 'bofeel' && (name.startsWith(alias + ' ') || name.startsWith(alias + '/'))))))))
    .map(([vendor]) => vendor);
  const mappedSupplier = mappedVendors.length === 1 ? ({ bofeel: '보필', eroum: '티에이치케이컴퍼니' })[mappedVendors[0]] : null;
  const supplier = learned.status === 'matched' ? learned.supplier : learned.status === 'not_found' ? mappedSupplier : null;
  const conflict = supplier && mappedSupplier && supplier !== mappedSupplier;
  const partsOrder = !supplier || Boolean(conflict) || row.orderKind === PARTS_ORDER_KIND;
  return { ...centerOrderContext(row), partsOrder, orderKind: partsOrder ? PARTS_ORDER_KIND : 'STANDARD',
    supplier: partsOrder ? '' : supplier,
    supplierEvidence: partsOrder ? '상품 연결표·발주처 학습 자료에서 발주처 미확인 또는 모호함' :
      learned.status === 'matched' ? '발주처 학습 자료의 전체 모델명 일치' : '상품 연결표의 품명·모델 일치',
    ...(partsOrder ? { status: 'HOLD', reason: PARTS_ORDER_LABEL } : {}) };
}

export function partitionOrderRows(rows) {
  const normalRows = [], partsRows = [];
  for (const row of rows) {
    const classification = classifyOrderRow(row);
    const value = { ...row, ...classification };
    (classification.partsOrder ? partsRows : normalRows).push(value);
  }
  return { normalRows, partsRows };
}

export function isPartsOrder(job) {
  return job?.orderKind === PARTS_ORDER_KIND || Boolean(job?.rows?.some(row => row.orderKind === PARTS_ORDER_KIND || classifyOrderRow(row).partsOrder));
}
