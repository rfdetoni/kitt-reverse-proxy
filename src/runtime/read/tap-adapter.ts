import { decodeTextBody } from '../../discovery/decoder.js';
import type { JsonValue } from '../../types.js';
import { getPathValues } from '../../util/path.js';
import {
  applyTapPiece,
  collectTapStringLeaves,
  tapPathScore,
  tapTextValues,
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
  private readonly decoder = new TextDecoder('utf-8');
  private readonly candidates = new Map<string, TapTextState>();
  private matched?: MatchedResponse;
  private frameBuffer = '';
  private rawText = '';
  private parsedEvents = 0;
  private learnedText = '';
  private learnedSamples = 0;

  constructor(private readonly profile?: TapProfile) {}

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
    this.frameBuffer = this.frameBuffer.replace(/\r\n/g, '\n');
    return this.consumeFrames(false);
  }

  end(): string[] {
    const tail = this.decoder.decode();
    if (tail) {
      this.rawText += tail;
      this.frameBuffer += tail;
      this.frameBuffer = this.frameBuffer.replace(/\r\n/g, '\n');
    }
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

    if (this.profile) {
      if (this.learnedSamples === 0 || normalizeTapText(this.learnedText) !== expected) return undefined;
      return { profile: { ...this.profile }, text: this.learnedText };
    }

    const matches = [...this.candidates.entries()]
      .filter(([, state]) => state.samples > 0 && normalizeTapText(state.text) === expected)
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
        textPath: best[0]
      },
      text: best[1].text
    };
  }

  accumulatedText(): string {
    if (this.profile) return this.learnedText;
    let best: TapTextState | undefined;
    for (const state of this.candidates.values()) {
      if (!best || state.score > best.score || (state.score === best.score && state.text.length > best.text.length)) {
        best = state;
      }
    }
    return best?.text ?? '';
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
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') return [];
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
      const values = getPathValues(value, this.profile.textPath).flatMap(tapTextValues);
      for (const raw of values) {
        const state: TapTextState = {
          text: this.learnedText,
          score: 1,
          samples: this.learnedSamples
        };
        const delta = applyTapPiece(state, raw);
        this.learnedText = state.text;
        this.learnedSamples = state.samples;
        if (delta) deltas.push(delta);
      }
      return deltas;
    }

    for (const [path, values] of collectTapStringLeaves(value)) {
      const combined = values.join('');
      if (!combined) continue;
      const state = this.candidates.get(path) ?? {
        text: '',
        score: path === '$' ? 5 : tapPathScore(path),
        samples: 0
      };
      applyTapPiece(state, combined);
      this.candidates.set(path, state);
    }
    return [];
  }
}
