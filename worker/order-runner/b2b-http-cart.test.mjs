import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { CREDENTIAL_SECRETS, PREPARATION_SCRIPT, childEnvironment, isEnabled, runB2bHttpPreparation } from "./b2b-http-cart.mjs";

const credentials = {
  EROUM_LOGIN_ID: "mock-id", EROUM_LOGIN_PASSWORD: "mock-pw",
  BOFEEL_LOGIN_ID: "mock-id-2", BOFEEL_LOGIN_PASSWORD: "mock-pw-2",
};
const unrelatedSecrets = {
  FIREBASE_SERVICE_ACCOUNT_JSON: "mock-firebase", FINAL_SUBMISSION_APPROVAL_KEY: "mock-approval",
  GITHUB_TOKEN: "mock-token", EROUM_STORAGE_STATE_JSON: "mock-state",
};

function fakeSpawn({ stdout = "", code = 0, hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    if (!hang) setImmediate(() => {
      child.stdout.emit("data", stdout);
      child.stderr.emit("data", "server body that must not be printed");
      child.emit("close", code);
    });
    return child;
  };
  return { spawn, calls };
}

const success = JSON.stringify({ draft: { valid: true, submission_allowed: false }, final_empty: true });

test("플래그가 정확히 true가 아니면 프로세스를 만들지 않아 사이트 요청이 0건이다", async () => {
  for (const flag of [undefined, "", "false", "1", "TRUE", "yes", " true"]) {
    const env = { ...credentials, ...(flag === undefined ? {} : { ENABLE_B2B_HTTP_CART: flag }) };
    const { spawn, calls } = fakeSpawn({ stdout: success });
    assert.equal(isEnabled(env), false);
    for (const vendor of ["eroum", "bofeel"]) {
      const result = await runB2bHttpPreparation(vendor, { env, spawn });
      assert.deepEqual(result, { vendor, enabled: false, siteRequests: 0, status: "DISABLED" });
    }
    assert.equal(calls.length, 0);
  }
});

test("켜져 있어도 로그인 secret이 없거나 업체가 다르면 실행하지 않는다", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: success });
  const env = { ENABLE_B2B_HTTP_CART: "true", EROUM_LOGIN_ID: "mock-id" };
  assert.equal((await runB2bHttpPreparation("eroum", { env, spawn })).status, "MISSING_SECRETS");
  assert.equal((await runB2bHttpPreparation("bofeel", { env, spawn })).status, "MISSING_SECRETS");
  assert.equal((await runB2bHttpPreparation("thk", { env: { ENABLE_B2B_HTTP_CART: "true", ...credentials }, spawn })).status, "INVALID_VENDOR");
  assert.equal(calls.length, 0);
});

test("켜지면 업체 하나를 1회만 실행하고 해당 업체 secret 외 비밀값은 넘기지 않는다", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: "noise\n" + success + "\n" });
  const env = { ENABLE_B2B_HTTP_CART: "true", PATH: "/bin", ...credentials, ...unrelatedSecrets };
  const result = await runB2bHttpPreparation("bofeel", { env, spawn, python: "py" });
  assert.equal(result.status, "PREPARED_NOT_SUBMITTED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "py");
  assert.deepEqual(calls[0].args.slice(-3), [PREPARATION_SCRIPT, "--vendor", "bofeel"]);
  const childEnv = calls[0].options.env;
  assert.equal(childEnv.ENABLE_B2B_HTTP_CART, "true");
  assert.equal(childEnv.BOFEEL_LOGIN_ID, "mock-id-2");
  for (const name of [...Object.keys(unrelatedSecrets), ...CREDENTIAL_SECRETS.eroum]) assert.equal(name in childEnv, false);
  assert.equal(JSON.stringify(result).includes("mock-pw-2"), false);
  assert.equal(JSON.stringify(result).includes("server body"), false);
});

test("실패·형식 불명·시간 초과는 재시도하지 않고 장바구니 확인 필요로 보고한다", async (t) => {
  const env = { ENABLE_B2B_HTTP_CART: "true", ...credentials };
  for (const [options, status] of [
    [{ code: 1, stdout: "HTTP 준비 실패" }, "FAILED"],
    [{ stdout: "not json" }, "FAILED"],
    [{ stdout: JSON.stringify({ draft: { valid: true, submission_allowed: true }, final_empty: true }) }, "FAILED"],
    [{ stdout: JSON.stringify({ draft: { valid: false, submission_allowed: false }, final_empty: true }) }, "FAILED"],
    [{ stdout: JSON.stringify({ draft: { valid: true, submission_allowed: false }, final_empty: false }) }, "FAILED"],
  ]) {
    const { spawn, calls } = fakeSpawn(options);
    const result = await runB2bHttpPreparation("eroum", { env, spawn });
    assert.equal(result.status, status);
    assert.equal(result.cartCheckRequired, true);
    assert.equal(calls.length, 1);
  }
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { spawn, calls } = fakeSpawn({ hang: true });
  const pending = runB2bHttpPreparation("eroum", { env, spawn });
  t.mock.timers.tick(180_000);
  const result = await pending;
  assert.equal(result.status, "UNCERTAIN_TIMEOUT");
  assert.equal(calls.length, 1);
});

test("시작 실패는 요청 없이 끝나고 다시 시도하지 않는다", async () => {
  let count = 0;
  const spawn = () => { count += 1; throw new Error("ENOENT"); };
  const result = await runB2bHttpPreparation("eroum", { env: { ENABLE_B2B_HTTP_CART: "true", ...credentials }, spawn });
  assert.equal(result.status, "START_FAILED");
  assert.equal(count, 1);
});

test("childEnvironment는 지원 업체만 받는다", () => {
  assert.throws(() => childEnvironment("other", {}));
});

test("연결부는 기존 주문 제출 경로·Playwright·Firebase를 불러오지 않는다", () => {
  const source = readFileSync(new URL("./b2b-http-cart.mjs", import.meta.url), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["node:child_process", "node:path", "node:url"]);
  for (const word of ["orderformupdate", "ajax.simple_order", "order_ps", "submitEroumOrder", "reserveSubmission", "SUBMIT_QUEUED"]) {
    assert.equal(source.includes(word), false, word);
  }
  const python = readFileSync(new URL("./http_preparation.py", import.meta.url), "utf8") +
    readFileSync(new URL("./http_cart.py", import.meta.url), "utf8");
  assert.equal(/def\s+\w*submit\w*\s*\(/i.test(python), false);
});

test("workflow의 HTTP 장바구니 job은 수동 실행과 저장소 변수가 모두 있어야 돌고 기존 job은 바뀌지 않는다", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/order-worker.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const [queueJob, httpJob] = workflow.split("\n  b2b-http-cart:\n");
  assert.ok(httpJob, "HTTP job 없음");
  const queueCode = queueJob.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  // 즉시실행기(Apps Script)는 입력 없이 workflow_dispatch를 호출하므로, 사람이 입력을 직접 켜야만 돈다.
  assert.match(httpJob, /^    if: github\.event_name == 'workflow_dispatch' && inputs\.b2b_http_cart == true && vars\.ENABLE_B2B_HTTP_CART == 'true'\n/);
  assert.equal(/^    needs:/m.test(httpJob.split("\n    steps:")[0]), false, "주문 처리 job에 묶이지 않아야 함");
  assert.match(queueJob, /workflow_dispatch:\n    inputs:\n      b2b_http_cart:\n[\s\S]*?type: boolean\n        default: false\n/);
  const dispatcher = readFileSync(new URL("../../scripts/order_dispatcher.gs", import.meta.url), "utf8");
  assert.equal(/b2b_http_cart|inputs\s*:/.test(dispatcher), false, "즉시실행기가 HTTP 장바구니 입력을 보내면 안 됨");
  assert.match(httpJob, /permissions:\n      contents: read\n/);
  assert.match(httpJob, /pip install --disable-pip-version-check -r requirements-http\.txt/);
  for (const name of ["FIREBASE", "FINAL_SUBMISSION_APPROVAL_KEY", "EROUM_STORAGE_STATE_JSON", "GITHUB_TOKEN", "npm start"]) {
    assert.equal(httpJob.includes(name), false, name);
  }
  for (const name of ["ENABLE_B2B_HTTP_CART", "_LOGIN_ID", "_LOGIN_PASSWORD", "http_preparation", "b2b-http-cart"]) {
    assert.equal(queueCode.includes(name), false, name);
  }
  assert.match(queueJob, /FINAL_SUBMISSION_APPROVAL_KEY: \$\{\{ secrets\.FINAL_SUBMISSION_APPROVAL_KEY \}\}/);
  const requirements = readFileSync(new URL("./requirements-http.txt", import.meta.url), "utf8");
  assert.match(requirements, /^cryptography==\d+\.\d+\.\d+$/m);
});
