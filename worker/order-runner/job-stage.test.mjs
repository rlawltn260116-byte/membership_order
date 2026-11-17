// 칸반 단계 분류 시험. 모의 작업만 쓰며 외부 요청 없음.
import test from "node:test";
import assert from "node:assert/strict";
import { jobStage, jobChannelGroup, groupJobsByStage, preparingMinutes, isSlowPreparing, formatElapsed, JOB_STAGES, CHANNEL_FILTERS } from "./job-stage.mjs";

const NOW = new Date("2026-11-17T10:30:00+09:00");
const job = (patch) => ({ id: "j", filename: "모의.xlsx", sourceSystem: "보필", status: "READY", createdAt: "2026-11-17T08:00:00+09:00", updatedAt: "2026-11-17T08:00:00+09:00", ...patch });

test("작업 상태를 다섯 단계로 나누고 보류·실패는 사람 검토의 문제 구역으로 보낸다", () => {
  assert.deepEqual(JOB_STAGES.map((stage) => stage.label), ["발주서 대기", "서버 준비", "사람 검토", "주문 확정", "완료"]);
  const expected = { READY: "WAITING", QUEUED: "PREPARING", RUNNING: "PREPARING", AWAITING_REVIEW: "REVIEW", REVIEWED: "CONFIRM", SUBMIT_QUEUED: "CONFIRM", COMPLETED: "DONE" };
  for (const [status, stage] of Object.entries(expected)) assert.deepEqual(jobStage(job({ status })), { stage, problem: false }, status);
  assert.deepEqual(jobStage(job({ status: "HOLD" })), { stage: "REVIEW", problem: true });
  assert.deepEqual(jobStage(job({ status: "FAILED" })), { stage: "REVIEW", problem: true });
  assert.equal(jobStage(job({ status: "READY", vendorOrderDone: { doneAt: "2026-11-17T09:00:00+09:00" } })).stage, "DONE");
});

test("채널 필터는 발주 형태로 묶고 시간표에 없는 채널은 기타로 둔다", () => {
  assert.deepEqual(CHANNEL_FILTERS, ["전체", "B2B몰", "ERP", "메일", "카톡", "팩스"]);
  assert.equal(jobChannelGroup(job({ sourceSystem: "보필" })), "B2B몰");
  assert.equal(jobChannelGroup(job({ sourceSystem: "없는채널" })), "기타");
  assert.equal(jobChannelGroup(null), "기타");
});

test("단계별로 나누고 미완료는 날짜와 무관, 완료는 오늘 것만 보이며 필터가 적용된다", () => {
  const jobs = [
    job({ id: "a", status: "READY" }), job({ id: "b", status: "RUNNING" }), job({ id: "c", status: "AWAITING_REVIEW" }),
    job({ id: "d", status: "HOLD" }), job({ id: "e", status: "REVIEWED" }),
    job({ id: "f", status: "COMPLETED" }), job({ id: "old", status: "COMPLETED", updatedAt: "2026-11-10T08:00:00+09:00" }),
    job({ id: "older-hold", status: "FAILED", updatedAt: "2026-11-01T08:00:00+09:00" }),
  ];
  const grouped = groupJobsByStage(jobs, "전체", NOW);
  assert.deepEqual(grouped.WAITING.map((j) => j.id), ["a"]);
  assert.deepEqual(grouped.PREPARING.map((j) => j.id), ["b"]);
  assert.deepEqual(grouped.REVIEW.map((j) => j.id), ["c"]);
  assert.deepEqual(grouped.problems.map((j) => j.id), ["d", "older-hold"]);
  assert.deepEqual(grouped.CONFIRM.map((j) => j.id), ["e"]);
  assert.deepEqual(grouped.DONE.map((j) => j.id), ["f"]);
  const none = groupJobsByStage(jobs, "메일", NOW);
  assert.equal(Object.values(none).flat().length, 0);
  assert.equal(groupJobsByStage(jobs, "B2B몰", NOW).WAITING.length, 1);
});

test("서버 준비가 오래 걸리면 경과 시간과 느림 표시를 낸다", () => {
  const running = job({ status: "RUNNING", updatedAt: "2026-11-17T10:00:00+09:00" });
  assert.equal(preparingMinutes(running, NOW), 30);
  assert.equal(isSlowPreparing(running, NOW), true);
  assert.equal(isSlowPreparing(job({ status: "QUEUED", updatedAt: "2026-11-17T10:25:00+09:00" }), NOW), false);
  assert.equal(preparingMinutes(job({ status: "READY" }), NOW), null);
  assert.equal(formatElapsed(30), "30분 경과");
  assert.equal(formatElapsed(135), "2시간 15분 경과");
  assert.equal(formatElapsed(null), "");
});
