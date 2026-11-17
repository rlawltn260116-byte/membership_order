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
  assert.match(classifyOrderRow({ productName: '성인용보행기 ActiveFree OP5' }).supplierEvidenceConflict, /사과나무코퍼레이션.*안앤락/);
});

test('표 밖 품목·부품·다른 모델·미등록 옵션·업체를 추측하지 않는다', () => {
  for (const name of ['욕창예방방석 CD-07', '지팡이 SS / 와인', '지팡이 BS / 브라운', '미끄럼방지매트 바이오스타 논슬립매트 3', 'DYJ-03 부품', 'DYJ-030', 'SLT-10 / 보라', 'SLT-10'])
    assert.equal(itemRound('이로움', name), null, name);
  assert.equal(itemRound('안앤락', 'DYJ-03'), null);
});
