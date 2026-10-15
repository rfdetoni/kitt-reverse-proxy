/** Serialize exactly the contract under test, including malformed fixtures. */
export function jsonFixture(value: Record<string, unknown>): string { return JSON.stringify(value); }
export function jsonFromFixture(raw: string): string { return raw; }
