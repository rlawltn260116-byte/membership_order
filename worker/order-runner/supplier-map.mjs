import { readFileSync } from 'node:fs';

/** 공백·대소문자·괄호 기호만 흡수하고 괄호 안 정보는 보존한다. */
export function normalizeModel(model) {
  return String(model ?? '').normalize('NFKC').toLowerCase().replace(/[\s()[\]{}]/gu, '');
}

export function loadSupplierMap(path = new URL('./data/supplier-map.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 조회만 수행한다. 같은 키의 발주처가 복수면 정확 표기도 모호함으로 반환한다. */
export function lookupSupplier(model, data = loadSupplierMap()) {
  const modelKey = normalizeModel(model);
  const matches = modelKey ? data.records.filter(row => row.modelKey === modelKey) : [];
  const suppliers = [...new Set(matches.map(row => row.supplier))].sort();
  if (suppliers.length === 0) {
    return { status: 'not_found', modelKey, supplier: null, suppliers, matches };
  }
  return {
    status: suppliers.length === 1 ? 'matched' : 'ambiguous',
    modelKey,
    supplier: suppliers.length === 1 ? suppliers[0] : null,
    suppliers,
    matches,
  };
}
