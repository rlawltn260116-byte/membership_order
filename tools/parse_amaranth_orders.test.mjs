import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmaranthRows, recentOrderPeriod, splitDelivery, supplierLookup } from './parse_amaranth_orders.mjs';

const suppliers = supplierLookup([{ vendor: '모의업체', appChannel: '모의채널' }], { '모의업체-오전': '모의업체' });
const row = (overrides = {}) => ({ 주문일자: '2026-11-06', 주문번호: 'TEST-1', 순번: '1', 소분류: '직배(모의업체)', 주문수량: '2', 미납수량: '2', ...overrides });
const parse = (rows, processed = []) => parseAmaranthRows(rows, { asOf: '2026-11-06', processedOrderNumbers: new Set(processed), suppliers });

test('최근 30일은 기준일 포함이며 월 경계와 윤년을 처리한다', () => {
  assert.deepEqual(recentOrderPeriod('2026-11-06'), { start: '2026-10-08', end: '2026-11-06' });
  assert.equal(recentOrderPeriod('2024-03-01').start, '2024-02-01');
  assert.throws(() => recentOrderPeriod('2026-02-30'));
  const r = parse([row({ 주문일자: '2026-10-08' }), row({ 주문일자: '2026-10-07' }), row({ 주문일자: '2026-11-07' })]);
  assert.equal(r.bySupplier['모의채널'].length, 1);
  assert.deepEqual(r.excluded.map(x => x.reason), ['outside_period', 'outside_period']);
});
test('처리 이력은 주문번호 전체를 제외하고 신규 주문의 여러 품목은 보존한다', () => {
  const r = parse([row(), row({ 순번: '2' }), row({ 주문번호: 'TEST-2' }), row({ 주문번호: 'TEST-2', 순번: '2' })], ['TEST-2']);
  assert.equal(r.bySupplier['모의채널'].length, 2);
  assert.deepEqual(r.excluded.map(x => x.reason), ['already_processed_order', 'already_processed_order']);
});
test('합계 제거, 일부 출고 제외, 누락 및 미대응 업체 예외 분리', () => {
  const r = parse([{ 주문일자: '합계', 주문수량: '99' }, {}, row({ 주문번호: 'TEST-PART', 미납수량: '1' }), row({ 소분류: '' }), row({ 소분류: '직배(미등록업체)' }), row({ 소분류: '직배(모의업체)_오후' }), row({ 주문수량: '' }), row({ 주문수량: '0', 미납수량: '0' })]);
  assert.equal(r.totalsRemoved, 1);
  assert.deepEqual(r.excluded.map(x => x.reason), ['quantity_mismatch', 'zero_quantity']);
  assert.deepEqual(r.exceptions.map(x => x.reason), ['missing_subcategory', 'unmapped_subcategory', 'unmapped_subcategory', 'invalid_quantity']);
  assert.deepEqual(Object.keys(r.bySupplier), []);
});
test('업체별 분류와 명시적 별칭만 허용하며 숫자 문자열과 중복행을 처리한다', () => {
  const rows = [row({ 소분류: '직배 (모의업체-오전)', 주문수량: '1,000', 미납수량: '1000' }), row(), row({ 순번: '' })];
  const before = JSON.stringify(rows);
  const r = parse(rows);
  assert.equal(r.bySupplier['모의채널'][0].quantity, 1000);
  assert.deepEqual(r.exceptions.map(x => x.reason), ['duplicate_line', 'missing_line']);
  assert.equal(JSON.stringify(rows), before);
  assert.throws(() => supplierLookup([], { 별칭: '없는업체' }));
});
test('비고 건, 내역, 납품처 순서로 배송 필드를 보완한다', () => {
  const delivery = splitDelivery({ '비고(건)': '수취인: 모의수령인 / 010-0000-0000', '비고(내역)': '가상시 모의구 예제로 123 / 010-1111-1111', 납품처: '수취인: 대체수령인 / 가상시 다른구 모의로 456' });
  assert.equal(delivery.recipient, '모의수령인');
  assert.equal(delivery.phone, '010-0000-0000');
  assert.equal(delivery.address, '가상시 모의구 예제로 123');
  assert.equal(delivery.sources.address, '비고(내역)');
  assert.equal(delivery.needsReview, false);
  const fallback = splitDelivery({ 납품처: '수취인: 모의수령인 / 가상시 모의구 예제로 123 / 010-0000-0000' });
  assert.equal(fallback.sources.phone, '납품처');
  assert.equal(fallback.needsReview, false);
  assert.equal(splitDelivery({ '비고(건)': '자유형모의이름' }).needsReview, true);
});
test('기준일, 처리이력, 필수 필드 오류는 조용히 통과하지 않는다', () => {
  assert.throws(() => parseAmaranthRows([], { asOf: '2026-11-06', suppliers }));
  const r = parse([row({ 주문번호: '' }), row({ 주문일자: '2026-02-30' }), row({ 주문수량: 'NaN' })]);
  assert.deepEqual(r.exceptions.map(x => x.reason), ['missing_order_number', 'invalid_date', 'invalid_quantity']);
});
test('일부 출고된 품목이 있으면 같은 주문번호의 다른 품목도 처리하지 않는다', () => {
  const r = parse([row({ 주문번호: 'PART-1', 미납수량: '1' }), row({ 주문번호: 'PART-1', 순번: '2' }), row({ 주문번호: 'FULL-1' })]);
  assert.deepEqual(r.bySupplier['모의채널'].map(x => x.orderNumber), ['FULL-1']);
  assert.deepEqual(r.excluded.map(x => [x.orderNumber, x.line, x.reason]), [['PART-1', '1', 'quantity_mismatch'], ['PART-1', '2', 'quantity_mismatch']]);
});
