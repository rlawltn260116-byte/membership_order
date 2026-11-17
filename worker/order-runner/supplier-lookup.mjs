/** 브라우저와 워커 공용. 외부 요청이나 파일 읽기를 하지 않는다. */
export function normalizeModel(model) {
  return String(model ?? '').normalize('NFKC').toLowerCase().replace(/[\s()[\]{}]/gu, '');
}

export function lookupSupplier(model, data) {
  const modelKey = normalizeModel(model);
  const matches = modelKey ? data.records.filter(row => row.modelKey === modelKey) : [];
  return summarize(modelKey, matches);
}

const OPTION_SEPARATOR = ' / ';

/** 상품마스터 모델명은 " / " 앞이 상품명, 뒤가 옵션이다. 구분자가 없으면 전체가 상품명이다. */
export function splitProductModel(model) {
  const text = String(model ?? '');
  const at = text.indexOf(OPTION_SEPARATOR);
  return at < 0 ? { product: text, option: '' }
    : { product: text.slice(0, at), option: text.slice(at + OPTION_SEPARATOR.length) };
}

/**
 * 주문 행의 품명·옵션으로 발주처를 찾는다.
 * 옵션이 없으면 전체 모델명 일치를 먼저 보고, 없으면 상품명(슬래시 앞)이 같은 행을 모은다.
 * 옵션이 있으면 상품명과 옵션(슬래시 뒤)이 모두 같은 행만 고른다. 같은 상품의 발주처가 갈리면 모호함이다.
 */
export function lookupSupplierByProduct(productName, option, data) {
  const optionKey = normalizeModel(option);
  if (!optionKey) {
    const full = lookupSupplier(productName, data);
    if (full.status !== 'not_found') return { ...full, basis: 'model' };
  }
  const productKey = normalizeModel(productName);
  const matches = productKey ? data.records.filter(row => {
    const parts = splitProductModel(row.model);
    if (normalizeModel(parts.product) !== productKey) return false;
    return optionKey ? normalizeModel(parts.option) === optionKey : true;
  }) : [];
  return { ...summarize(productKey, matches), basis: 'product' };
}

function summarize(modelKey, matches) {
  const suppliers = [...new Set(matches.map(row => row.supplier))].sort();
  return { status: suppliers.length === 0 ? 'not_found' : suppliers.length === 1 ? 'matched' : 'ambiguous',
    modelKey, supplier: suppliers.length === 1 ? suppliers[0] : null, suppliers, matches };
}
