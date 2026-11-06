export type PreparationReservation = { channel: string; method: string; runAt: string; receiptDeadlineAt: string };
export function normalizeChannelName(value: unknown): string;
export const deliverySchedule: {channel: string; vendor: string; method: string; orderDeadline: string | null; receiptDeadline: string | null}[];
export const orderChannelGroups: {title: string; items: string[]}[];
export function scheduleLabel(channel: string): string;
export function nextPreparation(channel: string, now?: Date): PreparationReservation | null;
export function preparationDue(job: {scheduledPreparation?: PreparationReservation | null}, now?: Date, enabled?: boolean): boolean;
export function reservationProblem(job: {sourceSystem?: string; scheduledPreparation?: PreparationReservation | null; rows?: {sourceSystem?: string}[]}, now?: Date): string | null;
