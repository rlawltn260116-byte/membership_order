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
};

type WorkerReport = {
  workerId: string;
  startedAt: string;
  finishedAt: string;
  totalRows: number;
  successRows: number;
  failedRows: number;
  holdRows: number;
  reviewState: "WAITING_FOR_DASHBOARD" | "BLOCKED";
  canSubmit: false;
  details: WorkerDetail[];
};

type ProductMapping = { model: string; productId: string; option?: string };

const productMappings: ProductMapping[] = [
  { model: "DYJ-03", productId: "PRO2022102700012" },
  { model: "DA-006", productId: "PRO2022042900001", option: "COLOR_REQUIRED" },
];

const databaseUrl = process.env.FIREBASE_DATABASE_URL;
if (!databaseUrl) throw new Error("FIREBASE_DATABASE_URL 환경변수가 필요합니다.");
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
if (!serviceAccountJson) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON 환경변수가 필요합니다.");
initializeApp({ credential: cert(JSON.parse(serviceAccountJson)), databaseURL: databaseUrl });
const database = getDatabase();
const queuePath = process.env.FIREBASE_QUEUE_PATH || "order-ops/jobs";
const workerId = process.env.WORKER_ID || `web-worker-${randomUUID()}`;
const now = () => new Date().toISOString();

async function claimJob(jobId: string): Promise<OrderJob | null> {
  let claimed: OrderJob | null = null;
  await database.ref(`${queuePath}/${jobId}`).transaction((value) => {
    const current = value as OrderJob | null;
    if (!current || current.status !== "QUEUED") return;
    claimed = { ...current, id: jobId, status: "RUNNING" };
    return claimed;
  }, undefined, false);
  return claimed;
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
  if (mapping.option === "COLOR_REQUIRED") {
    return { lineNo, status: "HOLD", reason: "DA-006은 색상 옵션(회색/초록) 자동 선택 검증이 아직 필요합니다.", productId: mapping.productId };
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

  const bodyText = await page.locator("body").innerText();
  const inventoryMatch = bodyText.match(/My\s*보유\s*재고[\s\S]{0,80}?(\d+)개/);
  const availableInventory = inventoryMatch ? Number(inventoryMatch[1]) : null;
  if (availableInventory !== null && quantity > availableInventory) {
    return { lineNo, status: "HOLD", reason: `보유 재고 ${availableInventory}개보다 주문수량 ${quantity}개가 많습니다.`, productId: mapping.productId, quantity };
  }

  const unitPrice = Number(await page.locator("#it_price").inputValue());
  const expectedPrice = parseOptionalPrice(row.expectedPrice);
  if (expectedPrice !== null && expectedPrice !== unitPrice) {
    return { lineNo, status: "HOLD", reason: `예상 단가 ${expectedPrice.toLocaleString()}원과 이로움 단가 ${unitPrice.toLocaleString()}원이 다릅니다.`, productId: mapping.productId, unitPrice, quantity };
  }

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
  const stockStatus = await page.locator('input[name="stock_status[]"]').inputValue();
  if (!formValid) return { lineNo, status: "HOLD", reason: "이로움 주문서 필수 입력값 검증을 통과하지 못했습니다.", productId: mapping.productId, unitPrice, quantity, orderFormUrl: page.url() };
  if (stockStatus !== "normal") return { lineNo, status: "HOLD", reason: `이로움 재고 상태가 ${stockStatus}입니다.`, productId: mapping.productId, unitPrice, quantity, orderFormUrl: page.url() };

  const shippingFee = Number(await page.locator("#od_send_cost").inputValue());
  return {
    lineNo,
    status: "READY",
    reason: "상품·수량·재고·배송지 입력 검증 완료. 최종 주문은 제출하지 않았습니다.",
    productId: mapping.productId,
    unitPrice,
    quantity,
    shippingFee,
    totalPrice: unitPrice * quantity + shippingFee,
    orderFormUrl: page.url(),
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
  return {
    workerId,
    startedAt,
    finishedAt: now(),
    totalRows: rows.length,
    successRows,
    failedRows,
    holdRows,
    reviewState: failedRows || holdRows ? "BLOCKED" : "WAITING_FOR_DASHBOARD",
    canSubmit: false,
    details,
  };
}

async function runOnce() {
  const snapshot = await database.ref(queuePath).orderByChild("status").equalTo("QUEUED").limitToFirst(10).get();
  if (!snapshot.exists()) {
    console.log("Queue empty");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    for (const jobId of Object.keys((snapshot.val() ?? {}) as Record<string, unknown>)) {
      const job = await claimJob(jobId);
      if (!job) continue;
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
            detail: `총 ${report.totalRows}건 · 성공 ${report.successRows}건 · 실패 ${report.failedRows}건 · 보류 ${report.holdRows}건 · 최종 주문 미실행`,
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
