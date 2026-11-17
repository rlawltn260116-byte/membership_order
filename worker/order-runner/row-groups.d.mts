export type RowView = "all" | "hold" | "failed" | "ready";
export type RowLike = { status: string; reason?: string };
export type RowGroup<T> = { label: string; rows: T[] };
export type RowSection<T> = { key: "hold" | "failed" | "ready"; title: string; rows: T[]; groups: RowGroup<T>[] };

export const ROW_VIEWS: RowView[];
export function primaryReason(row: RowLike | null | undefined): string;
export function reasonGroupLabel(row: RowLike | null | undefined): string;
export function splitRowsByStatus<T extends RowLike>(rows?: T[]): { ready: T[]; hold: T[]; failed: T[] };
export function groupHoldRowsByReason<T extends RowLike>(rows?: T[]): RowGroup<T>[];
export function rowCounts<T extends RowLike>(rows?: T[]): { all: number; ready: number; hold: number; failed: number };
export function rowSections<T extends RowLike>(rows?: T[], view?: RowView): RowSection<T>[];
