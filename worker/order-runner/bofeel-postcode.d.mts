export const provinceAliases: Readonly<Record<string, string>>;
export function bofeelPostcodeKeyword(address: string): string | null;
export function resolveBofeelPostcode(address: string, response: unknown): {
  decision: 'USE' | 'HOLD'; reason: string; postcode: string; roadAddress: string; detail: string;
};
