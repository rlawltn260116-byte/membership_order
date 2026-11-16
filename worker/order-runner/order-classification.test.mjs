import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDestination, SITE_RECIPIENT_REQUIRED_REASON } from './b2b-destination.mjs';
import { classifyOrderRow, partitionOrderRows, PARTS_ORDER_KIND } from './order-classification.mjs';
import { planOrders } from './b2b-orders.mjs';
import { prepareHttpJob } from './b2b-queue.mjs';

const filename = '20261116_직배(가상센터) 모의.xlsx';
const row = changes => ({ lineNo: 2, sourceSheet: '발주', sourceSystem: '보필', productName: 'BFSH10',
  quantity: 1, destination: '가상시 모의로 1 / 모의인', recipientPhone: '01000000000', zipcode: '00000', ...changes });
const job = rows => ({ filename, selectedSheet: '발주', sourceSystem: '보필',
  sourceWorkbook: { filename, sheets: [{ name: '발주', state: 'visible' }] }, rows });

test('센터·지사 판정은 파일명 또는 비고만 근거로 기록하고 일반 고객 빈 수취인은 보류한다', () => {
  for (const context of [{ filename: '제조사발주서(가상센터).xlsx' }, { filename: '직배(가상센터).xlsx' },
    { filename: '가상센터_재고보유용.xlsx' }, { filename: '제조사지사.xlsx' }, { memo: '가상지사' }]) {
    const empty = analyzeDestination('가상시 모의로 1 /', 'bofeel', context);
    assert.equal(empty.status, 'READY');
    assert.equal(empty.name, '');
    assert.equal(empty.address, '가상시 모의로 1');
    assert.equal(empty.centerOrderEvidence.length, 1);
    const named = analyzeDestination('가상시 모의로 1 / 가상센터', 'bofeel', context);
    assert.equal(named.status, 'READY');
    assert.equal(named.name, '가상센터');
  }
  assert.equal(analyzeDestination('가상시 모의로 1 /', 'bofeel').reason, '수취인 없음');
  assert.equal(analyzeDestination('가상시 모의로 1 /', 'bofeel', { filename: '일반.xlsx', memo: '고객 주문' }).centerOrder, false);
  assert.equal(analyzeDestination('가상시 모의로 1 / 가상센터', 'bofeel').centerOrder, false);
  assert.equal(analyzeDestination('', 'bofeel', { filename }).status, 'HOLD');
  assert.equal(analyzeDestination('가상시 모의로 1 /302호', 'bofeel', { filename }).status, 'HOLD');
  assert.equal(analyzeDestination('가상시 모의로 1 가상지사', 'bofeel', { filename }).name, '가상지사');
  assert.equal(analyzeDestination('가상시 모의로 1 모의인', 'bofeel', { filename }).name, '모의인');
});

test('센터 공란은 사이트 수취인 필수 제약을 별도로 보고하며 외부 준비·주소 조회를 하지 않는다', async () => {
  const source = job([row({ destination: '가상시 모의로 1 /', zipcode: '' })]);
  const plan = planOrders(source);
  assert.equal(plan.rows[0].recipient.name, '');
  assert.equal(plan.rows[0].centerOrder, true);
  assert.ok(plan.rows[0].reason.includes(SITE_RECIPIENT_REQUIRED_REASON));
  assert.ok(!plan.rows[0].reason.includes('수취인 없음'));
  assert.equal(plan.groups.length, 0);
  const result = await prepareHttpJob(source, { env: { ENABLE_B2B_HTTP_CART: 'true' },
    lookupPostcodes: () => assert.fail('센터 공란 주소 조회 금지'), runVendor: () => assert.fail('센터 공란 사이트 요청 금지') });
  assert.equal(result.canSubmit, false);
  assert.equal(result.details[0].centerOrder, true);
  assert.deepEqual(result.details[0].centerOrderEvidence, ['파일명에 센터·지사 포함']);
});

test('미확인 부품·발주처는 분리하고 본체 모델·파일 업체로 발주처를 추측하지 않는다', () => {
  for (const productName of ['모의 브레이크 캡', '휠체어부품 모의 NA-1 방석 쿠션', '모의 발걸이띠', '미확인 일반 상품', 'DYJ-03 부품']) {
    const result = classifyOrderRow({ productName, sourceSystem: '보필' });
    assert.equal(result.partsOrder, true);
    assert.equal(result.status, 'HOLD');
    assert.equal(result.orderKind, PARTS_ORDER_KIND);
    assert.equal(result.supplier, '');
  }
  assert.equal(classifyOrderRow({ productName: 'BFSH10' }).partsOrder, false);
  assert.equal(classifyOrderRow({ productName: '전동침대 NY(T)-2100 3모터' }).supplier, '남양금속');
  const suppliers = { records: [{ modelKey: '모의쿠션', supplier: '모의발주처' }] };
  assert.equal(classifyOrderRow({ productName: '모의 쿠션' }, suppliers, {}).partsOrder, false);
  suppliers.records.push({ modelKey: '모의쿠션', supplier: '다른발주처' });
  assert.equal(classifyOrderRow({ productName: '모의 쿠션' }, suppliers, {}).partsOrder, true);
});

test('같은 배송지의 미정 부품은 일반 주문과 독립하며 분리한 부품만 HOLD로 보존한다', async () => {
  const input = [row(), row({ lineNo: 3, productName: '모의 부품 캡', memo: '원문 비고' })];
  const parts = partitionOrderRows(input);
  assert.equal(parts.normalRows.length, 1);
  assert.equal(parts.partsRows.length, 1);
  assert.equal(parts.partsRows[0].memo, '원문 비고');
  assert.equal(input[1].status, undefined);
  const plan = planOrders(job(input));
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].rows.length, 1);
  assert.equal(plan.partsOrders.length, 1);
  const result = await prepareHttpJob({ ...job(parts.partsRows), orderKind: PARTS_ORDER_KIND }, {
    env: { ENABLE_B2B_HTTP_CART: 'true' }, lookupPostcodes: () => assert.fail('부품 주소 조회 금지'),
    runVendor: () => assert.fail('부품 사이트 요청 금지') });
  assert.equal(result.canSubmit, false);
  assert.equal(result.details[0].status, 'HOLD');
});
