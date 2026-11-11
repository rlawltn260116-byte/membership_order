import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { inspectWorkbook, selectWorksheet, worksheetMatrix, workbookProblem, duplicateOrderFiles } from '../worker/order-runner/workbook-policy.mjs';
import { planOrders } from '../worker/order-runner/b2b-orders.mjs';
import { prepareHttpJob } from '../worker/order-runner/b2b-queue.mjs';
import { readAmaranthWorkbook } from './parse_amaranth_orders.mjs';

const filename = '20261112_직배(보필) 모의 발주서.xlsx';
const headers = ['주문번호', '납품처', '납품처전화번호', '품명', '주문수량', '비고(내역)'];
async function fixture(sheets) {
  const book = new ExcelJS.Workbook();
  for (const [name, state = 'visible', quantity = 1] of sheets) {
    const sheet = book.addWorksheet(name, { state });
    sheet.addRows([headers, ['TEST', '가상시 모의로 1_모의인', '01000000000', 'BFSH10', quantity, '']]);
  }
  const loaded = new ExcelJS.Workbook();
  await loaded.xlsx.load(await book.xlsx.writeBuffer());
  return loaded;
}
function job(book, selectedSheet, rowsSheet = selectedSheet) {
  return { filename, sourceSystem: '보필', selectedSheet, sourceWorkbook: inspectWorkbook(book, filename), rows: [{
    lineNo: 2, sourceSheet: rowsSheet, productName: 'BFSH10', quantity: 1, recipientName: '모의인',
    recipientPhone: '01000000000', zipcode: '00000', address: '가상시 모의로 1', status: 'READY', memo: '' }] };
}

test('가짜 단일 시트는 자동 선택하고 파일에서 읽은 이름·행·머리글을 기록한다', async () => {
  const book = await fixture([['발주']]);
  assert.equal(selectWorksheet(book).name, '발주');
  assert.deepEqual(inspectWorkbook(book, filename).sheets[0], { name: '발주', state: 'visible', rowCount: 2, headers });
  assert.equal(workbookProblem(job(book, '발주')), null);
  assert.equal(planOrders(job(book, '발주')).groups.length, 1);
});

test('내용이 다른 두 시트는 자동 선택하지 않고 두 번째 시트만 읽을 수 있다', async () => {
  const book = await fixture([['원본', 'visible', 1], ['추가본', 'visible', 9]]);
  assert.throws(() => selectWorksheet(book), /사람/);
  assert.equal(worksheetMatrix(selectWorksheet(book, '추가본'))[1][4], '9');
  const source = job(book, undefined);
  const result = await prepareHttpJob(source, { runVendor: async () => assert.fail('사이트 접근 금지') });
  assert.equal(result.details[0].status, 'HOLD');
  assert.match(result.details[0].reason, /시트가 선택되지/);
  assert.equal(planOrders(job(book, '추가본')).groups.length, 1);
});

test('숨김·매우 숨김 시트는 후보에서 빼며 첫 시트가 숨김이어도 보이는 단일 시트를 읽는다', async () => {
  const book = await fixture([['숨김', 'hidden'], ['발주'], ['매우숨김', 'veryHidden']]);
  assert.equal(selectWorksheet(book).name, '발주');
  for (const name of ['숨김', '매우숨김', '없는시트']) {
    assert.throws(() => selectWorksheet(book, name), /없거나 숨김/);
    assert.equal(planOrders(job(book, name)).groups.length, 0);
  }
  assert.throws(() => selectWorksheet({ worksheets: [{ name: '숨김', state: 'hidden' }] }), /보이는 시트가 없습니다/);
});

test('선택 이름·행 출처·파일명 불일치와 예전 시트 정보 없는 작업은 사이트 접근 전에 전부 HOLD다', async () => {
  const book = await fixture([['원본'], ['수정본']]);
  const valid = job(book, '수정본');
  for (const source of [job(book, '없음'), job(book, '수정본', '원본'), { ...valid, selectedSheet: '' },
    { ...valid, sourceWorkbook: undefined }, { ...valid, filename: '다른파일.xlsx' }]) {
    const result = await prepareHttpJob(source, { runVendor: async () => assert.fail('사이트 접근 금지') });
    assert.equal(result.details[0].status, 'HOLD');
    assert.equal(result.canSubmit, false);
  }
});

test('아마란스 원본 파서도 다중 시트·숨김 시트를 임의로 읽지 않는다', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'order-sheet-'));
  try {
    const file = join(dir, '모의.xlsx'), book = new ExcelJS.Workbook();
    const cols = ['주문일자', '주문번호', '순번', '소분류', '주문수량', '미납수량', '비고(건)', '비고(내역)', '납품처'];
    book.addWorksheet('숨김', { state: 'hidden' }).addRow(cols);
    for (const name of ['원본', '추가']) book.addWorksheet(name).addRows([cols, ['2026-11-12', name]]);
    await book.xlsx.writeFile(file);
    await assert.rejects(readAmaranthWorkbook(file), /사람/);
    await assert.rejects(readAmaranthWorkbook(file, '숨김'), /숨김/);
    assert.equal((await readAmaranthWorkbook(file, '추가'))[0]['주문번호'], '추가');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('같은 날짜·업체의 수정본·추가본은 경고 대상이고 다른 날짜·업체는 제외한다', () => {
  const candidate = { filename, sourceSystem: '보필' };
  const jobs = [{ id: 'a', filename: '20261112_수정본.xlsx', sourceSystem: '보필' },
    { id: 'b', filename: '20261112_추가본.xlsx', sourceSystem: '보필' },
    { id: 'c', filename: '20261111_원본.xlsx', sourceSystem: '보필' },
    { id: 'd', filename: '20261112_원본.xlsx', sourceSystem: 'THKC' }];
  assert.deepEqual(duplicateOrderFiles(candidate, jobs).map(job => job.id), ['a', 'b']);
  assert.deepEqual(duplicateOrderFiles({ filename, sourceSystem: '이로움' }, jobs).map(job => job.id), ['d']);
  assert.deepEqual(duplicateOrderFiles({ ...jobs[0] }, jobs).map(job => job.id), ['b']);
  assert.deepEqual(duplicateOrderFiles({ filename }, jobs).map(job => job.id), ['a', 'b']);
  assert.deepEqual(duplicateOrderFiles({ filename: '보필 발주내역_261112.xlsx' }, jobs).map(job => job.id), ['a', 'b']);
});

test('시트 선택 화면은 이름·행·머리글·숨김 안내를 렌더하고 숨김 선택지를 만들지 않는다', async () => {
  const source = await readFile('app/workbook-sheet-picker.tsx', 'utf8');
  const ast = ts.createSourceFile('picker.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node));
  const snippet = fn.getText(ast).replace('export default ', '');
  const js = ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const context = vm.createContext({ React });
  vm.runInContext(js, context);
  const book = await fixture([['원본'], ['추가본'], ['비공개', 'hidden']]);
  const html = renderToStaticMarkup(React.createElement(context.WorkbookSheetPicker, {
    source: inspectWorkbook(book, filename), selectedSheet: '', onSelect: () => assert.fail('선택 동작 없음') }));
  assert.match(html, /숨김 시트 1개/);
  assert.match(html, /사용 행 2개/);
  assert.match(html, /머리글: 주문번호/);
  assert.match(html, /선택 전에는 저장·서버 준비 요청/);
  assert.match(html, /value="추가본"/);
  assert.doesNotMatch(html, /value="비공개"/);
});
