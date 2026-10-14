import { cert, initializeApp } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { chromium, type Browser, type Page } from "playwright";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

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

type ExecutionMode = "PREPARE" | "SUBMIT";

type OrderJob = {
  id: string;
  sourceSystem?: string;
  status?: string;
  executionMode?: ExecutionMode;
  rows?: OrderRow[];
  dashboardReview?: {
    decision?: "ACCEPTED" | "ON_HOLD";
    finalSubmissionApproved?: boolean;
    finalSubmissionApprovedAt?: string;
    submissionRequestId?: string;
    approvalProof?: string;
  };
};

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
  orderNumber?: string;
  submittedAt?: string;
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
  submittedRows: number;
  reviewState: "WAITING_FOR_DASHBOARD" | "BLOCKED" | "COMPLETED";
  canSubmit: boolean;
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
    if (!current || !["QUEUED", "SUBMIT_QUEUED"].includes(current.status ?? "")) return;
    const executionMode: ExecutionMode = current.status === "SUBMIT_QUEUED" ? "SUBMIT" : "PREPARE";
    claimed = { ...current, id: jobId, status: "RUNNING", executionMode };
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

// Eroum has no real inventory (the "내 보유 재고" figure is the buyer's own past orders), so stock is never a reason
// to hold. What matters is the orange shipping banner shown on the product. Seen so far:
//   "10/12 출고 예정", "10월 초 출고 예정", "10월 중순 출고 예정", "출고 일정 확인 중",
//   and per-option / per-part banners: "회색 : 10/8 출고 예정", "롱젠손잡이 : 출고일정 확인중".
const shippingStatusSource =
  "(?:출고\\s*지연|\\d{1,2}\\s*[\\/.월]\\s*(?:\\d{1,2}\\s*일?|\\d(?:~\\d)?\\s*주차|중순|하순|상순|초|중|말)?\\s*(?:\\([^)]*\\))?\\s*출고\\s*(?:예정|가능)|(?:[출츨]고|배송)\\s*(?:예정\\s*)?일정?\\s*(?:일\\s*)?(?:확인|미정)\\s*중?|입고\\s*(?:예정|지연)|일시\\s*품절|품절|예약\\s*가능)";
const bannerPattern = new RegExp(`([가-힣A-Za-z0-9()\\-][가-힣A-Za-z0-9 ()\\-]{0,22}?)\\s*[:：]\\s*(${shippingStatusSource})`, "g");
const barePattern = new RegExp(shippingStatusSource, "g");

type ShippingNote = { target: string; status: string };

function formatShippingNote(note: ShippingNote): string {
  return note.target ? `${note.target} : ${note.status}` : note.status;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// A banner is a short standalone line. Requiring almost nothing besides the matched text keeps menu items and
// long sentences that merely mention shipping from being reported.
function isBannerLike(line: string, matched: string, extraAllowed: number): boolean {
  return normalizeSpaces(line.replace(matched, "")).length <= extraAllowed;
}

function detectShippingNotes(sources: string[]): ShippingNote[] {
  const notes: ShippingNote[] = [];
  const add = (note: ShippingNote) => {
    const duplicate = notes.some((existing) => existing.status === note.status && (existing.target === note.target || !note.target || !existing.target));
    if (!duplicate) notes.push(note);
  };
  for (const source of sources) {
    const lines = source.split(/\r?\n/).map(normalizeSpaces).filter(Boolean);
    // Each line on its own. A "회색 :" line followed by its status on the next line is joined; other neighbours are
    // not, so a product name above a banner never leaks into the option label.
    const candidates = lines.flatMap((line, i) => (/[:：]$/.test(line) && lines[i + 1] ? [line, `${line} ${lines[i + 1]}`] : [line]));
    for (const candidate of candidates) {
      if (candidate.length > 80) continue;
      for (const match of candidate.matchAll(bannerPattern)) {
        if (isBannerLike(candidate, match[0], 6)) add({ target: normalizeSpaces(match[1]), status: normalizeSpaces(match[2]) });
      }
    }
    for (const candidate of candidates) {
      if (candidate.length > 80) continue;
      for (const match of candidate.matchAll(barePattern)) {
        if (isBannerLike(candidate, match[0], 6)) add({ target: "", status: normalizeSpaces(match[0]) });
      }
    }
  }
  return notes.filter((note, index) => !(note.target === "" && notes.some((other, j) => j !== index && other.target !== "" && other.status === note.status))).slice(0, 8);
}

// On the product page the orange banner always sits in `.item-expected-warehousing-date`, and the status badges
// (출고지연, 일시품절, 예약가능 ...) in `.it_type_box .p_box`. Reading those two places directly is more reliable than
// scanning the whole page, which also lists other products. Everything inside the banner container is kept as a note,
// so formats we have not seen yet (e.g. "화,목 출고 가능", "출고까지 7~10일 소요") are still reported.
const badgeExact = new RegExp(`^(?:${shippingStatusSource})$`);

function parseBannerContainer(text: string): ShippingNote[] {
  const notes: ShippingNote[] = [];
  for (const line of text.split(/\r?\n/).map(normalizeSpaces).filter(Boolean)) {
    const labelled = [...line.matchAll(/([^:：]+?)\s*[:：]\s*([^:：]+?)(?=\s*[,，]\s*[^,，:：]{1,30}[:：]|$)/g)];
    if (labelled.length === 0) {
      notes.push({ target: "", status: line });
      continue;
    }
    for (const match of labelled) {
      const target = normalizeSpaces(match[1].replace(/^[\s,，]+/, ""));
      const status = normalizeSpaces(match[2]);
      if (status) notes.push({ target, status });
    }
  }
  return notes;
}

async function readProductShippingNotes(page: Page): Promise<ShippingNote[]> {
  const { banners, badges } = await page.evaluate(() => {
    const visibleTexts = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector))
        .filter((element) => element.offsetParent !== null || element.getClientRects().length > 0)
        .map((element) => element.innerText);
    return { banners: visibleTexts(".item-expected-warehousing-date"), badges: visibleTexts(".it_type_box .p_box") };
  });
  const notes = banners.flatMap(parseBannerContainer);
  for (const badge of badges.map(normalizeSpaces)) {
    if (badgeExact.test(badge)) notes.push({ target: "", status: badge });
  }
  return notes.filter((note, index) => notes.findIndex((other) => other.target === note.target && other.status === note.status) === index);
}

// A banner that names a specific option (e.g. "회색") only matters when that option is what we are ordering.
function bannerAppliesToOption(note: ShippingNote, wantedOption: string): boolean {
  if (!wantedOption || !note.target) return true;
  const wanted = canonicalColor(wantedOption);
  const withoutParens = note.target.replace(/\([^)]*\)/g, "");
  return withoutParens
    .split(/[,，/]/)
    .map((token) => token.trim())
    .filter(Boolean)
    .some((token) => canonicalColor(token) === wanted || token.includes(wantedOption) || wantedOption.includes(token));
}

type OptionPick = { ok: true; label: string; tags: string[] } | { ok: false; reason: string };

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
  const candidates = options
    .filter((option) => option.value !== "")
    .map((option) => ({ ...option, text: option.text, plain: normalizeSpaces(option.text.replace(/\[[^\]]*\]/g, "")) }));
  const match = candidates.find((option) => canonicalColor(option.plain) === target) ?? candidates.find((option) => canonicalColor(option.plain).includes(target) || option.plain.includes(wanted));
  if (!match) {
    const available = candidates.map((option) => option.text.slice(0, 30)).slice(0, 8).join(" | ");
    return { ok: false, reason: `이로움에서 옵션 "${wanted}"을(를) 찾지 못했습니다. 선택 가능한 옵션: ${available || "없음"}` };
  }
  if (match.disabled) {
    return { ok: false, reason: `옵션 "${match.text}"은(는) 선택할 수 없는 상태입니다.` };
  }
  // Eroum only adds the option row when the select saw a mouseup first (option_add flag), which selectOption never fires.
  await select.dispatchEvent("mouseup");
  await select.selectOption({ value: match.value });
  const rowAdded = await page
    .locator("li.it_opt_list")
    .first()
    .waitFor({ state: "attached", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!rowAdded) {
    // Fallback: call the shop's own function so the option row (and quantity input) is created.
    await page.evaluate(() => (window as unknown as { sel_option_process?: (add: boolean) => void }).sel_option_process?.(true));
  }
  const tags = Array.from(match.text.matchAll(/\[([^\]]+)\]/g), (m) => normalizeSpaces(m[1]));
  return { ok: true, label: normalizeSpaces(match.text.replace(/\[[^\]]*\]/g, "")), tags };
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

type SubmissionRowState = {
  state: "SUBMITTING" | "SUBMITTED" | "UNKNOWN";
  attemptId: string;
  startedAt: string;
  submittedAt?: string;
  orderNumber?: string;
  resultUrl?: string;
  reason?: string;
};

async function reserveSubmission(jobId: string, lineNo: number): Promise<{ reserved: boolean; value: SubmissionRowState }> {
  const ref = database.ref(`${queuePath}/${jobId}/submission/rows/${lineNo}`);
  const attemptId = randomUUID();
  const startedAt = now();
  let reserved = false;
  const result = await ref.transaction((value) => {
    const current = value as SubmissionRowState | null;
    if (current?.state) return;
    reserved = true;
    return { state: "SUBMITTING", attemptId, startedAt } satisfies SubmissionRowState;
  }, undefined, false);
  const value = result.snapshot.val() as SubmissionRowState | null;
  if (!value) throw new Error("주문 제출 잠금 상태를 저장하지 못했습니다.");
  return { reserved, value };
}

async function reserveTrustedSubmissionRequest(requestId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const token = process.env.GITHUB_TOKEN ?? "";
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  if (!token || !repository) return { ok: false, reason: "서버의 중복 주문 방지 저장소가 설정되지 않았습니다." };
  const variableName = "USED_SUBMISSION_REQUESTS";
  const baseUrl = `https://api.github.com/repos/${repository}/actions/variables`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "membership-order-worker",
  };
  const existing = await fetch(`${baseUrl}/${variableName}`, { headers });
  let used: string[] = [];
  if (existing.ok) {
    const payload = await existing.json() as { value?: string };
    try {
      const parsed = JSON.parse(payload.value ?? "[]") as unknown;
      used = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
      return { ok: false, reason: "서버의 중복 주문 방지 기록 형식이 올바르지 않습니다." };
    }
  } else if (existing.status !== 404) {
    return { ok: false, reason: `서버의 중복 주문 방지 기록을 읽지 못했습니다 (${existing.status}).` };
  }
  if (used.includes(requestId)) {
    return { ok: false, reason: "이미 사용된 최종 승인 요청입니다. 중복 주문 방지를 위해 다시 제출하지 않았습니다." };
  }
  const value = JSON.stringify([...used.slice(-499), requestId]);
  const saved = existing.status === 404
    ? await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify({ name: variableName, value }) })
    : await fetch(`${baseUrl}/${variableName}`, { method: "PATCH", headers, body: JSON.stringify({ name: variableName, value }) });
  if (!saved.ok) return { ok: false, reason: `서버의 중복 주문 방지 기록을 저장하지 못했습니다 (${saved.status}).` };
  return { ok: true };
}

async function submitEroumOrder(page: Page, jobId: string, lineNo: number, requestId: string): Promise<{ ok: true; orderNumber: string; submittedAt: string } | { ok: false; reason: string }> {
  const form = page.locator("#simple_order");
  const candidates = form.locator('button[type="submit"]:visible, input[type="submit"]:visible');
  let finalButton = candidates.nth(-1);
  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    const label = normalizeSpaces((await candidate.getAttribute("value")) ?? (await candidate.innerText().catch(() => "")));
    if (/주문|결제|확정/.test(label)) {
      finalButton = candidate;
      break;
    }
  }
  if (await candidates.count() === 0 || !(await finalButton.count())) {
    return { ok: false, reason: "이로움 주문서에서 최종 주문 버튼을 찾지 못했습니다. 실제 주문은 실행하지 않았습니다." };
  }

  const trustedReservation = await reserveTrustedSubmissionRequest(requestId);
  if (!trustedReservation.ok) return trustedReservation;
  const reservation = await reserveSubmission(jobId, lineNo);
  if (!reservation.reserved) {
    if (reservation.value.state === "SUBMITTED" && reservation.value.orderNumber && reservation.value.submittedAt) {
      return { ok: true, orderNumber: reservation.value.orderNumber, submittedAt: reservation.value.submittedAt };
    }
    return { ok: false, reason: "이 주문은 이전 제출 시도가 완료되지 않았거나 결과 확인이 필요합니다. 중복 주문 방지를 위해 자동 재시도하지 않았습니다." };
  }

  const submissionRef = database.ref(`${queuePath}/${jobId}/submission/rows/${lineNo}`);
  const candidateOrderNumber = new URL(page.url()).searchParams.get("od_id") ?? "";
  try {
    page.once("dialog", (dialog) => dialog.accept());
    const beforeUrl = page.url();
    await finalButton.click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    const afterUrl = page.url();
    const formStillPresent = await page.locator("#simple_order").count() > 0;
    const bodyText = normalizeSpaces(await page.locator("body").innerText());
    const successText = /주문(?:이|이 정상적으로)?\s*(?:완료|접수)|주문\s*번호/.test(bodyText);
    if ((afterUrl === beforeUrl && formStillPresent) || (!successText && formStillPresent)) {
      const reason = "최종 버튼 실행 후 주문 완료 화면을 확인하지 못했습니다. 이로움 주문관리에서 주문번호를 확인하기 전에는 재실행하지 마세요.";
      await submissionRef.update({ state: "UNKNOWN", reason, resultUrl: afterUrl });
      return { ok: false, reason };
    }
    const bodyOrderNumber = bodyText.match(/주문\s*번호\s*[:：]?\s*([A-Za-z0-9-]{8,})/)?.[1] ?? "";
    const orderNumber = bodyOrderNumber || new URL(afterUrl).searchParams.get("od_id") || candidateOrderNumber;
    if (!orderNumber) {
      const reason = "주문 완료 화면은 확인했지만 주문번호를 읽지 못했습니다. 이로움 주문관리에서 확인이 필요합니다.";
      await submissionRef.update({ state: "UNKNOWN", reason, resultUrl: afterUrl });
      return { ok: false, reason };
    }
    const submittedAt = now();
    await submissionRef.update({ state: "SUBMITTED", submittedAt, orderNumber, resultUrl: afterUrl });
    return { ok: true, orderNumber, submittedAt };
  } catch (error) {
    const reason = `최종 제출 중 결과가 불명확해졌습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}. 중복 주문 방지를 위해 자동 재시도하지 않습니다.`;
    await submissionRef.update({ state: "UNKNOWN", reason, resultUrl: page.url() }).catch(() => undefined);
    return { ok: false, reason };
  }
}

async function prepareEroumRow(page: Page, row: OrderRow, index: number, jobId: string, submitApproved: boolean, submissionRequestId: string): Promise<WorkerDetail> {
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
  let optionTagNotes: ShippingNote[] = [];
  // Prefer the product summary block over the whole page so menus/filters don't create false shipping notices.
  if (wantedOption) {
    const picked = await selectEroumOption(page, wantedOption);
    if (!picked.ok) return { lineNo, status: "HOLD", reason: picked.reason, productId: mapping.productId, quantity };
    optionLabel = picked.label;
    optionTagNotes = picked.tags.filter((tag) => badgeExact.test(tag)).map((tag) => ({ target: picked.label, status: tag }));
    await page.locator(`input[name="ct_qty[${mapping.productId}][]"]:visible`).first().waitFor({ state: "visible", timeout: 10_000 });
  }
  const productShippingNotes = await readProductShippingNotes(page);
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
  const shippingNotes = [...productShippingNotes, ...optionTagNotes, ...detectShippingNotes([orderPageText])]
    .filter((note) => bannerAppliesToOption(note, wantedOption))
    .map(formatShippingNote);

  const shippingFee = Number(await page.locator("#od_send_cost").inputValue());
  const preparedDetail: WorkerDetail = {
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
  if (!submitApproved) return preparedDetail;

  const submitted = await submitEroumOrder(page, jobId, lineNo, submissionRequestId);
  if (!submitted.ok) {
    return { ...preparedDetail, status: "HOLD", reason: submitted.reason };
  }
  return {
    ...preparedDetail,
    reason: `이로움 주문 제출 완료. 주문번호 ${submitted.orderNumber}.${shippingNotes.length ? ` 출고 확인 필요: ${shippingNotes.join(" / ")}` : ""}`,
    orderNumber: submitted.orderNumber,
    submittedAt: submitted.submittedAt,
  };
}

async function prepareReport(job: OrderJob, browser: Browser): Promise<WorkerReport> {
  const startedAt = now();
  const rows = job.rows ?? [];
  const submitMode = job.executionMode === "SUBMIT";
  const approvalKey = process.env.FINAL_SUBMISSION_APPROVAL_KEY ?? "";
  const approvalMaterial = `${job.id}:${job.dashboardReview?.submissionRequestId ?? ""}:${approvalKey}`;
  const expectedProof = createHash("sha256").update(approvalMaterial).digest("hex");
  const suppliedProof = job.dashboardReview?.approvalProof ?? "";
  const finalApprovedAt = Date.parse(job.dashboardReview?.finalSubmissionApprovedAt ?? "");
  const finalApprovalFresh = Number.isFinite(finalApprovedAt) && Date.now() - finalApprovedAt <= 30 * 60 * 1000;
  const approvalProofValid =
    expectedProof.length === suppliedProof.length &&
    timingSafeEqual(Buffer.from(expectedProof), Buffer.from(suppliedProof));
  const submitApproved =
    submitMode &&
    rows.length === 1 &&
    approvalKey.length >= 12 &&
    approvalProofValid &&
    job.dashboardReview?.decision === "ACCEPTED" &&
    job.dashboardReview?.finalSubmissionApproved === true &&
    finalApprovalFresh &&
    Boolean(job.dashboardReview?.submissionRequestId);
  const serialized = process.env.EROUM_STORAGE_STATE_JSON;
  const details: WorkerDetail[] = [];

  if (submitMode && !submitApproved) {
    const reason = rows.length !== 1
      ? "현재 실제 주문 확정은 안전 검증을 위해 한 번에 1행만 지원합니다. 주문을 나눠서 처리해 주세요."
      : approvalKey.length < 12
        ? "서버에 최종 주문 승인 코드가 설정되지 않았습니다."
        : !approvalProofValid
          ? "최종 승인 코드가 올바르지 않습니다. 실제 주문은 실행하지 않았습니다."
          : !finalApprovalFresh
            ? "최종 주문 승인이 30분을 지나 만료되었습니다. 최신 준비 결과를 다시 확인해 주세요."
          : "운영 페이지의 검토 수락과 최종 주문 확정 승인을 모두 확인하지 못했습니다.";
    for (const [index, row] of rows.entries()) details.push({ lineNo: row.lineNo ?? index + 1, status: "HOLD", reason });
  } else if (!serialized) {
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
            details.push(await prepareEroumRow(page, row, index, job.id, submitApproved, job.dashboardReview?.submissionRequestId ?? ""));
          } catch (error) {
            details.push({ lineNo: row.lineNo ?? index + 1, status: "FAILED", reason: `이로움 주문 처리 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}` });
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
  const submittedRows = details.filter((entry) => Boolean(entry.orderNumber && entry.submittedAt)).length;
  const completed = submitMode && rows.length > 0 && submittedRows === rows.length && failedRows === 0 && holdRows === 0;
  return {
    workerId,
    startedAt,
    finishedAt: now(),
    totalRows: rows.length,
    successRows,
    failedRows,
    holdRows,
    shippingNoticeRows,
    submittedRows,
    reviewState: failedRows || holdRows ? "BLOCKED" : completed ? "COMPLETED" : "WAITING_FOR_DASHBOARD",
    canSubmit: !submitMode && rows.length === 1 && successRows === rows.length && failedRows === 0 && holdRows === 0,
    details,
  };
}

async function runOnce() {
  // orderByKey needs no ".indexOn" rule; filter QUEUED jobs on the client side.
  const recent = await database.ref(queuePath).orderByKey().limitToLast(100).get();
  const queuedIds: string[] = [];
  recent.forEach((child) => {
    if (["QUEUED", "SUBMIT_QUEUED"].includes((child.val() as { status?: string } | null)?.status ?? "")) queuedIds.push(child.key as string);
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
        const submitMode = job.executionMode === "SUBMIT";
        const completed = submitMode && report.submittedRows === report.totalRows && report.failedRows === 0 && report.holdRows === 0;
        const nextStatus = report.failedRows || report.holdRows ? "HOLD" : completed ? "COMPLETED" : "AWAITING_REVIEW";
        const auditKey = database.ref(`${queuePath}/${jobId}/auditLogs`).push().key ?? randomUUID();
        await database.ref(`${queuePath}/${jobId}`).update({
          status: nextStatus,
          updatedAt: report.finishedAt,
          workerId,
          report,
          dashboardReview: submitMode
            ? {
                ...job.dashboardReview,
                state: report.reviewState,
                required: !completed,
                finalSubmissionApproved: true,
                updatedAt: report.finishedAt,
              }
            : { state: report.reviewState, required: true, finalSubmissionApproved: false, updatedAt: report.finishedAt },
          [`auditLogs/${auditKey}`]: {
            id: auditKey,
            jobId,
            action: submitMode ? "FINAL_SUBMISSION_FINISHED" : "BACKGROUND_RUN_FINISHED",
            actorName: "서버 자동화 워커",
            actorEmail: "",
            detail: submitMode
              ? `실제 주문 확정 · 총 ${report.totalRows}건 · 제출 완료 ${report.submittedRows}건 · 실패 ${report.failedRows}건 · 보류 ${report.holdRows}건`
              : `총 ${report.totalRows}건 · 성공 ${report.successRows}건 · 실패 ${report.failedRows}건 · 보류 ${report.holdRows}건 · 출고 확인 필요 ${report.shippingNoticeRows}건 · 최종 주문 미실행`,
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
