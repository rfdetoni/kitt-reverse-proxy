import { chromium, type Request, type Response } from 'playwright';
import { logger } from '../logger.js';
import type { AppConfig, CapturedExchange, JsonObject, JsonValue, LiveBrowserSession } from '../types.js';
import { isJsonObject } from '../util/json.js';
import { assertAllowedEndpoint } from '../security/url-policy.js';
import { sanitizeCapturedHeaders } from '../security/headers.js';
import { decodeTextBody } from './decoder.js';
import { scoreRequestCandidate, scoreResponseCandidate } from './scoring.js';

interface Candidate {
  request: Request;
  endpointUrl: string;
  headers: Record<string, string>;
  requestSample: JsonObject;
  requestContentType: string;
  responseSample: JsonValue | null;
  responseHeaders: Record<string, string>;
  responseContentType: string;
  score: number;
}

function parseRequestBody(request: Request): JsonObject | null {
  const text = request.postData();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isJsonObject(parsed)) return parsed;
  } catch {
    // Continue to fallback parsers
  }
  try {
    const params = new URLSearchParams(text);
    const entries = [...params.entries()];
    if (entries.length > 0 && entries.some(([_, v]) => v.length > 0)) {
      const obj: JsonObject = {};
      for (const [k, v] of entries) {
        try {
          const inner = JSON.parse(v);
          obj[k] = isJsonObject(inner) || Array.isArray(inner) ? inner : v;
        } catch {
          obj[k] = v;
        }
      }
      return obj;
    }
  } catch {
    // Non-parseable body
  }
  return null;
}

async function readResponse(response: Response): Promise<{ body: JsonValue; headers: Record<string, string>; contentType: string }> {
  await response.finished();
  const headers = await response.allHeaders();
  const contentType = headers['content-type'] || '';
  const text = await response.text();
  return { body: decodeTextBody(text, contentType), headers, contentType };
}

export async function captureChatExchange(config: AppConfig): Promise<{ capture: CapturedExchange; session: LiveBrowserSession }> {
  const browser = await chromium.launch({ headless: !config.headed });
  const context = await browser.newContext();
  const page = await context.newPage();
  const candidates = new Map<Request, Candidate>();
  const blockedHosts = new Set<string>();
  let best: Candidate | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCapture!: (candidate: Candidate) => void;
  let rejectCapture!: (error: Error) => void;
  let settled = false;

  const done = new Promise<Candidate>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });

  const consider = (candidate: Candidate): void => {
    if (!best || candidate.score > best.score) best = candidate;
    if (candidate.score < 60) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!settled && best) {
        settled = true;
        resolveCapture(best);
      }
    }, config.settleAfterCandidateMs);
  };

  page.on('request', (request: Request) => {
    if (settled || request.method() !== 'POST') return;
    void (async () => {
      const body = parseRequestBody(request);
      if (!body) return;
      const rawUrl = request.url();
      const preliminaryScore = scoreRequestCandidate(rawUrl, body, request.resourceType());
      let endpointUrl: string;
      try {
        endpointUrl = assertAllowedEndpoint(config.targetUrl, rawUrl, config.allowedEndpointHosts).toString();
      } catch {
        if (preliminaryScore >= 60) {
          const host = new URL(rawUrl).hostname;
          if (!blockedHosts.has(host)) {
            blockedHosts.add(host);
            logger.warn(`Candidato de chat em host externo ignorado: ${host}. Se esse backend for autorizado, reinicie com --allow-endpoint-host ${host}`);
          }
        }
        return;
      }
      const score = preliminaryScore;
      if (score < 35) return;
      const allHeaders = await request.allHeaders();
      const candidate: Candidate = {
        request,
        endpointUrl,
        headers: sanitizeCapturedHeaders(allHeaders),
        requestSample: body,
        requestContentType: allHeaders['content-type'] || 'application/json',
        responseSample: null,
        responseHeaders: {},
        responseContentType: '',
        score
      };
      candidates.set(request, candidate);
      consider(candidate);
    })().catch((error: unknown) => logger.warn(`Falha ao inspecionar request: ${String(error)}`));
  });

  page.on('response', (response: Response) => {
    const candidate = candidates.get(response.request());
    if (!candidate || settled) return;
    void readResponse(response).then((decoded) => {
      candidate.responseSample = decoded.body;
      candidate.responseHeaders = decoded.headers;
      candidate.responseContentType = decoded.contentType;
      candidate.score += scoreResponseCandidate(decoded.contentType, decoded.body);
      consider(candidate);
    }).catch((error: unknown) => logger.warn(`Falha ao ler response candidata: ${String(error)}`));
  });

  timeoutTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    if (best && best.score >= 45) {
      resolveCapture(best);
      return;
    }
    rejectCapture(new Error(
      `Nenhum endpoint de chat confiável foi detectado em ${config.captureTimeoutMs / 1000}s. ` +
      'No Chromium, abra o chat e envie uma mensagem manualmente.'
    ));
  }, config.captureTimeoutMs);

  try {
    logger.info(config.headed
      ? 'Chromium aberto. Envie uma mensagem no chat para ensinar o endpoint.'
      : 'Modo headless: aguardando uma requisição de chat emitida pela página.');
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(config.captureTimeoutMs, 60_000) })
      .catch((error: unknown) => logger.warn(`Navegação não concluiu normalmente: ${error instanceof Error ? error.message : String(error)}`));
    const candidate = await done;

    if (!candidate.responseSample) {
      const deadline = Date.now() + config.responseSampleTimeoutMs;
      while (!candidate.responseSample && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const session: LiveBrowserSession = {
      browser,
      context,
      page,
      async close(): Promise<void> {
        await context.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
      }
    };

    return {
      capture: Object.freeze({
        endpointUrl: candidate.endpointUrl,
        headers: Object.freeze({ ...candidate.headers }),
        requestSample: candidate.requestSample,
        responseSample: candidate.responseSample,
        responseHeaders: Object.freeze({ ...candidate.responseHeaders }),
        score: candidate.score,
        requestContentType: candidate.requestContentType,
        responseContentType: candidate.responseContentType
      }),
      session
    };
  } catch (error) {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  } finally {
    if (settleTimer) clearTimeout(settleTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}
