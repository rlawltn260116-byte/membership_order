// 업체별 발주 현황판 규칙 시험. 모의 작업만 쓰며 외부 요청 없음.
import test from "node:test";
import assert from "node:assert/strict";
import { deliverySchedule } from "./schedule.mjs";
import { PARTS_ORDER_KIND } from "./order-classification.mjs";
import {
  boardEntries, vendorBoard, boardSummary, vendorAction, entryForJob, uploadTargetProblem,
  orderDraft, orderSheetRows, printableOrderHtml, manualDonePatch, manualDoneUndoPatch, findBoardEntry,
} from "./vendor-board.mjs";

const NOW = new Date("2026-11-17T10:05:00+09:00");
const key = (channel, time) => `${channel}|${time}`;
const job = (patch) => ({ id: "job", filename: "모의.xlsx", status: "READY", totalRows: 1, holdRows: 0, failedRows: 0, createdAt: "2026-11-17T08:30:00+09:00", ...patch });

test("시간표 모든 회차를 발주마감 순서로 나열하고 회차마다 키가 다르다", () => {
  assert.equal(boardEntries.length, deliverySchedule.length);
  assert.equal(new Set(boardEntries.map((entry) => entry.key)).size, boardEntries.length);
  const times = boardEntries.map((entry) => entry.orderDeadline);
  assert.deepEqual(times, [...times].sort());
  assert.equal(boardEntries[0].channel, "보필");
  assert.deepEqual(boardEntries.filter((entry) => entry.channel === "이로움").map((entry) => entry.key), [key("이로움", "10:00"), key("이로움", "14:00")]);
  assert.equal(boardEntries.filter((entry) => entry.channel === "안앤락").length, 3);
});

test("발주 형태마다 다른 동작을 고르고 자동 주문은 보필·이로움만이다", () => {
  const kind = (channel) => vendorAction(channel)?.kind;
  assert.equal(kind("보필"), "B2B_AUTO");
  assert.equal(kind("THK"), "B2B_AUTO");
  assert.equal(kind("나눔에이치앤씨"), "B2B_MANUAL");
  assert.equal(kind("세비앙"), "ERP");
  assert.equal(kind("나이스텍"), "EMAIL");
  assert.equal(kind("유광정밀"), "FAX");
  assert.equal(kind("선인케어"), "KAKAO");
  assert.equal(vendorAction("베스타").label, "카톡친구 발주");
  assert.equal(vendorAction("보필").serverPrepare, true);
  assert.equal(vendorAction("보필").manualDone, false);
  for (const channel of ["나눔에이치앤씨", "세비앙", "나이스텍", "유광정밀", "선인케어"]) {
    assert.equal(vendorAction(channel).serverPrepare, false, channel);
    assert.equal(vendorAction(channel).manualDone, true, channel);
  }
  assert.ok(vendorAction("세비앙").url);
  assert.ok(vendorAction("현대메딕스").warnings.some((text) => text.includes("별도 양식")));
  assert.ok(vendorAction("코지디자인").warnings.some((text) => text.includes("텍스트")));
  assert.equal(vendorAction("미등록 업체"), null);
});

test("오늘 작업으로 발주 전·진행 중·발주 완료를 정하고 지난 날·부품 작업은 세지 않는다", () => {
  const jobs = [
    job({ id: "a", sourceSystem: "선인케어", scheduleKey: key("선인케어", "09:30") }),
    job({ id: "b", sourceSystem: "나이스텍", scheduleKey: key("나이스텍", "10:00"), status: "COMPLETED", vendorOrderDone: { doneAt: NOW.toISOString() } }),
    job({ id: "c", sourceSystem: "보필", status: "COMPLETED" }),
    job({ id: "d", sourceSystem: "유광정밀", createdAt: "2026-11-16T09:00:00+09:00" }),
    job({ id: "e", sourceSystem: "부품", orderKind: PARTS_ORDER_KIND }),
    job({ id: "f", sourceSystem: "THKC", createdAt: "2026-11-17T10:10:00+09:00", status: "AWAITING_REVIEW" }),
  ];
  const board = vendorBoard(jobs, NOW);
  const item = (k) => board.find((value) => value.key === k);
  assert.equal(item(key("선인케어", "09:30")).status, "IN_PROGRESS");
  assert.equal(item(key("선인케어", "09:30")).statusLabel, "진행 중");
  assert.equal(item(key("나이스텍", "10:00")).status, "DONE");
  assert.equal(item(key("보필", "09:00")).status, "DONE");
  assert.equal(item(key("유광정밀", "10:30")).status, "BEFORE");
  assert.equal(item(key("유광정밀", "10:30")).statusLabel, "발주 전");
  // 예전 작업은 올린 시각 이후 첫 회차로 본다(10:10 → 이로움 오후).
  assert.equal(item(key("이로움", "10:00")).status, "BEFORE");
  assert.equal(item(key("이로움", "14:00")).status, "IN_PROGRESS");
  assert.equal(item(key("이로움", "14:00")).waitingReview, true);
  assert.equal(item(key("선인케어", "09:30")).overdue, true);
  assert.equal(item(key("나이스텍", "10:00")).overdue, false);
  assert.equal(item(key("유광정밀", "10:30")).overdue, false);
  const summary = boardSummary(board);
  assert.equal(summary.total, deliverySchedule.length);
  assert.equal(summary.done, 2);
  assert.equal(summary.inProgress, 2);
  assert.equal(summary.done + summary.inProgress + summary.before, summary.total);
  assert.equal(entryForJob(jobs[4]), null);
});

test("업체 카드와 다른 업체가 파일명에 있으면 업로드를 멈춘다", () => {
  assert.equal(uploadTargetProblem({ channel: "보필" }, "20261117_직배(보필) 발주서.xlsx"), null);
  assert.equal(uploadTargetProblem({ channel: "이로움" }, "20261117_직배(THKC).xlsx"), null);
  assert.equal(uploadTargetProblem({ channel: "선인케어" }, "발주서.xlsx"), null);
  assert.match(uploadTargetProblem({ channel: "선인케어" }, "20261117_직배(THKC).xlsx"), /이로움/);
  assert.match(uploadTargetProblem({ channel: "미키코리아" }, "직배(미키코리아메디칼).xlsx"), /미키코리아메디칼/);
  assert.equal(uploadTargetProblem({ channel: "미키코리아메디칼" }, "직배(미키코리아메디칼).xlsx"), null);
  assert.equal(uploadTargetProblem(null, "직배(보필).xlsx"), null);
});

test("메일·카톡 초안과 팩스 인쇄본은 비고를 원문대로만 싣고 값을 이스케이프한다", () => {
  const entry = findBoardEntry(key("나이스텍", "10:00"));
  const rows = [
    { orderId: "T-1", destination: "가상시 모의로 1 / 모의인", recipientPhone: "01000000000", productName: "모의품", option: "회색", quantity: "2", memo: "문 앞" },
    { orderId: "", address: "가상시 모의로 2", recipientName: "<모의>", recipientPhone: "", productName: "모의품2", option: "", quantity: "1", memo: "" },
  ];
  const draft = orderDraft(entry, rows, NOW);
  assert.equal(draft.subject, "[발주] 나이스텍 2026-11-17 발주서 (2건)");
  assert.ok(draft.text.includes("1) 모의품 / 회색 × 2"));
  assert.ok(draft.text.includes("납품처: 가상시 모의로 1 / 모의인"));
  assert.ok(draft.text.includes("비고: 문 앞"));
  assert.equal((draft.text.match(/비고:/g) ?? []).length, 1);
  assert.equal((draft.text.match(/주문번호:/g) ?? []).length, 1);
  assert.deepEqual(orderSheetRows(rows)[1], ["", "가상시 모의로 2 <모의>", "", "모의품2", "1", ""]);
  const html = printableOrderHtml(entry, rows, NOW);
  assert.ok(html.includes("&lt;모의&gt;"));
  assert.ok(!html.includes("<모의>"));
  assert.ok(orderDraft(findBoardEntry(key("이로움", "14:00")), rows, NOW).subject.includes("THK 오후"));
});

test("완료 표시는 사람이 보내는 업체만 가능하고 처리 중·자동 주문·부품·중복 완료를 막으며 되돌릴 수 있다", () => {
  const manual = job({ id: "m", sourceSystem: "선인케어", scheduleKey: key("선인케어", "09:30"), status: "HOLD" });
  const patch = manualDonePatch(manual, NOW, "모의 운영자");
  assert.equal(patch.status, "COMPLETED");
  assert.equal(patch.vendorOrderDone.previousStatus, "HOLD");
  assert.equal(patch.vendorOrderDone.method, "카톡");
  assert.equal(patch.vendorOrderDone.scheduleKey, key("선인케어", "09:30"));
  const audit = Object.entries(patch).find(([name]) => name.startsWith("auditLogs/"))[1];
  assert.equal(audit.action, "VENDOR_ORDER_MARKED_DONE");
  assert.throws(() => manualDonePatch(job({ sourceSystem: "보필" }), NOW), /서버 승인·제출/);
  assert.throws(() => manualDonePatch({ ...manual, status: "QUEUED" }, NOW), /서버 처리 중/);
  assert.throws(() => manualDonePatch({ ...manual, orderKind: PARTS_ORDER_KIND }, NOW), /부품/);
  assert.throws(() => manualDonePatch({ ...manual, ...patch }, NOW), /이미/);
  assert.throws(() => manualDonePatch(job({ sourceSystem: "미등록" }), NOW), /시간표/);
  const undo = manualDoneUndoPatch({ ...manual, ...patch }, NOW);
  assert.equal(undo.status, "HOLD");
  assert.equal(undo.vendorOrderDone, null);
  assert.throws(() => manualDoneUndoPatch(job({ sourceSystem: "보필", status: "COMPLETED" }), NOW), /사람이 완료 표시한/);
});
