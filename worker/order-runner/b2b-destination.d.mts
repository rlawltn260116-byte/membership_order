export const DESTINATION_HOLD_REASON: string;
export function splitDestination(value: string, vendor?: string): { name: string; address: string; normalizationNotes?: string[] } | null;
