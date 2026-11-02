/**
 * 주문 워커 즉시 실행기 (Google Apps Script — 별도 프로젝트)
 *
 * GitHub 예약(cron)은 10~40분씩 밀려 시작돼서, 1분마다 주문 대기열(Firebase order-ops/jobs)을 보고
 * 처리할 작업(QUEUED 또는 SUBMIT_QUEUED)이 있으면 GitHub Actions에 실행 요청(workflow_dispatch)을 보낸다.
 * 실행 요청은 보통 30초 안에 시작된다. 대기 작업이 없으면 아무것도 실행하지 않는다.
 * (erp-stock-sync 저장소의 재고 동기화 정시 실행기와 같은 방식)
 *
 * 설치:
 * 1. script.google.com → 새 프로젝트("주문워커 즉시실행기") → 이 코드 붙여넣기 → 저장
 *    (재고동기화 정시실행기 프로젝트에 넣지 말 것: 함수 이름 setup/stop/tick이 겹친다)
 * 2. 프로젝트 설정(톱니) → 시간대 "(GMT+09:00) 한국 표준시 - 서울",
 *    스크립트 속성 GITHUB_TOKEN 추가 (membership_order 저장소 Actions 읽기/쓰기 권한만 준 fine-grained 토큰)
 *    Firebase 보안 규칙을 잠근 뒤에는 스크립트 속성 FIREBASE_AUTH(데이터베이스 비밀번호/토큰)도 추가
 * 3. 위쪽 함수 선택에서 checkSetup 실행 → 권한 승인 → 실행 로그에 "토큰 확인 OK", "대기열 읽기 OK"
 * 4. setup 실행 → 1분 간격 트리거 생성 (멈추려면 stop 실행)
 *
 * 실행 요청이 계속 실패하면 이 스크립트 소유자 메일로 한 번 알린다.
 */
const REPO = 'rlawltn260116-byte/membership_order';
const WORKFLOW = 'order-worker.yml';
const FIREBASE_URL = 'https://membership-7aef2-default-rtdb.firebaseio.com';
const QUEUE_PATH = 'order-ops/jobs';
const PENDING_STATUSES = ['QUEUED', 'SUBMIT_QUEUED'];
const TZ = 'Asia/Seoul';
// 같은 대기 작업으로 실행 요청을 반복하지 않도록, 마지막 요청 후 이 시간(분) 동안은 다시 요청하지 않는다.
// (워커 1회 실행이 보통 2~4분. 그 사이 새 작업이 들어오면 워커가 끝날 때 같이 처리되거나 다음 요청에서 처리된다)
const REDISPATCH_AFTER_MINUTES = 4;
// 최근 몇 건의 작업만 본다 (워커도 최근 100건 중 대기 작업을 처리한다)
const RECENT_JOBS = 30;

function setup() {
  stop();
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  Logger.log('1분 간격 트리거 생성 완료. 대기 작업이 있을 때만 주문 워커를 실행합니다.');
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
  Logger.log('대기열 읽기 OK — 지금 처리 대기 작업 ' + pending.length + '건');
}

// 최근 실행 요청 기록 보기
function status() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('마지막 실행 요청: ' + (props.getProperty('last_dispatch') || '없음'));
  Logger.log('마지막 대기 작업 수: ' + (props.getProperty('last_pending') || '0'));
}

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    let pending;
    try {
      pending = pendingJobs_();
    } catch (err) {
      warnOnce_(props, 'queue', '[주문 워커] 대기열 읽기 실패', String(err));
      return;
    }
    props.setProperty('last_pending', String(pending.length));
    if (!pending.length) return;

    const lastMs = Number(props.getProperty('last_dispatch_ms') || 0);
    if (Date.now() - lastMs < REDISPATCH_AFTER_MINUTES * 60 * 1000) return;
    if (workerBusy_()) return;

    const result = dispatch_();
    if (result.ok) {
      props.setProperty('last_dispatch_ms', String(Date.now()));
      props.setProperty('last_dispatch', Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss') + ' (대기 ' + pending.length + '건)');
      return;
    }
    warnOnce_(props, 'dispatch', '[주문 워커] 실행 요청 실패', result.error +
      '\n\n1분마다 다시 시도합니다. 토큰 만료라면 GITHUB_TOKEN을 새로 발급해 바꿔 주세요. 워크플로가 꺼져 있으면 GitHub Actions에서 켜 주세요.');
  } finally {
    lock.releaseLock();
  }
}

// 처리 대기 작업 id 목록
function pendingJobs_() {
  const auth = PropertiesService.getScriptProperties().getProperty('FIREBASE_AUTH');
  const url = FIREBASE_URL + '/' + QUEUE_PATH + '.json?orderBy=' + encodeURIComponent('"$key"') +
    '&limitToLast=' + RECENT_JOBS + (auth ? '&auth=' + encodeURIComponent(auth) : '');
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  const jobs = JSON.parse(res.getContentText()) || {};
  return Object.keys(jobs).filter((id) => jobs[id] && PENDING_STATUSES.indexOf(jobs[id].status) >= 0);
}

// 이미 실행 중이거나 시작 대기 중인 워커가 있으면 true (있으면 그 실행이 대기 작업을 처리한다)
function workerBusy_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) return false;
  try {
    return ['in_progress', 'queued'].some((s) => {
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

function dispatch_() {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) return { ok: false, error: '스크립트 속성 GITHUB_TOKEN이 없습니다.' };
  try {
    const res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches', {
      method: 'post',
      contentType: 'application/json',
      headers: githubHeaders_(token),
      payload: JSON.stringify({ ref: 'main' }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() === 204) return { ok: true };
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
