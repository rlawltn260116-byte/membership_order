import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runQueueVendor } from "./b2b-queue.mjs";

const groups = [{ vendor: "bofeel", rows: [{ lineNo: 1, sourceKey: "mock-source" }] }];
const env = { ENABLE_B2B_HTTP_CART: "true", ENABLE_B2B_HTTP_SUBMIT: "true", B2B_HTTP_SUBMIT_VENDORS: "bofeel", BOFEEL_LOGIN_ID: "mock-id", BOFEEL_LOGIN_PASSWORD: "mock-password",
  FIREBASE_SERVICE_ACCOUNT_JSON: "다른비밀", GITHUB_TOKEN: "다른비밀", FINAL_SUBMISSION_APPROVAL_KEY: "다른비밀", B2B_SUBMISSION_LEDGER_KEY: "다른비밀" };
const event = { event: "prepared", sourceKey: "mock-source", submissionReady: true, cartVerified: true, finalEmpty: false,
  details: [{ lineNo: 1, status: "READY", reason: "모의 준비", vendor: "bofeel", cookie: "출력금지" }] };

function fakeChild(prepared = event, reply = true) {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.commands = [];
  child.stdin = new Writable({ write(chunk, encoding, callback) {
    const command = JSON.parse(chunk.toString()); child.commands.push(command);
    queueMicrotask(() => {
      if (command.groups) child.stdout.write(JSON.stringify(prepared) + "\n");
      else if (command.submit && reply) child.stdout.write(JSON.stringify({ event: "submitted", state: "SUBMITTED", orderNumber: "20261111000001" }) + "\n");
    }); callback();
  } });
  child.stdin.on("finish", () => queueMicrotask(() => child.emit("close", 0)));
  child.kill = () => { child.emit("close", 1); };
  return child;
}

test("PREPARE는 부모 제출 플래그가 있어도 자식에게 넘기지 않는다", async () => {
  const child = fakeChild(); let childEnv;
  const result = await runQueueVendor("bofeel", groups, { env, spawn: (_, __, options) => { childEnv = options.env; return child; } });
  assert.equal(childEnv.ENABLE_B2B_HTTP_SUBMIT, undefined);
  assert.equal(child.commands[0].executionMode, "PREPARE");
  assert.equal(child.commands.length, 1);
  for (const key of ["FIREBASE_SERVICE_ACCOUNT_JSON", "GITHUB_TOKEN", "FINAL_SUBMISSION_APPROVAL_KEY", "B2B_SUBMISSION_LEDGER_KEY"]) assert.equal(childEnv[key], undefined);
  assert.equal(result.details[0].cookie, undefined);
  assert.equal(JSON.stringify(result).includes("출력금지"), false);
});

test("SUBMIT는 부모 승인 콜백 뒤 같은 자식에게 한 명령만 보낸다", async () => {
  const child = fakeChild(); let approved = false;
  const result = await runQueueVendor("bofeel", groups, { env, submitMode: true, spawn: () => child,
    onPrepared: async (prepared, transport) => { assert(prepared.submissionReady); approved = true; return await transport(); } });
  assert.equal(approved, true);
  assert.equal(child.commands[0].executionMode, "SUBMIT");
  assert.deepEqual(child.commands[1], { submit: true, sourceKey: "mock-source" });
  assert.equal(child.commands.length, 2);
  assert.equal(result.submission.state, "SUBMITTED");
});

test("행 누락·중복·대조 실패 결과는 제출 가능으로 받지 않는다", async () => {
  for (const details of [[], [event.details[0], event.details[0]], [{ ...event.details[0], lineNo: 99 }], [{ ...event.details[0], status: "HOLD" }]]) {
    const child = fakeChild({ ...event, details });
    const result = await runQueueVendor("bofeel", groups, { env, spawn: () => child });
    assert.equal(result.submissionReady, false);
    assert.equal(child.commands.length, 1);
  }
});

test("전송 명령 뒤 자식 결과가 끊기면 UNKNOWN을 콜백에 전달하고 재전송하지 않는다", async () => {
  const child = fakeChild(event, false); let outcome;
  const result = await runQueueVendor("bofeel", groups, { env, submitMode: true, timeoutMs: 20, spawn: () => child,
    onPrepared: async (_, transport) => { outcome = await transport(); return outcome; } });
  assert.equal(outcome.state, "UNKNOWN");
  assert.equal(result.submission.state, "UNKNOWN");
  assert.equal(child.commands.filter((command) => command.submit).length, 1);
});

test("이로움과 목록 밖 업체는 브리지에서도 프로세스 생성 전에 차단한다", async () => {
  for (const [vendor, flags] of [["eroum", env], ["bofeel", { ...env, B2B_HTTP_SUBMIT_VENDORS: "" }]]) {
    const result = await runQueueVendor(vendor, groups, { env: flags, submitMode: true,
      spawn: () => assert.fail("차단한 업체의 Python 실행 금지") });
    assert.deepEqual(result.details, []); assert.match(result.reason, /허용 업체/);
  }
});
