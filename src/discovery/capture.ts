import type { Request, Response } from 'playwright';
import { logger } from '../logger.js';
import { openBrowserSession, navigateSession } from '../runtime/browser-session.js';
import { sanitizeCapturedHeaders } from '../security/headers.js';
import { assertAllowedEndpoint } from '../security/url-policy.js';
import type { AppConfig, CapturedExchange, JsonValue, LiveBrowserSession, ProviderId, RequestBodyCodecDescriptor } from '../types.js';
import { decodeRequestBody } from './body-codec.js';
import { decodeTextBody } from './decoder.js';
import { scoreRequestCandidate, scoreResponseCandidate } from './scoring.js';

interface Candidate {
  request: Request;
  endpointUrl: string;
  headers: Record<string, string>;
  requestSample: CapturedExchange['requestSample'];
  requestCodec: RequestBodyCodecDescriptor;
  requestContentType: string;
  responseSample: JsonValue | null;
  responseHeaders: Record<string, string>;
  responseContentType: string;
  score: number;
}

async function readResponse(response: Response): Promise<{ body: JsonValue; headers: Record<string, string>; contentType: string }> {
  await response.finished();
  const headers = await response.allHeaders();
  const contentType = headers['content-type'] || '';
  const text = await response.text();
  return { body: decodeTextBody(text, contentType), headers, contentType };
}

export async function captureChatExchange(
  config: AppConfig,
  provider: ProviderId = 'generic'
): Promise<{ capture: CapturedExchange; session: LiveBrowserSession }> {
  const session = await openBrowserSession(config);
  const page = session.page;
  const candidates = new Map<Request, Candidate>();
  const blockedHosts = new Set<string>();
  let best: Candidate | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveCapture!: (candidate: Candidate) => void;
  let rejectCapture!: (error: Error) => void;
  let selected = false;

  const done = new Promise<Candidate>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });

  const consider = (candidate: Candidate): void => {
    if (!best || candidate.score > best.score) best = candidate;
    if (candidate.score < 60 || selected) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (!selected && best) {
        selected = true;
        resolveCapture(best);
      }
    }, config.settleAfterCandidateMs);
  };

  const onRequest = (request: Request): void => {
    if (selected || request.method() !== 'POST') return;
    void (async () => {
      const postData = request.postData();
      if (!postData) return;
      const allHeaders = await request.allHeaders();
      const contentType = allHeaders['content-type'] || '';
      const decoded = decodeRequestBody(postData, contentType);
      if (!decoded) return;

      const rawUrl = request.url();
      const preliminaryScore = scoreRequestCandidate(rawUrl, decoded.body, request.resourceType(), provider);
      let endpointUrl: string;
      try {
        endpointUrl = assertAllowedEndpoint(config.targetUrl, rawUrl, config.allowedEndpointHosts).toString();
      } catch {
        if (preliminaryScore >= 55) {
          const host = new URL(rawUrl).hostname;
          if (!blockedHosts.has(host)) {
            blockedHosts.add(host);
            logger.warn(`Candidato de chat em host externo ignorado: ${host}. Se esse backend for autorizado, reinicie com --allow-endpoint-host ${host}`);
          }
        }
        return;
      }
      if (preliminaryScore < 35) return;

      const candidate: Candidate = {
        request,
        endpointUrl,
        headers: sanitizeCapturedHeaders(allHeaders),
        requestSample: decoded.body,
        requestCodec: decoded.codec,
        requestContentType: contentType || (decoded.codec.kind === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'),
        responseSample: null,
        responseHeaders: {},
        responseContentType: '',
        score: preliminaryScore
      };
      candidates.set(request, candidate);
      consider(candidate);
    })().catch((error: unknown) => logger.warn(`Falha ao inspecionar request: ${String(error)}`));
  };

  const onResponse = (response: Response): void => {
    const candidate = candidates.get(response.request());
    if (!candidate) return;
    void readResponse(response).then((decoded) => {
      candidate.responseSample = decoded.body;
      candidate.responseHeaders = decoded.headers;
      candidate.responseContentType = decoded.contentType;
      candidate.score += scoreResponseCandidate(decoded.contentType, decoded.body);
      if (!selected) consider(candidate);
    }).catch((error: unknown) => logger.warn(`Falha ao ler response candidata: ${String(error)}`));
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  timeoutTimer = setTimeout(() => {
    if (selected) return;
    selected = true;
    if (best && best.score >= 45) {
      resolveCapture(best);
      return;
    }
    rejectCapture(new Error(
      `Nenhum endpoint de chat confiável foi detectado em ${config.captureTimeoutMs / 1000}s. ` +
      'No Chromium, abra o chat e envie uma mensagem manualmente.'
    ));
  }, config.captureTimeoutMs);

  const cleanup = (): void => {
    if (settleTimer) clearTimeout(settleTimer);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    page.off('request', onRequest);
    page.off('response', onResponse);
  };

  try {
    logger.info(config.headed
      ? 'Chromium aberto. Envie uma mensagem no chat para ensinar o endpoint de rede.'
      : 'Modo headless: aguardando uma requisição de chat emitida pela página.');
    await navigateSession(session, config.targetUrl, config.captureTimeoutMs)
      .catch((error: unknown) => logger.warn(`Navegação não concluiu normalmente: ${error instanceof Error ? error.message : String(error)}`));

    const candidate = await done;
    if (!candidate.responseSample) {
      const deadline = Date.now() + config.responseSampleTimeoutMs;
      while (!candidate.responseSample && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }

    cleanup();
    return {
      capture: Object.freeze({
        endpointUrl: candidate.endpointUrl,
        headers: Object.freeze({ ...candidate.headers }),
        requestSample: candidate.requestSample,
        requestCodec: Object.freeze({ ...candidate.requestCodec, jsonStringPaths: Object.freeze([...candidate.requestCodec.jsonStringPaths]) }) as RequestBodyCodecDescriptor,
        responseSample: candidate.responseSample,
        responseHeaders: Object.freeze({ ...candidate.responseHeaders }),
        score: candidate.score,
        requestContentType: candidate.requestContentType,
        responseContentType: candidate.responseContentType
      }),
      session
    };
  } catch (error) {
    cleanup();
    await session.close();
    throw error;
  }
}
