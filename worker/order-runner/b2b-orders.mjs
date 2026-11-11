// 상품 연결·배송지별 준비 계획. 외부 요청과 고객정보 저장을 하지 않는다.
import { readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { submissionContent } from "./order-approval.mjs";

export const catalog = JSON.parse(readFileSync(new URL("./data/b2b-product-map.json", import.meta.url), "utf8"));
const norm = (v) => String(v ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
export function vendorFor(value) {
  return ({ 이로움: "eroum", THK: "eroum", THKC: "eroum", eroum: "eroum", 보필: "bofeel", bofeel: "bofeel" })[norm(value)] ?? null;
}

export function mapProduct(vendor, row) {
  const name = norm(row.productName ?? row["품명"]);
  const matches = [];
  for (const item of catalog[vendor] ?? []) {
    for (const alias of item.names) {
      if (name === alias) matches.push({ item, suffix: "" });
      else if (name.startsWith(alias + " / ")) matches.push({ item, suffix: name.slice(alias.length + 3) });
      else if (name.startsWith(alias + "(") && name.endsWith(")")) matches.push({ item, suffix: name.slice(alias.length + 1, -1) });
    }
  }
  if (matches.length !== 1) return { status: "HOLD", reason: "상품 연결표와 정확히 일치하는 품명·모델이 없습니다." };
  const { item, suffix } = matches[0];
  const explicit = norm(row.option);
  if (explicit && suffix && explicit !== suffix) return { status: "HOLD", reason: "품명의 옵션과 별도 옵션 열이 다릅니다." };
  const wanted = explicit || suffix;
  const options = item.options.filter((option) => option.name === wanted);
  if (options.length !== 1) return { status: "HOLD", model: item.model, productId: item.it_id ?? item.goodsNo, optionName: wanted, reason: "확인된 사이트 옵션 식별자가 없습니다." };
  return { status: "READY", model: item.model, productId: item.it_id ?? item.goodsNo,
    optionName: wanted, optionId: options[0].io_id ?? options[0].optionSno };
}

export function splitDestination(value) {
  const text = norm(value);
  const underscore = text.lastIndexOf("_");
  const slash = [...text.matchAll(/\s+\/\s+/g)].at(-1);
  const index = underscore >= 0 ? underscore : slash?.index ?? -1;
  const width = underscore >= 0 ? 1 : slash?.[0].length ?? 0;
  if (index < 1) return null;
  const address = text.slice(0, index).trim(), name = text.slice(index + width).trim();
  // 구분자 잔여·중복 수취인·주소처럼 보이는 수취인은 자동 해석하지 않는다.
  if (!address || !name || name.length > 40 || /[_/\r\n]/.test(name)) return null;
  return { name, address };
}

export function normalizeRow(row, job, index) {
  const vendor = vendorFor(row.sourceSystem || job.sourceSystem);
  const destination = row.destination ?? row["납품처"];
  const parsed = destination ? splitDestination(destination) : null;
  const name = norm(row.recipientName || parsed?.name);
  const address = norm(row.address || parsed?.address);
  const phone = norm(row.recipientPhone ?? row["납품처전화번호"]).replace(/[\s-]/g, "");
  const detail = norm(row.addressDetail), postcode = norm(row.zipcode);
  const lineNo = row.lineNo ?? index + 1;
  const quantity = String(row.quantity ?? row["주문수량"] ?? "").trim();
  const orderId = norm(row.orderId ?? row["주문번호"]);
  let reason = "";
  if (!Number.isSafeInteger(lineNo) || lineNo < 1) reason = "원본 행 번호가 올바른 양의 정수가 아닙니다.";
  else if (!vendor) reason = "지원하지 않는 업체입니다.";
  else if (row.status && row.status !== "READY") reason = "운영 페이지 검증에서 보류된 행입니다.";
  else if (!/^SO\d{10}$/.test(orderId)) reason = "고객 주문 식별자가 없거나 지점·재고 주문 후보입니다.";
  else if (destination && (!parsed || (row.recipientName && parsed.name !== name) || (row.address && parsed.address !== address))) reason = "납품처와 구조화된 배송지가 모호하거나 서로 다릅니다.";
  else if (!name || !address || !/^\d{9,11}$/.test(phone)) reason = "수취인·주소·연락처가 불명확합니다.";
  else if (!/^\d{5}$/.test(postcode)) reason = "검증된 우편번호를 입력해야 합니다. 원본 주소에서 추측하지 않습니다.";
  else if (!/^[1-9]\d*$/.test(quantity) || !Number.isSafeInteger(Number(quantity))) reason = "수량은 양의 정수여야 합니다.";
  const mapped = mapProduct(vendor, row);
  reason ||= mapped.status === "HOLD" ? mapped.reason : "";
  const recipient = { name, address, detail, phone, postcode, memo: String(row.memo ?? row["비고(내역)"] ?? "") };
  // 원본 주문번호+품명+옵션은 큐 작업 ID와 독립적인 원장 키다. 배송지·고객정보는 해시에 넣지 않는다.
  const sourceKey = createHash("sha256").update(JSON.stringify([vendor, orderId, mapped.model ?? norm(row.productName ?? row["품명"]), mapped.optionName ?? norm(row.option)])).digest("hex");
  return { lineNo, vendor, orderId, quantity: Number(quantity), recipient, sourceKey, mapping: mapped,
    status: reason ? "HOLD" : "READY", reason };
}

export function planOrders(job) {
  const rows = (job.rows ?? []).map((row, index) => normalizeRow(row, job, index));
  const counts = new Map();
  const lines = new Map();
  for (const row of rows) counts.set(row.sourceKey, (counts.get(row.sourceKey) ?? 0) + 1);
  for (const row of rows) lines.set(row.lineNo, (lines.get(row.lineNo) ?? 0) + 1);
  const groups = new Map();
  for (const row of rows) {
    if (counts.get(row.sourceKey) > 1) { row.status = "HOLD"; row.reason = "같은 원본 주문·상품 행이 중복되어 있습니다."; }
    if (lines.get(row.lineNo) > 1) { row.status = "HOLD"; row.reason = "같은 원본 행 번호가 중복되어 있습니다."; }
    if (row.status !== "READY") continue;
    const { name, address, detail, phone, postcode } = row.recipient;
    const key = JSON.stringify([row.vendor, name, address, detail, phone, postcode]);
    if (!groups.has(key)) groups.set(key, { vendor: row.vendor, addressMode: row.vendor === "eroum" ? "new" : "shippingNew", rows: [] });
    groups.get(key).rows.push(row);
  }
  return { rows, groups: [...groups.values()] };
}

export function submissionProblem(job, env = process.env, time = Date.now()) {
  if (env.ENABLE_B2B_HTTP_SUBMIT !== "true") return "HTTP 주문 제출 잠금이 켜져 있습니다.";
  const review = job.dashboardReview ?? {};
  if (job.executionMode !== "SUBMIT" || job.claimedFromStatus !== "SUBMIT_QUEUED" || review.reviewedFromStatus !== "REVIEWED" || review.decision !== "ACCEPTED" || review.finalSubmissionApproved !== true) return "검토 완료와 운영 페이지 주문 확정 이력이 필요합니다.";
  if (job.rows?.length !== 1) return "한 번에 한 주문·한 행만 제출할 수 있습니다.";
  const key = env.FINAL_SUBMISSION_APPROVAL_KEY ?? "";
  const request = review.submissionRequestId ?? "";
  const approved = Date.parse(review.finalSubmissionApprovedAt ?? "");
  if (!Number.isFinite(approved) || time < approved || time - approved > 30 * 60_000) return "최종 승인이 만료되었거나 시각이 잘못되었습니다.";
  if (key.length < 12 || !/^[A-Za-z0-9-]{8,100}$/.test(request)) return "최종 승인 설정이 불완전합니다.";
  const expected = createHash("sha256").update(`${job.id}:${request}:${key}`).digest("hex");
  const proof = review.approvalProof ?? "";
  if (!/^[a-f0-9]{64}$/.test(proof) || !timingSafeEqual(Buffer.from(expected), Buffer.from(proof))) return "최종 승인 증명값이 올바르지 않습니다.";
  const contentExpected = createHash("sha256").update(`${job.id}:${request}:${submissionContent(job)}:${key}`).digest("hex");
  const contentProof = review.contentApprovalProof ?? "";
  if (!/^[a-f0-9]{64}$/.test(contentProof) || !timingSafeEqual(Buffer.from(contentExpected), Buffer.from(contentProof))) return "주문 행의 상품·수량·배송지·메모가 승인 내용과 다릅니다.";
  return null;
}

export function sourceRowKey(vendor, row) {
  return normalizeRow(row, { sourceSystem: vendor }, 0).sourceKey;
}

export function publicLedgerRowKey(sourceKey, secret) {
  if (typeof secret !== "string" || secret.length < 32 || !/^[a-f0-9]{64}$/.test(sourceKey)) throw new Error("고정 원장 비밀 키 또는 행 식별자가 없습니다.");
  return `b2b-row:${createHmac("sha256", secret).update(sourceKey).digest("hex")}`;
}

// 콜백은 기존 신뢰 원장과 Firebase 행 잠금에 연결된다. 전송은 잠금 저장 뒤 딱 한 번만 호출한다.
export async function submitOnePrepared({ job, prepared, env = process.env, reserveLedger, lockRow, record, transport }) {
  const problem = submissionProblem(job, env);
  if (problem) return { state: "HOLD", reason: problem };
  const plan = planOrders(job);
  if (plan.groups.length !== 1 || plan.rows.length !== 1 || plan.rows[0].status !== "READY" || !prepared.submissionReady) return { state: "HOLD", reason: "상품·배송지·제출 필드 대조가 끝나지 않았습니다." };
  const row = plan.rows[0];
  if (![reserveLedger, lockRow, record, transport].every((callback) => typeof callback === "function")) return { state: "HOLD", reason: "원장·잠금·결과 저장·전송 연결이 필요합니다." };
  if (prepared.sourceKey !== row.sourceKey) return { state: "HOLD", reason: "준비한 원본 행이 다릅니다." };
  if (!await reserveLedger(job.dashboardReview.submissionRequestId, row.sourceKey)) return { state: "HOLD", reason: "일회성 원장을 예약하지 못했거나 이미 사용한 행입니다." };
  if (!await lockRow(row.lineNo)) return { state: "HOLD", reason: "행 제출 잠금이 있거나 결과 확인이 필요합니다." };
  try {
    const result = await transport();
    if (result?.state !== "SUBMITTED" || !/^[A-Za-z0-9-]{8,40}$/.test(result.orderNumber ?? "")) throw new Error("UNKNOWN");
    const value = { state: "SUBMITTED", orderNumber: result.orderNumber, submittedAt: new Date().toISOString() };
    await record(row.lineNo, value);
    return value;
  } catch {
    const value = { state: "UNKNOWN", reason: "제출 결과가 불명확합니다. 주문내역을 확인하기 전에는 재시도하지 마세요." };
    await record(row.lineNo, value).catch(() => undefined);
    return value;
  }
}
