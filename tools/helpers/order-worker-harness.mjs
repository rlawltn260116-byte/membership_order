// 실제 워커 함수의 제어 흐름을 모의 Firebase·GitHub 원장에 연결한다. 외부 접근은 없다.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { usesHttp, ledgerReservation, bofeelOnlyJob } from '../../worker/order-runner/b2b-orders.mjs';
import { submissionContent } from '../../worker/order-runner/order-approval.mjs';
import { workbookProblem } from '../../worker/order-runner/workbook-policy.mjs';
import { preparationDue, reservationProblem } from '../../worker/order-runner/schedule.mjs';
import { isPartsOrder, PARTS_ORDER_LABEL } from '../../worker/order-runner/order-classification.mjs';
import { centerReservationProblem, updateJobWithCenters } from '../../worker/order-runner/center-queue.mjs';

export async function workerHarness(jobs, env, prepareHttpJob, centerQueue = {}, { retryTransactions = false } = {}) {
  const source = await readFile('worker/order-runner/src/index.ts', 'utf8');
  const ast = ts.createSourceFile('worker.ts', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['claimJob', 'saveWorkerResult', 'reserveSubmission', 'reserveTrustedSubmissionRequest', 'prepareReport', 'runOnce']);
  const snippet = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text)).map(node => node.getText(ast)).join('\n');
  let ledger = [], version = 1;
  const store = { jobs, 'center-queue': centerQueue };
  const callbackErrors = [];
  const value = path => path ? path.split('/').reduce((obj, key) => obj?.[key], store) : store;
  const put = (path, data) => {
    if (!path) {
      for (const key of Object.keys(jobs)) delete jobs[key];
      Object.assign(jobs, data.jobs);
      Object.assign(centerQueue, data['center-queue']);
      return;
    }
    const keys = path.split('/'); let obj = store;
    for (const key of keys.slice(0, -1)) obj = obj[key] ??= {};
    obj[keys.at(-1)] = data;
  };
  const database = { ref: path => ({
    transaction: async callback => {
      let next;
      try {
        if (retryTransactions) { callback(null); await Promise.resolve(); }
        next = callback(structuredClone(value(path) ?? null));
      } catch (error) { callbackErrors.push(error); throw error; }
      if (next !== undefined) put(path, next);
      return { committed: next !== undefined, snapshot: { val: () => value(path) } };
    },
    update: async patch => { for (const [key, data] of Object.entries(patch)) put(path + '/' + key, data); },
    push: () => ({ key: randomUUID() }),
    get: async () => ({ key: path.split('/').at(-1), val: () => structuredClone(value(path) ?? null) }),
    orderByKey: () => ({ limitToLast: () => ({ get: async () => ({
      numChildren: () => Object.keys(jobs).length,
      forEach: callback => Object.entries(jobs).forEach(([key, job]) => callback({ key, val: () => structuredClone(job) })),
    }) }) }),
  }) };
  const context = vm.createContext({ process: { env }, Buffer, Date, createHash, randomUUID, timingSafeEqual, database,
    queuePath: 'jobs', workerId: '모의워커', now: () => new Date().toISOString(), usesHttp, bofeelOnlyJob, ledgerReservation,
    submissionContent, workbookProblem, preparationDue, reservationProblem, prepareHttpJob, isPartsOrder, PARTS_ORDER_LABEL, centerReservationProblem, updateJobWithCenters,
    console: { log: () => {} }, chromium: { launch: () => { throw new Error('이 시험은 Playwright 실행 금지'); } },
    fetch: async (url, options) => {
      if (!url.startsWith('https://api.github.com/repos/mock/repo/contents/.github/order-submission-ledger.json')) throw new Error('실제 요청 금지');
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        if (body.sha !== String(version) || body.branch !== 'main') return { ok: false, status: 409 };
        ledger = JSON.parse(Buffer.from(body.content, 'base64').toString()); version++;
        return { ok: true };
      }
      return { ok: true, json: async () => ({ content: Buffer.from(JSON.stringify(ledger)).toString('base64'), sha: String(version) }) };
    },
  });
  vm.runInContext(ts.transpileModule(snippet, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return { run: () => context.runOnce(), saveResult: (id, patch) => context.saveWorkerResult(id, patch), callbackErrors, jobs, get ledger() { return ledger; } };
}
