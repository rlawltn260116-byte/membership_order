export function sourceRowKey(vendor: string, row: unknown, job?: unknown): string;
export function usesHttp(job: { sourceSystem?: string; rows?: { sourceSystem?: string }[] }): boolean;
export function httpSubmitAllowed(vendor: string, env?: NodeJS.ProcessEnv): boolean;
export function splitDestination(value: string, vendor?: string): { name: string; address: string } | null;
export function publicLedgerRowKey(sourceKey: string, secret: string): string;
export function ledgerReservation(used: string[], requestId: string, sourceKeys: string[], secret: string): string[] | null;
