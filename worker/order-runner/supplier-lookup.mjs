/** 브라우저와 워커 공용. 외부 요청이나 파일 읽기를 하지 않는다. */
export function normalizeModel(model) {
  return String(model ?? '').normalize('NFKC').toLowerCase().replace(/[\s()[\]{}]/gu, '');
}

export function lookupSupplier(model, data) {
  const modelKey = normalizeModel(model);
  const matches = modelKey ? data.records.filter(row => row.modelKey === modelKey) : [];
  const suppliers = [...new Set(matches.map(row => row.supplier))].sort();
  return { status: suppliers.length === 0 ? 'not_found' : suppliers.length === 1 ? 'matched' : 'ambiguous',
    modelKey, supplier: suppliers.length === 1 ? suppliers[0] : null, suppliers, matches };
}
