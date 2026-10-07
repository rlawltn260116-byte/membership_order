import { cert, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { chromium, type Browser, type Page } from "playwright";
import { randomUUID } from "node:crypto";

type RowStatus = "READY" | "HOLD" | "FAILED";

type OrderRow = {
  lineNo?: number;
  sourceSystem?: string;
  orderId?: string;
  productName?: string;
  option?: string;
  quantity?: string | number;
  expectedPrice?: string | number;
  recipientName?: string;
  recipientPhone?: string;
  zipcode?: string;
  address?: string;
  addressDetail?: string;
  memo?: string;
  status?: RowStatus;
  reason?: string;
};

type OrderJob = { id: string; sourceSystem?: string; status?: string; rows?: OrderRow[] };

type WorkerDetail = {
  lineNo: number;
  status: RowStatus;
  reason: string;
  productId?: string;
  unitPrice?: number;
  quantity?: number;
  shippingFee?: number;
  totalPrice?: number;
  orderFormUrl?: string;
  shippingNotes?: string[];
};

type WorkerReport = {
  workerId: string;
  startedAt: string;
  finishedAt: string;
  totalRows: number;
  successRows: number;
  failedRows: number;
  holdRows: number;
  shippingNoticeRows: number;
  reviewState: "WAITING_FOR_DASHBOARD" | "BLOCKED";
  canSubmit: false;
  details: WorkerDetail[];
};

type ProductMapping = { model: string; productId: string; option?: string };

const productMappings: ProductMapping[] = [
  { model: "DYJ-03", productId: "PRO2022102700012" },
  { model: "DA-006", productId: "PRO2022042900001", option: "COLOR_REQUIRED" },
];

// Surface failures as GitHub annotations (readable without downloading logs).
// Never include raw secret values: only fixed messages or sanitized error text.
function annotateError(title: string, message: string) {
  const safe = message.replace(/[\r\n]+/g, " ").slice(0, 300);
  console.error(`::error title=${title}::${safe}`);
}

function configError(message: string): never {
  annotateError("주문 워커 설정 오류", message);
  process.exit(1);
}

const databaseUrl = process.env.FIREBASE_DATABASE_URL;
if (!databaseUrl) configError("FIREBASE_DATABASE_URL 환경변수가 필요합니다.");
if (!/^https:\/\/.+\.(firebaseio\.com|firebasedatabase\.app)\/?$/.test(databaseUrl.trim())) {
  configError("FIREBASE_DATABASE_URL 형식이 올바르지 않습니다 (https://<프로젝트>-default-rtdb.<지역>.firebasedatabase.app 형태여야 합니다).");
}
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) configError("FIREBASE_SERVICE_ACCOUNT_JSON 환경변수가 필요합니다.");
let serviceAccount: Record<string, unknown>;
try {
  serviceAccount = JSON.parse(serviceAccountJson) as Record<string, unknown>;
} catch {
  configError("FIREBASE_SERVICE_ACCOUNT_JSON 이 올바른 JSON 형식이 아닙니다 (파일 내용 전체를 붙여넣었는지 확인하세요).");
}
try {
  initializeApp({ credential: cert(serviceAccount as never), databaseURL: databaseUrl.trim() });
} catch (error) {
  configError(`Firebase 서비스 계정 키가 올바르지 않습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
}
const database = getDatabase();
const queuePath = process.env.FIREBASE_QUEUE_PATH || "order-ops/jobs";
const workerId = process.env.WORKER_ID || `web-worker-${randomUUID()}`;
const now = () => new Date().toISOString();

async function claimJob(jobId: string): Promise<OrderJob | null> {
  let claimed: OrderJob | null = null;
  await database.ref(`${queuePath}/${jobId}`).transaction((value) => {
    // First invocation may see an empty local cache (null). Returning null makes
    // Firebase retry with the real server value instead of aborting the claim.
    if (value === null) return value;
    const current = value as OrderJob | null;
    if (!current || current.status !== "QUEUED") return;
    claimed = { ...current, id: jobId, status: "RUNNING" };
    return claimed;
  }, undefined, false);
  return claimed;
}

const colorAliases: Record<string, string[]> = {
  회색: ["회색", "그레이", "grey", "gray"],
  초록: ["초록", "그린", "녹색", "green"],
  블랙: ["블랙", "검정", "검은색", "black"],
  블루: ["블루", "파랑", "파란색", "blue"],
  레드: ["레드", "빨강", "빨간색", "red"],
  와인: ["와인", "wine"],
};

function canonicalColor(value: string): string {
  const text = value.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(colorAliases)) {
    if (aliases.some((alias) => text.includes(alias.toLowerCase()))) return canonical;
  }
  return text;
}

// Option comes from the sheet's option/color column; fall back to a color written in the product name,
// e.g. "DA-006(초록)" or "미끄럼방지매트리스 DA-006 / 회색".
function resolveWantedOption(row: OrderRow): string {
  const explicit = (row.option ?? "").trim();
  if (explicit) return explicit;
  const name = row.productName ?? "";
  const paren = name.match(/\(([^)]+)\)/);
  if (paren) return paren[1].trim();
  const slash = name.split("/");
  if (slash.length > 1) return slash[slash.length - 1].trim();
  return "";
}

// Eroum has no real inventory (the "My 보유 재고" figure is the buyer's own past orders), so stock is never a
// reason to hold. What matters is shipping status: delays, scheduled dates, schedule pending, sold-out notices.
const shippingPatterns: RegExp[] = [
  /출고\s*지연/,
  /\d{1,2}\s*[\/.월]\s*\d{1,2}\s*일?\s*(?:\([^)]*\))?\s*출고\s*(?:예정|가능)/,
  /출고\s*(?:예정|일정)\s*(?:일\s*)?(?:확인|미정)/,
  /(?:출고|배송)\s*일정\s*확인\s*중/,
  /입고\s*(?:예정|지연)/,
  /일시\s*품절|품절|예약\s*가능/,
];

function detectShippingNotes(...sources: string[]): string[] {
  const notes: string[] = [];
  for (const source of sources) {
    const lines = source.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      // Join with the next line: the label and the date are often on separate lines.
      const windowText = lines[i].length > 120 ? lines[i] : `${lines[i]} ${lines[i + 1] ?? ""}`.trim();
      if (windowText.length > 160) continue;
      for (const pattern of shippingPatterns) {
        const found = windowText.match(pattern)?.[0]?.replace(/\s+/g, " ").trim();
        if (found && !notes.includes(found)) notes.push(found);
      }
      if (notes.length >= 6) return notes.slice(0, 6);
    }
  }
  return notes;
}

type OptionPick = { ok: true; label: string } | { ok: false; reason: string };

async function selectEroumOption(page: Page, wanted: string): Promise<OptionPick> {
  const target = canonicalColor(wanted);
  const selects = page.locator('select[name^="it_option_"]:visible, select.it_option:visible');
  const selectCount = await selects.count();
  if (selectCount === 0) {
    return { ok: false, reason: "이로움 상품 페이지에서 옵션 선택 목록을 찾지 못했습니다." };
  }
  const select = selects.first();
  const options = await select.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({ value: (node as HTMLOptionElement).value, text: (node.textContent ?? "").replace(/\s+/g, " ").trim(), disabled: (node as HTMLOptionElement).disabled })),
  );
  const candidates = options.filter((option) => option.value !== "");
  const match = candidates.find((option) => canonicalColor(option.text) === target) ?? candidates.find((option) => canonicalColor(option.text).includes(target) || option.text.includes(wanted));
  if (!match) {
    const available = candidates.map((option) => option.text.slice(0, 30)).slice(0, 8).join(" | ");
    return { ok: false, reason: `이로움에서 옵션 "${wanted}"을(를) 찾지 못했습니다. 선택 가능한 옵션: ${available || "없음"}` };
  }
  if (match.disabled) {
    return { ok: false, reason: `옵션 "${match.text}"은(는) 선택할 수 없는 상태입니다.` };
  }
  // selectOption fires real input/change events, which the shop's jQuery handler needs to add the option row.
  await select.selectOption({ value: match.value });
  return { ok: true, label: match.text };
}

function parsePositiveInteger(value: string | number | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseOptionalPrice(value: string | number | undefined): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function findProductMapping(productName = ""): ProductMapping | null {
  const normalized = productName.toUpperCase().replace(/\s+/g, "");
  return productMappings.find((mapping) => normalized.includes(mapping.model)) ?? null;
}

async function setReadonlyInput(page: Page, selector: string, value: string): Promise<void> {
  await page.locator(selector).evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    input.value = nextValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function prepareEroumRow(page: Page, row: OrderRow, index: number): Promise<WorkerDetail> {
  const lineNo = row.lineNo ?? index + 1;
  if (row.status !== "READY") {
    return { lineNo, status: "HOLD", reason: row.reason || "대시보드 검증에서 확인 대상으로 분류되었습니다." };
  }

  const mapping = findProductMapping(row.productName);
  if (!mapping) return { lineNo, status: "HOLD", reason: "이로움 상품 코드 매핑을 찾지 못했습니다." };
  const wantedOption = mapping.option === "COLOR_REQUIRED" ? resolveWantedOption(row) : "";
  if (mapping.option === "COLOR_REQUIRED" && !wantedOption) {
    return { lineNo, status: "HOLD", reason: "색상(옵션) 값이 없습니다. 주문 파일에 option(색상) 열을 넣어 주세요.", productId: mapping.productId };
  }

  const quantity = parsePositiveInteger(row.quantity);
  if (!quantity) return { lineNo, status: "HOLD", reason: "주문수량이 올바른 양의 정수가 아닙니다.", productId: mapping.productId };
  if (!row.recipientName || !row.recipientPhone || !row.zipcode || !row.address) {
    return { lineNo, status: "HOLD", reason: "수취인, 연락처, 우편번호 또는 배송지가 누락되었습니다.", productId: mapping.productId };
  }

  await page.goto(`https://eroumcare.com/shop/item.php?it_id=${mapping.productId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  if (page.url().includes("/bbs/login.php") || await page.getByText("로그인", { exact: true }).count()) {
    return { lineNo, status: "HOLD", reason: "이로움 로그인 세션이 만료되었습니다.", productId: mapping.productId };
  }

  const unitPrice = Number(await page.locator("#it_price").inputValue());
  const expectedPrice = parseOptionalPrice(row.expectedPrice);
  if (expectedPrice !== null && expectedPrice !== unitPrice) {
    return { lineNo, status: "HOLD", reason: `예상 단가 ${expectedPrice.toLocaleString()}원과 이로움 단가 ${unitPrice.toLocaleString()}원이 다릅니다.`, productId: mapping.productId, unitPrice, quantity };
  }

  let optionLabel: string | undefined;
  // Prefer the product summary block over the whole page so menus/filters don't create false shipping notices.
  const productText = async () => {
    for (const selector of ["#sit_ov_wrap", ".sit_ov_wrap", "#sit_ov", ".sit_ov", "#sit_hd"]) {
      const locator = page.locator(selector).first();
      if (await locator.count()) return locator.innerText();
    }
    return page.locator("body").innerText();
  };
  if (wantedOption) {
    const picked = await selectEroumOption(page, wantedOption);
    if (!picked.ok) return { lineNo, status: "HOLD", reason: picked.reason, productId: mapping.productId, quantity };
    optionLabel = picked.label;
    await page.locator(`input[name="ct_qty[${mapping.productId}][]"]:visible`).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  const itemPageText = await productText();
  await page.locator(`input[name="ct_qty[${mapping.productId}][]"]:visible`).first().fill(String(quantity));
  await page.locator('input[type="submit"][value="상품주문"]:visible').first().click();
  await page.waitForURL("**/simple_order.php**", { timeout: 30_000 });

  await page.locator("#od_b_name").fill(row.recipientName);
  await page.locator("#od_b_tel").fill(row.recipientPhone);
  await page.locator("#od_b_hp").fill(row.recipientPhone);
  await setReadonlyInput(page, "#od_b_zip", row.zipcode);
  await setReadonlyInput(page, "#od_b_addr1", row.address);
  await setReadonlyInput(page, "#od_b_addr2", row.addressDetail ?? "");
  await page.locator("#od_memo").fill(row.memo || row.orderId || "");

  const formValid = await page.locator("#simple_order").evaluate((form) => (form as HTMLFormElement).checkValidity());
  if (!formValid) return { lineNo, status: "HOLD", reason: "이로움 주문서 필수 입력값 검증을 통과하지 못했습니다.", productId: mapping.productId, unitPrice, quantity, orderFormUrl: page.url() };
  const orderPageText = await page.locator("body").innerText();
  const shippingNotes = detectShippingNotes(optionLabel ?? "", itemPageText, orderPageText);

  const shippingFee = Number(await page.locator("#od_send_cost").inputValue());
  return {
    lineNo,
    status: "READY",
    reason: `상품${optionLabel ? `·옵션(${optionLabel})` : ""}·수량·배송지 입력 검증 완료. 최종 주문은 제출하지 않았습니다.${shippingNotes.length ? ` 출고 확인 필요: ${shippingNotes.join(" / ")}` : ""}`,
    productId: mapping.productId,
    unitPrice,
    quantity,
    shippingFee,
    totalPrice: unitPrice * quantity + shippingFee,
    orderFormUrl: page.url(),
    shippingNotes,
  };
}

async function prepareReport(job: OrderJob, browser: Browser): Promise<WorkerReport> {
  const startedAt = now();
  const rows = job.rows ?? [];
  const serialized = process.env.EROUM_STORAGE_STATE_JSON;
  const details: WorkerDetail[] = [];

  if (!serialized) {
    for (const [index, row] of rows.entries()) details.push({ lineNo: row.lineNo ?? index + 1, status: "HOLD", reason: "서버에 이로움 로그인 세션이 설정되지 않았습니다." });
  } else {
    let storageState: NonNullable<Parameters<Browser["newContext"]>[0]>["storageState"];
    try {
      storageState = JSON.parse(serialized) as NonNullable<typeof storageState>;
    } catch {
      storageState = undefined;
      for (const [index, row] of rows.entries()) details.push({ lineNo: row.lineNo ?? index + 1, status: "HOLD", reason: "서버 로그인 세션 형식이 올바르지 않습니다." });
    }

    if (details.length === 0) {
      const context = await browser.newContext({ storageState });
      try {
        const page = await context.newPage();
        for (const [index, row] of rows.entries()) {
          if (job.sourceSystem !== "이로움" && row.sourceSystem !== "이로움") {
            details.push({ lineNo: row.lineNo ?? index + 1, status: "HOLD", reason: "현재 워커는 이로움 채널만 지원합니다." });
            continue;
          }
          try {
            details.push(await prepareEroumRow(page, row, index));
          } catch (error) {
            details.push({ lineNo: row.lineNo ?? index + 1, status: "FAILED", reason: `이로움 주문서 준비 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}` });
          }
        }
      } finally {
        await context.close();
      }
    }
  }

  const successRows = details.filter((entry) => entry.status === "READY").length;
  const failedRows = details.filter((entry) => entry.status === "FAILED").length;
  const holdRows = details.filter((entry) => entry.status === "HOLD").length;
  const shippingNoticeRows = details.filter((entry) => (entry.shippingNotes?.length ?? 0) > 0).length;
  return {
    workerId,
    startedAt,
    finishedAt: now(),
    totalRows: rows.length,
    successRows,
    failedRows,
    holdRows,
    shippingNoticeRows,
    reviewState: failedRows || holdRows ? "BLOCKED" : "WAITING_FOR_DASHBOARD",
    canSubmit: false,
    details,
  };
}

async function runOnce() {
  // orderByKey needs no ".indexOn" rule; filter QUEUED jobs on the client side.
  const recent = await database.ref(queuePath).orderByKey().limitToLast(100).get();
  const queuedIds: string[] = [];
  recent.forEach((child) => {
    if ((child.val() as { status?: string } | null)?.status === "QUEUED") queuedIds.push(child.key as string);
    return false;
  });
  console.log(`::notice title=주문 워커::큐 조회 ${recent.numChildren()}건 중 실행 대기 ${queuedIds.length}건`);
  if (queuedIds.length === 0) {
    console.log("Queue empty");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    for (const jobId of queuedIds.slice(0, 10)) {
      const job = await claimJob(jobId);
      if (!job) {
        console.log(`::warning title=주문 워커::작업 ${jobId} 선점에 실패했습니다 (다른 워커가 처리 중이거나 상태가 바뀜).`);
        continue;
      }
      try {
        const report = await prepareReport(job, browser);
        const auditKey = database.ref(`${queuePath}/${jobId}/auditLogs`).push().key ?? randomUUID();
        await database.ref(`${queuePath}/${jobId}`).update({
          status: report.failedRows || report.holdRows ? "HOLD" : "AWAITING_REVIEW",
          updatedAt: report.finishedAt,
          workerId,
          report,
          dashboardReview: { state: report.reviewState, required: true, finalSubmissionApproved: false, updatedAt: report.finishedAt },
          [`auditLogs/${auditKey}`]: {
            id: auditKey,
            jobId,
            action: "BACKGROUND_RUN_FINISHED",
            actorName: "서버 자동화 워커",
            actorEmail: "",
            detail: `총 ${report.totalRows}건 · 성공 ${report.successRows}건 · 실패 ${report.failedRows}건 · 보류 ${report.holdRows}건 · 출고 확인 필요 ${report.shippingNoticeRows}건 · 최종 주문 미실행`,
            createdAt: report.finishedAt,
          },
        });
        console.log(`Finished job ${jobId}: success=${report.successRows} failed=${report.failedRows} hold=${report.holdRows}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "알 수 없는 워커 오류";
        await database.ref(`${queuePath}/${jobId}`).update({ status: "FAILED", updatedAt: now(), workerId, error: message });
      }
    }
  } finally {
    await browser.close();
  }
}

runOnce()
  .catch((error: unknown) => {
    annotateError("주문 워커 실행 오류", error instanceof Error ? `${error.name}: ${error.message}` : "알 수 없는 오류");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Firebase Realtime Database keeps a socket open, so exit explicitly
    // instead of letting the GitHub Actions job hang until its timeout.
    database.goOffline();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
    process.exit(process.exitCode ?? 0);
  });
