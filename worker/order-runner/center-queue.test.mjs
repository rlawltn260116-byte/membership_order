// 전부 합성 엑셀·메모리 Firebase다. 네트워크나 운영 자격증명을 사용하지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { webcrypto, createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import * as core from './center-queue.mjs';
import { inspectWorkbook, selectWorksheet, workbookProblem } from './workbook-policy.mjs';
import { planOrders, sourceRowKey } from './b2b-orders.mjs';
import { submissionContent } from './order-approval.mjs';
import { workerHarness } from '../../tools/helpers/order-worker-harness.mjs';
import { prepareHttpJob } from './b2b-queue.mjs';
import supplierData from './data/supplier-map.json' with { type: 'json' };

const morning = '2026-11-17T00:00:00.000Z';
function source(filename, sheet = '발주') { return { filename, sheets: [{ name: sheet, state: 'visible', rowCount: 2, headers: [] }] }; }
function manufacturer(channel = '보필', now = morning) {
  const filename = `20261117_직배(${channel})_모의.xlsx`;
  return { filename, sourceSystem: channel, selectedSheet: '발주', sourceWorkbook: source(filename), orderKind: 'STANDARD', status: 'READY',
    createdAt: now, rows: [{ lineNo: 2, sourceFile: filename, sourceDate: '20261117', sourceSheet: '발주', sourceSystem: channel,
      productName: channel === '보필' ? 'BFSH10' : 'DYJ-03', quantity: '1', status: 'READY', recipientName: '모의인', recipientPhone: '01000000000',
      zipcode: '00000', address: '가상시 모의로 1', addressDetail: '', memo: '' }] };
}
async function uploadRows(products = ['BFSH10'], filename = '20261116_가상센터.xlsx', sheets = ['발주']) {
  const book = new ExcelJS.Workbook();
  for (const name of sheets) book.addWorksheet(name).addRows([
    ['주문번호', '납품처', '납품처전화번호', '품명', '주문수량', '비고(내역)'],
    ...products.map((product, index) => ['', '가상시 모의로 1 /', '01000000000', product, index + 1, '모의센터'])]);
  const sourceWorkbook = inspectWorkbook(book, filename);
  return { book, sourceWorkbook, filename, rows: core.parseCenterSheet(selectWorksheet(book, sheets[0]), { filename, sourceDate: '2026-11-16', sourceWorkbook }) };
}
async function fixture(products) {
  const { rows } = await uploadRows(products);
  const prepared = await core.prepareCenterEntries(rows, new Date(morning));
  const root = core.uploadCenterEntries({}, prepared, 'parts', morning);
  return { root, prepared };
}

// 실제 브라우저 저장 어댑터를 가짜 ETag 서버에 연결한다. 두 읽기가 같은 버전을 볼 수 있다.
async function firebase(initial = {}) {
  let root = structuredClone(initial), version = 0, collisions = 0;
  const code = await readFile('lib/firebase-order-ops.ts', 'utf8');
  const ast = ts.createSourceFile('adapter.ts', code, ts.ScriptTarget.Latest, true);
  const source = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replaceAll('export ', '');
  const requests = [];
  const context = vm.createContext({ ...core, crypto: webcrypto, Date, fetch: async (url, init = {}) => {
    requests.push({ method: init.method || 'GET', url });
    assert.ok(url.endsWith('/order-ops.json') || url.includes('/order-ops/'), '허용된 모의 경로만 사용');
    if (url.endsWith('/order-ops.json')) {
      if (init.method === 'PUT') {
        if (init.headers['If-Match'] !== String(version)) { collisions++; return { status: 412, ok: false }; }
        root = JSON.parse(init.body); version++;
        return { status: 200, ok: true };
      }
      const snapshot = structuredClone(root), savedVersion = version;
      return { ok: true, headers: { get: () => String(savedVersion) }, json: async () => snapshot };
    }
    const path = url.split('/order-ops/')[1].replace('.json', '').split('/').map(decodeURIComponent);
    return { ok: true, json: async () => path.reduce((value, key) => value?.[key], root) ?? null };
  } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { context, requests, get root() { return root; }, get collisions() { return collisions; } };
}

test('센터 공통 양식은 행별로 발주처·센터 수취인을 판정하고 미분류 부품을 분리한다', async () => {
  const unknown = supplierData.records.find(row => row.supplier === '사과나무코퍼레이션').model;
  const { root, prepared } = await fixture(['BFSH10', 'DYJ-03', unknown, '모의 미분류 캡']);
  assert.deepEqual(prepared.map(entry => entry.supplier), ['보필', '티에이치케이컴퍼니', '사과나무코퍼레이션', '부품 주문(발주처 미정)']);
  assert.deepEqual(prepared.map(entry => entry.channel), ['보필', '이로움', null, null]);
  assert.ok(prepared.every(entry => entry.row.recipientName === '모의센터'));
  assert.equal(root.jobs.parts.status, 'HOLD');
  assert.equal(root.jobs.parts.orderKind, 'UNASSIGNED_PARTS');
  assert.equal(root.jobs.parts.rows.length, 1);
  assert.equal(core.centerDeadline('사과나무코퍼레이션').label, '발주 시각·방식 미정');
  assert.equal(core.centerDeadline('에이블라이크').channel, null);
});

test('보이는 다중 시트는 사람 선택 없이는 읽을 수 없고 원본 날짜·시트는 필수다', async () => {
  const { book, rows } = await uploadRows(['BFSH10'], '20261116_가상센터.xlsx', ['첫째', '둘째']);
  assert.throws(() => selectWorksheet(book), /사람/);
  assert.equal(core.parseCenterSheet(selectWorksheet(book, '둘째'), { filename: '20261116_가상센터.xlsx', sourceDate: '2026-11-16', sourceWorkbook: inspectWorkbook(book, '20261116_가상센터.xlsx') })[0].sourceSheet, '둘째');
  await assert.rejects(core.prepareCenterEntries([{ ...rows[0], sourceDate: '' }]), /날짜/);
  await assert.rejects(core.prepareCenterEntries([{ ...rows[0], sourceSheet: '숨김' }]), /시트/);
});

test('같은 파일·행 재업로드와 동시 업로드는 센터·부품을 중복 생성하지 않는다', async () => {
  const { prepared } = await fixture(['BFSH10', '모의 부품']);
  const db = await firebase();
  await Promise.all([db.context.saveCenterUpload(prepared), db.context.saveCenterUpload(prepared)]);
  assert.equal(Object.keys(db.root['center-queue'].entries).length, 2);
  assert.equal(Object.keys(db.root.jobs).length, 1);
  assert.ok(db.collisions > 0);
  await db.context.saveCenterUpload(prepared);
  assert.equal(Object.keys(db.root.jobs).length, 1);
  assert.ok(db.requests.filter(request => request.method === 'PUT').every(request => request.url.endsWith('/order-ops.json')));
});

test('그날 첫 작업만 센터 상품을 포함하며 동시 두 작업의 예약은 한 작업에만 속한다', async () => {
  const { root, prepared } = await fixture();
  const db = await firebase(root);
  assert.ok(db.context.newOrderJobId(1794870000000) < db.context.newOrderJobId(1794870000001));
  assert.match(db.context.newOrderJobId(), /^[-0-9A-Z_a-z]{20}$/);
  const created = await Promise.all([db.context.createOrderJob(manufacturer()), db.context.createOrderJob(manufacturer())]);
  assert.deepEqual(created.map(job => job.rows.filter(row => row.centerQueueId).length).sort(), [0, 1]);
  const included = Object.values(db.root.jobs).find(job => job.rows.some(row => row.centerQueueId));
  assert.equal(db.root['center-queue'].entries[prepared[0].id].jobId, included.id);
  assert.equal(included.rows[1].lineNo, 3);
  assert.equal(included.rows[1].sourceLineNo, 2);
  const secondUpload = await uploadRows(['BFSH10'], '20261116_다른가상센터.xlsx');
  await db.context.saveCenterUpload(await core.prepareCenterEntries(secondUpload.rows, new Date(morning)));
  const third = await db.context.createOrderJob(manufacturer());
  assert.equal(third.rows.length, 1);
});

test('센터가 포함된 보필 작업도 실제 워커의 검토·내용 승인·원장·모든 행 잠금을 거쳐야 완료된다', async () => {
  const { root, prepared } = await fixture();
  Object.values(root['center-queue'].entries)[0].row.zipcode = '00000';
  const input = manufacturer(); input.rows[0].recipientName = '모의센터';
  core.createJobWithCenters(root, 'merged', input, morning);
  const env = { ENABLE_B2B_HTTP_CART: 'true', ENABLE_B2B_HTTP_SUBMIT: 'true', B2B_HTTP_SUBMIT_VENDORS: 'bofeel',
    FINAL_SUBMISSION_APPROVAL_KEY: 'mock-approval-key-12345', B2B_SUBMISSION_LEDGER_KEY: 'mock-ledger-key-'.repeat(4),
    GITHUB_TOKEN: 'mock-token', GITHUB_REPOSITORY: 'mock/repo' };
  let sends = 0;
  const worker = await workerHarness(root.jobs, env, (job, callbacks) => prepareHttpJob(job, { ...callbacks, env,
    lookupPostcodes: () => assert.fail('모의 자료 외부 검색 금지'),
    runVendor: async (vendor, groups, options) => {
      const rows = groups.flatMap(group => group.rows);
      const result = { submissionReady: true, sourceKeys: rows.map(row => row.sourceKey), details: rows.map(row => ({ lineNo: row.lineNo, status: 'READY', reason: '모의 준비' })) };
      if (options.onPrepared) result.submission = await options.onPrepared(result, async () => { sends++; return { state: 'SUBMITTED', orderNumber: 'MOCK-20261117' }; });
      return result;
    } }), root['center-queue']);
  root.jobs.merged.status = 'QUEUED';
  await worker.run();
  assert.equal(root.jobs.merged.status, 'AWAITING_REVIEW');
  assert.equal(root.jobs.merged.report.canSubmit, true);
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'RESERVED');
  assert.equal(sends, 0); assert.equal(worker.ledger.length, 0);
  const requestId = 'mock-request-12345';
  const job = root.jobs.merged;
  core.updateJobWithCenters(root, 'merged', { status: 'REVIEWED', dashboardReview: { decision: 'ACCEPTED', finalSubmissionApproved: false } }, morning);
  const hash = value => createHash('sha256').update(value).digest('hex');
  core.updateJobWithCenters(root, 'merged', { status: 'SUBMIT_QUEUED', executionMode: 'SUBMIT', dashboardReview: {
    decision: 'ACCEPTED', reviewedFromStatus: 'REVIEWED', finalSubmissionApproved: true, finalSubmissionApprovedAt: new Date().toISOString(), submissionRequestId: requestId,
    approvalProof: hash(`merged:${requestId}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`),
    contentApprovalProof: hash(`merged:${requestId}:${submissionContent(job)}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`),
  } }, morning);
  await worker.run();
  assert.equal(root.jobs.merged.status, 'COMPLETED', JSON.stringify(root.jobs.merged.report));
  assert.equal(sends, 1); assert.equal(worker.ledger.length, 3);
  assert.equal(root.jobs.merged.submission.rows[2].state, 'SUBMITTED');
  assert.equal(root.jobs.merged.submission.rows[3].state, 'SUBMITTED');
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'COMPLETED');
});

test('한국시간 날짜와 THK·티에이치케이컴퍼니·이로움 및 안앤락 다회차는 같은 첫 작업 이력이다', async () => {
  assert.equal(core.koreaDay('2026-11-16T15:00:00Z'), '2026-11-17');
  const { root } = await fixture(['DYJ-03']);
  core.createJobWithCenters(root, 'first', manufacturer('THK'), morning);
  core.createJobWithCenters(root, 'second', manufacturer('이로움'), '2026-11-17T05:00:00Z');
  assert.equal(root.jobs.first.rows.length, 2);
  assert.equal(root.jobs.second.rows.length, 1);
  assert.equal(core.supplierChannel('티에이치케이컴퍼니'), '이로움');
  assert.ok(core.centerDeadline('티에이치케이컴퍼니', new Date(morning)).receiptDeadlineAt.endsWith('01:30:00.000Z'));
  const model = supplierData.records.find(row => row.supplier === '안앤락').model;
  const other = (await fixture([model])).root;
  core.createJobWithCenters(other, 'a', manufacturer('안앤락'), morning);
  core.createJobWithCenters(other, 'b', manufacturer('안앤락'), '2026-11-17T04:00:00Z');
  assert.equal(other.jobs.a.rows.length, 2); assert.equal(other.jobs.b.rows.length, 1);
});

test('이전 같은 날 작업도 첫 작업으로 인정하며 삭제한 첫 작업 이력도 지우지 않는다', async () => {
  const { root } = await fixture();
  root.jobs = { old: manufacturer('보필') };
  core.createJobWithCenters(root, 'second', manufacturer(), morning);
  assert.equal(root.jobs.second.rows.length, 1);
  core.deleteJobWithCenters(root, 'old');
  core.deleteJobWithCenters(root, 'second');
  core.createJobWithCenters(root, 'third', manufacturer(), morning);
  assert.equal(root.jobs.third.rows.length, 1);
});

test('검토에서 제외하면 대기열로 복귀하고 이전 보고·승인을 무효화하며 다시 예약할 수 있다', async () => {
  const { root, prepared } = await fixture();
  core.createJobWithCenters(root, 'job', manufacturer(), morning);
  const job = root.jobs.job;
  job.status = 'REVIEWED'; job.report = { canSubmit: true }; job.dashboardReview = { finalSubmissionApproved: true };
  core.removeCenterRow(root, 'job', prepared[0].id, morning);
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'WAITING');
  assert.equal(job.rows.length, 1); assert.equal(job.status, 'READY'); assert.equal(job.report, null);
  assert.equal(job.dashboardReview.finalSubmissionApproved, false);
  core.createCenterOnlyJob(root, 'only', '보필', morning);
  assert.equal(root.jobs.only.rows.length, 1);
  assert.equal(root['center-queue'].entries[prepared[0].id].jobId, 'only');
});

test('보류·실패·삭제는 예약을 돌리고 과거 작업에 센터 행을 남기지 않는다', async () => {
  for (const state of ['HOLD', 'FAILED', 'DELETE']) {
    const { root, prepared } = await fixture();
    core.createJobWithCenters(root, 'job', manufacturer(), morning);
    if (state === 'DELETE') core.deleteJobWithCenters(root, 'job');
    else core.updateJobWithCenters(root, 'job', { status: state }, morning);
    assert.equal(root['center-queue'].entries[prepared[0].id].state, 'WAITING');
    assert.ok(!root.jobs.job || root.jobs.job.rows.every(row => !row.centerQueueId));
    assert.equal(root.jobs.job?.report ?? null, null);
  }
});

test('실제 제출 완료 증거만 완료로 전환하고 UNKNOWN·실행 중은 재예약하지 않는다', async () => {
  const { root, prepared } = await fixture();
  core.createJobWithCenters(root, 'job', manufacturer(), morning);
  assert.throws(() => core.updateJobWithCenters(root, 'job', { status: 'COMPLETED' }, morning), /실제 제출/);
  core.updateJobWithCenters(root, 'job', { status: 'RUNNING' }, morning);
  assert.throws(() => core.removeCenterRow(root, 'job', prepared[0].id, morning), /실행 중/);
  assert.throws(() => core.deleteJobWithCenters(root, 'job'), /삭제/);
  core.updateJobWithCenters(root, 'job', { status: 'HOLD', report: { details: [{ submissionState: 'UNKNOWN' }] } }, morning, true);
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'RESERVED');
  assert.throws(() => core.removeCenterRow(root, 'job', prepared[0].id, morning), /제출 이력/);
  core.updateJobWithCenters(root, 'job', { status: 'COMPLETED', executionMode: 'SUBMIT', report: { submittedRows: 2, details: root.jobs.job.rows.map(row => ({ lineNo: row.lineNo, status: 'READY', orderNumber: 'MOCK', submittedAt: morning })) } }, morning, true);
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'COMPLETED');
});

test('접수마감 30분 전 알림과 센터만 작업 생성, 시간표 미정은 표시만 한다', async () => {
  const { root } = await fixture(['BFSH10']);
  assert.equal(core.centerQueueGroups(root, new Date('2026-11-16T23:59:59Z'))[0].alert, false);
  assert.equal(core.centerQueueGroups(root, new Date(morning))[0].alert, true);
  const db = await firebase(root);
  const id = await db.context.makeCenterOnlyJob('보필');
  assert.equal(db.root.jobs[id].orderOrigin, 'CENTER_ONLY');
  assert.equal(db.root.jobs[id].status, 'READY');
  assert.equal(db.root.jobs[id].rows.length, 1);
  assert.equal(core.centerQueueGroups(db.root, new Date(morning))[0].alert, false);
  await assert.rejects(db.context.makeCenterOnlyJob('보필'), /검증 완료된 대기/);
  assert.throws(() => core.createCenterOnlyJob(root, 'unknown', '에이블라이크', morning), /미정/);
});

test('다른 원본 파일의 센터 행과 제조사 행은 각각 출처 검사·내용 승인·원장 행 키에 포함된다', async () => {
  const { root } = await fixture();
  // 준비 단계에서 우편번호를 보완한 상태를 합성한다.
  Object.values(root['center-queue'].entries)[0].row.zipcode = '00000';
  core.createJobWithCenters(root, 'job', manufacturer(), morning);
  const job = root.jobs.job, row = job.rows[1];
  assert.equal(workbookProblem(job), null);
  const plan = planOrders(job);
  assert.equal(plan.rows.length, 2); assert.equal(plan.groups.length, 2);
  assert.ok(plan.rows.every(row => row.status === 'READY'), JSON.stringify(plan.rows.map(row => row.reason)));
  assert.equal(sourceRowKey('bofeel', row, job), sourceRowKey('bofeel', { ...row, centerQueueId: undefined, lineNo: row.sourceLineNo }, { filename: row.sourceFile }));
  const proof = submissionContent(job);
  row.sourceLineNo++;
  assert.notEqual(submissionContent(job), proof);
  assert.match(core.centerReservationProblem(root, job), /原本|원본/);
  row.sourceLineNo--; row.selectedSheet = '숨김';
  assert.ok(workbookProblem(job));
  row.selectedSheet = '발주';
  assert.throws(() => core.updateJobWithCenters(root, 'job', { rows: [job.rows[0]] }, morning), /누락/);
});

test('실제 워커 선점은 센터 예약 소유권을 검사하고 준비 실패 시 원자적으로 대기열 복귀한다', async () => {
  const { root, prepared } = await fixture();
  core.createJobWithCenters(root, 'job', manufacturer(), morning);
  root.jobs.job.status = 'QUEUED';
  let calls = 0;
  const harness = await workerHarness(root.jobs, {}, async job => { calls++; return { canSubmit: false, details: job.rows.map(row => ({ lineNo: row.lineNo, status: 'HOLD', reason: '모의 보류' })) }; }, root['center-queue']);
  await harness.run();
  assert.equal(calls, 1); assert.equal(root.jobs.job.status, 'HOLD');
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'WAITING');
  assert.equal(root.jobs.job.rows.length, 1);
  core.createCenterOnlyJob(root, 'only', '보필', morning);
  root.jobs.only.status = 'QUEUED'; root['center-queue'].entries[prepared[0].id].jobId = '다른작업';
  const blocked = await workerHarness(root.jobs, {}, () => assert.fail('예약 불일치 외부 접근 금지'), root['center-queue']);
  await blocked.run();
  assert.equal(root.jobs.only.status, 'QUEUED');
});

test('실제 워커 예외와 생성 시 검증 보류도 센터 예약을 남기지 않는다', async () => {
  const { root, prepared } = await fixture();
  core.createJobWithCenters(root, 'failed', manufacturer(), morning);
  root.jobs.failed.status = 'QUEUED';
  const worker = await workerHarness(root.jobs, {}, () => { throw new Error('모의 준비 실패'); }, root['center-queue']);
  await worker.run();
  assert.equal(root.jobs.failed.status, 'FAILED');
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'WAITING');
  assert.equal(root.jobs.failed.rows.length, 1);
  const next = (await fixture()).root;
  const held = manufacturer(); held.status = 'HOLD'; held.rows[0].status = 'HOLD';
  core.createJobWithCenters(next, 'held', held, morning);
  assert.equal(next.jobs.held.rows.length, 1);
  assert.equal(Object.values(next['center-queue'].entries)[0].state, 'WAITING');
});

test('검증 보류 센터 행은 정상 제조사와 다른 센터 상품을 막지 않고 수정본으로 교체된다', async () => {
  const { root, prepared } = await fixture(['BFSH10', 'BFSH10']);
  const held = root['center-queue'].entries[prepared[1].id];
  held.row = { ...held.row, status: 'HOLD', reason: '수취인 연락처 형식 확인 필요', recipientPhone: '모의 오류' };
  core.createJobWithCenters(root, 'first', manufacturer(), morning);
  assert.equal(root.jobs.first.status, 'READY');
  assert.equal(root.jobs.first.rows.length, 2);
  assert.equal(root.jobs.first.holdRows, 0);
  assert.equal(held.state, 'WAITING');
  core.removeCenterRow(root, 'first', prepared[0].id, morning);
  core.createCenterOnlyJob(root, 'only', '보필', morning);
  assert.equal(root.jobs.only.status, 'READY'); assert.equal(root.jobs.only.rows.length, 1);
  assert.equal(held.state, 'WAITING');
  const fixed = await core.prepareCenterEntries([{ ...held.row, status: 'READY', reason: '', recipientPhone: '01000000000' }], new Date(morning));
  assert.equal(fixed[0].id, held.id);
  core.uploadCenterEntries(root, fixed, 'parts', morning);
  assert.equal(Object.keys(root['center-queue'].entries).length, 2);
  assert.equal(root['center-queue'].entries[held.id].row.status, 'READY');
  core.createCenterOnlyJob(root, 'fixed', '보필', morning);
  assert.equal(root.jobs.fixed.rows.length, 1);
  // 예약된 행은 같은 키의 재업로드로 연락처·비고를 바꾸지 못한다.
  const changed = [{ ...fixed[0], row: { ...fixed[0].row, memo: '모의 변경' } }];
  core.uploadCenterEntries(root, changed, 'parts', morning);
  assert.notEqual(root['center-queue'].entries[held.id].row.memo, '모의 변경');
});

test('대기열의 보류 항목 제외는 재업로드 중복을 만들지 않고 수정본으로 복원할 수 있다', async () => {
  const { root, prepared } = await fixture();
  const entry = root['center-queue'].entries[prepared[0].id];
  assert.throws(() => core.excludeHeldCenterEntry(root, entry.id, morning), /검증 보류/);
  entry.row = { ...entry.row, status: 'HOLD', reason: '모의 검증 보류' };
  const db = await firebase(root);
  await db.context.excludeHeldCenter(entry.id);
  assert.equal(db.root['center-queue'].entries[entry.id].state, 'EXCLUDED');
  await db.context.saveCenterUpload([entry]);
  assert.equal(db.root['center-queue'].entries[entry.id].state, 'EXCLUDED');
  await db.context.saveCenterUpload([{ ...entry, state: 'WAITING', row: { ...entry.row, status: 'READY', reason: '' } }]);
  assert.equal(db.root['center-queue'].entries[entry.id].state, 'WAITING');
  assert.equal(Object.keys(db.root['center-queue'].entries).length, 1);
});

test('센터 단독 작업은 채널이 같아도 선택한 발주처의 검증 완료 행만 예약한다', async () => {
  const { root, prepared } = await fixture(['BFSH10', 'BFSH10']);
  const other = root['center-queue'].entries[prepared[1].id];
  other.supplier = '가상 같은채널 발주처';
  core.createCenterOnlyJob(root, 'only', '보필', morning);
  assert.equal(root.jobs.only.rows.length, 1);
  assert.equal(other.state, 'WAITING');
});

test('Firebase REST의 null 포함 제출 배열도 UNKNOWN 예약을 유지하며 명확한 사유로 변경을 차단한다', async () => {
  const { root, prepared } = await fixture();
  core.createJobWithCenters(root, 'job', manufacturer(), morning);
  root.jobs.job.submission = { rows: [null, null, { state: 'UNKNOWN' }] };
  const db = await firebase(root);
  await db.context.updateOrderJob('job', { status: 'HOLD' });
  assert.equal(db.root['center-queue'].entries[prepared[0].id].state, 'RESERVED');
  await assert.rejects(db.context.excludeCenterRow('job', prepared[0].id), /제출 이력/);
  await assert.rejects(db.context.deleteOrderJob('job'), /제출 확인/);
});

test('SDK 트랜잭션 재실행 오류는 갱신 콜백 밖에서 보고하고 보류 보고는 읽기 전용으로 남긴다', async () => {
  const { root, prepared } = await fixture();
  core.createJobWithCenters(root, 'job', manufacturer(), morning);
  const worker = await workerHarness(root.jobs, {}, () => assert.fail('외부 실행 금지'), root['center-queue'], { retryTransactions: true });
  await assert.rejects(worker.saveResult('job', { status: 'COMPLETED' }), /실제 제출/);
  assert.equal(worker.callbackErrors.length, 0);
  assert.equal(root.jobs.job.status, 'READY');
  await assert.rejects(worker.saveResult('missing', { status: 'FAILED' }), /작업이 없습니다/);
  assert.equal(worker.callbackErrors.length, 0);
  const report = { details: [{ lineNo: 2, status: 'HOLD', reason: '모의 배송지 검증 보류' }] };
  await worker.saveResult('job', { status: 'HOLD', report });
  assert.equal(root.jobs.job.report, null);
  assert.equal(root.jobs.job.lastReport.details[0].reason, '모의 배송지 검증 보류');
  assert.equal(root['center-queue'].entries[prepared[0].id].state, 'WAITING');
});
