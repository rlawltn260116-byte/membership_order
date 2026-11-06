// 로컬 분석 전용. 큐, 네트워크, 처리 이력 쓰기를 수행하지 않는다.
import ExcelJS from 'exceljs';

const text = value => String(value ?? '').trim();
const normalize = value => text(value).replace(/\s+/g, '');
const required = ['주문일자', '주문번호', '순번', '소분류', '주문수량', '미납수량', '비고(건)', '비고(내역)', '납품처'];

export function recentOrderPeriod(asOf) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('기준일은 YYYY-MM-DD 형식이어야 합니다.');
  const end = new Date(`${asOf}T00:00:00Z`);
  if (!Number.isFinite(end.getTime()) || end.toISOString().slice(0, 10) !== asOf) throw new Error('유효하지 않은 기준일입니다.');
  const start = new Date(end); start.setUTCDate(start.getUTCDate() - 29);
  return { start: start.toISOString().slice(0, 10), end: asOf };
}

export async function readAmaranthWorkbook(path) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(path);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error('첫 시트가 없습니다.');
  const headers = sheet.getRow(1).values.slice(1).map(text);
  if (required.some(h => !headers.includes(h)) || new Set(headers).size !== headers.length) throw new Error('필수 열 누락 또는 중복 열이 있습니다.');
  const rows = [];
  sheet.eachRow((row, n) => {
    if (n > 1) rows.push(Object.fromEntries(headers.map((h, i) => [h, row.getCell(i + 1).text.trim()])));
  });
  return rows;
}

export function supplierLookup(schedule, aliases = {}) {
  const result = new Map();
  for (const entry of schedule) {
    for (const name of [entry.vendor, entry.appChannel].filter(Boolean)) {
      result.set(normalize(name), entry.appChannel || entry.vendor);
    }
  }
  // 별칭은 호출자가 확인한 값만 전달한다. 시간/품목 접미사는 추측하지 않는다.
  for (const [alias, target] of Object.entries(aliases)) {
    if (!result.has(normalize(target))) throw new Error('별칭 대상이 시간표에 없습니다.');
    result.set(normalize(alias), result.get(normalize(target)));
  }
  return result;
}

export function splitDelivery(row) {
  const result = { recipient: '', address: '', phone: '', sources: {}, needsReview: true };
  for (const source of ['비고(건)', '비고(내역)', '납품처']) {
    const value = text(row[source]);
    const phone = value.match(/(?<!\d)0\d{1,2}[- )]?\d{3,4}[- ]?\d{4}(?!\d)/)?.[0];
    const parts = value.split(/[\/\n|]/).map(text).filter(Boolean);
    const address = parts.find(p => /(?:[가-힣]+(?:시|군|구)\s+).*(?:로|길|동|읍|면|리)\s*\d/.test(p));
    const recipient = value.match(/(?:수취인|수령인|받는분|수신인)\s*[:：]\s*([^/\n|,]+)/)?.[1]?.trim();
    for (const [key, candidate] of Object.entries({ recipient, address, phone })) {
      if (!result[key] && candidate) { result[key] = candidate; result.sources[key] = source; }
    }
  }
  // 자유형 비고의 이름을 추측하지 않는다. 원문은 반환해 로컬에서만 검토한다.
  result.needsReview = !result.recipient || !result.address || !result.phone;
  return result;
}

function quantity(value) {
  const v = text(value).replace(/,/g, '');
  return /^\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v)) ? Number(v) : null;
}

export function parseAmaranthRows(rows, { asOf, processedOrderNumbers, suppliers }) {
  const period = recentOrderPeriod(asOf);
  if (!(processedOrderNumbers instanceof Set) || !(suppliers instanceof Map)) throw new Error('처리 주문번호 Set과 업체 Map이 필요합니다.');
  const processed = new Set([...processedOrderNumbers].map(text));
  const result = { period, bySupplier: {}, excluded: [], exceptions: [], totalsRemoved: 0 };
  const seen = new Set();
  // 한 품목이라도 일부 출고됐다면 주문이 이미 들어간 것이므로 같은 주문번호 전체를 처리하지 않는다.
  const partialOrders = new Set(rows.filter(row => {
    const ordered = quantity(row['주문수량']), unpaid = quantity(row['미납수량']);
    return ordered !== null && unpaid !== null && ordered !== unpaid;
  }).map(row => text(row['주문번호'])));
  for (const [index, row] of rows.entries()) {
    if (['No', '주문일자', '주문번호', '고객', '품명'].some(k => /^(?:총\s*합계|합계|소계)$/.test(text(row[k])))) { result.totalsRemoved++; continue; }
    if (Object.values(row).every(v => !text(v))) continue;
    const orderNumber = text(row['주문번호']);
    const item = { rowNumber: index + 2, orderNumber, line: text(row['순번']) };
    const exclude = reason => result.excluded.push({ ...item, reason });
    const exception = reason => result.exceptions.push({ ...item, reason });
    if (!orderNumber) { exception('missing_order_number'); continue; }
    if (processed.has(orderNumber)) { exclude('already_processed_order'); continue; }
    if (partialOrders.has(orderNumber)) { exclude('quantity_mismatch'); continue; }
    const date = text(row['주문일자']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) { exception('invalid_date'); continue; }
    if (date < period.start || date > period.end) { exclude('outside_period'); continue; }
    const ordered = quantity(row['주문수량']), unpaid = quantity(row['미납수량']);
    if (ordered === null || unpaid === null) { exception('invalid_quantity'); continue; }
    if (ordered === 0) { exclude('zero_quantity'); continue; }
    const category = text(row['소분류']);
    if (!category) { exception('missing_subcategory'); continue; }
    const name = category.match(/^직배\s*\(([^)]+)\)(.*)$/);
    const lookupName = name && !text(name[2]) ? name[1] : category;
    const supplier = suppliers.get(normalize(lookupName));
    if (!supplier) { exception('unmapped_subcategory'); continue; }
    if (!item.line) { exception('missing_line'); continue; }
    const key = JSON.stringify([orderNumber, item.line]);
    if (seen.has(key)) { exception('duplicate_line'); continue; }
    seen.add(key);
    const parsed = { ...item, supplier, quantity: ordered, productCode: text(row['품번']), product: text(row['품명']), delivery: splitDelivery(row), deliveryNotes: Object.fromEntries(['비고(건)', '비고(내역)', '납품처'].map(k => [k, text(row[k])])) };
    (result.bySupplier[supplier] ??= []).push(parsed);
  }
  return result;
}
