export const DESTINATION_HOLD_REASON: string;
export const RECIPIENT_EMPTY_REASON: string;
export const RECIPIENT_ADDRESS_REASON: string;
export const RECIPIENT_MAX_LENGTH: Readonly<Record<string, number>>;
export function analyzeDestination(value: string, vendor?: string): {
  status: "READY" | "HOLD"; name: string; address: string; reason: string;
  originalDestination: string; normalizationNotes: string[];
};
export function splitDestination(value: string, vendor?: string): { name: string; address: string; normalizationNotes?: string[] } | null;
