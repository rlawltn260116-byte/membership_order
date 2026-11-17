import test from 'node:test';
import assert from 'node:assert/strict';
import { itemRounds, itemRound, itemRoundScheduleDifferences } from './item-rounds.mjs';
import { classifyOrderRow } from './order-classification.mjs';
import { supplierChannel } from './center-queue.mjs';

test('사용자 표 6구분의 모든 모델·품명·옵션은 5개 시간표 회차와 마감에 일치한다', () => {
  assert.equal(itemRounds.length, 6);
  assert.equal(new Set(itemRounds.map(row => row.scheduleKey)).size, 5);
  assert.deepEqual(itemRoundScheduleDifferences(), []);
  for (const round of itemRounds) for (const item of round.items) {
    for (const name of [item.model, item.name]) for (const option of item.options || ['']) {
      assert.equal(itemRound(round.channel, name, option)?.group, round.group, `${name}/${option}`);
      assert.equal(itemRound(round.channel, option ? `${name} / ${option}` : name)?.group, round.group);
      const classification = classifyOrderRow({ productName: option ? `${name} / ${option}` : name });
      assert.equal(classification.partsOrder, false, `${name}/${option}`);
      assert.equal(supplierChannel(classification.supplier), round.channel, `${name}/${option}`);
    }
  }
  assert.equal(itemRound('THK', '수동휠체어 NA-101W (440/블랙)(재고소진 후 미운영)')?.group, 2);
  assert.equal(itemRound('안앤락', '지팡이 나래-4000 / 와인')?.group, 6);
});

test('ActiveFree OP5 전체 품명과 모델명 모두 최신 사용자 승인 안앤락 분류를 따른다', () => {
  for (const productName of ['ActiveFree OP5', '성인용보행기 ActiveFree OP5'])
    assert.equal(classifyOrderRow({ productName }).supplier, '안앤락');
  assert.equal(classifyOrderRow({ productName: '성인용보행기 ActiveFree OP5' }).supplierEvidenceConflict, undefined);
});

test('추가 확정 네 품목과 지팡이의 색상·색상 미기재도 승인된 회차에 연결된다', () => {
  for (const name of ['CD-07', '욕창예방방석 CD-07', 'SS', '지팡이 SS', '지팡이 SS / 와인', '지팡이 SS / 회색', 'BS', '지팡이 BS', '지팡이 BS / 브라운', '지팡이 BS / 와인']) {
    assert.equal(itemRound('이로움', name)?.scheduleKey, '이로움|14:00', name);
    assert.equal(classifyOrderRow({ productName: name }).supplier, '티에이치케이컴퍼니', name);
  }
  assert.equal(itemRound('안앤락', '미끄럼방지매트 바이오스타 논슬립매트 3')?.scheduleKey, '안앤락|13:30');
  assert.equal(classifyOrderRow({ productName: '미끄럼방지매트 바이오스타 논슬립매트 3' }).supplier, '안앤락');
  for (const name of ['지팡이 SS 부품', '지팡이 BS 부품', 'SS 고무패킹', 'CD-070', '바이오스타 논슬립매트 30'])
    assert.equal(itemRound('이로움', name), null, name);
});

test('표 밖 품목·부품·다른 모델·미등록 옵션·업체를 추측하지 않는다', () => {
  for (const name of ['지팡이 ISA / 와인', '미끄럼방지매트 바이오스타 논슬립매트 30', 'DYJ-03 부품', 'DYJ-030', 'SLT-10 / 보라', 'SLT-10'])
    assert.equal(itemRound('이로움', name), null, name);
  assert.equal(itemRound('안앤락', 'DYJ-03'), null);
});
