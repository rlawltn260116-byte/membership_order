export type ItemRound = { group: number; subcategory: string; channel: string; round: string; scheduleKey: string; orderDeadline: string; receiptDeadline: string; items: Array<{ model: string; name: string; options?: string[]; aliases?: string[]; allowUnspecifiedOption?: boolean }>; schedule: { orderDeadline: string; receiptDeadline: string } };
export const itemRounds: Omit<ItemRound, 'schedule'>[];
export function hasItemRounds(channel: string): boolean;
export function itemRound(channel: string, productName: string, option?: string): ItemRound | null;
export function itemRoundScheduleDifferences(): unknown[];
