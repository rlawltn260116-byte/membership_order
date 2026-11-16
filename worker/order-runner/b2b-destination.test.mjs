import test from 'node:test';
import assert from 'node:assert/strict';
import { splitDestination, analyzeDestination, RECIPIENT_EMPTY_REASON, RECIPIENT_ADDRESS_REASON, DESTINATION_HOLD_REASON } from './b2b-destination.mjs';

const address = '가상시 모의로 18, 501동/1306호';
const names = ['가나', '모의인', '가나다라림', '가상복지용구', '가상의료기', '가상요양원', '가상재가복지센터',
  '가상의료기 모의인', '가상요양원(모의인)', '(주)가상센터', '주식회사 가상', '가상유한회사', '(복)가상',
  'MOCK PERSON', 'MOCK D', 'MHD', '모의인(가나림)', '모의인 가나림', '모의인.가나림', '모의인ㆍ가나림', '가', '모*인'];

test('규칙 1: 마지막 구분자 뒤 기관·법인·담당자·영문·두 이름·한 글자·가림 표기는 그대로 확정한다', () => {
  for (const vendor of ['bofeel', 'eroum']) for (const separator of ['_', '/', ' /', '/ ', ' / ', ', ']) {
    for (const name of names) assert.deepEqual(splitDestination(`${address}${separator}${name}`, vendor), { address, name });
  }
  assert.deepEqual(splitDestination('가상시_모의로 1_가상/모의인'), { address: '가상시_모의로 1_가상', name: '모의인' });
  assert.deepEqual(splitDestination('가상시 모의로 1 (가상동, 가상건물)/모의인'), { address: '가상시 모의로 1 (가상동, 가상건물)', name: '모의인' });
  assert.equal(analyzeDestination('가상시 모의로 1 (가상동_모의인').name, '모의인');
});

test('규칙 2: 직함·호칭에서 끝의 님만 제거한다', () => {
  for (const vendor of ['bofeel', 'eroum']) for (const name of ['가상센터장', '모의인 과장', '가상의료기 대표', '모의인']) {
    const result = analyzeDestination(`${address}/${name}님`, vendor);
    assert.equal(result.status, 'READY'); assert.equal(result.name, name);
    assert.deepEqual(result.normalizationNotes, ['수취인 끝 호칭 님 제거']);
  }
  assert.equal(analyzeDestination(`${address}/가상님센터`).name, '가상님센터');
});

test('규칙 3: 한글 바로 뒤 D/d/H/h 한 글자와 앞 공백을 제거하고 영문 이름은 보존한다', () => {
  for (const vendor of ['bofeel', 'eroum']) for (const name of ['모의인', '(주)가상센터', '가상의료기 대표', 'MH기관']) {
    for (const suffix of ['D', 'd', 'H', 'h']) for (const space of ['', ' ']) {
      const result = analyzeDestination(`${address}/${name}${space}${suffix}`, vendor);
      assert.equal(result.status, 'READY'); assert.equal(result.name, name);
      assert.deepEqual(result.normalizationNotes, [`수취인 끝 내부 표기 ${suffix.toUpperCase()} 제거`]);
    }
  }
  for (const name of ['MOCK PERSON', 'MOCK D', 'MHD', '모의인DD', '가상D센터']) {
    assert.equal(analyzeDestination(`${address}/${name}`).name, name);
  }
  assert.equal(analyzeDestination(`${address}/모의인님 H`).name, '모의인');
  assert.equal(analyzeDestination(`${address}/모의인H님`).name, '모의인');
});

test('규칙 4·7: 복사 흔적을 제거하고 원문·각 정규화 기록을 성공과 보류 결과에 보존한다', () => {
  for (const tail of ['모의인님 h', '302호님 D']) {
    const original = `\t" ${address}/"${tail}" "\t`;
    const result = analyzeDestination(original, 'bofeel');
    assert.equal(result.originalDestination, original);
    assert.equal(result.name, tail.startsWith('302') ? '302호' : '모의인');
    assert.deepEqual(result.normalizationNotes, ['납품처 앞뒤 탭·큰따옴표 제거', '수취인 끝 내부 표기 D 제거', '수취인 끝 호칭 님 제거'].map(note => tail.startsWith('302') ? note : note.replace(' D ', ' H ')));
  }
});

test('규칙 5: 빈 꼬리와 숫자로 시작하는 주소 조각을 구체적인 사유로 보류한다', () => {
  for (const vendor of ['bofeel', 'eroum']) {
    for (const separator of ['_', '/', ',']) {
      for (const tail of ['', ' ', '""']) {
        assert.equal(analyzeDestination(`${address}${separator}${tail}`, vendor).reason, RECIPIENT_EMPTY_REASON);
        assert.equal(splitDestination(`${address}${separator}${tail}`, vendor), null);
      }
      for (const tail of ['1층', '302호', '101동', '2가', '123 가상', '3', '(302호)', '지하 1층']) {
        assert.equal(analyzeDestination(`${address}${separator}${tail}`, vendor).reason, RECIPIENT_ADDRESS_REASON);
        assert.equal(splitDestination(`${address}${separator}${tail}`, vendor), null);
      }
    }
    assert.equal(analyzeDestination('', vendor).reason, RECIPIENT_EMPTY_REASON);
    assert.equal(analyzeDestination('/모의인', vendor).reason, DESTINATION_HOLD_REASON);
  }
});

test('규칙 6: 확인된 보필 20자 제한만 적용하고 이로움에는 임의 제한을 두지 않는다', () => {
  assert.equal(analyzeDestination(`${address}/${'가'.repeat(20)}`, 'bofeel').status, 'READY');
  assert.equal(analyzeDestination(`${address}/${'가'.repeat(21)}`, 'bofeel').reason, '수취인 길이가 사이트 제한 20자를 초과함');
  assert.equal(analyzeDestination(`${address}/${'가'.repeat(20)}님 D`, 'bofeel').status, 'READY');
  assert.equal(analyzeDestination(`${address}/${'가'.repeat(80)}`, 'eroum').status, 'READY');
});

test('기존 보필 끝 이름과 주소 안 구분자를 유지하고 미확정 구조는 보류한다', () => {
  for (const text of ['가상시 모의로 1 모의인', '가상시 모의로 1 101동/102호 모의인', '가상시 모의로 1 (가상동/가상건물) 모의인']) {
    assert.equal(splitDestination(text, 'bofeel')?.name, '모의인');
    assert.equal(splitDestination(text, 'eroum'), null);
  }
  for (const text of ['가상시 모의로 1 (가상동, 가상아파트)', '가상시 모의로 1 모의센터', '가상시 모의로 1/모의인(가나림']) {
    assert.equal(splitDestination(text, 'bofeel'), null);
  }
});
