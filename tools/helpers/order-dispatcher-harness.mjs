// 즉시실행기(scripts/order_dispatcher.gs)를 모의 Apps Script 환경에서 실행한다. 외부 접근은 없다.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// jobs: 매번 Firebase 대기열로 돌려줄 객체를 만드는 함수. busy: 진행·대기 중인 워커 실행이 있는지.
// indexed: Firebase 규칙에 status 인덱스가 있는지. 없으면 실제 서버처럼 상태 조회를 400으로 거부한다.
// 조회 조건(orderBy·equalTo·limitToLast)은 실제 REST 의미대로 적용한다.
export async function dispatcherHarness({ jobs, busy = () => false, properties = {}, dispatchStatus = 204, indexed = true } = {}) {
  const source = await readFile(new URL('../../scripts/order_dispatcher.gs', import.meta.url), 'utf8');
  const props = { GITHUB_TOKEN: 'mock-token', ...properties };
  const dispatches = [], mails = [], requests = [];
  let clock = Date.parse('2026-11-17T01:00:00Z');
  const response = (code, body) => ({ getResponseCode: () => code, getContentText: () => typeof body === 'string' ? body : JSON.stringify(body) });
  const context = vm.createContext({
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => Object.hasOwn(props, key) ? props[key] : null,
      setProperty: (key, value) => { props[key] = String(value); },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    // 하루 한 번 알림 키(yyyyMMdd)는 날짜만, 나머지는 ISO 시각으로 돌려준다.
    Utilities: { formatDate: (date, tz, pattern) => pattern === 'yyyyMMdd' ? new Date(date).toISOString().slice(0, 10).replaceAll('-', '') : new Date(date).toISOString() },
    MailApp: { sendEmail: (to, subject, body) => mails.push({ to, subject, body }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) },
    Logger: { log: () => {} },
    __now: () => clock,
    UrlFetchApp: { fetch: (url, options = {}) => {
      requests.push({ url, method: options.method ?? 'get' });
      if (url.startsWith('https://membership-7aef2-default-rtdb.firebaseio.com/order-ops/jobs.json?')) {
        const query = new URL(url).searchParams;
        const all = jobs();
        const keys = Object.keys(all).sort();
        if (query.get('orderBy') === '"status"') {
          if (!indexed) return response(400, { error: 'Index not defined, add ".indexOn": "status", for path "/order-ops/jobs", to the rules' });
          const status = JSON.parse(query.get('equalTo'));
          return response(200, Object.fromEntries(keys.filter(key => all[key]?.status === status).map(key => [key, all[key]])));
        }
        assert(query.get('orderBy') === '"$key"', '허용하지 않은 조회');
        const limit = Number(query.get('limitToLast'));
        return response(200, Object.fromEntries(keys.slice(-limit).map(key => [key, all[key]])));
      }
      const base = 'https://api.github.com/repos/rlawltn260116-byte/membership_order/actions/workflows/order-worker.yml';
      if (url.startsWith(base + '/runs?')) return response(200, { total_count: busy() ? 1 : 0 });
      if (url === base + '/dispatches' && options.method === 'post') {
        assert(options.headers.Authorization === 'Bearer mock-token', '토큰 헤더 불일치');
        dispatches.push(JSON.parse(options.payload));
        return response(dispatchStatus, dispatchStatus === 204 ? '' : { message: 'mock failure' });
      }
      throw new Error('모의 즉시실행기에서 허용하지 않은 요청: ' + url);
    } },
  });
  vm.runInContext('Date.now = () => __now();', context);
  vm.runInContext(source, context);
  return {
    tick: () => vm.runInContext('tick()', context),
    pending: () => Array.from(vm.runInContext('pendingJobs_()', context)),
    advance: minutes => { clock += minutes * 60 * 1000; },
    dispatches, mails, requests, props,
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
