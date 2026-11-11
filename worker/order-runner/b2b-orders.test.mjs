import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planOrders, mapProduct, splitDestination, submissionProblem, submitOnePrepared, publicLedgerRowKey } from "./b2b-orders.mjs";
import { prepareHttpJob, runQueueVendor } from "./b2b-queue.mjs";
import { submissionContent } from "./order-approval.mjs";

const row = (changes = {}) => ({ lineNo: 1, sourceSystem: "이로움", orderId: "SO1234567890", productName: "자세변환용구 DYJ-03", quantity: 1,
  recipientName: "시험", recipientPhone: "010-0000-0000", zipcode: "04524", address: "시험로 1", addressDetail: "1층", memo: "", status: "READY", ...changes });
const job = (rows = [row()]) => ({ id: "시험작업", sourceSystem: "이로움", executionMode: "PREPARE", rows });
function approved() {
  const env = { ENABLE_B2B_HTTP_SUBMIT: "true", FINAL_SUBMISSION_APPROVAL_KEY: "모의시험승인코드12345" };
  const value = { ...job(), executionMode: "SUBMIT", claimedFromStatus: "SUBMIT_QUEUED", dashboardReview: {
    reviewedFromStatus: "REVIEWED", decision: "ACCEPTED", finalSubmissionApproved: true,
    finalSubmissionApprovedAt: new Date().toISOString(), submissionRequestId: "mock-request-0001" } };
  value.dashboardReview.approvalProof = createHash("sha256").update(`${value.id}:${value.dashboardReview.submissionRequestId}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`).digest("hex");
  value.dashboardReview.contentApprovalProof = createHash("sha256").update(`${value.id}:${value.dashboardReview.submissionRequestId}:${submissionContent(value)}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`).digest("hex");
  return { value, env };
}

test("확인된 기본 상품만 정확히 연결한다", () => {
  assert.equal(mapProduct("eroum", row()).productId, "PRO2022102700012");
  assert.equal(mapProduct("bofeel", row({ productName: "안전손잡이 BFSH10" })).optionId, "31");
  for (const name of ["DYJ-03 부품", "DYJ-030", "미확인 모델", "DA-006(초록)"]) assert.equal(mapProduct("eroum", row({ productName: name })).status, "HOLD");
  assert.equal(mapProduct("eroum", row({ productName: "미끄럼방지매트리스 DA-006 / 회색" })).optionId, "회색");
  assert.equal(mapProduct("bofeel", row({ productName: "BFMB20 / 파스텔블루" })).optionId, "6348");
  assert.equal(planOrders(job([row({ expectedPrice: "10" })])).rows[0].expectedPrice, "10");
  assert.equal(mapProduct("bofeel", row({ productName: "이동변기 BFMB20 / 블루" })).status, "HOLD");
  assert.equal(mapProduct("eroum", row({ option: "회색" })).status, "HOLD");
});

test("마지막 밑줄 우선과 공백 슬래시 보조 규칙을 따른다", () => {
  assert.deepEqual(splitDestination("시험_주소_수취인"), { address: "시험_주소", name: "수취인" });
  assert.deepEqual(splitDestination("시험 / 주소 / 수취인"), { address: "시험 / 주소", name: "수취인" });
  for (const text of ["주소만", "주소/이름", "주소_", "_이름", "주소_이름/다른이름"]) assert.equal(splitDestination(text), null);
});

test("같은 업체·수취인·연락처·주소인 행만 묶고 다른 배송지는 분리한다", () => {
  const rows = [row(), row({ lineNo: 2, orderId: "SO1234567891", recipientPhone: "01000000000" }),
    row({ lineNo: 3, orderId: "SO1234567892", address: "다른로 2" }),
    row({ lineNo: 4, orderId: "SO1234567893", sourceSystem: "보필", productName: "BFSH10" }),
    row({ lineNo: 5, orderId: "SO1234567894", recipientName: "다른수취인" }),
    row({ lineNo: 6, orderId: "SO1234567895", recipientPhone: "010-0000-0001" })];
  const plan = planOrders(job(rows));
  assert.equal(plan.groups.length, 5);
  assert.equal(plan.groups[0].rows.length, 2);
  assert.equal(plan.groups[0].addressMode, "new");
  assert.equal(plan.groups[2].addressMode, "shippingNew");
});

test("공통 발주 양식과 비고를 변환하고 우편번호 없는 주소는 HOLD다", () => {
  const common = { "주문번호": "SO1234567890", "납품처": "시험로 1_시험", "납품처전화번호": "010-0000-0000", "품명": "DYJ-03", "주문수량": "2", "비고(내역)": "문 앞", zipcode: "04524" };
  const plan = planOrders(job([common]));
  assert.equal(plan.rows[0].recipient.memo, "문 앞");
  assert.equal(plan.rows[0].quantity, 2);
  assert.equal(plan.groups.length, 1);
  assert.equal(planOrders(job([{ ...common, zipcode: "" }])).rows[0].status, "HOLD");
  assert.equal(planOrders(job([row({ memo: "" })])).rows[0].recipient.memo, "");
});

test("배송지 모호함·수량 오류·원본 중복과 운영 보류는 HOLD다", () => {
  for (const changes of [{ lineNo: "../다른행" }, { lineNo: 0 }, { destination: "구분자없음" }, { destination: "다른주소_다른이름" }, { quantity: 0 }, { quantity: 1.5 }, { quantity: "1e2" }, { orderId: "THK" }, { recipientPhone: "알수없음" }, { status: "HOLD" }, { sourceSystem: "다른업체" }]) assert.equal(planOrders(job([row(changes)])).rows[0].status, "HOLD");
  const duplicated = planOrders(job([row(), row({ lineNo: 2, productName: "DYJ-03" })]));
  assert.equal(duplicated.groups.length, 0);
  assert(duplicated.rows.every((r) => r.status === "HOLD"));
  assert.equal(planOrders(job([row(), row({ orderId: "SO1234567891" })])).groups.length, 0);
});

test("원본 행 키는 큐 작업과 별칭이 바뀌어도 같다", () => {
  const first = planOrders(job()).rows[0].sourceKey;
  const second = planOrders({ ...job([row({ productName: "DYJ-03" })]), id: "다른작업" }).rows[0].sourceKey;
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  const secret = "모의시험용고정원장키_실제비밀값아님_1234567890".repeat(2);
  const publicKey = publicLedgerRowKey(first, secret);
  assert.equal(publicKey, publicLedgerRowKey(second, secret));
  assert.notEqual(publicKey, `b2b-row:${first}`);
  assert.notEqual(publicKey, publicLedgerRowKey(first, secret + "변경"));
  assert.throws(() => publicLedgerRowKey(first, "짧음"));
});

test("제출 잠금·검토 이력·증명·승인 시각·한 행 제한을 각각 검사한다", () => {
  const { value, env } = approved();
  assert.equal(submissionProblem(value, env), null);
  for (const flag of [undefined, "false", "TRUE", "1"]) assert(submissionProblem(value, { ...env, ENABLE_B2B_HTTP_SUBMIT: flag }));
  for (const change of [{ claimedFromStatus: "QUEUED" }, { rows: [row(), row()] }, { executionMode: "PREPARE" },
    { dashboardReview: { ...value.dashboardReview, reviewedFromStatus: "AWAITING_REVIEW" } },
    { dashboardReview: { ...value.dashboardReview, approvalProof: "잘못된증명" } },
    { dashboardReview: { ...value.dashboardReview, finalSubmissionApprovedAt: new Date(Date.now() + 60_000).toISOString() } },
    { dashboardReview: { ...value.dashboardReview, finalSubmissionApprovedAt: new Date(Date.now() - 31 * 60_000).toISOString() } }]) assert(submissionProblem({ ...value, ...change }, env));
});

test("신뢰 원장→행 잠금→전송→결과 기록 순서를 지킨다", async () => {
  const { value, env } = approved(); const events = [];
  const result = await submitOnePrepared({ job: value, env, prepared: { submissionReady: true, sourceKey: planOrders(value).rows[0].sourceKey },
    reserveLedger: async () => { events.push("원장"); return true; }, lockRow: async () => { events.push("잠금"); return true; },
    transport: async () => { events.push("전송"); return { state: "SUBMITTED", orderNumber: "20261111000001" }; }, record: async () => { events.push("기록"); } });
  assert.equal(result.state, "SUBMITTED"); assert.deepEqual(events, ["원장", "잠금", "전송", "기록"]);
});

test("일회성 원장과 행 잠금은 새 작업·승인으로 중복 제출하는 것을 막는다", async () => {
  const used = new Set(); let sent = 0;
  const { value, env } = approved();
  const args = { job: value, env, prepared: { submissionReady: true, sourceKey: planOrders(value).rows[0].sourceKey },
    reserveLedger: async (requestId, sourceKey) => { if (used.has(sourceKey)) return false; used.add(sourceKey); return true; },
    lockRow: async () => true, transport: async () => { sent++; return { state: "SUBMITTED", orderNumber: "20261111000001" }; }, record: async () => {} };
  assert.equal((await submitOnePrepared(args)).state, "SUBMITTED");
  const newJob = structuredClone(value); newJob.id = "복제작업"; newJob.dashboardReview.submissionRequestId = "new-request-0001";
  newJob.dashboardReview.approvalProof = createHash("sha256").update(`${newJob.id}:${newJob.dashboardReview.submissionRequestId}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`).digest("hex");
  newJob.dashboardReview.contentApprovalProof = createHash("sha256").update(`${newJob.id}:${newJob.dashboardReview.submissionRequestId}:${submissionContent(newJob)}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`).digest("hex");
  assert.equal((await submitOnePrepared({ ...args, job: newJob })).state, "HOLD");
  assert.equal(sent, 1);
  assert.equal((await submitOnePrepared({ ...args, reserveLedger: async () => true, lockRow: async () => false })).state, "HOLD");
  assert.equal(sent, 1);
});

test("승인 뒤 상품·수량·배송지·메모를 바꾸면 원장 예약 전에 막는다", async () => {
  for (const changes of [{ quantity: 2 }, { address: "다른 배송지" }, { memo: "변경 메모" }, { productName: "BFSH10" }, { recipientPhone: "01000000001" }]) {
    const { value, env } = approved(); value.rows[0] = { ...value.rows[0], ...changes };
    assert(submissionProblem(value, env));
    let calls = 0;
    const result = await submitOnePrepared({ job: value, env, prepared: { submissionReady: true }, reserveLedger: async () => { calls++; return true; } });
    assert.equal(result.state, "HOLD"); assert.equal(calls, 0);
  }
});

test("응답 유실과 결과 기록 실패는 UNKNOWN이며 재전송하지 않는다", async () => {
  for (const mode of ["timeout", "ambiguous", "record-failed"]) {
    const { value, env } = approved(); let sent = 0; const states = [];
    const result = await submitOnePrepared({ job: value, env, prepared: { submissionReady: true, sourceKey: planOrders(value).rows[0].sourceKey },
      reserveLedger: async () => true, lockRow: async () => true,
      transport: async () => { sent++; if (mode === "timeout") throw new Error("모의 유실"); return mode === "ambiguous" ? { state: "UNKNOWN" } : { state: "SUBMITTED", orderNumber: "20261111000001" }; },
      record: async (_, value) => { states.push(value.state); if (mode === "record-failed" && value.state === "SUBMITTED") throw new Error("기록 유실"); } });
    assert.equal(result.state, "UNKNOWN"); assert.equal(sent, 1); assert.equal(states.at(-1), "UNKNOWN");
  }
});

test("제출 잠금과 준비 미완료는 원장·전송 전 차단한다", async () => {
  const { value, env } = approved(); let called = 0;
  const callbacks = { reserveLedger: async () => { called++; return true; }, lockRow: async () => true, record: async () => {}, transport: async () => { called++; } };
  for (const [flags, prepared] of [[{}, { submissionReady: true }], [env, { submissionReady: false }], [env, { submissionReady: true, sourceKey: "다른행" }]]) {
    assert.equal((await submitOnePrepared({ job: value, env: flags, prepared, ...callbacks })).state, "HOLD");
  }
  assert.equal(called, 0);
});

test("양 업체는 같은 큐에서 준비하며 제출 꺼짐은 전송하지 않는다", async () => {
  const value = job([row(), row({ lineNo: 2, orderId: "SO1234567891", sourceSystem: "보필", productName: "BFSH10" })]); const vendors = [];
  const result = await prepareHttpJob(value, { env: {}, runVendor: async (vendor, groups) => { vendors.push(vendor); return { submissionReady: false, details: groups.flatMap((g) => g.rows.map((r) => ({ lineNo: r.lineNo, status: "READY", reason: "모의 준비" }))) }; } });
  assert.deepEqual(vendors, ["eroum", "bofeel"]); assert.equal(result.details.length, 2); assert.equal(result.canSubmit, false);
  const disabled = await runQueueVendor("bofeel", [], { env: {}, spawn: () => assert.fail("프로세스 실행 금지") });
  assert.equal(disabled.details.length, 0);
});

test("스위치·승인·원장 중복·행 잠금·복수 주문은 각각 전송 전에 멈춘다", async () => {
  for (const mode of ["스위치", "승인", "원장", "행잠금", "복수주문"]) {
    const { value, env } = approved();
    const events = [];
    if (mode === "스위치") delete env.ENABLE_B2B_HTTP_SUBMIT;
    if (mode === "승인") value.dashboardReview.finalSubmissionApproved = false;
    if (mode === "복수주문") value.rows.push(row({ lineNo: 2, orderId: "SO1234567891" }));
    const result = await submitOnePrepared({ job: value, env,
      prepared: { submissionReady: true, sourceKey: planOrders(value).rows[0].sourceKey },
      reserveLedger: async () => { events.push("원장"); return mode !== "원장"; },
      lockRow: async () => { events.push("행잠금"); return mode !== "행잠금"; },
      transport: async () => { events.push("전송"); throw Error("전송 금지"); },
      record: async () => { events.push("기록"); } });
    assert.equal(result.state, "HOLD", mode);
    assert.deepEqual(events, mode === "원장" ? ["원장"] : mode === "행잠금" ? ["원장", "행잠금"] : [], mode);
  }
});
