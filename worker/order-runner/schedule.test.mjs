import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { deliverySchedule, orderChannelGroups, nextPreparation, preparationDue, reservationProblem, scheduleLabel } from "./schedule.mjs";

test("시간표의 모든 업체가 한 분류에 속하고 THK는 이로움으로 유지된다", () => {
  const channels = orderChannelGroups.flatMap((group) => group.items);
  assert.equal(channels.length, new Set(channels).size);
  for (const entry of deliverySchedule) assert.ok(channels.includes(entry.channel));
  assert.ok(channels.includes("이로움"));
  assert.ok(!channels.includes("THK"));
  assert.ok(orderChannelGroups.find((group) => group.title === "카톡 주문").items.includes("그레이스케일"));
});
test("한국시간 회차 경계와 주말을 처리하고 미등록 업체는 예약하지 않는다", () => {
  const next = (channel, at) => nextPreparation(channel, new Date(at));
  assert.equal(next("THK", "2026-11-05T10:00:00+09:00").runAt, "2026-11-05T01:00:00.000Z");
  assert.equal(next("이로움", "2026-11-05T10:00:01+09:00").runAt, "2026-11-05T05:00:00.000Z");
  assert.equal(next("안앤락", "2026-11-05T12:00:00+09:00").runAt, "2026-11-05T04:00:00.000Z");
  assert.equal(next("이로움", "2026-11-06T14:00:01+09:00").runAt, "2026-11-09T01:00:00.000Z");
  assert.equal(next("그레이스케일", "2026-11-06T14:30:00+09:00").runAt, "2026-11-06T05:30:00.000Z");
  assert.equal(next("그레이스케일", "2026-11-06T14:30:01+09:00").runAt, "2026-11-09T05:30:00.000Z");
  assert.equal(next("미등록", "2026-11-05T00:00:00Z"), null);
});
test("예약 전 선점하지 않고 접수마감 초과·변조·혼합 업체는 보류한다", () => {
  const scheduledPreparation = nextPreparation("이로움", new Date("2026-11-05T09:00:00+09:00"));
  const job = { sourceSystem: "이로움", scheduledPreparation, rows: [{sourceSystem: "이로움"}] };
  assert.equal(preparationDue(job, new Date("2026-11-05T09:59:59+09:00"), true), false);
  assert.equal(preparationDue(job, new Date(scheduledPreparation.runAt), true), true);
  assert.equal(reservationProblem(job, new Date("2026-11-05T10:30:00+09:00")), null);
  assert.ok(reservationProblem(job, new Date("2026-11-05T10:30:01+09:00")));
  assert.ok(reservationProblem({...job, rows: [{sourceSystem: "보필"}]}));
  assert.ok(reservationProblem({...job, scheduledPreparation: {...scheduledPreparation, runAt: "invalid"}}));
  assert.equal(preparationDue(job), false);
  assert.equal(preparationDue({}), true);
  assert.equal(reservationProblem({}), null);
});
test("즉시실행기도 미래 예약을 제외하고 최종 승인 작업은 즉시 실행한다", () => {
  const jobs = {
    future: {status: "QUEUED", scheduledPreparation: {runAt: "2099-01-01T00:00:00Z"}},
    due: {status: "QUEUED", scheduledPreparation: {runAt: "2020-01-01T00:00:00Z"}},
    immediate: {status: "QUEUED"},
    final: {status: "SUBMIT_QUEUED", scheduledPreparation: {runAt: "2099-01-01T00:00:00Z"}},
    running: {status: "RUNNING"},
  };
  const context = vm.createContext({
    PropertiesService: {getScriptProperties: () => ({getProperty: (key) => key === "ENABLE_ORDER_PREPARATION_SCHEDULING" ? "true" : null})},
    UrlFetchApp: {fetch: () => ({getResponseCode: () => 200, getContentText: () => JSON.stringify(jobs)})},
  });
  vm.runInContext(readFileSync(new URL("../../scripts/order_dispatcher.gs", import.meta.url), "utf8"), context);
  assert.deepEqual(Array.from(vm.runInContext("pendingJobs_()", context)), ["due", "immediate", "final"]);
  context.PropertiesService.getScriptProperties = () => ({getProperty: () => null});
  assert.deepEqual(Array.from(vm.runInContext("pendingJobs_()", context)), ["immediate"]);
});


test("최신 시간표 32행과 카톡 업체의 마감 표시 및 예약 정보를 반영한다", () => {
  assert.equal(deliverySchedule.length, 32);
  const deadlines = deliverySchedule.map((entry) => entry.orderDeadline);
  assert.deepEqual(deadlines, [...deadlines].sort());
  const chatChannels = orderChannelGroups.find((group) => group.title === "카톡 주문").items;
  assert.deepEqual(chatChannels, ["선인케어", "현대메딕스", "포에버헬스케어", "베스타", "아이비", "코지디자인", "포웰", "엘에스케이화인텍스", "미키코리아", "미키코리아메디칼", "그레이스케일", "대성홈테크", "보림제작소"]);
  for (const group of orderChannelGroups) {
    const methods = {"B2B몰 주문": ["B2B몰"], "ERP 주문": ["ERP"], "메일 주문": ["이메일"], "팩스 주문": ["팩스"], "카톡 주문": ["카톡", "카톡친구"]}[group.title];
    assert.deepEqual(group.items, [...new Set(deliverySchedule.filter((entry) => methods.includes(entry.method)).map((entry) => entry.channel))]);
  }
  assert.equal(orderChannelGroups.flatMap((group) => group.items).filter((channel) => channel === "안앤락").length, 1);
  assert.equal(orderChannelGroups.flatMap((group) => group.items).filter((channel) => channel === "이로움").length, 1);
  for (const [channel, order, receipt] of [["엘에스케이화인텍스", "13:30", "14:00"], ["그레이스케일", "14:30", "15:00"], ["보림제작소", "15:00", "15:30"]]) {
    assert.equal(scheduleLabel(channel), `${order} 발주 · ${receipt} 접수`);
    assert.deepEqual(nextPreparation(channel, new Date("2026-11-06T09:00:00+09:00")), {
      channel, method: "카톡", runAt: new Date(`2026-11-06T${order}:00+09:00`).toISOString(),
      receiptDeadlineAt: new Date(`2026-11-06T${receipt}:00+09:00`).toISOString(),
    });
  }
});
