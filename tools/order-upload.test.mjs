// 실제 화면 함수·핸들러를 가짜 저장소와 React 상태로 실행한다. 브라우저·운영 DB 접근 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { File } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import * as policy from '../worker/order-runner/workbook-policy.mjs';
import * as schedule from '../worker/order-runner/schedule.mjs';
import { splitDestination } from '../worker/order-runner/b2b-destination.mjs';
import { submissionContent } from '../worker/order-runner/order-approval.mjs';
import { prepareHttpJob, runQueueVendor } from '../worker/order-runner/b2b-queue.mjs';
import { workerHarness } from './helpers/order-worker-harness.mjs';

async function screen() {
  const source = await readFile('app/order-ops-app.tsx', 'utf8');
  const ast = ts.createSourceFile('screen.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let cursor = 0;
  const slots = [], saved = [], writes = [];
  const state = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const context = { React, ExcelJS, console, window: { crypto: webcrypto }, TextEncoder, process: { env: {} }, ...policy, ...schedule, splitDestination, submissionContent,
    useState: state, useRef: initial => state(() => ({ current: initial }))[0], useMemo: fn => fn(), useEffect: () => {},
    createOrderJob: async value => { const job = { ...value, id: 'saved' }; saved.push(job); return job; },
    listOrderJobs: async () => saved,
    getOrderJob: async id => saved.find(job => job.id === id),
    updateOrderJob: async (...args) => { writes.push(args); Object.assign(saved.find(job => job.id === args[0]), args[1]); return null; },
    fetch: () => assert.fail('실제 사이트·Firebase 요청 금지') };
  for (const node of ast.statements.filter(ts.isImportDeclaration)) {
    const bindings = node.importClause?.namedBindings;
    if (node.importClause?.name && !(node.importClause.name.text in context)) context[node.importClause.name.text] = () => null;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (!(binding.name.text in context)) context[binding.name.text] = () => null;
    }
  }
  for (const [name, tag] of Object.entries({ Table: 'table', TableBody: 'tbody', TableHeader: 'thead', TableRow: 'tr', TableCell: 'td', TableHead: 'th', Badge: 'span', Button: 'button' })) {
    context[name] = ({ children }) => React.createElement(tag, null, children);
  }
  let snippet = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replaceAll('\r\n', '\n');
  snippet = snippet.replace('export default function OrderOpsApp', 'function OrderOpsApp')
    .replace('const ExcelJS = (await import("exceljs")).default;', '')
    .replace('  return (\n    <main', '  globalThis.screenActions = { handleFile, saveJob, queueExecution, openJob, loadJobs, reviewWorkerResult, queueFinalSubmission };\n  return (\n    <main');
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
  const render = () => { cursor = 0; return context.OrderOpsApp(); };
  const elements = tree => {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(elements);
    return [tree, ...elements(tree.props?.children)];
  };
  const text = element => elements(element).flatMap(value => React.Children.toArray(value.props?.children).filter(child => typeof child === 'string')).join('');
  const button = (tree, label) => elements(tree).find(element => element.type === context.Button && text(element).includes(label));
  const picker = tree => elements(tree).find(element => element.type === context.WorkbookSheetPicker);
  return { context, render, saved, writes, button, picker };
}

async function file(sheets) {
  const book = new ExcelJS.Workbook();
  for (const [name, state = 'visible', quantity = 1] of sheets) {
    book.addWorksheet(name, { state }).addRows([
      ['주문번호', '납품처', '납품처전화번호', '품명', '주문수량', '비고(내역)'],
      ['TEST', '가상시 모의로 1_모의인', '01000000000', 'BFSH10', quantity, '모의 비고']]);
  }
  return new File([await book.xlsx.writeBuffer()], '20261112_직배(보필) 모의.xlsx');
}

test('실제 업로드 핸들러는 두 시트 선택 전 저장을 막고 선택한 두 번째 시트만 저장한다', async () => {
  const app = await screen(); app.render();
  await app.context.screenActions.handleFile(await file([['원본'], ['추가', 'visible', 9], ['숨김', 'hidden']]));
  let tree = app.render();
  assert.equal(app.button(tree, '클라우드 저장').props.disabled, true);
  await app.context.screenActions.saveJob();
  assert.equal(app.saved.length, 0);
  const picker = app.picker(tree);
  assert.equal(picker.props.selectedSheet, '');
  assert.equal(picker.props.source.sheets.length, 3);
  picker.props.onSelect('추가');
  tree = app.render();
  assert.equal(app.button(tree, '클라우드 저장').props.disabled, false);
  await app.context.screenActions.saveJob();
  assert.equal(app.saved.length, 1);
  assert.equal(app.saved[0].selectedSheet, '추가');
  assert.equal(app.saved[0].rows.length, 1);
  assert.equal(app.saved[0].rows[0].sourceSheet, '추가');
  assert.equal(app.saved[0].rows[0].quantity, '9');
  assert.equal(app.saved[0].rows[0].memo, '모의 비고');
  assert.equal(app.writes.length, 0);
});

test('실제 핸들러는 단일 보이는 시트를 자동 선택하고 다시 미선택하면 기존 행·저장 가능 상태를 비운다', async () => {
  const app = await screen(); app.render();
  await app.context.screenActions.handleFile(await file([['숨김', 'hidden'], ['발주']]));
  let tree = app.render();
  assert.equal(app.picker(tree).props.selectedSheet, '발주');
  assert.equal(app.button(tree, '클라우드 저장').props.disabled, false);
  app.picker(tree).props.onSelect('');
  tree = app.render();
  assert.equal(app.button(tree, '클라우드 저장').props.disabled, true);
  await app.context.screenActions.saveJob();
  assert.equal(app.saved.length, 0);
});

test('시트 정보 없는 기존 작업은 화면 준비 버튼과 핸들러에서 모두 막는다', async () => {
  const app = await screen(); app.render();
  await app.context.screenActions.handleFile(await file([['발주']])); app.render();
  app.saved.push({ id: 'legacy', filename: '20261112_모의.xlsx', sourceSystem: '보필', status: 'READY',
    rows: [], totalRows: 0, readyRows: 0, holdRows: 0, failedRows: 0 });
  await app.context.screenActions.openJob('legacy');
  const tree = app.render();
  assert.equal(app.button(tree, '서버 준비 요청').props.disabled, true);
  await app.context.screenActions.queueExecution();
  assert.equal(app.writes.length, 0);
});

test('우편번호의 애매한 복수 결과 사유와 특이사항을 실제 운영 결과 패널에 표시한다', async () => {
  const app = await screen();
  const filename = '20261112_모의.xlsx';
  const item = { roadAddress: '서울 모의구 가상로 1', groundAddress: '서울 모의구 가상동 1', zoneCode: '00000' };
  const job = { filename, selectedSheet: '발주', sourceSystem: '보필', status: 'HOLD',
    sourceWorkbook: { filename, sheets: [{ name: '발주', state: 'visible' }] }, rows: [{
      lineNo: 2, sourceSheet: '발주', sourceSystem: '보필', productName: 'BFSH10', quantity: 1,
      recipientName: '모의인', recipientPhone: '01000000000', address: item.roadAddress, zipcode: '',
      postcodeSearchResponse: { resultData: { codeData: { code: '0' }, addressData: [item, item] } } }] };
  const result = await prepareHttpJob(job, { runVendor: async () => assert.fail('사이트 접근 금지') });
  job.report = { ...result, totalRows: 1, successRows: 0, failedRows: 0, holdRows: 1, finishedAt: new Date().toISOString(), transport: 'HTTP' };
  const html = renderToStaticMarkup(React.createElement(app.context.WorkerReviewPanel, { job, loading: false, onDecision: () => {}, onFinalSubmit: () => assert.fail('제출 금지') }));
  assert.match(html, /특이사항: 우편번호 보류/);
  assert.match(html, /일치하는 결과가 2건 이상/);
  assert.match(html, /보류/);
});

test('보필 1주문은 실제 화면 준비→검토 수락→내용 승인→모의 HTTP 제출→원장·주문번호 기록을 끝까지 거친다', async () => {
  const app = await screen(); app.render();
  const filename = '20261113_보필_모의.xlsx';
  const id = 'bofeel-e2e';
  app.saved.push({ id, filename, selectedSheet: '발주', sourceSystem: '보필', status: 'READY',
    totalRows: 1, readyRows: 1, failedRows: 0, holdRows: 0,
    sourceWorkbook: { filename, sheets: [{ name: '발주', state: 'visible' }] }, rows: [{
      lineNo: 2, sourceSheet: '발주', sourceSystem: '보필', productName: 'BFSH10', quantity: 2, expectedPrice: '10',
      recipientName: '모의인', recipientPhone: '01000000000', address: '서울 모의구 가상로 1', zipcode: '', memo: '모의 비고', status: 'READY' }] });
  const key = 'mock-approval-key-12345';
  const runtime = 'C:/Users/woori/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
    B2B_HTTP_PYTHON: process.env.B2B_HTTP_TEST_PYTHON || (existsSync(runtime) ? runtime : 'python3'),
    ENABLE_B2B_HTTP_CART: 'true', ENABLE_B2B_HTTP_SUBMIT: 'true', B2B_HTTP_SUBMIT_VENDORS: 'bofeel',
    BOFEEL_LOGIN_ID: 'mock-user', BOFEEL_LOGIN_PASSWORD: 'mock-password',
    FINAL_SUBMISSION_APPROVAL_KEY: key, B2B_SUBMISSION_LEDGER_KEY: 'mock-ledger-key-'.repeat(4),
    GITHUB_TOKEN: 'mock-token', GITHUB_REPOSITORY: 'mock/repo' };
  let lookups = 0, posts = 0;
  const runVendor = (vendor, groups, options) => runQueueVendor(vendor, groups, { ...options, timeoutMs: 10_000,
    spawn: (command, args, childOptions) => {
      assert.equal(vendor, 'bofeel');
      const fixture = new URL('../worker/order-runner/test_helpers/bofeel_queue_mock.py', import.meta.url);
      const child = spawn(command, ['-B', '-X', 'utf8', fileURLToPath(fixture)], childOptions);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        if (JSON.parse(chunk).submit === true) posts++;
        return write(chunk, ...rest);
      };
      return child;
    } });
  // 워커가 전달하는 실제 원장·행 잠금·저장 콜백까지 그대로 연결한다.
  const worker = await workerHarness({ [id]: app.saved[0] }, env, (job, callbacks) =>
    prepareHttpJob(job, { env, runVendor, ...callbacks, lookupPostcodes: async keywords => {
      lookups++; assert.deepEqual(keywords, ['서울 모의구 가상로 1']);
      return [{ resultData: { codeData: { code: '0' }, addressData: [{
        roadAddress: '서울 모의구 가상로 1', groundAddress: '서울 모의구 가상동 1', zoneCode: '00000' }] } }];
    } }));
  await app.context.screenActions.openJob(id); app.render();
  await app.context.screenActions.queueExecution();
  assert.equal(app.saved[0].status, 'QUEUED');
  await worker.run(); app.saved[0] = worker.jobs[id];
  assert.equal(worker.jobs[id].status, 'AWAITING_REVIEW', JSON.stringify(worker.jobs[id].report));
  assert.equal(posts, 0); assert.equal(lookups, 1); assert.deepEqual(worker.ledger, []);
  const prepareReport = structuredClone(worker.jobs[id].report);
  assert.equal(prepareReport.canSubmit, true);
  assert.match(prepareReport.details[0].postcodeDecision, /확정: 00000/);
  assert.equal(worker.jobs[id].rows[0].postcodeSearchResponse.resultData.addressData[0].zoneCode, '00000');
  await app.context.screenActions.openJob(id); app.render();
  const panel = job => renderToStaticMarkup(React.createElement(app.context.WorkerReviewPanel, { job, loading: false, onDecision: () => {}, onFinalSubmit: () => {} }));
  assert.match(panel(app.saved[0]), /배송지 묶음 1/);
  assert.match(panel(app.saved[0]), /BFSH10/);
  await app.context.screenActions.queueFinalSubmission(key);
  assert.equal(app.saved[0].status, 'AWAITING_REVIEW');
  await app.context.screenActions.reviewWorkerResult('ACCEPTED'); app.render();
  assert.equal(app.saved[0].status, 'REVIEWED');
  // 승인 버튼이 실제 패널의 대상 조건을 통과한다.
  assert.match(panel(app.saved[0]), /실제 주문 확정/);
  await app.context.screenActions.queueFinalSubmission(key);
  assert.equal(app.saved[0].status, 'SUBMIT_QUEUED');
  assert.equal(app.saved[0].dashboardReview.reviewedFromStatus, 'REVIEWED');
  assert.match(app.saved[0].dashboardReview.contentApprovalProof, /^[a-f0-9]{64}$/);
  await worker.run(); app.saved[0] = worker.jobs[id];
  assert.equal(app.saved[0].status, 'COMPLETED');
  assert.equal(app.saved[0].submission.rows[2].state, 'SUBMITTED');
  assert.equal(app.saved[0].report.details[0].orderNumber, '20261111000001');
  assert.match(panel(app.saved[0]), /주문번호 20261111000001/);
  assert.equal(worker.ledger.length, 2); assert.equal(posts, 1); assert.equal(lookups, 1);
  await worker.run(); assert.equal(posts, 1);

  // 새 작업 ID와 새 승인 증명도 같은 원본 행의 원장을 우회할 수 없다.
  const duplicate = { ...structuredClone(app.saved[0]), id: 'duplicate', status: 'REVIEWED', executionMode: 'PREPARE',
    report: prepareReport, submission: {}, dashboardReview: { decision: 'ACCEPTED', state: 'ACCEPTED' } };
  app.saved.push(duplicate); worker.jobs.duplicate = duplicate;
  await app.context.screenActions.openJob('duplicate'); app.render();
  await app.context.screenActions.queueFinalSubmission(key);
  await worker.run();
  assert.equal(worker.jobs.duplicate.status, 'HOLD');
  assert.match(worker.jobs.duplicate.report.details[0].reason, /원장/);
  assert.equal(posts, 1);

  const locked = { ...structuredClone(duplicate), id: 'locked', status: 'REVIEWED', executionMode: 'PREPARE', report: prepareReport,
    rows: duplicate.rows.map(row => ({ ...row, lineNo: 3 })), submission: { rows: { 3: { state: 'SUBMITTING' } } },
    dashboardReview: { decision: 'ACCEPTED', state: 'ACCEPTED' } };
  app.saved.push(locked); worker.jobs.locked = locked;
  await app.context.screenActions.openJob('locked'); app.render();
  await app.context.screenActions.queueFinalSubmission(key);
  await worker.run();
  assert.equal(worker.jobs.locked.status, 'HOLD');
  assert.match(worker.jobs.locked.report.details[0].reason, /잠금/);
  assert.equal(posts, 1);
});

test('보필의 UNKNOWN과 워커 실패 결과는 예외 처리 메뉴와 상세에 표시된다', async () => {
  const app = await screen();
  const job = { id: 'unknown', filename: '모의.xlsx', sourceSystem: '보필', status: 'HOLD', failedRows: 0, holdRows: 0,
    report: { totalRows: 1, successRows: 0, failedRows: 0, holdRows: 1, finishedAt: new Date().toISOString(), transport: 'HTTP',
      details: [{ lineNo: 2, status: 'HOLD', reason: '제출 결과가 불명확합니다.', submissionState: 'UNKNOWN' }] } };
  const html = renderToStaticMarkup(React.createElement(app.context.ExceptionsPage, { jobs: [job], onOpenJob: () => {} }));
  assert.match(html, /모의.xlsx/); assert.match(html, /UNKNOWN/); assert.match(html, /보류 1건/);
  const detail = renderToStaticMarkup(React.createElement(app.context.WorkerReviewPanel, { job, loading: false, onDecision: () => {}, onFinalSubmit: () => {} }));
  assert.match(detail, /UNKNOWN/); assert.match(detail, /재시도 금지/);
  const failed = renderToStaticMarkup(React.createElement(app.context.ExceptionsPage, { jobs: [{ ...job, status: 'FAILED', report: undefined }], onOpenJob: () => {} }));
  assert.match(failed, /모의.xlsx/);
});

test('제출 응답 유실·시간 초과·비정상 종료는 실제 워커 저장부터 상세·예외 화면까지 UNKNOWN을 유지한다', async () => {
  for (const mode of ['timeout', 'close', 'stdin-error', 'malformed', 'before-submit']) {
    const app = await screen(); app.render();
    const filename = '20261113_보필_모의.xlsx', key = 'mock-approval-key-12345', id = 'unknown-' + mode;
    const report = { totalRows: 1, successRows: 1, failedRows: 0, holdRows: 0, canSubmit: true, transport: 'HTTP',
      finishedAt: new Date().toISOString(), details: [{ lineNo: 2, status: 'READY', reason: '모의 준비' }] };
    const job = { id, filename, selectedSheet: '발주', sourceSystem: '보필', status: 'REVIEWED', executionMode: 'PREPARE',
      totalRows: 1, readyRows: 1, failedRows: 0, holdRows: 0, report, dashboardReview: { decision: 'ACCEPTED', state: 'ACCEPTED' },
      sourceWorkbook: { filename, sheets: [{ name: '발주', state: 'visible' }] }, rows: [{
        lineNo: 2, sourceSheet: '발주', sourceSystem: '보필', productName: 'BFSH10', quantity: 1, zipcode: '00000',
        recipientName: '모의인', recipientPhone: '01000000000', address: '서울 모의구 가상로 1', memo: '', status: 'READY' }] };
    app.saved.push(job);
    const env = { ENABLE_B2B_HTTP_CART: 'true', ENABLE_B2B_HTTP_SUBMIT: 'true', B2B_HTTP_SUBMIT_VENDORS: 'bofeel',
      BOFEEL_LOGIN_ID: 'mock-user', BOFEEL_LOGIN_PASSWORD: 'mock-password', FINAL_SUBMISSION_APPROVAL_KEY: key,
      B2B_SUBMISSION_LEDGER_KEY: 'mock-ledger-key-'.repeat(4), GITHUB_TOKEN: 'mock-token', GITHUB_REPOSITORY: 'mock/repo' };
    let sends = 0;
    const spawn = () => {
      const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, encoding, done) {
        const command = JSON.parse(chunk);
        queueMicrotask(() => {
          if (command.groups) {
            if (mode === 'before-submit') return child.emit('close', 1);
            const rows = command.groups.flatMap(group => group.rows);
            child.stdout.write(JSON.stringify({ event: 'prepared', submissionReady: true, cartVerified: true,
              sourceKeys: rows.map(row => row.sourceKey), details: rows.map(row => ({ lineNo: row.lineNo, status: 'READY', reason: '모의 준비' })) }) + '\n');
          } else if (command.submit) {
            sends++;
            if (mode === 'close') child.emit('close', 1);
            if (mode === 'stdin-error') child.stdin.emit('error', new Error('모의 파이프 유실'));
            if (mode === 'malformed') child.stdout.write('모의 불명 응답\n');
          }
        }); done();
      } });
      child.stdin.on('finish', () => queueMicrotask(() => child.emit('close', 0)));
      child.kill = () => child.emit('close', 1);
      return child;
    };
    const worker = await workerHarness({ [id]: job }, env, (source, callbacks) => prepareHttpJob(source, { env, ...callbacks,
      runVendor: (vendor, groups, options) => runQueueVendor(vendor, groups, { ...options, spawn, timeoutMs: 20 }) }));
    await app.context.screenActions.openJob(id); app.render();
    await app.context.screenActions.queueFinalSubmission(key);
    await worker.run();
    const result = worker.jobs[id];
    assert.equal(result.status, 'HOLD', mode);
    assert.equal(result.report.canSubmit, false);
    assert.equal(sends, mode === 'before-submit' ? 0 : 1);
    const detailHtml = renderToStaticMarkup(React.createElement(app.context.WorkerReviewPanel, { job: result, loading: false, onDecision: () => {}, onFinalSubmit: () => {} }));
    const exceptionHtml = renderToStaticMarkup(React.createElement(app.context.ExceptionsPage, { jobs: [result], onOpenJob: () => {} }));
    if (mode === 'before-submit') {
      assert.equal(result.submission, undefined);
      assert.equal(result.report.details[0].submissionState, 'HOLD');
      assert.doesNotMatch(detailHtml, /UNKNOWN/);
    } else {
      assert.equal(result.submission.rows[2].state, 'UNKNOWN', mode);
      assert.equal(result.report.details[0].submissionState, 'UNKNOWN', mode);
      assert.match(result.report.details[0].reason, /재시도하지/);
      assert.match(detailHtml, /UNKNOWN/); assert.match(detailHtml, /재시도 금지/);
      assert.match(exceptionHtml, /UNKNOWN: 주문내역 확인 필요/);
    }
    await worker.run();
    assert.equal(sends, mode === 'before-submit' ? 0 : 1);
  }
});
