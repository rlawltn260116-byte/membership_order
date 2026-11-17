/**
 * 주문 워커 즉시 실행기 (Google Apps Script — 별도 프로젝트)
 *
 * 주문 워커(order-worker.yml)에는 예약(cron) 실행이 없다(사용자 지시 2026-11-17). 이 스크립트가 1분마다 주문 대기열
 * (Firebase order-ops/jobs)을 보고, 보필 작업이 서버 준비 요청(QUEUED) 또는 검토 수락→주문 확정(SUBMIT_QUEUED) 상태가
 * 되면 그 작업 ID 하나를 job_id 입력으로 넣어 GitHub Actions에 실행 요청(workflow_dispatch)을 보낸다.
 * 실행 요청은 보통 30초 안에 시작된다. 대기 중인 보필 작업이 없으면 아무것도 실행하지 않는다.
 * 이로움 등 다른 업체 작업은 실행 요청하지 않는다. 실제 제출은 워커가 기존 승인 코드·원장·잠금을 다시 확인한다.
 *
 * GitHub 토큰은 이 스크립트 속성에만 둔다. 정적 운영 페이지(GitHub Pages, 브라우저)에는 토큰을 두지 않는다.
 *
 * 설치:
 * 1. script.google.com → 새 프로젝트("주문워커 즉시실행기") → 이 코드 붙여넣기 → 저장
 *    (재고동기화 정시실행기 프로젝트에 넣지 말 것: 함수 이름 setup/stop/tick이 겹친다)
 * 2. 프로젝트 설정(톱니) → 시간대 "(GMT+09:00) 한국 표준시 - 서울",
 *    스크립트 속성 GITHUB_TOKEN 추가 (membership_order 저장소 하나에 Actions 읽기/쓰기 권한만 준 fine-grained 토큰)
 *    Firebase 보안 규칙을 잠근 뒤에는 스크립트 속성 FIREBASE_AUTH(데이터베이스 비밀번호/토큰)도 추가
 * 3. 위쪽 함수 선택에서 checkSetup 실행 → 권한 승인 → 실행 로그에 "토큰 확인 OK", "대기열 읽기 OK"
 * 4. setup 실행 → 1분 간격 트리거 생성 (멈추려면 stop 실행)
 *
 * 실행 요청이 계속 실패하거나, 같은 작업을 여러 번 요청해도 처리되지 않으면 이 스크립트 소유자 메일로 하루 한 번 알린다.
 */
const REPO = 'rlawltn260116-byte/membership_order';
const WORKFLOW = 'order-worker.yml';
const FIREBASE_URL = 'https://membership-7aef2-default-rtdb.firebaseio.com';
const QUEUE_PATH = 'order-ops/jobs';
const PENDING_STATUSES = ['QUEUED', 'SUBMIT_QUEUED'];
const TZ = 'Asia/Seoul';
// 같은 요청(작업·상태·요청 세대)으로 실행 요청을 반복하지 않도록, 마지막 요청 후 이 시간(분) 동안은 다시 요청하지 않는다.
// (워커 1회 실행이 보통 2~4분. 실행이 작업을 가져가면 상태가 RUNNING으로 바뀌어 다시 요청하지 않는다)
const REDISPATCH_AFTER_MINUTES = 4;
// 같은 요청으로 이 횟수만큼 실행을 요청해도 처리되지 않으면 더 요청하지 않고 알린다(설정 오류로 무한 반복 방지).
// 운영 페이지에서 보류 후 다시 요청하면 새 세대가 되어 다시 요청한다.
const MAX_DISPATCHES_PER_JOB = 3;
// 상태 인덱스가 없을 때만 쓰는 최근 작업 수 (워커는 요청받은 ID를 직접 읽는다)
const RECENT_JOBS = 30;
// 워크플로 job_id 입력과 워커가 받는 작업 ID 형식 (운영 페이지의 newOrderJobId 문자 집합)
const JOB_ID_PATTERN = /^[-0-9A-Za-z_]{1,64}$/;
const BOFEEL_NAMES = ['보필', 'bofeel'];
const PARTS_ORDER_KIND = 'UNASSIGNED_PARTS';

function setup() {
  stop();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  Logger.log('1분 간격 트리거 생성 완료. 대기 중인 보필 작업이 있을 때만 주문 워커를 실행합니다.');
}

function stop() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'tick')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  Logger.log('트리거 삭제 완료');
}

// 실행 없이 토큰·워크플로 접근과 대기열 읽기만 확인한다.
function checkSetup() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('스크립트 속성 GITHUB_TOKEN이 없습니다.');
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW, {
    headers: githubHeaders_(token),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('토큰 확인 실패: HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  const workflow = JSON.parse(res.getContentText());
  Logger.log('토큰 확인 OK — 워크플로 "' + workflow.name + '" 상태: ' + workflow.state +
    (workflow.state === 'active' ? '' : '  ← GitHub Actions에서 워크플로를 켜야(Enable) 실행됩니다'));
  const pending = pendingJobs_();
  Logger.log('대기열 읽기 OK — 지금 처리 대기 보필 작업 ' + pending.length + '건');
}

// 최근 실행 요청 기록 보기
function status() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('마지막 실행 요청: ' + (props.getProperty('last_dispatch') || '없음'));
  Logger.log('마지막 대기 보필 작업 수: ' + (props.getProperty('last_pending') || '0'));
  Logger.log('작업별 요청 기록: ' + (props.getProperty('dispatch_log') || '{}'));
}

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    let jobs;
    try {
      jobs = pendingJobs_(true);
    } catch (err) {
      warnOnce_(props, 'queue', '[주문 워커] 대기열 읽기 실패', String(err));
      return;
    }
    props.setProperty('last_pending', String(jobs.length));
    const log = dispatchLog_(props, jobs);
    if (!jobs.length) return;
    if (workerBusy_()) return;

    const now = Date.now();
    const next = nextDispatch_(jobs, log, now);
    if (next.exhausted.length) {
      warnOnce_(props, 'stuck', '[주문 워커] 실행 요청 후에도 처리되지 않은 보필 작업',
        '작업 ' + next.exhausted.join(', ') + '을(를) ' + MAX_DISPATCHES_PER_JOB + '번 실행 요청했지만 상태가 바뀌지 않았습니다.\n' +
        '더 요청하지 않습니다. GitHub Actions 실행 기록과 워커 secret·저장소 변수를 확인한 뒤, 운영 페이지에서 작업을 보류했다가 다시 요청해 주세요.');
    }
    if (!next.job) return;

    const result = dispatch_(next.job.id);
    if (result.ok) {
      const previous = log[next.job.id];
      log[next.job.id] = { generation: next.job.generation, count: (previous && previous.generation === next.job.generation ? previous.count : 0) + 1, at: now };
      props.setProperty('dispatch_log', JSON.stringify(log));
      props.setProperty('last_dispatch', Utilities.formatDate(new Date(now), TZ, 'yyyy-MM-dd HH:mm:ss') +
        ' (작업 ' + next.job.id + ' · ' + next.job.status + ' · 대기 ' + jobs.length + '건)');
      return;
    }
    warnOnce_(props, 'dispatch', '[주문 워커] 실행 요청 실패', result.error +
      '\n\n1분마다 다시 시도합니다. 토큰 만료라면 GITHUB_TOKEN을 새로 발급해 바꿔 주세요. 워크플로가 꺼져 있으면 GitHub Actions에서 켜 주세요.');
  } finally {
    lock.releaseLock();
  }
}

// 보필 전용 작업인지: 작업 업체(비어 있으면 행이 상속)와 모든 행의 업체가 보필이고 부품 작업이 아니다.
// (워커의 bofeelOnlyJob과 같은 기준. 보필·이로움 혼합 행은 요청하지 않는다)
function isBofeelJob_(job) {
  const norm = (value) => String(value == null ? '' : value).normalize('NFC').replace(/\s+/g, ' ').trim();
  const isBofeel = (value) => BOFEEL_NAMES.indexOf(norm(value)) >= 0;
  if (!job || job.orderKind === PARTS_ORDER_KIND) return false;
  const rows = Array.isArray(job.rows) ? job.rows : [];
  if (norm(job.sourceSystem) && !isBofeel(job.sourceSystem)) return false;
  return rows.length > 0 && rows.every((row) => row && row.orderKind !== PARTS_ORDER_KIND &&
    isBofeel(norm(row.sourceSystem) ? row.sourceSystem : job.sourceSystem));
}

// 대기 상태 작업을 빠짐없이 읽는다. Firebase 규칙에 order-ops/jobs의 ".indexOn": ["status"]가 있으면 상태별 조회를 쓰고,
// 없으면(HTTP 400 Index not defined) 최근 RECENT_JOBS건만 읽으며 하루 한 번 인덱스 추가가 필요하다고 알린다.
function fetchQueuedJobs_() {
  const props = PropertiesService.getScriptProperties();
  const auth = props.getProperty('FIREBASE_AUTH');
  const base = FIREBASE_URL + '/' + QUEUE_PATH + '.json?';
  const authQuery = auth ? '&auth=' + encodeURIComponent(auth) : '';
  const read = (query) => {
    const res = UrlFetchApp.fetch(base + query + authQuery, { muteHttpExceptions: true });
    return { code: res.getResponseCode(), text: res.getContentText() };
  };
  const jobs = {};
  let indexed = true;
  for (let i = 0; i < PENDING_STATUSES.length && indexed; i++) {
    const res = read('orderBy=' + encodeURIComponent('"status"') + '&equalTo=' + encodeURIComponent('"' + PENDING_STATUSES[i] + '"'));
    if (res.code === 400 && /index not defined/i.test(res.text)) {
      indexed = false;
      break;
    }
    if (res.code !== 200) throw new Error('HTTP ' + res.code + ' ' + res.text.slice(0, 200));
    const found = JSON.parse(res.text) || {};
    Object.keys(found).forEach((id) => { jobs[id] = found[id]; });
  }
  if (indexed) return jobs;
  warnOnce_(props, 'index', '[주문 워커] 대기열 상태 인덱스 없음',
    'Firebase 규칙의 order-ops/jobs에 ".indexOn": ["status"]가 없어 최근 ' + RECENT_JOBS + '건만 확인합니다.\n' +
    '그보다 오래된 대기 작업은 실행 요청되지 않습니다. 운영 승인 후 Firebase 규칙에 인덱스를 추가해 주세요.');
  const res = read('orderBy=' + encodeURIComponent('"$key"') + '&limitToLast=' + RECENT_JOBS);
  if (res.code !== 200) throw new Error('HTTP ' + res.code + ' ' + res.text.slice(0, 200));
  return JSON.parse(res.text) || {};
}

// 같은 요청인지 가리는 세대 표식: 상태와 운영 페이지가 요청할 때마다 새로 쓰는 값(승인 요청번호·검토 갱신 시각).
// 보류했다가 다시 요청하면 감시 주기와 관계없이 새 세대가 되어 요청 횟수를 새로 센다.
function generation_(job) {
  const review = job.dashboardReview || {};
  return [job.status, review.submissionRequestId || '', review.updatedAt || job.updatedAt || ''].join('|');
}

// 처리 대기 보필 작업 목록. 기본은 id 목록, withStatus면 {id, status, generation} 목록 (작업 키 순서 = 등록 순서)
function pendingJobs_(withStatus) {
  const jobs = fetchQueuedJobs_();
  const schedulingEnabled = PropertiesService.getScriptProperties().getProperty('ENABLE_ORDER_PREPARATION_SCHEDULING') === 'true';
  const ids = Object.keys(jobs).sort().filter((id) => JOB_ID_PATTERN.test(id) && jobs[id] && isBofeelJob_(jobs[id]) &&
    PENDING_STATUSES.indexOf(jobs[id].status) >= 0 &&
    (!jobs[id].scheduledPreparation || (schedulingEnabled && (
      jobs[id].status === 'SUBMIT_QUEUED' || !Number.isFinite(Date.parse(jobs[id].scheduledPreparation.runAt)) || Date.parse(jobs[id].scheduledPreparation.runAt) <= Date.now()))));
  return withStatus ? ids.map((id) => ({ id: id, status: jobs[id].status, generation: generation_(jobs[id]) })) : ids;
}

// 작업별 요청 기록 {id: {generation, count, at}}. 지금 대기 중이 아닌 작업의 기록은 지운다.
function dispatchLog_(props, jobs) {
  let log = {};
  try {
    log = JSON.parse(props.getProperty('dispatch_log') || '{}') || {};
  } catch (err) {
    log = {};
  }
  const kept = {};
  jobs.forEach((job) => { if (log[job.id]) kept[job.id] = log[job.id]; });
  if (JSON.stringify(kept) !== JSON.stringify(log)) props.setProperty('dispatch_log', JSON.stringify(kept));
  return kept;
}

// 이번에 요청할 작업 하나(가장 먼저 등록된 것)와 요청 한도를 넘긴 작업 목록
function nextDispatch_(jobs, log, now) {
  const exhausted = [];
  let job = null;
  jobs.forEach((candidate) => {
    const entry = log[candidate.id];
    const sameRequest = entry && entry.generation === candidate.generation;
    if (sameRequest && entry.count >= MAX_DISPATCHES_PER_JOB) {
      exhausted.push(candidate.id);
      return;
    }
    if (sameRequest && now - Number(entry.at || 0) < REDISPATCH_AFTER_MINUTES * 60 * 1000) return;
    if (!job) job = candidate;
  });
  return { job: job, exhausted: exhausted };
}

// 이미 실행 중이거나 시작 대기 중인 워커가 있으면 true (실행은 한 번에 하나만 요청한다)
function workerBusy_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) return false;
  try {
    return ['in_progress', 'queued', 'pending', 'waiting', 'requested'].some((s) => {
      const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/runs?per_page=1&status=' + s, {
        headers: githubHeaders_(token),
        muteHttpExceptions: true,
      });
      return res.getResponseCode() === 200 && JSON.parse(res.getContentText()).total_count > 0;
    });
  } catch (err) {
    return false;
  }
}

// 작업 하나에 대해서만 실행을 요청한다. 입력은 job_id 하나뿐이다(HTTP 장바구니 시험 입력은 보내지 않는다).
function dispatch_(jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId || ''))) return { ok: false, error: '작업 ID 형식이 올바르지 않습니다.' };
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) return { ok: false, error: '스크립트 속성 GITHUB_TOKEN이 없습니다.' };
  try {
    const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: githubHeaders_(token),
      payload: JSON.stringify({ ref: 'main', inputs: { job_id: jobId } }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 204 || res.getResponseCode() === 200) return { ok: true };
    return { ok: false, error: 'HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 300) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function githubHeaders_(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// 같은 종류의 실패 알림은 하루 한 번만 보낸다.
function warnOnce_(props, kind, subject, body) {
  const key = 'warned_' + kind + '_' + Utilities.formatDate(new Date(), TZ, 'yyyyMMdd');
  if (props.getProperty(key)) return;
  props.setProperty(key, '1');
  try {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), subject, body);
  } catch (err) {
    Logger.log('알림 메일 실패: ' + err);
  }
}
