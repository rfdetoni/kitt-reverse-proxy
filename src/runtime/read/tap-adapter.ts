import { sameContractText } from './contract-text.js';
import { decodeTextBody, sseEventData } from '../../discovery/decoder.js';
import type { JsonValue } from '../../types.js';
import { copyProfile } from './tap-health.js';
import { RESOURCE_LIMITS } from '../../core/resource-limits.js';
import {
  applyTapPiece,
  collectTapStringLeaves,
  tapPathScore,
  tapProfileValues,
  type TapTextState
} from './tap-extract.js';
import type {
  TapFraming,
  TapProfile,
  TapVerificationCandidate
} from './types.js';

interface MatchedResponse {
  url: string;
  method: string;
  contentType: string;
  framing: TapFraming;
}
interface TextCandidate extends TapTextState {
  path: string;
  jsonStringPaths: string[];
  textMode: 'delta' | 'snapshot';
}

function mime(contentType: string): string {
  return contentType.split(';', 1)[0]!.trim().toLowerCase();
}

export function tapFramingForContentType(contentType: string): TapFraming {
  const value = mime(contentType);
  if (value === 'text/event-stream') return 'sse';
  if (value.includes('ndjson') || value.includes('json-seq')) return 'ndjson';
  return 'framed';
}

export function normalizeTapText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function parseJson(value: string): JsonValue | undefined {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function stripXssi(line: string): string {
  const trimmed = line.trim();
  return trimmed.startsWith(")]}'") ? trimmed.slice(4).trim() : trimmed;
}

export class TapStreamAdapter {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly candidates = new Map<string, TextCandidate>();
  private matched?: MatchedResponse;
  private frameBuffer = '';
  private rawText = '';
  private parsedEvents = 0;
  private learnedText = '';
  private learnedSamples = 0;
  private learnedInvalid = false;
  private readonly alternative: TapTextState = { text: '', score: 1, samples: 0 };

  constructor(private readonly profile?: TapProfile, private readonly contractMode = false) {}

  matchedResponse(url: string, method: string, contentType: string): void {
    this.matched = {
      url,
      method,
      contentType: mime(contentType),
      framing: tapFramingForContentType(contentType)
    };
  }

  push(bytes: Uint8Array): string[] {
    if (!bytes.byteLength) return [];
    const decoded = this.decoder.decode(bytes, { stream: true });
    if (!decoded) return [];
    this.rawText += decoded;
    this.frameBuffer += decoded;
    // Keep a trailing CR until the next chunk resolves whether it is CRLF.
    this.frameBuffer = this.frameBuffer.replace(/\r\n|\r(?!$)/g, '\n');
    return this.consumeFrames(false);
  }

  end(): string[] {
    const tail = this.decoder.decode();
    if (tail) {
      this.rawText += tail;
      this.frameBuffer += tail;
    }
    this.frameBuffer = this.frameBuffer.replace(/\r\n?/g, '\n');
    const deltas = this.consumeFrames(true);

    if (this.parsedEvents === 0 && this.rawText.trim() && this.matched) {
      try {
        deltas.push(...this.consumeValue(decodeTextBody(this.rawText, this.matched.contentType)));
      } catch {
        // Verification rejects unreadable streams and leaves DOM authoritative.
      }
    }
    return deltas;
  }

  verification(finalDomText: string): TapVerificationCandidate | undefined {
    if (!this.matched) return undefined;
    const expected = normalizeTapText(finalDomText);
    if (!expected) return undefined;

    const matchesDom = (text: string): boolean => normalizeTapText(text) === expected
      || (this.contractMode && sameContractText(text, finalDomText));
    if (this.profile) {
      if (this.learnedInvalid || this.learnedSamples === 0 || !matchesDom(this.learnedText)) return undefined;
      return { profile: { ...copyProfile(this.profile), textMode: this.profile.textMode ?? 'delta' }, text: this.learnedText };
    }

    const matches = [...this.candidates.entries()]
      .filter(([, state]) => !state.invalid && state.samples > 0 && matchesDom(state.text))
      .sort((left, right) => {
        if (right[1].score !== left[1].score) return right[1].score - left[1].score;
        return right[1].samples - left[1].samples;
      });
    const best = matches[0];
    if (!best) return undefined;

    const url = new URL(this.matched.url);
    return {
      profile: {
        endpointOrigin: url.origin,
        endpointPath: url.pathname,
        method: this.matched.method.toUpperCase(),
        contentType: this.matched.contentType,
        framing: this.matched.framing,
        textPath: best[1].path,
        ...(best[1].jsonStringPaths.length ? { jsonStringPaths: [...best[1].jsonStringPaths] } : {}),
        textMode: best[1].textMode
      },
      text: best[1].text
    };
  }

  accumulatedText(): string {
    if (this.profile) return this.learnedInvalid ? '' : this.learnedText;
    let best: TapTextState | undefined;
    for (const state of this.candidates.values()) {
      if (state.invalid) continue;
      if (!best || state.score > best.score || (state.score === best.score && state.text.length > best.text.length)) {
        best = state;
      }
    }
    return best?.text ?? '';
  }

  accumulatedAlternativeText(): string {
    return this.profile && !this.alternative.invalid ? this.alternative.text : '';
  }

  private consumeFrames(flush: boolean): string[] {
    if (!this.matched) return [];
    if (this.matched.framing === 'sse') return this.consumeSseFrames(flush);
    return this.consumeLineFrames(flush);
  }

  private consumeSseFrames(flush: boolean): string[] {
    const deltas: string[] = [];
    while (true) {
      const index = this.frameBuffer.indexOf('\n\n');
      if (index < 0) break;
      const block = this.frameBuffer.slice(0, index);
      this.frameBuffer = this.frameBuffer.slice(index + 2);
      deltas.push(...this.consumeSseBlock(block));
    }
    if (flush && this.frameBuffer.trim()) {
      deltas.push(...this.consumeSseBlock(this.frameBuffer));
      this.frameBuffer = '';
    }
    return deltas;
  }

  private consumeLineFrames(flush: boolean): string[] {
    const deltas: string[] = [];
    while (true) {
      const index = this.frameBuffer.indexOf('\n');
      if (index < 0) break;
      const line = this.frameBuffer.slice(0, index);
      this.frameBuffer = this.frameBuffer.slice(index + 1);
      deltas.push(...this.consumeLine(line));
    }
    if (flush && this.frameBuffer.trim()) {
      deltas.push(...this.consumeLine(this.frameBuffer));
      this.frameBuffer = '';
    }
    return deltas;
  }

  private consumeSseBlock(block: string): string[] {
    const data = sseEventData(block);
    if (data === undefined || data === '[DONE]') return [];
    this.parsedEvents += 1;
    return this.consumeValue(parseJson(data) ?? data);
  }

  private consumeLine(raw: string): string[] {
    const line = stripXssi(raw);
    if (!line || /^\d+$/.test(line)) return [];
    const parsed = parseJson(line);
    if (parsed === undefined) return [];
    this.parsedEvents += 1;
    return this.consumeValue(parsed);
  }

  private consumeValue(value: JsonValue): string[] {
    if (this.profile) {
      const deltas: string[] = [];
      const values = tapProfileValues(value, this.profile.textPath, this.profile.jsonStringPaths);
      for (const raw of values) {
        const state: TapTextState = {
          text: this.learnedText,
          score: 1,
          samples: this.learnedSamples,
          invalid: this.learnedInvalid
        };
        const delta = applyTapPiece(state, raw, this.profile.textMode ?? 'delta');
        applyTapPiece(this.alternative, raw, this.profile.textMode === 'snapshot' ? 'delta' : 'snapshot');
        this.learnedText = state.text;
        this.learnedSamples = state.samples;
        this.learnedInvalid = state.invalid === true;
        if (delta) deltas.push(delta);
      }
      return deltas;
    }

    for (const [candidateKey, {path, jsonStringPaths, values}] of collectTapStringLeaves(value)) {
      const combined = values.join('');
      if (!combined) continue;
      for (const textMode of ['delta', 'snapshot'] as const) {
        const key = textMode + ':' + candidateKey;
        if (this.candidates.size >= 2 * RESOURCE_LIMITS.discoveryCandidates && !this.candidates.has(key)) throw new Error('Tap candidate limit exceeded');
        const state = this.candidates.get(key) ?? {
          path, jsonStringPaths, textMode, text: '', score: path === '$' ? 5 : tapPathScore(path), samples: 0
        };
        applyTapPiece(state, combined, textMode);
        this.candidates.set(key, state);
      }
    }
    return [];
  }
}
