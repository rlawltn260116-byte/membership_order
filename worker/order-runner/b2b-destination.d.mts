export const DESTINATION_HOLD_REASON: string;
export const RECIPIENT_EMPTY_REASON: string;
export const RECIPIENT_ADDRESS_REASON: string;
export const RECIPIENT_MAX_LENGTH: Readonly<Record<string, number>>;
export const CENTER_ORDER_LABEL: string;
export const SITE_RECIPIENT_REQUIRED_REASON: string;
export type CenterContext = { sourceFile?: string; filename?: string; memo?: string };
export function centerOrderContext(context?: CenterContext): { centerOrder: boolean; centerOrderEvidence: string[] };
export function analyzeDestination(value: string, vendor?: string, context?: CenterContext): {
  status: "READY" | "HOLD"; name: string; address: string; reason: string;
  originalDestination: string; normalizationNotes: string[];
  centerOrder: boolean; centerOrderEvidence: string[];
};
export function splitDestination(value: string, vendor?: string): { name: string; address: string; normalizationNotes?: string[] } | null;
