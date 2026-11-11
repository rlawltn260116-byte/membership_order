export const provinceAliases: Readonly<Record<string, string>>;
export function resolveBofeelPostcode(address: string, response: unknown): {
  decision: 'USE' | 'HOLD'; reason: string; postcode: string; roadAddress: string; detail: string;
};
