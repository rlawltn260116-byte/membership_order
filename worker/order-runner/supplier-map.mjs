import { readFileSync } from 'node:fs';
import { lookupSupplier as lookup } from './supplier-lookup.mjs';
export { normalizeModel } from './supplier-lookup.mjs';

/** 공백·대소문자·괄호 기호만 흡수하고 괄호 안 정보는 보존한다. */
export function loadSupplierMap(path = new URL('./data/supplier-map.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** 조회만 수행한다. 같은 키의 발주처가 복수면 정확 표기도 모호함으로 반환한다. */
export function lookupSupplier(model, data = loadSupplierMap()) {
  return lookup(model, data);
}
