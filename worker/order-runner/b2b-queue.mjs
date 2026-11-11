// 큐의 실제 행을 표준 입출력으로 전달한다. 폼·쿠키·고객정보는 로그/파일로 내보내지 않는다.
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { childEnvironment, CREDENTIAL_SECRETS } from "./b2b-http-cart.mjs";
import { planOrders, submitOnePrepared, submissionProblem } from "./b2b-orders.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const safeDetail = (value) => ({ lineNo: value.lineNo, status: value.status, reason: value.reason,
  ...(value.productId ? { productId: value.productId } : {}),
  ...(value.quantity ? { quantity: value.quantity } : {}),
  vendor: value.vendor, orderGroup: value.orderGroup, addressMode: value.addressMode, submissionReady: value.submissionReady === true });

export async function runQueueVendor(vendor, groups, { env = process.env, spawn = nodeSpawn, onPrepared, submitMode = false, timeoutMs = 180_000 } = {}) {
  if (env.ENABLE_B2B_HTTP_CART !== "true") return { details: [], reason: "HTTP 준비 기능이 꺼져 있습니다." };
  if (!CREDENTIAL_SECRETS[vendor]?.every((key) => env[key])) return { details: [], reason: "업체 로그인 설정이 없습니다." };
  return await new Promise((resolve) => {
    let child, timer, closed = false, buffer = "", prepared = null, submitted = null, handling = Promise.resolve();
    const finish = (result) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      child?.stdin?.end();
      resolve(result);
    };
    const fail = () => {
      submitted?.({ state: "UNKNOWN" }); submitted = null;
      // 제출 결과 UNKNOWN 저장이 끝난 뒤 큐 보고를 마친다.
      handling.finally(() => finish({ details: [], reason: "HTTP 준비 통신 결과가 불명확합니다. 자동 재시도하지 말고 장바구니를 확인하세요." }));
    };
    try {
      const childEnv = childEnvironment(vendor, env);
      // 새 제출 잠금은 부모 환경의 정확한 값만 전달한다. workflow는 이 변수를 주입하지 않는다.
      if (submitMode && env.ENABLE_B2B_HTTP_SUBMIT === "true") childEnv.ENABLE_B2B_HTTP_SUBMIT = env.ENABLE_B2B_HTTP_SUBMIT;
      const python = env.B2B_HTTP_PYTHON || (env.pythonLocation ? join(env.pythonLocation, process.platform === "win32" ? "python.exe" : "bin/python") : process.platform === "win32" ? "python" : "python3");
      child = spawn(python, ["-B", "-X", "utf8", join(here, "http_queue.py"), "--vendor", vendor],
        { cwd: here, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch { fail(); return; }
    timer = setTimeout(() => { child.kill?.("SIGKILL"); fail(); }, timeoutMs);
    child.stdin.on("error", () => { submitted?.({ state: "UNKNOWN" }); fail(); });
    child.stdout.setEncoding("utf8");
    child.stderr.on("data", () => {});
    child.on("error", fail);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) { child.kill?.("SIGKILL"); fail(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { fail(); return; }
        if (event.event === "submitted") {
          submitted?.({ state: event.state, orderNumber: event.orderNumber });
          submitted = null;
        } else if (event.event === "prepared" && !prepared) {
          const expected = groups.flatMap((g) => g.rows).map((r) => r.lineNo);
          const details = Array.isArray(event.details) ? event.details : [];
          const valid = details.length === expected.length && details.every((d) => expected.includes(d.lineNo) && ["READY", "HOLD", "FAILED"].includes(d.status) && typeof d.reason === "string") && new Set(details.map((d) => d.lineNo)).size === details.length;
          prepared = { details: valid ? details.map(safeDetail) : [], submissionReady: valid && details.every((d) => d.status === "READY") && event.cartVerified === true && event.submissionReady === true,
            sourceKey: typeof event.sourceKey === "string" ? event.sourceKey : "", reason: "HTTP 준비를 완료하지 못했습니다." };
          if (Array.isArray(event.sourceKeys)) prepared.sourceKeys = event.sourceKeys;
          handling = (async () => {
            if (onPrepared) {
              prepared.submission = await onPrepared(prepared, async () => await new Promise((done) => {
                submitted = done;
                child.stdin.write(JSON.stringify({ submit: true, sourceKey: prepared.sourceKey,
                  ...(prepared.sourceKeys ? { sourceKeys: prepared.sourceKeys } : {}) }) + "\n");
              }));
            }
            child.stdin.end();
          })().catch(fail);
        } else { fail(); return; }
      }
    });
    child.on("close", (code) => {
      submitted?.({ state: "UNKNOWN" });
      handling.finally(() => finish(code === 0 && prepared ? prepared : { details: [], reason: "HTTP 준비가 중단되었습니다. 장바구니 확인이 필요합니다." }));
    });
    child.stdin.write(JSON.stringify({ groups, executionMode: submitMode ? "SUBMIT" : "PREPARE" }) + "\n");
  });
}

export async function prepareHttpJob(job, { env = process.env, runVendor = runQueueVendor, reserveLedger, lockRow, record } = {}) {
  const plan = planOrders(job);
  if (job.executionMode === "SUBMIT") {
    const problem = submissionProblem(job, env);
    if (problem) return { canSubmit: false, details: plan.rows.map((r) => ({ lineNo: r.lineNo, status: "HOLD", reason: problem })) };
  }
  const details = plan.rows.filter((r) => r.status === "HOLD").map((r) => ({ lineNo: r.lineNo, status: "HOLD", reason: r.reason }));
  let canSubmit = false;
  for (const vendor of ["eroum", "bofeel"]) {
    const groups = plan.groups.filter((g) => g.vendor === vendor);
    if (!groups.length) continue;
    const result = await runVendor(vendor, groups, { env, submitMode: job.executionMode === "SUBMIT",
      onPrepared: job.executionMode === "SUBMIT" ? async (prepared, transport) => await submitOnePrepared({ job, prepared, env, reserveLedger, lockRow, record, transport }) : undefined });
    for (const row of groups.flatMap((g) => g.rows)) {
      const detail = result.details.find((d) => d.lineNo === row.lineNo) ?? { lineNo: row.lineNo, status: "HOLD", reason: result.reason };
      if (job.executionMode === "SUBMIT") {
        const submission = result.submission;
        if (submission?.state === "SUBMITTED") Object.assign(detail, { status: "READY", orderNumber: submission.orderNumber, submittedAt: submission.submittedAt, reason: "HTTP 주문 접수 번호를 확인했습니다." });
        else Object.assign(detail, { status: "HOLD", reason: submission?.reason || "제출 필드 검증 미완료로 HTTP 제출을 잠갔습니다." });
      }
      details.push(detail);
    }
    canSubmit = plan.groups.length === 1 && plan.rows.every(row => row.status === "READY") && result.submissionReady === true && env.ENABLE_B2B_HTTP_SUBMIT === "true";
  }
  return { details: details.sort((a, b) => a.lineNo - b.lineNo), canSubmit };
}
