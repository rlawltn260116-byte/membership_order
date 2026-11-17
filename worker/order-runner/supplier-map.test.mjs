import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadSupplierMap, lookupSupplier, normalizeModel } from './supplier-map.mjs';

const data = loadSupplierMap();

test('ActiveFree OP5 발주처·시간표는 사용자 확정 안앤락으로 보정하고 원본 출처를 보존한다', () => {
  const result = lookupSupplier('성인용보행기 ActiveFree OP5', data);
  assert.equal(result.supplier, '안앤락');
  assert.equal(result.matches[0].scheduleVendor, '안앤락');
  assert.equal(result.matches[0].scheduleStatus, '시간표 연결');
  assert.match(result.matches[0].rawSupplier, /사과나무/);
  assert.ok(result.matches[0].appliedRules.includes('사용자 확정 발주처 보정(2026-11-17)'));
});

test('학습한 모든 모델의 키와 정확 조회가 일치한다', () => {
  for (const row of data.records) {
    assert.equal(normalizeModel(row.model), row.modelKey);
    const result = lookupSupplier(row.model, data);
    assert.ok(result.matches.includes(row));
    const expected = new Set(data.records.filter(other => other.modelKey === row.modelKey).map(other => other.supplier));
    assert.equal(result.status, expected.size === 1 ? 'matched' : 'ambiguous');
  }
});

test('공백·대소문자·전각 및 괄호 기호 차이를 흡수한다', () => {
  const model = '수동휠체어 MiKi-W AH (오렌지)';
  const result = lookupSupplier(' 수동휠체어　ＭＩＫＩ-W ah［오렌지］ ', data);
  assert.equal(result.status, 'matched');
  assert.equal(result.supplier, lookupSupplier(model, data).supplier);
  assert.equal(normalizeModel('A(B)'), normalizeModel('ab'));
  assert.notEqual(normalizeModel('A(B)'), normalizeModel('A(C)'));
  assert.notEqual(normalizeModel('AB-1'), normalizeModel('AB1'));
});

test('같은 모델의 복수 발주처는 정확 표기여도 하나를 고르지 않는다', () => {
  const records = [
    { model: 'M(1)', modelKey: 'm1', supplier: '명성H' },
    { model: 'm 1', modelKey: 'm1', supplier: '명성실버케어' },
  ];
  const result = lookupSupplier('M(1)', { records });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.supplier, null);
  assert.deepEqual(result.suppliers, ['명성H', '명성실버케어']);
  assert.equal(result.matches.length, 2);
  assert.equal(lookupSupplier('m1', { records: [records[0], records[0]] }).status, 'matched');
});

test('미등록·빈 모델과 부분 모델은 미발견으로 반환한다', () => {
  for (const value of ['', '   ', null, '존재하지 않는 모의 모델', 'MiKi-W AH']) {
    assert.equal(lookupSupplier(value, data).status, 'not_found');
  }
});

test('학습 자료는 공개 허용 필드만 포함하고 미정 발주처를 보존한다', () => {
  const fields = ['model', 'modelKey', 'category', 'productName', 'supplier', 'manufacturer', 'scheduleVendor', 'scheduleStatus', 'rawSupplier', 'appliedRules'].sort();
  const schedule = JSON.parse(readFileSync(new URL('./data/direct-delivery-schedule.json', import.meta.url), 'utf8'));
  const scheduled = new Set(schedule.schedule.map(row => row.vendor));
  for (const row of data.records) {
    assert.deepEqual(Object.keys(row).sort(), fields);
    for (const [key, value] of Object.entries(row)) {
      if (key === 'appliedRules') {
        assert.ok(Array.isArray(value));
        assert.ok(value.every(rule => typeof rule === 'string'));
      } else {
        assert.equal(typeof value, 'string');
      }
      assert.doesNotMatch(JSON.stringify(value), /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\s*원|https?:\/\//u);
    }
    assert.notEqual(row.rawSupplier, '조아(시호넨스)');
    assert.ok(row.scheduleVendor === '미정' || scheduled.has(row.scheduleVendor));
    if (row.scheduleVendor === '미정') assert.equal(row.scheduleStatus, '발주 시각·방식 미정');
    if (row.supplier === '티에이치케이컴퍼니') assert.equal(row.scheduleVendor, 'THK');
  }
});
