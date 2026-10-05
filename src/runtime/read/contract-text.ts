import { isDeepStrictEqual } from 'node:util';
import { toolCallEnvelopes } from '../../mapping/tool-calling.js';
import { parseContractJson, ContractJsonError } from '../../util/contract-json.js';

export function transportPayload(text: string): unknown {
  // Literal tool markup within a JSON source string is data.
  try { return parseContractJson(text).value; } catch { /* Try explicit envelopes. */ }
  const envelopes = toolCallEnvelopes(text);
  if (!envelopes.length) return parseContractJson(text).value;
  let remaining = text;
  const calls = envelopes.map(envelope => {
    remaining = remaining.replace(envelope.whole, '');
    return parseContractJson(envelope.body).value;
  });
  if (remaining.trim()) throw new ContractJsonError('ambiguous', 'Extra text around tool-call payload');
  return calls.length === 1 ? calls[0] : calls;
}

/** Use a correlated, completed stream only after its profile earned trust. */
export function selectContractResponseText(dom: string, raw: string, eligible: boolean): string {
  if (!eligible || !raw) return dom;
  let rawValue: unknown;
  try { rawValue = transportPayload(raw); } catch { return dom; }
  let domValue: unknown;
  try { domValue = transportPayload(dom); } catch { return raw; }
  if (!isDeepStrictEqual(rawValue, domValue)) throw new ContractJsonError('ambiguous', 'Raw stream and DOM contain different valid contract payloads');
  return raw;
}

export function sameContractText(left: string, right: string): boolean {
  try { return isDeepStrictEqual(transportPayload(left), transportPayload(right)); } catch { return false; }
}
