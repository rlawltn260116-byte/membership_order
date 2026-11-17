// 사용자가 확인한 품목·옵션만 대응한다. 부분 모델·미등록 옵션으로 회차를 추정하지 않는다.
import data from './data/item-rounds.json' with { type: 'json' };
import { deliverySchedule, normalizeChannelName } from './schedule.mjs';

export const itemRounds = data.rounds;
export const hasItemRounds = channel => itemRounds.some(round => round.channel === normalizeChannelName(channel));
const norm = value => String(value ?? '').normalize('NFC').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, '').replace(/\((?:비유통전환상품|재고소진후미운영|직배출고)\)/g, '');
const key = entry => `${entry.channel}|${entry.orderDeadline}`;
export function itemRound(channel, productName, option = '') {
  channel = normalizeChannelName(channel);
  const name = norm(productName), selected = norm(option);
  const matches = itemRounds.filter(round => round.channel === channel && round.items.some(item => {
    const bases = [item.model, item.name, ...(item.aliases || [])].map(norm);
    if (item.allowUnspecifiedOption && !selected && bases.includes(name)) return true;
    if (item.options) return item.options.some(value => bases.some(base =>
      (name === base && selected === norm(value)) || (!selected && (name === `${base}/${norm(value)}` || (value.startsWith('(') && name === `${base}${norm(value)}`)))));
    return !selected && bases.includes(name);
  }));
  if (matches.length !== 1) return null;
  const round = matches[0];
  const schedule = deliverySchedule.find(entry => key(entry) === round.scheduleKey);
  return schedule ? { ...round, schedule } : null;
}

export function itemRoundScheduleDifferences() {
  return itemRounds.flatMap(round => {
    const entry = deliverySchedule.find(entry => key(entry) === round.scheduleKey);
    return !entry || entry.orderDeadline !== round.orderDeadline || entry.receiptDeadline !== round.receiptDeadline
      ? [{ subcategory: round.subcategory, scheduleKey: round.scheduleKey, orderDeadline: round.orderDeadline, receiptDeadline: round.receiptDeadline,
        scheduleOrderDeadline: entry?.orderDeadline ?? null, scheduleReceiptDeadline: entry?.receiptDeadline ?? null }] : [];
  });
}
