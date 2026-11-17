// 실제 센터 화면의 파일·시트·저장 핸들러를 모의 React/Firebase로 실행한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { File } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import * as core from '../worker/order-runner/center-queue.mjs';
import * as policy from '../worker/order-runner/workbook-policy.mjs';

async function screen() {
  const source = await readFile('app/center-order-queue.tsx', 'utf8');
  const ast = ts.createSourceFile('center.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let cursor = 0, saved = 0;
  let root = {};
  const slots = [];
  const useState = initial => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  };
  const context = vm.createContext({ React, ExcelJS, crypto: webcrypto, ...core, ...policy, useState,
    useEffect: () => {}, useRef: initial => useState(() => ({ current: initial }))[0],
    Button: ({ children, ...props }) => React.createElement('button', props, children), WorkbookSheetPicker: () => null,
    listCenterQueue: async () => structuredClone(root['center-queue'] || {}),
    saveCenterUpload: async entries => { saved++; root = core.uploadCenterEntries(structuredClone(root), entries, 'parts', '2026-11-17T00:00:00Z'); },
    makeCenterOnlyJob: async (supplier, scheduleKey) => { root = core.createCenterOnlyJob(structuredClone(root), 'only', supplier, '2026-11-17T00:00:00Z', scheduleKey); return 'only'; },
    excludeHeldCenter: async id => { root = core.excludeHeldCenterEntry(structuredClone(root), id, '2026-11-17T00:00:00Z'); },
    fetch: () => assert.fail('실제 요청 금지'),
  });
  let snippet = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n');
  snippet = snippet.replace('export default function', 'function')
    .replace("const ExcelJS = (await import('exceljs')).default;", 'const ExcelJS = globalThis.ExcelJS;')
    .replace('  const root = { jobs:', '  globalThis.actions = { loadFiles, save, refresh, makeJob, excludeHeld, uploads, busy, setNow };\n  const root = { jobs:');
  vm.runInContext(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText, context);
  const opened = [];
  const render = () => { cursor = 0; return context.CenterOrderQueue({ jobs: Object.values(root.jobs || {}), onOpenJob: id => opened.push(id), onChanged: async () => {} }); };
  const elements = tree => Array.isArray(tree) ? tree.flatMap(elements) : !tree || typeof tree !== 'object' ? [] : [tree, ...elements(tree.props?.children)];
  return { context, render, elements, opened, get saved() { return saved; }, get root() { return root; } };
}
async function file(filename, sheets = ['발주'], phone = '01000000000', products = ['BFSH10']) {
  const book = new ExcelJS.Workbook();
  for (const name of sheets) book.addWorksheet(name).addRows([
    ['주문번호', '납품처', '납품처전화번호', '품명', '주문수량', '비고(내역)'],
    ...products.map(product => ['', '가상시 모의로 1 /', phone, product, 1, '모의센터'])]);
  return new File([await book.xlsx.writeBuffer()], filename);
}

test('실제 화면은 같은 업체를 회차별로 표시하고 선택한 묶음의 단독 작업만 만든다', async () => {
  const app = await screen(); app.render();
  await app.context.actions.loadFiles([await file('20261116_가상센터.xlsx', ['발주'], '01000000000', ['SPORTY', 'DYJ-03', '욕창예방방석 CD-07'])]);
  app.render(); await app.context.actions.save(); const tree = app.render();
  const html = renderToStaticMarkup(tree);
  assert.match(html, /10:30 접수마감/); assert.match(html, /14:30 접수마감/); assert.match(html, /회차 확인 필요\(표에 없음\)/);
  assert.match(html, /회차 미확정 항목 제외/);
  const articles = app.elements(tree).filter(element => element.type === 'article');
  const afternoon = articles.find(element => renderToStaticMarkup(element).includes('14:30 접수마감'));
  const button = app.elements(afternoon).find(element => element.type === app.context.Button && element.props.children === '센터 상품만 따로 주문 만들기');
  await button.props.onClick(); app.render();
  assert.equal(app.root.jobs.only.scheduleKey, '이로움|14:00');
  assert.equal(app.root.jobs.only.rows.length, 1); assert.equal(app.root.jobs.only.rows[0].productName, 'DYJ-03');
  assert.equal(Object.values(app.root['center-queue'].entries).filter(entry => entry.state === 'WAITING').length, 2);
});

test('실제 센터 화면은 여러 파일을 한 번에 읽고 각 파일의 사람 시트 선택 후에만 저장한다', async () => {
  const app = await screen(); app.render();
  await app.context.actions.loadFiles([await file('20261116_가상센터.xlsx', ['첫째', '둘째']), await file('20261116_모의지사.xlsx')]);
  let tree = app.render();
  assert.equal(app.context.actions.uploads.length, 2);
  await app.context.actions.save(); assert.equal(app.saved, 0);
  const picker = app.elements(tree).find(element => element.type === app.context.WorkbookSheetPicker && element.props.source.filename.includes('가상센터'));
  assert.equal(picker.props.selectedSheet, ''); picker.props.onSelect('둘째');
  tree = app.render();
  assert.equal(app.context.actions.uploads[0].rows[0].sourceSheet, '둘째');
  assert.equal(app.context.actions.uploads[1].rows[0].sourceSheet, '발주');
  await app.context.actions.save(); tree = app.render();
  assert.equal(app.saved, 1); assert.equal(Object.keys(app.root['center-queue'].entries).length, 2);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /센터 발주 대기열/); assert.match(html, /모의센터/); assert.match(html, /09:30 접수마감/);
});

test('실제 화면은 검증 보류 항목을 표시·제외하고 같은 파일 수정본으로 정상 교체한다', async () => {
  const app = await screen(); app.render();
  await app.context.actions.loadFiles([await file('20261116_가상센터.xlsx', ['발주'], '모의 오류')]);
  app.render(); await app.context.actions.save(); let tree = app.render();
  assert.match(renderToStaticMarkup(tree), /대기.*검증 보류/);
  assert.match(renderToStaticMarkup(tree), /보류 항목 제외/);
  const id = Object.keys(app.root['center-queue'].entries)[0];
  await app.context.actions.excludeHeld(id); tree = app.render();
  assert.match(renderToStaticMarkup(tree), /제외됨/);
  await app.context.actions.loadFiles([await file('20261116_가상센터.xlsx')]); app.render();
  await app.context.actions.save(); app.render();
  assert.equal(Object.keys(app.root['center-queue'].entries).length, 1);
  assert.equal(app.root['center-queue'].entries[id].row.status, 'READY');
  await app.context.actions.makeJob('보필');
  assert.equal(app.root.jobs.only.rows.length, 1);
});

test('실제 화면은 원본 날짜 없는 파일의 저장을 막고 명시적으로 날짜를 고른 후 저장한다', async () => {
  const app = await screen(); app.render();
  await app.context.actions.loadFiles([await file('가상센터.xlsx')]);
  let tree = app.render();
  await app.context.actions.save(); assert.equal(app.saved, 0);
  const date = app.elements(tree).find(element => element.type === 'input' && element.props.type === 'date');
  date.props.onChange({ target: { value: '2026-11-16' } }); app.render();
  await app.context.actions.save(); tree = app.render(); assert.equal(app.saved, 1);
  app.context.actions.setNow(new Date('2026-11-17T00:00:00Z')); tree = app.render();
  assert.match(renderToStaticMarkup(tree), /센터 상품 미발주/);
  await app.context.actions.makeJob('보필'); app.render();
  assert.equal(app.root.jobs.only.rows.length, 1);
  assert.deepEqual(app.opened, ['only']);
});
