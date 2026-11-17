// 운영 화면 칸반 보드용 단계 분류. 화면 표시만 정하며 작업 상태·승인 흐름은 바꾸지 않는다.
import { entryForJob, vendorAction, jobOrderDone, kstParts } from "./vendor-board.mjs";
import { normalizeChannelName } from "./schedule.mjs";

export const JOB_STAGES = [
  { id: "WAITING", label: "발주서 대기", hint: "검증을 마친 발주서. 서버 준비 요청 전" },
  { id: "PREPARING", label: "서버 준비", hint: "서버가 장바구니·주문서를 준비 중" },
  { id: "REVIEW", label: "사람 검토", hint: "서버 결과를 확인하고 수락·보류" },
  { id: "CONFIRM", label: "주문 확정", hint: "검토 수락 후 최종 승인·제출 대기" },
  { id: "DONE", label: "완료", hint: "접수 결과와 주문번호 확인" },
];
export const CHANNEL_FILTERS = ["전체", "B2B몰", "ERP", "메일", "카톡", "팩스"];
// 서버 준비가 이 시간(분)을 넘기면 실행 기록 확인을 안내한다.
export const SLOW_PREPARE_MINUTES = 10;

const STAGE_BY_STATUS = {
  READY: "WAITING",
  QUEUED: "PREPARING",
  RUNNING: "PREPARING",
  AWAITING_REVIEW: "REVIEW",
  REVIEWED: "CONFIRM",
  SUBMIT_QUEUED: "CONFIRM",
  COMPLETED: "DONE",
};

// 보류·실패는 사람이 먼저 봐야 하므로 사람 검토 열의 문제 구역(problem)으로 보낸다.
export function jobStage(job) {
  if (jobOrderDone(job)) return { stage: "DONE", problem: false };
  const status = job?.status;
  if (status === "HOLD" || status === "FAILED") return { stage: "REVIEW", problem: true };
  return { stage: STAGE_BY_STATUS[status] ?? "WAITING", problem: false };
}

const GROUP_BY_KIND = { B2B_AUTO: "B2B몰", B2B_MANUAL: "B2B몰", ERP: "ERP", EMAIL: "메일", KAKAO: "카톡", FAX: "팩스" };

export function jobChannelGroup(job) {
  const action = vendorAction(entryForJob(job) ?? normalizeChannelName(job?.sourceSystem));
  return action ? GROUP_BY_KIND[action.kind] ?? "기타" : "기타";
}

export function jobDeadline(job) {
  return entryForJob(job)?.orderDeadline ?? null;
}

export function preparingMinutes(job, now = new Date()) {
  if (jobStage(job).stage !== "PREPARING") return null;
  const started = new Date(job.updatedAt || job.createdAt).getTime();
  if (Number.isNaN(started)) return null;
  return Math.max(0, Math.floor((now.getTime() - started) / 60000));
}

export function isSlowPreparing(job, now = new Date()) {
  const minutes = preparingMinutes(job, now);
  return minutes !== null && minutes >= SLOW_PREPARE_MINUTES;
}

export function formatElapsed(minutes) {
  if (minutes === null || minutes === undefined) return "";
  if (minutes < 60) return `${minutes}분 경과`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분 경과`;
}

// 채널 필터를 적용해 단계별로 나눈다. 완료는 오늘 끝난 것만 보이고 미완료 작업은 날짜와 무관하게 보인다.
export function groupJobsByStage(jobs, filter = "전체", now = new Date()) {
  const today = kstParts(now)?.date;
  const result = { WAITING: [], PREPARING: [], REVIEW: [], CONFIRM: [], DONE: [], problems: [] };
  const sorted = [...(jobs ?? [])].filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  for (const job of sorted) {
    if (filter !== "전체" && jobChannelGroup(job) !== filter) continue;
    const { stage, problem } = jobStage(job);
    if (stage === "DONE" && kstParts(job.updatedAt)?.date !== today) continue;
    if (problem) result.problems.push(job);
    else result[stage].push(job);
  }
  return result;
}
