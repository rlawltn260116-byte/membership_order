import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveBofeelPostcode } from './bofeel-postcode.mjs';
import { planOrders, submissionProblem } from './b2b-orders.mjs';
import { prepareHttpJob } from './b2b-queue.mjs';
import { submissionContent } from './order-approval.mjs';

const item = (roadAddress = '서울특별시 모의구 가상로 100-2', groundAddress = '서울특별시 모의구 가상동 123-4', zoneCode = '00000') => ({ roadAddress, groundAddress, zoneCode });
const response = (...items) => ({ resultData: { codeData: { code: '0' }, addressData: items } });
const filename = '20261112_직배(보필) 모의 발주서.xlsx';
const input = (address, postcodeSearchResponse) => ({ id: 'mock-job', filename, selectedSheet: '발주', sourceSystem: '보필',
  sourceWorkbook: { filename, sheets: [{ name: '발주', state: 'visible' }, { name: '추가', state: 'visible' }] },
  rows: [{ lineNo: 2, sourceSheet: '발주', sourceSystem: '보필', productName: 'BFSH10', quantity: 1,
    recipientName: '모의인', recipientPhone: '01000000000', address, addressDetail: '', zipcode: '',
    memo: '모의 비고', status: 'READY', postcodeSearchResponse }] });

test('기존 5건 보류 유형을 고객정보 없이 재현하고 정확히 하나만 확정한다', () => {
  const cases = [
    ['지번 유형 1', '서울특별시 모의구 가상동 123-4 101호', response(item())],
    ['지번 유형 2', '경기도 모의시 가상읍 모의리 산 10-2 가상건물', response(item('경기 모의시 가상읍 모의로 10', '경기 모의시 가상읍 모의리 산10-2'))],
    ['복수 결과 유형 1', '서울특별시 모의구 가상로 100-2', response(item(), item('서울특별시 다른구 가상로 100-2'))],
    ['복수 결과 유형 2', '서울특별시 모의구 가상로 100-2', response(item('서울특별시 모의구 가상로 100-3'), item())],
    ['광주 명칭 유형', '광주광역시 모의구 가상로 5', response(item('광주 모의구 가상로 5', '광주 모의구 가상동 11'))],
  ];
  for (const [label, address, data] of cases) {
    const result = resolveBofeelPostcode(address, data);
    assert.equal(result.decision, 'USE', label);
    assert.equal(result.postcode, '00000', label);
    const plan = planOrders(input(address, data));
    assert.equal(plan.rows[0].status, 'READY', label);
    assert.equal(plan.rows[0].recipient.address, result.roadAddress, label);
    assert.equal(plan.rows[0].recipient.detail, result.detail, label);
    assert.equal(plan.rows[0].recipient.memo, '모의 비고', label);
  }
});

test('지번의 동·본번·부번·산 구분과 시군구가 하나라도 다르면 HOLD다', () => {
  const source = '서울특별시 모의구 가상동 123-4';
  for (const ground of ['서울특별시 모의구 다른동 123-4', '서울특별시 모의구 가상동 124-4',
    '서울특별시 모의구 가상동 123-5', '서울특별시 모의구 가상동 산123-4', '서울특별시 다른구 가상동 123-4']) {
    assert.equal(resolveBofeelPostcode(source, response(item(undefined, ground))).decision, 'HOLD');
  }
  assert.equal(resolveBofeelPostcode(source, response(item(), item())).decision, 'HOLD');
  assert.equal(resolveBofeelPostcode(source, response(item('부산 모의구 가상로 100-2'))).decision, 'HOLD');
});

test('여러 결과 중 도로명·건물 본번·부번까지 유일하게 일치해야 하고 중복 결과는 HOLD다', () => {
  const source = '서울 모의구 가상로 100-2';
  for (const result of [response(item(), item()), response(item('서울 모의구 가상로 100')),
    response(item('서울 다른구 가상로 100-2')), response(item('서울 모의구 다른로 100-2')),
    response(item('서울 모의구 가상로 101-2')), response()]) {
    assert.equal(resolveBofeelPostcode(source, result).decision, 'HOLD');
  }
});

test('고정 시도 별칭만 허용하며 개편 명칭·약칭을 대조하고 임의 접두어는 거부한다', () => {
  for (const [before, after] of [['서울특별시', '서울'], ['광주광역시', '광주'],
    ['강원도', '강원특별자치도'], ['전라북도', '전북특별자치도'], ['경기도', '경기']]) {
    const result = resolveBofeelPostcode(`${before} 모의구 가상로 100-2`, response(item(`${after} 모의구 가상로 100-2`)));
    assert.equal(result.decision, 'USE');
  }
  for (const prefix of ['서', '서울시', '광주특별시', '모의특별자치도', '경상']) {
    assert.equal(resolveBofeelPostcode(`${prefix} 모의구 가상로 100-2`, response(item())).decision, 'HOLD');
  }
  assert.equal(resolveBofeelPostcode('광주광역시 모의구 가상로 100-2', response(item('경기 광주시 가상로 100-2'))).decision, 'HOLD');
});

test('주소 구조·성공 코드·검색 응답·5자리 우편번호 미확인과 이미 입력한 다른 우편번호는 HOLD다', () => {
  const address = '서울 모의구 가상로 100-2';
  for (const data of [null, {}, { resultData: { codeData: { code: '1' }, addressData: [item()] } },
    response(item(undefined, undefined, '1234')), response(item(undefined, undefined, 12345))]) {
    assert.equal(resolveBofeelPostcode(address, data).decision, 'HOLD');
  }
  for (const address of ['가상로 100-2', '서울 가상로 100-2', '서울 모의구 가상로', '서울 모의구 가상로 0', '서울 모의구 가상동 번지미상']) {
    assert.equal(resolveBofeelPostcode(address, response(item())).decision, 'HOLD');
  }
  const job = input(address, response(item())); job.rows[0].zipcode = '11111';
  assert.match(planOrders(job).rows[0].reason, /입력한 우편번호와 검색 결과가 다릅니다/);
});

test('우편번호 보류 사유는 운영 결과에 남고 같은 배송지의 다른 상품도 사이트 접근 전에 보류한다', async () => {
  const job = input('서울 모의구 가상로 100-2', response(item(), item()));
  job.rows.push({ ...job.rows[0], lineNo: 3, productName: 'BFMB5', zipcode: '00000', postcodeSearchResponse: undefined });
  const result = await prepareHttpJob(job, { runVendor: async () => assert.fail('사이트 접근 금지') });
  assert.equal(result.canSubmit, false);
  assert(result.details.every(row => row.status === 'HOLD'));
  assert.match(result.details[0].reason, /일치하는 결과가 2건 이상/);
  assert(result.details[0].reviewNotes.some(note => note.includes('우편번호 보류')));
  assert(result.details[1].reviewNotes.some(note => note.includes('우편번호 보류')));
});

test('같은 원본 배송지의 두 행이 서로 다른 우편번호로 확정되면 전체 HOLD다', () => {
  const job = input('서울 모의구 가상로 100-2', response(item()));
  job.rows.push({ ...job.rows[0], lineNo: 3, postcodeSearchResponse: response(item(undefined, undefined, '11111')) });
  const plan = planOrders(job);
  assert(plan.rows.every(row => row.status === 'HOLD'));
  assert.equal(plan.groups.length, 0);
});

test('시트 변경·검색 응답 변경은 재승인 전 원장·전송 전에 차단한다', () => {
  const job = input('서울 모의구 가상로 100-2', response(item()));
  const env = { ENABLE_B2B_HTTP_SUBMIT: 'true', B2B_HTTP_SUBMIT_VENDORS: 'bofeel', FINAL_SUBMISSION_APPROVAL_KEY: 'mock-approval-key-12345' };
  Object.assign(job, { executionMode: 'SUBMIT', claimedFromStatus: 'SUBMIT_QUEUED', dashboardReview: {
    reviewedFromStatus: 'REVIEWED', decision: 'ACCEPTED', finalSubmissionApproved: true,
    finalSubmissionApprovedAt: new Date().toISOString(), submissionRequestId: 'mock-request-1234' } });
  const prefix = `${job.id}:${job.dashboardReview.submissionRequestId}:`;
  job.dashboardReview.approvalProof = createHash('sha256').update(prefix + env.FINAL_SUBMISSION_APPROVAL_KEY).digest('hex');
  job.dashboardReview.contentApprovalProof = createHash('sha256').update(prefix + submissionContent(job) + ':' + env.FINAL_SUBMISSION_APPROVAL_KEY).digest('hex');
  assert.equal(submissionProblem(job, env), null);
  const changed = structuredClone(job);
  changed.selectedSheet = '추가'; changed.rows[0].sourceSheet = '추가';
  assert.match(submissionProblem(changed, env), /승인 내용과 다릅니다/);
  job.rows[0].postcodeSearchResponse.resultData.addressData[0].zoneCode = '11111';
  assert.match(submissionProblem(job, env), /승인 내용과 다릅니다/);
});
