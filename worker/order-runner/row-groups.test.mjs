// 주문 행 화면 분류 시험. 모의 행만 쓰며 외부 요청과 저장이 없다.
import test from "node:test";
import assert from "node:assert/strict";
import { PARTS_ORDER_LABEL } from "./order-classification.mjs";
import { primaryReason, reasonGroupLabel, splitRowsByStatus, groupHoldRowsByReason, rowCounts, rowSections } from "./row-groups.mjs";

const row = (lineNo, status, reason = "") => ({ lineNo, status, reason, productName: `상품${lineNo}` });

const ROWS = [
  row(1, "READY"),
  row(2, "HOLD", `${PARTS_ORDER_LABEL}`),
  row(3, "READY"),
  row(4, "HOLD", "수취인 20자 초과 (23자)"),
  row(5, "FAILED", "필수값 누락: recipient_name"),
  row(6, "HOLD", `${PARTS_ORDER_LABEL}; 수취인 20자 초과 (23자)`),
  row(7, "HOLD", "수취인 20자 초과 (23자)"),
  row(8, "READY"),
];

test("상태별로 정상·보류·실패를 나누고 정상 행이 보류 행 사이에 섞이지 않는다", () => {
  const { ready, hold, failed } = splitRowsByStatus(ROWS);
  assert.deepEqual(ready.map((r) => r.lineNo), [1, 3, 8]);
  assert.deepEqual(hold.map((r) => r.lineNo), [2, 4, 6, 7]);
  assert.deepEqual(failed.map((r) => r.lineNo), [5]);
});

test("건수는 전체·정상·보류·실패로 센다", () => {
  assert.deepEqual(rowCounts(ROWS), { all: 8, ready: 3, hold: 4, failed: 1 });
  assert.deepEqual(rowCounts([]), { all: 0, ready: 0, hold: 0, failed: 0 });
});

test("보류 사유는 첫 번째 사유로 묶고 빈 사유는 '사유 없음'으로 표시한다", () => {
  assert.equal(primaryReason(row(6, "HOLD", `${PARTS_ORDER_LABEL}; 수취인 20자 초과 (23자)`)), PARTS_ORDER_LABEL);
  assert.equal(reasonGroupLabel(row(9, "HOLD", "")), "사유 없음");
  assert.equal(reasonGroupLabel(row(9, "HOLD", "  ")), "사유 없음");
});

test("보류 묶음은 건수 많은 사유가 위에 오고 같은 건수는 이름순, 행 순서를 유지한다", () => {
  const groups = groupHoldRowsByReason(splitRowsByStatus(ROWS).hold);
  // 두 묶음 모두 2건이므로 이름순(부품 … < 수취인 …)
  assert.deepEqual(groups.map((g) => [g.label, g.rows.map((r) => r.lineNo)]), [
    [PARTS_ORDER_LABEL, [2, 6]],
    ["수취인 20자 초과 (23자)", [4, 7]],
  ]);
  const more = groupHoldRowsByReason([row(1, "HOLD", "가 사유"), row(2, "HOLD", "나 사유"), row(3, "HOLD", "나 사유")]);
  assert.deepEqual(more.map((g) => g.label), ["나 사유", "가 사유"]);
});

test("전체 보기는 보류 → 실패 → 정상 순서이고 보류만 사유 묶음을 가진다", () => {
  const sections = rowSections(ROWS, "all");
  assert.deepEqual(sections.map((s) => [s.key, s.rows.length]), [["hold", 4], ["failed", 1], ["ready", 3]]);
  assert.equal(sections[0].groups.length, 2);
  assert.deepEqual(sections[1].groups, []);
});

test("보기별로 해당 구역만 나오고 행이 없는 구역은 빠진다", () => {
  assert.deepEqual(rowSections(ROWS, "hold").map((s) => s.key), ["hold"]);
  assert.deepEqual(rowSections(ROWS, "failed").map((s) => s.key), ["failed"]);
  assert.deepEqual(rowSections(ROWS, "ready").map((s) => s.key), ["ready"]);
  assert.deepEqual(rowSections(ROWS.filter((r) => r.status === "READY"), "all").map((s) => s.key), ["ready"]);
  assert.deepEqual(rowSections(ROWS.filter((r) => r.status === "READY"), "hold"), []);
});

test("보류 행의 상태를 바꾸지 않고 원본 배열을 변경하지 않는다", () => {
  const before = JSON.stringify(ROWS);
  rowSections(ROWS, "all");
  groupHoldRowsByReason(ROWS);
  assert.equal(JSON.stringify(ROWS), before);
});
