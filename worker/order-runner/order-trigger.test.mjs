// 주문 워커 실행 계기: 예약 없음, 즉시실행기가 보필 작업 하나만 요청, 워커는 그 작업만 처리한다.
// 모의 Firebase·모의 Apps Script만 사용한다. 실제 사이트·GitHub·Firebase 요청은 없다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { dispatcherHarness } from '../../tools/helpers/order-dispatcher-harness.mjs';
import { workerHarness } from '../../tools/helpers/order-worker-harness.mjs';

const workflow = readFileSync(new URL('../../.github/workflows/order-worker.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const code = text => text.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');

test('워크플로에는 예약 실행이 없고 즉시실행기의 작업 ID 요청으로만 큐를 처리한다', () => {
  const trigger = code(workflow.split('\npermissions:\n')[0]);
  assert.equal(/schedule\s*:|cron\s*:/.test(code(workflow)), false, '예약 실행 금지');
  assert.equal(/repository_dispatch|push\s*:|pull_request|workflow_run/.test(trigger), false);
  assert.match(trigger, /^on:\n  workflow_dispatch:\n    inputs:\n      job_id:\n[\s\S]*?        type: string\n        required: false\n        default: ''\n/m);
  // 같은 작업은 물론 모든 실행이 한 번에 하나만 돈다. 진행 중 실행은 취소하지 않는다.
  assert.match(code(workflow), /\nconcurrency:\n  group: membership-order-worker\n  cancel-in-progress: false\n/);
  const queueJob = code(workflow.split('\n  process-queue:\n')[1].split('\n  b2b-http-cart:\n')[0]);
  assert.match(queueJob, /^    if: github\.event_name == 'workflow_dispatch' && inputs\.job_id != ''\n/);
  // 작업 ID는 환경변수로만 전달하고 셸 명령에 끼워 넣지 않는다.
  assert.match(queueJob, /\n          ORDER_JOB_ID: \$\{\{ inputs\.job_id \}\}\n/);
  for (const block of queueJob.split(/\n        run: /).slice(1)) assert.equal(block.split('\n      - name:')[0].includes('inputs.'), false);
  // 보필만 처리하므로 이로움 세션은 필수가 아니고, 설정이 없으면 조용히 건너뛰지 않고 실패한다.
  const check = queueJob.split('- name: Check worker secrets\n')[1].split('\n      - name:')[0];
  assert.equal(check.includes('EROUM_STORAGE_STATE_JSON'), false);
  assert.match(check, /exit 1/);
  // 고정 장바구니 시험 job은 그대로 사람이 입력을 켠 수동 실행에서만 돈다.
  assert.match(workflow, /\n  b2b-http-cart:\n    if: github\.event_name == 'workflow_dispatch' && inputs\.b2b_http_cart == true && vars\.ENABLE_B2B_HTTP_CART == 'true'\n/);
});

test('운영 페이지(브라우저 코드)에는 GitHub 토큰이나 워크플로 실행 요청이 없다', () => {
  const files = [];
  const walk = dir => { for (const name of readdirSync(dir)) { const path = join(dir, name); statSync(path).isDirectory() ? walk(path) : files.push(path); } };
  for (const dir of ['app', 'components', 'hooks', 'lib']) walk(new URL(`../../${dir}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  assert.ok(files.length > 0);
  for (const file of files.filter(path => /\.(ts|tsx|js|mjs)$/.test(path))) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/api\.github\.com|GITHUB_TOKEN|workflow_dispatch|\/dispatches\b/.test(text), false, file);
  }
});

const job = (sourceSystem, status, extra = {}) => ({ sourceSystem, status, rows: [{ sourceSystem }], ...extra });

test('즉시실행기는 보필 대기 작업만 한 번에 하나씩 작업 ID와 함께 요청한다', async () => {
  const jobs = {
    'A0000001eroum': job('이로움', 'QUEUED'),
    'A0000002bofeel': job('보필', 'QUEUED'),
    'A0000003bofeel': job('보필', 'SUBMIT_QUEUED'),
    'A0000004mixed': { status: 'QUEUED', rows: [{ sourceSystem: '보필' }, { sourceSystem: '이로움' }] },
    'A0000004mixedBofeel': { sourceSystem: '보필', status: 'QUEUED', rows: [{ sourceSystem: '보필' }, { sourceSystem: '이로움' }] },
    'A0000004parts': job('보필', 'QUEUED', { orderKind: 'UNASSIGNED_PARTS' }),
    'A0000004empty': { sourceSystem: '보필', status: 'QUEUED', rows: [] },
    'A0000005hold': job('보필', 'HOLD'),
    'A0000006review': job('보필', 'AWAITING_REVIEW'),
    'bad id': job('보필', 'QUEUED'),
  };
  let busy = false;
  const d = await dispatcherHarness({ jobs: () => jobs, busy: () => busy });
  assert.deepEqual(d.pending(), ['A0000002bofeel', 'A0000003bofeel']);
  d.tick();
  assert.deepEqual(d.dispatches, [{ ref: 'main', inputs: { job_id: 'A0000002bofeel' } }]);
  // 실행 중·대기 중인 워커가 있으면 요청하지 않는다.
  busy = true; d.advance(1); d.tick();
  assert.equal(d.dispatches.length, 1);
  // 워커가 끝나면 다음 작업을 요청한다. 방금 요청한 작업은 4분 안에 다시 요청하지 않는다.
  busy = false; d.advance(1); d.tick();
  assert.deepEqual(d.dispatches.at(-1), { ref: 'main', inputs: { job_id: 'A0000003bofeel' } });
  d.advance(1); d.tick();
  assert.equal(d.dispatches.length, 2);
  // 실행이 작업을 가져가면(RUNNING) 다시 요청하지 않는다.
  jobs.A0000002bofeel.status = 'RUNNING'; jobs.A0000003bofeel.status = 'COMPLETED';
  d.advance(10); d.tick();
  assert.equal(d.dispatches.length, 2);
  assert.deepEqual(JSON.parse(d.props.dispatch_log), {});
  assert.equal(d.mails.length, 0);
  // 요청 내용에 다른 입력(장바구니 시험 등)이 없다.
  for (const body of d.dispatches) assert.deepEqual(Object.keys(body.inputs), ['job_id']);
});

test('대기 보필 작업이 없으면 GitHub에 아무 요청도 하지 않는다', async () => {
  const d = await dispatcherHarness({ jobs: () => ({ eroum: job('이로움', 'QUEUED'), done: job('보필', 'COMPLETED') }) });
  d.tick();
  assert.equal(d.dispatches.length, 0);
  assert.equal(d.requests.some(request => request.url.startsWith('https://api.github.com/')), false);
});

test('같은 요청을 세 번 실행 요청해도 처리되지 않으면 멈추고 알리며, 새 요청이면 다시 요청한다', async () => {
  const jobs = { B0000001bofeel: job('보필', 'QUEUED', { dashboardReview: { state: 'QUEUED', updatedAt: '2026-11-17T01:00:00.000Z' } }) };
  const d = await dispatcherHarness({ jobs: () => jobs });
  for (let index = 0; index < 5; index++) { d.tick(); d.advance(5); }
  assert.equal(d.dispatches.length, 3);
  assert.equal(d.mails.length, 1);
  assert.match(d.mails[0].body, /B0000001bofeel/);
  // 감시 주기 사이에 보류→다시 준비 요청(운영 페이지가 새 요청 시각을 씀)해도 새 요청으로 보고 다시 센다.
  jobs.B0000001bofeel.dashboardReview = { state: 'QUEUED', updatedAt: '2026-11-17T01:30:00.000Z' };
  d.tick();
  assert.equal(d.dispatches.length, 4);
  assert.equal(JSON.parse(d.props.dispatch_log).B0000001bofeel.count, 1);
  // 운영 페이지에서 검토 수락→주문 확정으로 SUBMIT_QUEUED가 되면 새 단계로 다시 요청한다.
  jobs.B0000001bofeel.status = 'SUBMIT_QUEUED';
  jobs.B0000001bofeel.dashboardReview = { state: 'FINAL_SUBMISSION_APPROVED', submissionRequestId: 'req-1', updatedAt: '2026-11-17T02:00:00.000Z' };
  d.tick();
  assert.equal(d.dispatches.length, 5);
  assert.equal(JSON.parse(d.props.dispatch_log).B0000001bofeel.count, 1);
});

test('최근 작업 30건 뒤로 밀린 오래된 대기 작업도 상태 인덱스로 찾아 먼저 요청한다', async () => {
  const jobs = { H0000000old: job('보필', 'QUEUED') };
  for (let index = 1; index <= 40; index++) jobs[`H${String(index).padStart(7, '0')}done`] = job('보필', 'COMPLETED');
  jobs.H9999999new = job('보필', 'QUEUED');
  const d = await dispatcherHarness({ jobs: () => jobs });
  d.tick();
  assert.deepEqual(d.dispatches, [{ ref: 'main', inputs: { job_id: 'H0000000old' } }]);
  assert.equal(d.mails.length, 0);
  assert.ok(d.requests.every(request => !request.url.includes('limitToLast')), '인덱스가 있으면 건수 제한 조회를 쓰지 않음');
  // 인덱스가 없으면 최근 30건만 보고, 놓칠 수 있음을 하루 한 번 알린다.
  const fallback = await dispatcherHarness({ jobs: () => jobs, indexed: false });
  fallback.tick(); fallback.advance(1); fallback.tick();
  assert.deepEqual(fallback.dispatches.map(body => body.inputs.job_id), ['H9999999new']);
  assert.equal(fallback.mails.length, 1);
  assert.match(fallback.mails[0].body, /indexOn/);
});

test('실행 요청이 실패하면 기록하지 않고 하루 한 번 알린다', async () => {
  const d = await dispatcherHarness({ jobs: () => ({ C0000001bofeel: job('보필', 'QUEUED') }), dispatchStatus: 422 });
  d.tick(); d.advance(1); d.tick();
  assert.equal(d.dispatches.length, 2);
  assert.equal(d.mails.length, 1);
  assert.match(d.mails[0].body, /HTTP 422/);
  assert.equal(d.props.dispatch_log ?? '{}', '{}');
});

const holdPrepare = () => async job => ({ canSubmit: false, details: (job.rows ?? []).map((row, index) => ({ lineNo: row.lineNo ?? index + 1, status: 'HOLD', reason: '모의 보류' })) });
const queued = (sourceSystem) => ({ sourceSystem, status: 'QUEUED', selectedSheet: '발주', filename: `20261117_${sourceSystem}_모의.xlsx`,
  sourceWorkbook: { filename: `20261117_${sourceSystem}_모의.xlsx`, sheets: [{ name: '발주', state: 'visible' }] },
  rows: [{ lineNo: 2, sourceSheet: '발주', sourceSystem, productName: 'BFSH10', quantity: 1, status: 'READY' }] });

test('워커는 ORDER_JOB_ID로 받은 보필 작업 하나만 선점하고 다른 대기 작업은 건드리지 않는다', async () => {
  const jobs = { D0000001bofeel: queued('보필'), D0000002bofeel: queued('보필'), D0000003eroum: queued('이로움') };
  const before = structuredClone(jobs);
  let calls = 0;
  const worker = await workerHarness(jobs, { ORDER_JOB_ID: 'D0000002bofeel' }, async source => { calls++; assert.equal(source.id, 'D0000002bofeel'); return holdPrepare()(source); });
  await worker.run();
  assert.equal(calls, 1);
  assert.equal(worker.jobs.D0000002bofeel.status, 'HOLD');
  assert.equal(worker.jobs.D0000002bofeel.report.transport, 'HTTP');
  assert.deepEqual(worker.jobs.D0000001bofeel, before.D0000001bofeel);
  assert.deepEqual(worker.jobs.D0000003eroum, before.D0000003eroum);
  assert.deepEqual(worker.callbackErrors, []);
});

test('워커는 요청 작업이 보필이 아니거나 대기 상태가 아니면 아무것도 하지 않는다', async () => {
  for (const [target, mutate] of [['E0000001eroum', null], ['E0000002bofeel', jobs => { jobs.E0000002bofeel.status = 'AWAITING_REVIEW'; }], ['E0000009none', null]]) {
    const jobs = { E0000001eroum: queued('이로움'), E0000002bofeel: queued('보필') };
    mutate?.(jobs);
    const before = structuredClone(jobs);
    const worker = await workerHarness(jobs, { ORDER_JOB_ID: target }, () => assert.fail('외부 준비 금지'));
    await worker.run();
    assert.deepEqual(worker.jobs, before, target);
  }
});

test('워커는 형식이 잘못되거나 비어 있거나 공백인 ORDER_JOB_ID를 거부하고 아무 작업도 바꾸지 않는다', async () => {
  for (const value of ['../F0000001bofeel', '', '   ', '\n', ' F0000001bofeel', 'F0000001bofeel\n']) {
    const jobs = { F0000001bofeel: queued('보필'), F0000002eroum: queued('이로움') };
    const before = structuredClone(jobs);
    const worker = await workerHarness(jobs, { ORDER_JOB_ID: value }, () => assert.fail('외부 준비 금지'));
    await assert.rejects(worker.run(), /ORDER_JOB_ID 형식/, JSON.stringify(value));
    assert.deepEqual(worker.jobs, before, JSON.stringify(value));
  }
});

test('워커는 작업 업체가 보필이어도 이로움 행이 섞이거나 부품 작업이면 선점하지 않는다', async () => {
  const mixed = queued('보필');
  mixed.rows.push({ ...mixed.rows[0], lineNo: 3, sourceSystem: '이로움' });
  const parts = { ...queued('보필'), orderKind: 'UNASSIGNED_PARTS' };
  for (const [id, target] of [['M0000001mixed', mixed], ['M0000002parts', parts]]) {
    const jobs = { [id]: target };
    const before = structuredClone(jobs);
    const worker = await workerHarness(jobs, { ORDER_JOB_ID: id }, () => assert.fail('외부 준비 금지'));
    await worker.run();
    assert.deepEqual(worker.jobs, before, id);
  }
});

test('요청받은 보필 제출(SUBMIT_QUEUED)도 승인 증명 없이는 제출하지 않는다', async () => {
  const jobs = { G0000001bofeel: { ...queued('보필'), status: 'SUBMIT_QUEUED', dashboardReview: { decision: 'ACCEPTED' } } };
  const env = { ORDER_JOB_ID: 'G0000001bofeel', FINAL_SUBMISSION_APPROVAL_KEY: 'mock-approval-key-12345', ENABLE_B2B_HTTP_CART: 'true', ENABLE_B2B_HTTP_SUBMIT: 'true', B2B_HTTP_SUBMIT_VENDORS: 'bofeel' };
  const worker = await workerHarness(jobs, env, () => assert.fail('승인 없는 제출 준비 금지'));
  await worker.run();
  assert.equal(worker.jobs.G0000001bofeel.status, 'HOLD');
  assert.match(worker.jobs.G0000001bofeel.report.details[0].reason, /최종 승인 코드/);
  assert.deepEqual(worker.ledger, []);
});
