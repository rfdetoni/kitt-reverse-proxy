export const RESOURCE_LIMITS = Object.freeze({
  httpRequestBytes: 2 * 1024 * 1024,
  mcpRequestBytes: 2 * 1024 * 1024,
  discoveryRequestBytes: 2 * 1024 * 1024,
  discoveryResponseBytes: 5 * 1024 * 1024,
  discoveryCandidates: 128,
  upstreamResponseBytes: 8 * 1024 * 1024,
  gatewayJsonBytes: 1024 * 1024,
  uiPromptChars: 500_000,
  uiHistoryChars: 2_000_000,
  uiDeltaChars: 2_000_000,
  telemetrySeriesPerMetric: 256,
  telemetryFunctionLabels: 128,
  structuredLogDepth: 6,
  structuredLogArrayItems: 32,
  structuredLogObjectKeys: 64
});

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function assertWithinBytes(value: string | Buffer, maxBytes: number, label: string): void {
  const size = Buffer.isBuffer(value) ? value.length : utf8Bytes(value);
  if (size > maxBytes) throw new Error(`${label} excede ${maxBytes} bytes.`);
}
