import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDestination } from './b2b-destination.mjs';

test('밑줄 규칙과 마지막 슬래시 뒤 한글 2~5자 이름은 두 업체에서 같다', () => {
  for (const vendor of ['bofeel', 'eroum']) {
    for (const separator of ['_', '/', ' /', '/ ', ' / ']) {
      for (const name of ['가나', '가나림', '가나다림', '가나다라림', '홍길동']) {
        assert.deepEqual(splitDestination(`가상시 모의로 18, 501동/1306호${separator}${name}`, vendor),
          { address: '가상시 모의로 18, 501동/1306호', name });
      }
    }
    assert.deepEqual(splitDestination('가상시_모의로 1_모의 수취인', vendor),
      { address: '가상시_모의로 1', name: '모의 수취인' });
    for (const text of ['가상시 모의로 1 101동/102호', '가상시 모의로 1 /',
      '가상시 모의로 1 /가', '가상시 모의로 1 /가나다라마바사', '가상시 모의로 1 /TEST',
      '가상시 모의로 1 /모의 인', '가상시 모의로 1 /모의 수취인', '가상시 모의로 1', '', '/모의인',
      '가상시 모의로 1_모의인/다른이름']) assert.equal(splitDestination(text, vendor), null, text);
  }
});

test('보필의 쉼표·끝 이름과 괄호 안 쉼표는 기존 규칙대로 보존한다', () => {
  for (const text of ['가상시 모의로 1, 모의인', '가상시 모의로 1 모의인',
    '가상시 모의로 1 (가상동, 가상아파트) 모의인']) {
    assert.equal(splitDestination(text, 'bofeel')?.name, '모의인');
    assert.equal(splitDestination(text, 'eroum'), null);
  }
  assert.deepEqual(splitDestination('가상시 모의로 1, 101동/102호, 모의인', 'bofeel'),
    { address: '가상시 모의로 1, 101동/102호', name: '모의인' });
  assert.deepEqual(splitDestination('가상시 모의로 1 101동/102호 모의인', 'bofeel'),
    { address: '가상시 모의로 1 101동/102호', name: '모의인' });
  assert.deepEqual(splitDestination('가상시 모의로 1 (가상동/가상건물), 모의인', 'bofeel'),
    { address: '가상시 모의로 1 (가상동/가상건물)', name: '모의인' });
  assert.deepEqual(splitDestination('가상시 모의로 1 (가상동/가상건물) 모의인', 'bofeel'),
    { address: '가상시 모의로 1 (가상동/가상건물)', name: '모의인' });
  for (const text of ['가상시 모의로 1 (가상동, 가상아파트)', '가상시 모의로 1 모의센터']) {
    assert.equal(splitDestination(text, 'bofeel'), null);
  }
});


test('수취인 끝 D 한 글자 제거와 원문 보존', () => {
  for (const vendor of ['bofeel', 'eroum']) {
    for (const separator of ['_', '/']) {
      for (const suffix of ['D', 'd']) {
        const original = `가상시 모의로 1${separator}모의인${suffix}`;
        assert.deepEqual(splitDestination(original, vendor), { address: '가상시 모의로 1',
          name: '모의인', normalizationNotes: ['수취인 끝 내부 표기 D 제거'] });
        assert.ok(original.endsWith(suffix));
      }
      assert.deepEqual(splitDestination(`가상시 모의로 1${separator}모의인`, vendor),
        { address: '가상시 모의로 1', name: '모의인' });
    }
    assert.equal(splitDestination('가상시 모의로 1/MH기관D', vendor), null);
    assert.equal(splitDestination('가상시 모의로 1/모의인DD', vendor), null);
    assert.deepEqual(splitDestination('가상시 모의로 1_MH기관D', vendor),
      { address: '가상시 모의로 1', name: 'MH기관D' });
    assert.deepEqual(splitDestination('가상시 모의로 1_MHD', vendor),
      { address: '가상시 모의로 1', name: 'MHD' });
  }
  for (const separator of [', ', ' ']) {
    assert.deepEqual(splitDestination(`가상시 모의로 1${separator}모의인d`, 'bofeel'),
      { address: '가상시 모의로 1', name: '모의인', normalizationNotes: ['수취인 끝 내부 표기 D 제거'] });
  }
});
