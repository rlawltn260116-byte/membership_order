// 실제 화면 함수·핸들러를 가짜 저장소와 React 상태로 실행한다. 브라우저·운영 DB 접근 없음.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { File } from 'node:buffer';
import ExcelJS from 'exceljs';
import * as policy from '../worker/order-runner/workbook-policy.mjs';
import * as schedule from '../worker/order-runner/schedule.mjs';
import { splitDestination } from '../worker/order-runner/b2b-destination.mjs';
import { submissionContent } from '../worker/order-runner/order-approval.mjs';
import { prepareHttpJob } from '../worker/order-runner/b2b-queue.mjs';

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
  const context = { React, ExcelJS, console, process: { env: {} }, ...policy, ...schedule, splitDestination, submissionContent,
    useState: state, useRef: initial => state(() => ({ current: initial }))[0], useMemo: fn => fn(), useEffect: () => {},
    createOrderJob: async value => { const job = { ...value, id: 'saved' }; saved.push(job); return job; },
    listOrderJobs: async () => saved,
    getOrderJob: async id => saved.find(job => job.id === id),
    updateOrderJob: async (...args) => { writes.push(args); return null; },
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
    .replace('  return (\n    <main', '  globalThis.screenActions = { handleFile, saveJob, queueExecution, openJob, loadJobs };\n  return (\n    <main');
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
