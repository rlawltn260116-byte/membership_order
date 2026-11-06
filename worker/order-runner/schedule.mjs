import data from "./data/direct-delivery-schedule.json" with { type: "json" };

export const normalizeChannelName = (value) => {
  const name = String(value ?? "").trim();
  if (["THK", "THKC"].includes(name.toUpperCase())) return "이로움";
  return name === "나눔에이치엔씨" ? "나눔에이치앤씨" : name;
};
export const deliverySchedule = data.schedule.map((entry) => ({ ...entry, channel: entry.appChannel || entry.vendor }));
const groups = [["B2B몰 주문", ["B2B몰"]], ["ERP 주문", ["ERP"]], ["메일 주문", ["이메일"]], ["팩스 주문", ["팩스"]], ["카톡 주문", ["카톡", "카톡친구"]]];
export const orderChannelGroups = groups.map(([title, methods]) => ({
  title, items: [...new Set(deliverySchedule.filter((entry) => methods.includes(entry.method)).map((entry) => entry.channel))],
}));
export function scheduleLabel(channel) {
  const entries = deliverySchedule.filter((entry) => entry.channel === normalizeChannelName(channel));
  return entries.length ? entries.map((entry) => entry.orderDeadline ? `${entry.orderDeadline} 발주 · ${entry.receiptDeadline} 접수` : "마감 미정 · 예약 제외").join(" / ") : "시간표 미등록 · 예약 제외";
}
// 발주마감에 준비를 시작하며 주말을 제외한다. 공휴일은 별도 확인이 필요하다.
export function nextPreparation(channel, now = new Date()) {
  const entries = deliverySchedule.filter((entry) => entry.channel === normalizeChannelName(channel) && entry.orderDeadline && entry.receiptDeadline);
  const local = new Date(now.getTime() + 9 * 3600000);
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + offset));
    if ([0, 6].includes(day.getUTCDay())) continue;
    for (const entry of entries) {
      const at = (time) => new Date(`${day.toISOString().slice(0, 10)}T${time}:00+09:00`);
      const runAt = at(entry.orderDeadline);
      if (runAt < now) continue;
      return { channel: entry.channel, method: entry.method, runAt: runAt.toISOString(), receiptDeadlineAt: at(entry.receiptDeadline).toISOString() };
    }
  }
  return null;
}
export function preparationDue(job, now = new Date(), enabled = false) {
  if (!job.scheduledPreparation) return true;
  if (!enabled) return false;
  const at = Date.parse(job.scheduledPreparation.runAt);
  return !Number.isFinite(at) || now.getTime() >= at;
}
export function reservationProblem(job, now = new Date()) {
  const saved = job.scheduledPreparation;
  if (!saved) return null;
  const runAt = new Date(saved.runAt);
  const expected = Number.isFinite(runAt.getTime()) ? nextPreparation(job.sourceSystem, runAt) : null;
  if (!expected || expected.runAt !== saved.runAt || expected.receiptDeadlineAt !== saved.receiptDeadlineAt || expected.channel !== saved.channel) return "시간표와 예약 정보가 일치하지 않습니다. 다시 예약해 주세요.";
  if ((job.rows ?? []).some((row) => row.sourceSystem && normalizeChannelName(row.sourceSystem) !== expected.channel)) return "여러 업체의 주문은 업체별로 나누어 예약해 주세요.";
  if (now.getTime() > Date.parse(expected.receiptDeadlineAt)) return "접수마감이 지나 예약 준비를 보류했습니다. 다음 회차를 다시 예약해 주세요.";
  return null;
}
