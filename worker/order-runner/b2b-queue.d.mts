export function prepareHttpJob(job: unknown, options?: {
  env?: NodeJS.ProcessEnv;
  reserveLedger?: (requestId: string, sourceKey: string | string[]) => Promise<boolean>;
  lockRow?: (lineNo: number) => Promise<boolean>;
  record?: (lineNo: number, value: { state: "SUBMITTED" | "UNKNOWN"; orderNumber?: string; submittedAt?: string; reason?: string }) => Promise<void>;
}): Promise<{ canSubmit: boolean; details: Array<{
  lineNo: number; status: "READY" | "HOLD" | "FAILED"; reason: string; reviewNotes?: string[]; vendor?: string;
  productId?: string; quantity?: number; orderGroup?: number; addressMode?: string;
  submissionReady?: boolean; orderNumber?: string; submittedAt?: string;
}> }>;
