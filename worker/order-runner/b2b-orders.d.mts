export function sourceRowKey(vendor: string, row: unknown, job?: unknown): string;
export function splitDestination(value: string, vendor?: string): { name: string; address: string } | null;
export function publicLedgerRowKey(sourceKey: string, secret: string): string;
export function ledgerReservation(used: string[], requestId: string, sourceKeys: string[], secret: string): string[] | null;
