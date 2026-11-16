export const PARTS_ORDER_LABEL: string;
export const PARTS_ORDER_KIND: string;
export type ClassifiedRow = { partsOrder: boolean; orderKind: string; supplier: string; supplierEvidence: string; status?: "READY" | "HOLD" | "FAILED"; reason?: string };
export function classifyOrderRow(row: unknown, suppliers?: unknown, products?: unknown): ClassifiedRow;
export function partitionOrderRows<T>(rows: T[]): { normalRows: (T & ClassifiedRow)[]; partsRows: (T & ClassifiedRow)[] };
export function isPartsOrder(job: unknown): boolean;
