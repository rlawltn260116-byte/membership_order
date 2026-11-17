import { createJobWithCenters, updateJobWithCenters, uploadCenterEntries, createCenterOnlyJob, removeCenterRow, excludeHeldCenterEntry, deleteJobWithCenters, type CenterEntry, type CenterRoot } from '../worker/order-runner/center-queue.mjs';

const FIREBASE_DB_URL = "https://membership-7aef2-default-rtdb.firebaseio.com";
const ROOT = "order-ops";

// 기존 orderByKey().limitToLast(100) 큐와 같은 시간순 Firebase push 키를 만든다.
// 무작위 UUID를 쓰면 최신 작업이 최근 큐 조회에서 빠질 수 있다.
export function newOrderJobId(time = Date.now()) {
  const alphabet = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
  let stamp = '';
  for (let index = 0; index < 8; index++) { stamp = alphabet[time % 64] + stamp; time = Math.floor(time / 64); }
  const random = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return stamp + Array.from(random, value => alphabet[value % 64]).join('');
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${FIREBASE_DB_URL}/${ROOT}/${path}.json`, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data && typeof data === "object" && "error" in data ? data.error : null;
    throw new Error(typeof message === "string" ? message : "Firebase 요청에 실패했습니다.");
  }
  return data as T;
}

export async function listOrderJobs() {
  const data = await request<Record<string, Record<string, unknown> & { createdAt?: string }> | null>("jobs");
  return Object.entries(data ?? {})
    .map(([id, job]) => ({ ...job, id }))
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

export async function getOrderJob(id: string) {
  const data = await request<Record<string, unknown> | null>(`jobs/${encodeURIComponent(id)}`);
  return data ? { ...data, id } : null;
}

export async function createOrderJob(job: Record<string, unknown>) {
  const id = newOrderJobId();
  const now = new Date().toISOString();
  const root = await transact(root => createJobWithCenters(root, id, job, now));
  return { ...(root.jobs as Record<string, Record<string, unknown>>)[id], id };
}

export async function updateOrderJob(id: string, patch: Record<string, unknown>) {
  const now = new Date().toISOString();
  const root = await transact(root => updateJobWithCenters(root, id, patch, now));
  return { ...(root.jobs as Record<string, Record<string, unknown>>)[id], id };
}
// Firebase REST의 ETag 조건부 PUT은 공통 부모의 비교·교환 트랜잭션이다.
// 예약과 작업 행을 한 번에 저장하며 412 충돌 때 최신 상태로 순수 전이를 다시 계산한다.
async function transact(change: (root: CenterRoot) => CenterRoot) {
  const url = `${FIREBASE_DB_URL}/${ROOT}.json`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const read = await fetch(url, { cache: 'no-store', headers: { 'X-Firebase-ETag': 'true' } });
    if (!read.ok) throw new Error('센터 대기열 트랜잭션 조회에 실패했습니다.');
    const etag = read.headers.get('ETag');
    if (!etag) throw new Error('센터 대기열의 동시 변경 확인값이 없습니다. 저장하지 않았습니다.');
    const root = change((await read.json() ?? {}) as CenterRoot);
    const write = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': etag }, body: JSON.stringify(root) });
    if (write.status === 412) continue;
    if (!write.ok) throw new Error('센터 대기열 트랜잭션 저장에 실패했습니다. 목록을 새로 불러오세요.');
    return root;
  }
  throw new Error('동시 변경이 많아 저장을 보류했습니다. 목록을 새로 불러오세요.');
}

export async function listCenterQueue() {
  return await request<{ entries?: Record<string, CenterEntry>; firstJobs?: Record<string, string> } | null>('center-queue') ?? {};
}
export async function saveCenterUpload(prepared: CenterEntry[]) {
  const now = new Date().toISOString(), id = newOrderJobId();
  const root = await transact(root => uploadCenterEntries(root, prepared, id, now));
  return root['center-queue'];
}
export async function makeCenterOnlyJob(supplier: string, scheduleKey?: string) {
  const now = new Date().toISOString(), id = newOrderJobId();
  await transact(root => createCenterOnlyJob(root, id, supplier, now, scheduleKey));
  return id;
}
export async function excludeCenterRow(id: string, centerId: string) {
  const now = new Date().toISOString();
  await transact(root => removeCenterRow(root, id, centerId, now));
}
export async function deleteOrderJob(id: string) {
  await transact(root => deleteJobWithCenters(root, id));
}
export async function excludeHeldCenter(id: string) {
  const now = new Date().toISOString();
  await transact(root => excludeHeldCenterEntry(root, id, now));
}

// 발주없음 표시 목록. 키는 날짜와 회차를 인코딩한 값이고 값에 날짜·회차 키가 들어 있다.
export async function listVendorNoOrders() {
  const data = await request<Record<string, { date: string; scheduleKey: string; channel: string; vendor: string; method: string; markedAt: string; markedByName: string }> | null>("vendorNoOrders");
  return Object.values(data ?? {});
}

// 루트에 대한 다중 경로 갱신. 값이 null인 경로는 지운다(발주없음 취소).
export async function updateOrderOpsPaths(patch: Record<string, unknown>) {
  await request("", { method: "PATCH", body: JSON.stringify(patch) });
}
