export type SourceWorkbook = { filename: string; sheets: Array<{ name: string; state: string; rowCount: number; headers: string[] }> };
export function inspectWorkbook(workbook: unknown, filename: string): SourceWorkbook;
export function selectWorksheet<T extends { worksheets: Array<{ name: string; state?: string }> }>(workbook: T, selectedSheet?: string): T['worksheets'][number];
export function worksheetMatrix(sheet: unknown): string[][];
export function workbookProblem(job: unknown): string | null;
export function orderFileDate(job: unknown): string;
export function duplicateOrderFiles<T>(candidate: unknown, jobs: T[]): T[];
