import { isDeepStrictEqual } from 'node:util';
import { toolCallEnvelopes } from '../../mapping/tool-calling.js';
import { parseContractJson, ContractJsonError } from '../../util/contract-json.js';

export function transportPayload(text: string, strict = false): unknown {
  const parse = (candidate: string): unknown => {
    const parsed = parseContractJson(candidate);
    if (strict && parsed.repaired) throw new ContractJsonError('syntax', 'Alternative stream requires syntax repair');
    return parsed.value;
  };
  // Literal tool markup within a JSON source string is data.
  try { return parse(text); } catch { /* Try explicit envelopes. */ }
  const envelopes = toolCallEnvelopes(text);
  if (!envelopes.length) return parse(text);
  let remaining = text;
  const calls = envelopes.map(envelope => {
    remaining = remaining.replace(envelope.whole, '');
    return parse(envelope.body);
  });
  if (remaining.trim()) throw new ContractJsonError('ambiguous', 'Extra text around tool-call payload');
  return calls.length === 1 ? calls[0] : calls;
}

/** Use a correlated, completed stream only after its profile earned trust. */
export function selectContractResponseText(dom: string, raw: string, eligible: boolean, alternativeRaw = ''): string {
  if (!eligible || !raw) return dom;
  let rawValue: unknown;
  try { rawValue = transportPayload(raw); } catch { return dom; }
  let domValue: unknown;
  let domValid = false;
  try { domValue = transportPayload(dom); domValid = true; } catch { /* Renderer damaged the payload. */ }
  if (domValid && !isDeepStrictEqual(rawValue, domValue)) throw new ContractJsonError('ambiguous', 'Raw stream and DOM contain different valid contract payloads');
  let domStrict = false;
  if (domValid) {
    try { transportPayload(dom, true); domStrict = true; } catch { /* A repaired DOM cannot prove an extraction mode. */ }
  }
  if (!domStrict) {
    let alternative: unknown;
    let alternativeValid = false;
    try { alternative = transportPayload(alternativeRaw, true); alternativeValid = true; } catch { /* Not a competing complete payload. */ }
    if (alternativeValid && !isDeepStrictEqual(rawValue, alternative)) {
      throw new ContractJsonError('ambiguous', 'Delta and snapshot extraction contain different valid contract payloads');
    }
  }
  return raw;
}

export function sameContractText(left: string, right: string): boolean {
  try { return isDeepStrictEqual(transportPayload(left), transportPayload(right)); } catch { return false; }
}
