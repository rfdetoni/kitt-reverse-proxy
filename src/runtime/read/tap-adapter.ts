import { isJsonObject } from '../../util/json.js';
import { sameContractText } from './contract-text.js';
import { parseContractJson } from '../../util/contract-json.js';
import { decodeTextBody, sseEventData } from '../../discovery/decoder.js';
import type { JsonValue } from '../../types.js';
import { copyProfile } from './tap-health.js';
import { RESOURCE_LIMITS } from '../../core/resource-limits.js';
import { appendJsonPath } from '../../util/path.js';
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
  messageId?: string;
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
  private terminalFrame = false;
  private ended = false;
  private learnedText = '';
  private learnedSamples = 0;
  private learnedInvalid = false;
  private readonly alternative: TapTextState = { text: '', score: 1, samples: 0 };
  private readonly patches = new Map<string, TapTextState>();
  private patchTarget: { path: string; mode: 'delta' | 'snapshot' } | undefined;
  private patchRole: string | undefined;
  private patchChannel: string | undefined;
  private patchRecipient: string | undefined;
  private patchMessageId = '';

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
    this.ended = true;
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

  /**
   * Independent tap completion: never infer the answer from a delimiter
   * or a single unverified JSON leaf. Only one complete, unambiguous JSON
   * object extracted from an answer-shaped response field can reach host
   * validation. Missing Agent fields are schema errors, never capture timeouts.
   */
  completedContract(): string | undefined {
    const sources = [...(this.profile
      ? [{ text: this.learnedText, score: 125, samples: this.learnedSamples, invalid: this.learnedInvalid,
          answer: !this.blockedMessage(), final: this.patchChannel === 'final' }]
      : [...this.candidates.values()]), ...this.patches.values()];
    const valid = new Map<string, string>();
    for (const source of sources) {
      if (source.invalid || source.answer === false || !source.samples || source.score < 80) continue;
      let value = source.text.trim();
      // Strip only the complete outer presentation wrapper. Literal tags
      // inside JSON strings remain source data; metadata is never a fallback.
      if (value.startsWith('<escape>') && value.endsWith('</escape>')) {
        value = value.slice(8, -9).trim();
      }
      try {
        const parsed = parseContractJson(value);
        if (parsed.repaired || parsed.value === null || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) continue;
        // Bare JSON in an unfinished, unclassified message can be native tool
        // arguments. Only a final channel or actual completion makes it a result.
        if (!Object.hasOwn(parsed.value, 'action') && !source.final && !this.ended && !this.terminalFrame) continue;
        const identity = JSON.stringify(parsed.value);
        valid.set(identity, value);
      } catch { /* Incomplete frame or marker in a literal is not completion. */ }
    }
    return valid.size === 1 ? [...valid.values()][0] : undefined;
  }

  hasTerminalFrame(): boolean { return this.terminalFrame; }

  /** Bounded failure evidence; response bytes are opt-in under full-content logging. */
  captureDiagnostics(includeText = false) {
    const sources = [
      ...(this.profile ? [{ path: 'learned', text: this.learnedText, score: 125,
        samples: this.learnedSamples, invalid: this.learnedInvalid }] : [...this.candidates.values()]),
      ...[...this.patches.entries()].map(([path, state]) => ({ ...state, path }))
    ];
    return {
      framing: this.matched?.framing, parsed_events: this.parsedEvents,
      buffered_chars: this.frameBuffer.length, raw_chars: this.rawText.length,
      patch_role: this.patchRole, patch_channel: this.patchChannel, patch_recipient: this.patchRecipient,
      terminal_frame: this.terminalFrame, candidate_count: sources.length,
      candidates: sources.sort((a, b) => b.score - a.score || b.samples - a.samples)
        .slice(0, 4).map(source => ({
          path: source.path.slice(0, 256), score: source.score, samples: source.samples,
          invalid: Boolean(source.invalid), chars: source.text.length,
          ...(includeText ? { text: source.text.slice(0, 8192) } : {})
        })),
      ...(includeText ? { raw_tail: this.rawText.slice(-8192) } : {})
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
    if (data === undefined) return [];
    if (data === '[DONE]') { this.terminalFrame = true; return []; }
    this.terminalFrame = false;
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
    if (this.contractMode && this.consumePatch(value)) return [];
    if (this.contractMode && this.blockedMessage()) return [];
    if (this.profile) {
      const deltas: string[] = [];
      const source = JSON.stringify([...(this.profile.jsonStringPaths ?? []), this.profile.textPath]);
      const decoded = tapProfileValues(value, this.profile.textPath, this.profile.jsonStringPaths);
      const values = collectTapStringLeaves(value).has(source) ? decoded : [];
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
        const key = this.patchMessageId + ':' + textMode + ':' + candidateKey;
        if (this.candidates.size >= 2 * RESOURCE_LIMITS.discoveryCandidates && !this.candidates.has(key)) throw new Error('Tap candidate limit exceeded');
        const state = this.candidates.get(key) ?? {
          path, jsonStringPaths, textMode, text: '', score: path === '$' ? 5 : tapPathScore(path), samples: 0,
          messageId: this.patchMessageId, answer: !this.blockedMessage(), final: this.patchChannel === 'final'
        };
        applyTapPiece(state, combined, textMode);
        this.candidates.set(key, state);
      }
    }
    return [];
  }

  private blockedMessage(): boolean {
    return Boolean((this.patchRole && !/^(?:assistant|model)$/i.test(this.patchRole))
      || (this.patchChannel && this.patchChannel !== 'final')
      || (this.patchRecipient && this.patchRecipient !== 'all'));
  }

  private invalidateMessage(): void {
    if (this.profile) this.learnedInvalid = true;
    for (const [key, state] of this.patches) {
      if (key.startsWith(this.patchMessageId + ':')) { state.answer = false; state.invalid = true; }
    }
    for (const state of this.candidates.values()) {
      if (state.messageId === this.patchMessageId) { state.answer = false; state.invalid = true; }
    }
  }

  private observeMessage(value: Record<string, JsonValue>): boolean {
    const envelope = isJsonObject(value.v) && (value.p === '' || (value.p === undefined && value.o === undefined))
      ? value.v : value;
    const message = value.p === '/message' ? value.v : envelope.message;
    if (!isJsonObject(message)) return false;
    const author = message.author;
    const role = message.role ?? (isJsonObject(author) ? author.role : undefined);
    if (typeof role !== 'string') return false;
    this.patchRole = role;
    this.patchRecipient = typeof message.recipient === 'string' ? message.recipient : undefined;
    this.patchChannel = typeof message.channel === 'string' ? message.channel : undefined;
    if (typeof message.id === 'string' && message.id.length > 256) throw new Error('Tap message identity limit exceeded');
    const messageId = typeof message.id === 'string' ? message.id : '';
    if (this.profile && messageId !== this.patchMessageId) {
      this.learnedText = '';
      this.learnedSamples = 0;
      this.learnedInvalid = false;
      Object.assign(this.alternative, {text: '', score: 1, samples: 0, invalid: false});
    }
    this.patchMessageId = messageId;
    this.patchTarget = undefined;
    if (this.blockedMessage()) { this.invalidateMessage(); return true; }
    const content = message.content;
    if (!isJsonObject(content)) return false;
    if (content.content_type === 'thoughts') { this.patchChannel = 'analysis'; this.invalidateMessage(); return true; }
    if (!Array.isArray(content.parts)) return false;
    if (content.parts.length > 128) throw new Error('Tap message part limit exceeded');
    content.parts.forEach((part, index) => {
      if (typeof part === 'string') this.applyPatchText('/message/content/parts/' + index, part, 'snapshot');
    });
    return true;
  }

  private applyPatchText(path: string, text: string, mode: 'delta' | 'snapshot', score = 100): void {
    const key = this.patchMessageId + ':' + path;
    if (!this.patches.has(key) && this.patches.size >= 128) throw new Error('Tap patch candidate limit exceeded');
    const state = this.patches.get(key) ?? { text: '', score, samples: 0, answer: !this.blockedMessage(), final: this.patchChannel === 'final' };
    if (!state.invalid) state.final = this.patchChannel === 'final';
    applyTapPiece(state, text, mode);
    if (state.text.length > 65_536) { state.text = ''; state.invalid = true; }
    this.patches.set(key, state);
  }

  /** Stateful text patches are not independent $.v leaves. Preserve their
   * declared target and operation, including continuation events, per turn. */
  private consumePatch(value: JsonValue, depth = 0): boolean {
    if (!isJsonObject(value)) return false;
    if (this.observeMessage(value)) return true;
    const explicit = Object.hasOwn(value, 'p') || Object.hasOwn(value, 'o');
    const batch = !explicit && Array.isArray(value.v) && value.v.length > 0
      && value.v.every(part => isJsonObject(part) && (Object.hasOwn(part, 'p') || Object.hasOwn(part, 'o')));
    if (value.o === 'patch' || batch) {
      this.patchTarget = undefined;
      if (depth >= 4 || !Array.isArray(value.v) || value.v.length > 128) throw new Error('Tap patch limit exceeded');
      for (const patch of value.v) this.consumePatch(patch, depth + 1);
      return true;
    }
    if (!explicit && (!this.patchTarget || !Object.hasOwn(value, 'v'))) return false;
    if (explicit) {
      const target = typeof value.p === 'string' ? value.p : this.patchTarget?.path;
      const mode = value.o === 'append' ? 'delta' : value.o === 'replace' || value.o === 'add' ? 'snapshot' : undefined;
      this.patchTarget = target && target.length <= 1024 && target.startsWith('/') && mode
        ? { path: target, mode } : undefined;
    }
    const target = this.patchTarget;
    // Message snapshots are seeded above. Only string patches update an
    // ordered text source; metadata objects never become source text.
    if (!target || typeof value.v !== 'string') return explicit && typeof value.v === 'string';
    if (target.path === '/message/channel' || target.path === '/message/recipient') {
      if (target.path === '/message/channel') this.patchChannel = value.v;
      else this.patchRecipient = value.v;
      if (this.blockedMessage()) this.invalidateMessage();
      return true;
    }
    if (this.blockedMessage()) return true;
    const segments = target.path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (segments.length > 20 || segments.some(part => /^(?:user|system|developer|tool|messages|history|prompt|input|request|metadata|thoughts|analysis|reasoning|citations?|attachments?)$/i.test(part))) return true;
    const path = segments.reduce((path, part) => appendJsonPath(path, /^\d+$/.test(part) ? Number(part) : part), '$');
    const score = tapPathScore(path);
    if (score < 80) return true;
    this.applyPatchText(target.path, value.v, target.mode, score);
    return true;
  }
}

