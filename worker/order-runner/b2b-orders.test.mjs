import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planOrders, mapProduct, splitDestination, submissionProblem, submitOnePrepared, publicLedgerRowKey, ledgerReservation } from "./b2b-orders.mjs";
import { prepareHttpJob, runQueueVendor } from "./b2b-queue.mjs";
import { submissionContent } from "./order-approval.mjs";

const row = (changes = {}) => ({ lineNo: 1, sourceSystem: "이로움", orderId: "SO1234567890", productName: "자세변환용구 DYJ-03", quantity: 1,
  recipientName: "시험", recipientPhone: "010-0000-0000", zipcode: "04524", address: "시험로 1", addressDetail: "1층", memo: "", status: "READY", ...changes });
const job = (rows = [row()]) => ({ id: "시험작업", filename: "20261006_직배 발주서.xlsx", sourceSystem: "이로움", executionMode: "PREPARE", rows });
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
  assert.equal(mapProduct("bofeel", row({ productName: "이동변기 BFMB20 / 블루" })).optionId, "6348");
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
  for (const changes of [{ lineNo: "../다른행" }, { lineNo: 0 }, { destination: "구분자없음" }, { destination: "다른주소_다른이름" }, { quantity: 0 }, { quantity: 1.5 }, { quantity: "1e2" }, { recipientPhone: "알수없음" }, { status: "HOLD" }, { sourceSystem: "다른업체" }]) assert.equal(planOrders(job([row(changes)])).rows[0].status, "HOLD");
  const duplicated = planOrders(job([row(), row({ productName: "DYJ-03" })]));
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

test("보필은 밑줄·괄호 밖 마지막 쉼표·보수적인 끝 이름을 해석하고 이로움은 기존 구분자를 유지한다", () => {
  for (const text of ["모의로 1, 모의인", "모의로 1 (모의동, 모의건물) 101호 모의인", "모의로 1_모의인"]) {
    assert.equal(splitDestination(text, "bofeel")?.name, "모의인");
  }
  assert.deepEqual(splitDestination("모의로 1, 상세, 모의인", "bofeel"), { address: "모의로 1, 상세", name: "모의인" });
  for (const text of ["모의로 1 모의동", "모의로 1 모의건물", "모의로 1 abc", "모의로 1 101호", "모의로 1 (모의건물 모의인", "모의로 1,", "모의로 1"]) assert.equal(splitDestination(text, "bofeel"), null);
  assert.equal(splitDestination("모의로 1, 모의인", "eroum"), null);
});

test("보필의 확인한 색상 별칭·수량 구간은 연결하며 미확인 색상·부품·오기는 HOLD다", () => {
  for (const [productName, quantity, optionId] of [["성인용보행기 동행(sk-130) / 그린체크", 1, "4699"],
    ["성인용보행기 장수(sk-120)", 6, "3843"], ["목욕의자 BOFEEL11 / 블루", 3, "4678"],
    ["목욕의자 BFSC-112", 5, "6624"], ["BFMB20 브라운", 1, "6347"], ["동행(sk-130)/체크그린", 1, "4699"]]) {
    assert.equal(mapProduct("bofeel", { productName, quantity }).optionId, optionId);
  }
  for (const productName of ["동행 SK-130", "BFMB20", "SK-103 / 꽃무늬", "BFMB5 부품 (변기통)", "BFMB20 / 초록"]) assert.equal(mapProduct("bofeel", { productName, quantity: 1 }).status, "HOLD");
});

test("두 업체 모두 공란·THK 원주문번호를 허용하고 수정본 파일의 같은 행 키와 원장은 유지된다", async () => {
  for (const sourceSystem of ["이로움", "보필"]) {
    const productName = sourceSystem === "보필" ? "BFSH10" : "DYJ-03";
    const first = job([row({ orderId: "", sourceSystem, productName })]);
    const plan = planOrders(first);
    assert.equal(plan.rows[0].status, "READY");
    for (const filename of ["20261006_직배 발주서_수정본.xlsx", "20261006_직배 발주서_v2.xlsx", "20261006_직배 발주서 (1).xlsx"]) {
      assert.equal(planOrders({ ...first, id: "재업로드", filename, rows: [row({ orderId: "THK", sourceSystem, productName })] }).rows[0].sourceKey, plan.rows[0].sourceKey);
    }
    for (const change of [{ lineNo: 2 }, { quantity: 2 }, { address: "모의로 2" }]) assert.notEqual(planOrders({ ...first, rows: [{ ...first.rows[0], ...change }] }).rows[0].sourceKey, plan.rows[0].sourceKey);
    assert.equal(planOrders({ ...first, filename: "날짜없음.xlsx" }).rows[0].status, "HOLD");
  }
  const { value, env } = approved();
  value.rows[0].orderId = "";
  const sign = v => { v.dashboardReview.contentApprovalProof = createHash("sha256").update(`${v.id}:${v.dashboardReview.submissionRequestId}:${submissionContent(v)}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`).digest("hex"); };
  sign(value);
  const used = new Set(); let sends = 0;
  const callbacks = { env, reserveLedger: async (_id,key) => { if(used.has(key)) return false; used.add(key); return true; }, lockRow: async () => true, record: async () => {}, transport: async () => { sends++; return { state:"SUBMITTED",orderNumber:"20261111000001" }; } };
  assert.equal((await submitOnePrepared({ ...callbacks, job:value, prepared:{ submissionReady:true,sourceKey:planOrders(value).rows[0].sourceKey } })).state,"SUBMITTED");
  const revised = { ...value, filename:"20261006_직배 발주서_수정본.xlsx" }; sign(revised);
  assert.equal((await submitOnePrepared({ ...callbacks, job:revised, prepared:{ submissionReady:true,sourceKey:planOrders(revised).rows[0].sourceKey } })).state,"HOLD");
  assert.equal(sends,1);
});

test("보필 다품목 주문은 모든 원장을 한번에 예약하고 각 행 잠금 뒤 딱 한번만 전송한다", async () => {
  const { value, env } = approved();
  value.rows=[row({ sourceSystem:"보필",productName:"BFSH10",orderId:"" }),row({ sourceSystem:"보필",productName:"BFMB20 / 블루",lineNo:2,orderId:"" })];
  value.dashboardReview.contentApprovalProof = createHash("sha256").update(`${value.id}:${value.dashboardReview.submissionRequestId}:${submissionContent(value)}:${env.FINAL_SUBMISSION_APPROVAL_KEY}`).digest("hex");
  const keys=planOrders(value).rows.map(r=>r.sourceKey), events=[];
  const args={job:value,env,prepared:{submissionReady:true,sourceKeys:keys},reserveLedger:async (_id,actual)=>{assert.deepEqual(actual,keys);events.push("원장");return true;},lockRow:async n=>{events.push(`잠금${n}`);return true;},record:async n=>events.push(`기록${n}`),transport:async()=>{events.push("전송");return {state:"SUBMITTED",orderNumber:"20261111000001"};}};
  assert.equal((await submitOnePrepared(args)).state,"SUBMITTED");
  assert.deepEqual(events,["원장","잠금1","잠금2","전송","기록1","기록2"]);
  events.length=0;
  assert.equal((await submitOnePrepared({...args,lockRow:async n=>n!==2})).state,"HOLD");
  assert.deepEqual(events,["원장"]);
  events.length=0;
  assert.equal((await submitOnePrepared({...args,prepared:{submissionReady:true,sourceKeys:[keys[0]]}})).state,"HOLD");
  assert.deepEqual(events,[]);
});

test("같은 수취인의 미연결 상품을 제외한 부분 주문은 만들지 않는다", () => {
  const plan=planOrders(job([row(),row({lineNo:2,productName:"미확인 상품"})]));
  assert.equal(plan.groups.length,0);
  assert(plan.rows.every(r=>r.status==="HOLD"));
});

test("원장은 다품목 전체를 함께 예약하며 기존 키 이관 전·한 행 중복이면 전부 차단한다", () => {
  const secret="모의원장키".repeat(12), a="a".repeat(64), b="b".repeat(64);
  const original=["기존승인"];
  const reserved=ledgerReservation(original,"새승인",[a,b],secret);
  assert.equal(reserved.length,4);assert.deepEqual(original,["기존승인"]);
  assert.equal(ledgerReservation(reserved,"다른승인",[b],secret),null);
  assert.equal(ledgerReservation(reserved,"새승인",["c".repeat(64)],secret),null);
  assert.equal(ledgerReservation(["b2b-row:이전해시"],"새승인",[a],secret),null);
  assert.equal(ledgerReservation([],"새승인",[a,a],secret),null);
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
