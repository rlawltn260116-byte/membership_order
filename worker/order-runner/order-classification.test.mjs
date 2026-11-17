import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDestination, SITE_RECIPIENT_REQUIRED_REASON } from './b2b-destination.mjs';
import supplierData from "./data/supplier-map.json" with { type: "json" };
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
    assert.ok(empty.name);
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

test('센터명은 계획에 출처와 함께 보존된다', () => {
 const plan = planOrders(job([row({ destination: '가상시 모의로 1 /' })]));
 assert.equal(plan.rows[0].recipient.name, '가상센터');
 assert.equal(plan.rows[0].recipientSource, '파일명 센터명');
 assert.equal(plan.rows[0].status, 'READY');
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

test('상품마스터의 " / " 앞은 상품명, 뒤는 옵션으로 조회해 품명·옵션 행을 보필로 분류한다', () => {
  for (const option of ['와인', '베이지']) {
    const productName = option === '와인' ? '이동변기 BFMB4' : '이동변기 BFMB8';
    const result = classifyOrderRow({ productName, option, sourceSystem: '보필' });
    assert.equal(result.partsOrder, false, `${productName}/${option}`);
    assert.equal(result.supplier, '보필');
    assert.equal(result.status, undefined);
  }
  const noOption = classifyOrderRow({ productName: '이동변기 BFMB4', sourceSystem: '보필' });
  assert.equal(noOption.partsOrder, false);
  assert.equal(noOption.supplier, '보필');
  assert.equal(classifyOrderRow({ productName: '이동변기 BFMB5', sourceSystem: '보필' }).supplier, '보필');
  assert.equal(classifyOrderRow({ productName: '이동변기 BFMB4 / 와인' }).supplier, '보필');
});

test('상품마스터에 없는 옵션이거나 상품명만 부분 일치하면 발주처를 정하지 않는다', () => {
  for (const [productName, option] of [['이동변기 BFMB4', '없는색'], ['이동변기 BFMB', '와인'], ['이동변기 BFMB4 / 없는색', '']]) {
    const result = classifyOrderRow({ productName, option, sourceSystem: '보필' }, supplierData, {});
    assert.equal(result.partsOrder, true, productName + '/' + option);
    assert.equal(result.supplier, '');
  }
});

test('같은 상품명의 옵션 발주처가 갈리면 옵션 없는 행도 모호함으로 보류한다', () => {
  const suppliers = { records: [
    { model: '모의 상품 / 빨강', modelKey: '모의상품/빨강', supplier: '모의A' },
    { model: '모의 상품 / 파랑', modelKey: '모의상품/파랑', supplier: '모의A' },
    { model: '모의 상품 / 검정', modelKey: '모의상품/검정', supplier: '모의B' },
  ] };
  assert.equal(classifyOrderRow({ productName: '모의 상품', option: '빨강' }, suppliers, {}).supplier, '모의A');
  const noOption = classifyOrderRow({ productName: '모의 상품' }, suppliers, {});
  assert.equal(noOption.partsOrder, true);
  assert.equal(noOption.supplier, '');
  const unknown = classifyOrderRow({ productName: '모의 상품', option: '노랑' }, suppliers, {});
  assert.equal(unknown.partsOrder, true);
  const sameSupplier = { records: suppliers.records.map(row => ({ ...row, supplier: '모의A' })) };
  assert.equal(classifyOrderRow({ productName: '모의 상품' }, sameSupplier, {}).supplier, '모의A');
});
