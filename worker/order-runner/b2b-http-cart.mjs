// 이로움·보필 브라우저 없는 HTTP 장바구니 준비 연결부.
// ENABLE_B2B_HTTP_CART가 정확히 "true"일 때만 Python 준비 모듈을 실행한다. 기본값은 꺼짐이며
// 꺼져 있으면 프로세스를 만들지 않으므로 사이트 요청이 0건이다.
// 주문 제출 기능은 없다. 기존 이로움 Playwright 흐름(src/index.ts), 승인 절차, SUBMITTING 잠금,
// 제출 원장, 1행 제한, FINAL_SUBMISSION_APPROVAL_KEY 검증을 불러오거나 바꾸지 않는다.
import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const ENABLE_FLAG = "ENABLE_B2B_HTTP_CART";

// GitHub Actions secret 이름. 값은 저장소에 두지 않는다.
export const CREDENTIAL_SECRETS = Object.freeze({
  eroum: Object.freeze(["EROUM_LOGIN_ID", "EROUM_LOGIN_PASSWORD"]),
  bofeel: Object.freeze(["BOFEEL_LOGIN_ID", "BOFEEL_LOGIN_PASSWORD"]),
});

const here = dirname(fileURLToPath(import.meta.url));
export const PREPARATION_SCRIPT = join(here, "http_preparation.py");
const TIMEOUT_MS = 180_000;
// 자식 프로세스에 넘기는 일반 환경변수. Firebase·승인 키·GitHub 토큰 같은 다른 비밀값은 넘기지 않는다.
const PASSTHROUGH = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "LANG"];

export function isEnabled(env = process.env) {
  return env[ENABLE_FLAG] === "true";
}

export function childEnvironment(vendor, env = process.env) {
  const names = CREDENTIAL_SECRETS[vendor];
  if (!names) throw new Error("지원하지 않는 업체");
  const child = { [ENABLE_FLAG]: env[ENABLE_FLAG], PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
  for (const name of PASSTHROUGH) if (env[name] !== undefined) child[name] = env[name];
  for (const name of names) child[name] = env[name];
  return child;
}

function defaultPython(env) {
  return env.pythonLocation ? join(env.pythonLocation, process.platform === "win32" ? "python.exe" : "bin/python")
    : process.platform === "win32" ? "python" : "python3";
}

/**
 * 업체 하나의 제출 없는 준비를 1회 실행한다. 실패해도 다시 실행하지 않는다.
 * 반환값에는 필드 이름과 판정만 있고 쿠키·토큰·로그인 값·응답 원문은 없다.
 */
export async function runB2bHttpPreparation(vendor, { env = process.env, spawn = nodeSpawn, python } = {}) {
  if (!isEnabled(env)) return { vendor, enabled: false, siteRequests: 0, status: "DISABLED" };
  if (!CREDENTIAL_SECRETS[vendor]) return { vendor, enabled: true, siteRequests: 0, status: "INVALID_VENDOR" };
  const missing = CREDENTIAL_SECRETS[vendor].filter((name) => !env[name]);
  if (missing.length) return { vendor, enabled: true, siteRequests: 0, status: "MISSING_SECRETS", missing };

  const executable = python ?? defaultPython(env);
  return await new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawn(executable, ["-B", "-X", "utf8", PREPARATION_SCRIPT, "--vendor", vendor], {
        cwd: here, env: childEnvironment(vendor, env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
    } catch {
      finish({ vendor, enabled: true, status: "START_FAILED", siteRequests: 0 });
      return;
    }
    // 시간 초과는 결과 불명이다. 장바구니를 사람이 확인해야 하며 다시 실행하지 않는다.
    timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      finish({ vendor, enabled: true, status: "UNCERTAIN_TIMEOUT", cartCheckRequired: true });
    }, TIMEOUT_MS);
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    // stderr에는 서버 원문이 섞일 수 있어 내용을 버리고 출력하지 않는다.
    child.stderr?.on("data", () => {});
    child.on("error", () => finish({ vendor, enabled: true, status: "START_FAILED", siteRequests: 0 }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ vendor, enabled: true, status: "FAILED", exitCode: code, cartCheckRequired: true });
        return;
      }
      const line = stdout.trim().split(/\r?\n/).pop() ?? "";
      let summary;
      try { summary = JSON.parse(line); } catch { summary = null; }
      const valid = summary && typeof summary === "object" && summary.final_empty === true &&
        summary.draft?.valid === true && summary.draft?.submission_allowed === false;
      finish(valid
        ? { vendor, enabled: true, status: "PREPARED_NOT_SUBMITTED", summary }
        : { vendor, enabled: true, status: "FAILED", reason: "결과 형식 미확인", cartCheckRequired: true });
    });
  });
}

async function main(argv) {
  const vendor = argv[0];
  if (!isEnabled()) {
    console.log(JSON.stringify({ enabled: false, siteRequests: 0 }));
    return 0;
  }
  if (!CREDENTIAL_SECRETS[vendor]) {
    console.log(JSON.stringify({ enabled: true, siteRequests: 0, status: "INVALID_VENDOR" }));
    return 1;
  }
  const result = await runB2bHttpPreparation(vendor);
  console.log(JSON.stringify(result));
  return result.status === "PREPARED_NOT_SUBMITTED" ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
