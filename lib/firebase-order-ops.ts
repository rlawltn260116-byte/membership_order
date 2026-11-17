const FIREBASE_DB_URL = "https://membership-7aef2-default-rtdb.firebaseio.com";
const ROOT = "order-ops";

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
  const created = await request<{ name?: string } | null>("jobs", { method: "POST", body: JSON.stringify(job) });
  const id = String(created?.name ?? Date.now());
  if (!created?.name) await request(`jobs/${id}`, { method: "PUT", body: JSON.stringify(job) });
  return { ...job, id };
}

export async function updateOrderJob(id: string, patch: Record<string, unknown>) {
  await request(`jobs/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
  return getOrderJob(id);
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
