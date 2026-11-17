// 통합 현황의 업체별 발주 현황판. 시간표 순서로 업체 회차를 나열하고 오늘 작업으로 상태를 정한다.
// 이 모듈은 메일·팩스·카톡을 보내지 않는다. 초안·인쇄본·입력값만 만들고 완료 표시는 사람이 한다.
import { deliverySchedule, normalizeChannelName } from "./schedule.mjs";
import { PARTS_ORDER_KIND } from "./order-classification.mjs";

export const BOARD_STATUS = { BEFORE: "BEFORE", IN_PROGRESS: "IN_PROGRESS", DONE: "DONE" };
export const BOARD_STATUS_LABEL = { BEFORE: "발주 전", IN_PROGRESS: "진행 중", DONE: "발주 완료" };
// 서버 자동 준비·제출이 연결된 B2B몰. 나머지 B2B몰은 사이트에서 사람이 주문한다.
export const AUTOMATED_B2B_CHANNELS = ["보필", "이로움"];
const ACTIVE_STATUSES = ["QUEUED", "RUNNING", "AWAITING_REVIEW", "REVIEWED", "SUBMIT_QUEUED"];

export function scheduleKey(entry) {
  return `${entry.channel}|${entry.orderDeadline ?? "미정"}`;
}

// 시간표 순서(발주마감 오름차순, 같은 시각은 시간표 기재 순서). 마감 미정은 맨 뒤.
export const boardEntries = deliverySchedule
  .map((entry, index) => ({ ...entry, index, key: scheduleKey(entry) }))
  .sort((a, b) => (a.orderDeadline ?? "99:99").localeCompare(b.orderDeadline ?? "99:99") || a.index - b.index);

export function findBoardEntry(key) {
  return boardEntries.find((entry) => entry.key === key) ?? null;
}

const STEPS = {
  B2B_AUTO: ["발주서 업로드 후 클라우드 저장", "서버 준비 요청(장바구니·주문서 준비)", "서버 결과 검토·수락", "최종 승인 후 서버가 주문 제출"],
  B2B_MANUAL: ["발주서 업로드 후 클라우드 저장", "입력값 확인", "B2B몰 사이트에서 직접 주문", "주문 후 발주 완료 표시"],
  ERP: ["발주서 업로드 후 클라우드 저장", "ERP 입력값 확인", "거래처 포털(ERP)에서 주문 등록", "등록 후 발주 완료 표시"],
  EMAIL: ["발주서 업로드 후 클라우드 저장", "메일 초안 복사·발주서 엑셀 내려받기", "메일에 발주서를 첨부해 보내기(받는 사람은 로컬 메모 확인)", "보낸 뒤 발주 완료 표시"],
  FAX: ["발주서 업로드 후 클라우드 저장", "인쇄용 발주서 열기", "팩스로 보내기(번호는 로컬 메모 확인)", "보낸 뒤 발주 완료 표시"],
  KAKAO: ["발주서 업로드 후 클라우드 저장", "카톡 문구 복사(필요하면 발주서 엑셀 첨부)", "업체 카톡방에 보내기", "보낸 뒤 발주 완료 표시"],
};
const LABELS = { B2B_AUTO: "B2B몰 자동 준비", B2B_MANUAL: "B2B몰 직접 주문", ERP: "ERP 주문 등록", EMAIL: "메일 발주", FAX: "팩스 발주", KAKAO: "카톡 발주" };

function actionKind(entry) {
  if (entry.method === "B2B몰") return AUTOMATED_B2B_CHANNELS.includes(entry.channel) ? "B2B_AUTO" : "B2B_MANUAL";
  if (entry.method === "ERP") return "ERP";
  if (entry.method === "이메일") return "EMAIL";
  if (entry.method === "팩스") return "FAX";
  if (entry.method === "카톡" || entry.method === "카톡친구") return "KAKAO";
  return null;
}

// 발주 형태별 클릭 동작. 시간표에 없는 업체는 null(기존 화면 동작 유지).
export function vendorAction(entryOrChannel) {
  const entry = typeof entryOrChannel === "string"
    ? boardEntries.find((item) => item.channel === normalizeChannelName(entryOrChannel))
    : entryOrChannel;
  if (!entry) return null;
  const kind = actionKind(entry);
  if (!kind) return null;
  const warnings = [];
  if (entry.note && entry.note.includes("별도 양식")) warnings.push("업체 별도 양식이 필요합니다. 자동 초안을 그대로 보내지 말고 업체 양식으로 옮겨 작성해 주세요.");
  if (entry.note && entry.note.includes("텍스트")) warnings.push("엑셀 파일이 아니라 카톡 텍스트로 보냅니다.");
  if (entry.method === "카톡친구") warnings.push("업체 단톡방이 아니라 카톡 친구 채팅으로 보냅니다.");
  return {
    kind,
    label: entry.method === "카톡친구" ? "카톡친구 발주" : LABELS[kind],
    serverPrepare: kind === "B2B_AUTO",
    manualDone: kind !== "B2B_AUTO",
    steps: STEPS[kind],
    url: entry.url ?? null,
    warnings,
  };
}

// 한국시간 기준 날짜(YYYY-MM-DD)와 시각(HH:MM).
export function kstParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const iso = new Date(date.getTime() + 9 * 3600000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: new Date(date.getTime() + 9 * 3600000).getUTCDay() };
}

// 작업이 어느 업체 회차에 속하는지. 업체 카드로 올린 작업은 저장한 회차를 쓰고,
// 예전 작업은 업체가 같고 올린 시각 이후 첫 회차(없으면 마지막 회차)로 본다.
export function entryForJob(job) {
  if (!job || job.orderKind === PARTS_ORDER_KIND) return null;
  if (job.scheduleKey) return findBoardEntry(job.scheduleKey);
  const channel = normalizeChannelName(job.sourceSystem);
  const entries = boardEntries.filter((entry) => entry.channel === channel);
  if (!entries.length) return null;
  const created = kstParts(job.createdAt);
  if (!created) return entries[entries.length - 1];
  return entries.find((entry) => entry.orderDeadline && entry.orderDeadline >= created.time) ?? entries[entries.length - 1];
}

export function jobOrderDone(job) {
  return job?.status === "COMPLETED" || Boolean(job?.vendorOrderDone?.doneAt);
}

export function vendorBoard(jobs, now = new Date()) {
  const today = kstParts(now);
  const todays = (jobs ?? []).filter((job) => job && job.orderKind !== PARTS_ORDER_KIND && kstParts(job.createdAt)?.date === today.date);
  return boardEntries.map((entry) => {
    const entryJobs = todays.filter((job) => entryForJob(job)?.key === entry.key);
    const status = entryJobs.some(jobOrderDone) ? BOARD_STATUS.DONE : entryJobs.length ? BOARD_STATUS.IN_PROGRESS : BOARD_STATUS.BEFORE;
    return {
      key: entry.key,
      entry,
      action: vendorAction(entry),
      jobs: entryJobs,
      status,
      statusLabel: BOARD_STATUS_LABEL[status],
      overdue: status !== BOARD_STATUS.DONE && Boolean(entry.orderDeadline) && today.time > entry.orderDeadline,
      waitingReview: entryJobs.some((job) => ACTIVE_STATUSES.includes(job.status)),
    };
  });
}

export function boardSummary(board) {
  return {
    total: board.length,
    done: board.filter((item) => item.status === BOARD_STATUS.DONE).length,
    inProgress: board.filter((item) => item.status === BOARD_STATUS.IN_PROGRESS).length,
    before: board.filter((item) => item.status === BOARD_STATUS.BEFORE).length,
    overdue: board.filter((item) => item.overdue).length,
  };
}

// 파일명에 다른 업체가 적혀 있으면 업로드를 멈춘다(애매하면 묻기 규칙).
const FILE_ALIASES = { THKC: "이로움", THK: "이로움" };
export function uploadTargetProblem(target, filename) {
  if (!target) return null;
  const name = String(filename ?? "").normalize("NFKC");
  const names = [...new Set(boardEntries.flatMap((entry) => [entry.vendor, entry.channel]).concat(Object.keys(FILE_ALIASES)))]
    .sort((a, b) => b.length - a.length);
  const found = [];
  let rest = name;
  for (const candidate of names) {
    if (!rest.includes(candidate)) continue;
    found.push(FILE_ALIASES[candidate] ?? normalizeChannelName(boardEntries.find((entry) => entry.vendor === candidate)?.channel ?? candidate));
    rest = rest.split(candidate).join(" ");
  }
  const other = found.filter((channel) => channel !== target.channel);
  return other.length ? `파일명에 다른 업체(${[...new Set(other)].join(", ")})가 있습니다. ${target.channel} 발주서가 맞는지 확인해 주세요.` : null;
}

function rowDestination(row) {
  return String(row.destination || [row.address, row.addressDetail, row.recipientName].filter(Boolean).join(" ")).trim();
}

function rowProduct(row) {
  return [row.productName, row.option].filter(Boolean).join(" / ");
}

// 메일·카톡·팩스 공용 초안. 비고는 원문 그대로, 없으면 줄을 만들지 않는다.
export function orderDraft(entry, rows, now = new Date()) {
  const day = kstParts(now).date;
  const list = rows ?? [];
  const round = entry.round && entry.round !== entry.orderDeadline ? ` ${entry.round}` : "";
  const subject = `[발주] ${entry.vendor}${round} ${day} 발주서 (${list.length}건)`;
  const lines = [`안녕하세요. ${entry.vendor}${round} ${day} 발주 요청드립니다.`, `총 ${list.length}건입니다.`, ""];
  list.forEach((row, index) => {
    lines.push(`${index + 1}) ${rowProduct(row)} × ${row.quantity}`);
    if (row.orderId) lines.push(`   주문번호: ${row.orderId}`);
    lines.push(`   납품처: ${rowDestination(row)}`);
    if (row.recipientPhone) lines.push(`   연락처: ${row.recipientPhone}`);
    if (row.memo) lines.push(`   비고: ${row.memo}`);
  });
  lines.push("", "확인 부탁드립니다. 감사합니다.");
  return { subject, text: lines.join("\n") };
}

export const ORDER_SHEET_HEADERS = ["주문번호", "납품처", "납품처전화번호", "품명", "주문수량", "비고(내역)"];
export function orderSheetRows(rows) {
  return (rows ?? []).map((row) => [row.orderId ?? "", rowDestination(row), row.recipientPhone ?? "", rowProduct(row), row.quantity ?? "", row.memo ?? ""]);
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

// 팩스용 인쇄 화면. 모든 값은 이스케이프한다.
export function printableOrderHtml(entry, rows, now = new Date()) {
  const { subject } = orderDraft(entry, rows, now);
  const body = orderSheetRows(rows).map((cells) => `<tr>${cells.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title><style>body{font-family:sans-serif;margin:24px;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #444;padding:6px;text-align:left;vertical-align:top}th{background:#eee}@media print{button{display:none}}</style></head><body><h1>${escapeHtml(subject)}</h1><p>발주처: ${escapeHtml(entry.vendor)} · 발주마감 ${escapeHtml(entry.orderDeadline ?? "미정")} · 접수마감 ${escapeHtml(entry.receiptDeadline ?? "미정")}</p><table><thead><tr>${ORDER_SHEET_HEADERS.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table><p><button onclick="window.print()">인쇄</button></p></body></html>`;
}

const BLOCKED_DONE_STATUSES = ["QUEUED", "RUNNING", "AWAITING_REVIEW", "REVIEWED", "SUBMIT_QUEUED"];

// 사람이 업체에 보낸 뒤 누르는 완료 표시. 서버 자동 주문 업체와 처리 중 작업은 막는다.
export function manualDonePatch(job, now = new Date(), actorName = "주문 운영자") {
  if (!job) throw new Error("작업을 먼저 선택해 주세요.");
  if (job.orderKind === PARTS_ORDER_KIND) throw new Error("부품 주문(발주처 미정)은 완료 표시할 수 없습니다.");
  const entry = entryForJob(job);
  const action = entry ? vendorAction(entry) : null;
  if (!entry || !action) throw new Error("시간표에 없는 업체는 완료 표시할 수 없습니다.");
  if (!action.manualDone) throw new Error(`${entry.channel}은 서버 승인·제출 결과로만 완료됩니다.`);
  if (jobOrderDone(job)) throw new Error("이미 발주 완료로 표시된 작업입니다.");
  if (BLOCKED_DONE_STATUSES.includes(job.status)) throw new Error("서버 처리 중인 작업은 완료 표시할 수 없습니다.");
  const at = now.toISOString();
  const auditId = `${now.getTime()}-vendor-order-done`;
  return {
    status: "COMPLETED",
    vendorOrderDone: { doneAt: at, doneByName: actorName, method: entry.method, scheduleKey: entry.key, previousStatus: job.status },
    updatedAt: at,
    [`auditLogs/${auditId}`]: { id: auditId, jobId: job.id, action: "VENDOR_ORDER_MARKED_DONE", actorName, actorEmail: "", detail: `${entry.vendor} ${entry.method} 발주 완료 표시 (${job.totalRows ?? 0}건)`, createdAt: at },
  };
}

export function manualDoneUndoPatch(job, now = new Date(), actorName = "주문 운영자") {
  if (!job?.vendorOrderDone?.doneAt) throw new Error("사람이 완료 표시한 작업만 되돌릴 수 있습니다.");
  const at = now.toISOString();
  const auditId = `${now.getTime()}-vendor-order-undone`;
  return {
    status: job.vendorOrderDone.previousStatus || "READY",
    vendorOrderDone: null,
    updatedAt: at,
    [`auditLogs/${auditId}`]: { id: auditId, jobId: job.id, action: "VENDOR_ORDER_DONE_UNDONE", actorName, actorEmail: "", detail: "발주 완료 표시를 취소했습니다.", createdAt: at },
  };
}
