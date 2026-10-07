import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const outputPath = resolve(process.cwd(), "eroum-storage-state.json");
const browser = await chromium.launch({ headless: false, channel: "chrome" });
const context = await browser.newContext();
const page = await context.newPage();

console.log("이로움 로그인 창을 열었습니다. 아이디와 비밀번호는 사용자가 직접 입력하세요.");
await page.goto("https://eroumcare.com/bbs/login.php", {
  waitUntil: "domcontentloaded",
  timeout: 30_000,
});

const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
  const currentUrl = page.url();
  const loggedIn = !currentUrl.includes("/bbs/login.php") &&
    (await page.locator('a[href*="logout"], a:has-text("로그아웃")').count()) > 0;
  if (loggedIn) {
    const state = await context.storageState();
    await writeFile(outputPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    console.log(`LOGIN_CAPTURED ${outputPath}`);
    // Copy to the clipboard so it can be pasted straight into the GitHub secret.
    const clip = process.platform === "win32" ? ["clip", []] : process.platform === "darwin" ? ["pbcopy", []] : null;
    if (clip) {
      const copied = spawnSync(clip[0], clip[1], { input: JSON.stringify(state), shell: process.platform === "win32" });
      if (copied.status === 0) console.log("로그인 세션을 클립보드에 복사했습니다. GitHub의 EROUM_STORAGE_STATE_JSON 비밀값 칸에 Ctrl+V 하세요.");
    }
    await browser.close();
    process.exit(0);
  }
  await page.waitForTimeout(1000);
}

console.error("로그인 대기 시간이 만료되었습니다.");
await browser.close();
process.exit(1);
