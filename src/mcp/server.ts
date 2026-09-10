import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { parseCliArgs } from '../config.js';
import { RESOURCE_LIMITS } from '../core/resource-limits.js';
import { configureLogger } from '../logger.js';
import { providerIds } from '../providers/catalog.js';
import { createRuntime } from '../runtime/runtime-factory.js';
import { createIsolatedUiSession } from '../runtime/isolated-ui-session.js';
import { SessionManager } from '../runtime/session-manager.js';
import { SERVICE_NAME, SERVICE_VERSION } from '../version.js';

interface AskArgs {
  message: string;
  session_id?: string;
}

class McpHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'McpHttpError';
  }
}

const askSchema = fromJsonSchema<AskArgs>({
  type: 'object',
  properties: {
    message: { type: 'string', minLength: 1, maxLength: RESOURCE_LIMITS.uiPromptChars },
    session_id: { type: 'string', pattern: '^[A-Za-z0-9]{1,64}$' }
  },
  required: ['message'],
  additionalProperties: false
});

function createKittMcpServer(manager: SessionManager, provider: string): McpServer {
  const server = new McpServer({
    name: SERVICE_NAME,
    version: SERVICE_VERSION,
    description: `MCP facade for the active KITT ${provider} web-chat provider.`
  }, { capabilities: { tools: {}, resources: {} } });

  const registerAsk = (name: string, description: string): void => {
    server.registerTool(name, {
      description,
      inputSchema: askSchema
    }, async ({ message, session_id }) => {
      const result = await manager.execute(session_id, {
        model: manager.modelId,
        messages: [{ role: 'user', content: message }]
      });
      const response = result.completion.choices[0]?.message.content || '';
      const output = {
        response,
        session_id: session_id || 'default',
        provider
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
        structuredContent: output
      };
    });
  };

  if (['chatgpt', 'claude', 'gemini'].includes(provider)) {
    registerAsk(`ask_${provider}`, `Ask the active ${provider} web session through KITT.`);
  }
  registerAsk('ask_generic', `Ask the active ${provider} web session through KITT using a provider-neutral tool name.`);

  server.registerResource(
    'kitt-sessions',
    'kitt://sessions',
    { title: 'KITT active sessions', mimeType: 'application/json' },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(manager.list())
      }]
    })
  );

  return server;
}

function declaredBodySize(req: IncomingMessage): number | undefined {
  const raw = req.headers['content-length'];
  if (raw === undefined) return undefined;
  const text = Array.isArray(raw) ? raw[0] : raw;
  const size = Number(text);
  if (!Number.isSafeInteger(size) || size < 0) throw new McpHttpError(400, 'Invalid Content-Length.');
  return size;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const declared = declaredBodySize(req);
  if (declared !== undefined && declared > RESOURCE_LIMITS.mcpRequestBytes) {
    throw new McpHttpError(413, 'MCP request body too large.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.length;
    if (size > RESOURCE_LIMITS.mcpRequestBytes) {
      throw new McpHttpError(413, 'MCP request body too large.');
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks, size) : undefined;
}

async function serveWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!res.write(Buffer.from(item.value))) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (error) {
    res.destroy(error instanceof Error ? error : new Error(String(error)));
  } finally {
    reader.releaseLock();
  }
}

function sendMcpBoundaryError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const status = error instanceof McpHttpError ? error.status : 500;
  const message = error instanceof McpHttpError ? error.message : 'Internal MCP gateway error.';
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: { message, code: status === 413 ? 'request_too_large' : 'mcp_gateway_error' } }));
}

async function serveHttpMcp(manager: SessionManager, provider: string, port: number): Promise<void> {
  const handler = createMcpHandler(() => createKittMcpServer(manager, provider));
  const origin = `http://127.0.0.1:${port}`;
  const http = createHttpServer(async (req, res) => {
    try {
      const requestTarget = req.url || '/mcp';
      if (/^https?:\/\//i.test(requestTarget)) throw new McpHttpError(400, 'Absolute request targets are not accepted.');
      const url = new URL(requestTarget, origin);
      if (url.origin !== origin || url.pathname !== '/mcp') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      const body = await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined || key.toLowerCase() === 'host') continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(key, item);
        } else {
          headers.set(key, value);
        }
      }
      const request = new Request(url, {
        method: req.method || 'GET',
        headers,
        ...(body ? { body: new Uint8Array(body) } : {})
      });
      const response = await handler.fetch(request);
      await serveWebResponse(response, res);
    } catch (error) {
      sendMcpBoundaryError(res, error);
    }
  });

  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  http.keepAliveTimeout = 5_000;
  http.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, '127.0.0.1', () => resolve());
  });
  console.error(`KITT MCP Streamable HTTP listening on ${origin}/mcp`);

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      http.close(() => resolve());
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

function parseMcpArgs(args: string[]): { proxyArgs: string[]; mcpPort?: number } {
  const providers = new Set(providerIds());
  const remaining: string[] = [];
  let mcpPort: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--mcp-port') {
      const raw = args[index + 1];
      if (!raw) throw new Error('Valor ausente para --mcp-port.');
      const port = Number(raw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--mcp-port deve estar entre 1 e 65535.');
      mcpPort = port;
      index += 1;
      continue;
    }
    remaining.push(arg);
  }

  const providerIndex = remaining.findIndex((arg) => providers.has(arg as ReturnType<typeof providerIds>[number]));
  if (providerIndex < 0) throw new Error(`Informe o provider MCP: ${[...providers].join('|')}.`);
  const provider = remaining[providerIndex]!;
  remaining.splice(providerIndex, 1);
  return { proxyArgs: [provider, ...remaining], ...(mcpPort ? { mcpPort } : {}) };
}

export async function runMcpCli(args: string[]): Promise<number> {
  const parsedArgs = parseMcpArgs(args);
  if (!parsedArgs.mcpPort) configureLogger({ sink: 'stderr' });

  const parsed = parseCliArgs(parsedArgs.proxyArgs);
  if ('help' in parsed) throw new Error('Use: kitt-reverse-proxy mcp [--mcp-port <porta>] <provider> [opções do proxy].');
  configureLogger({ format: parsed.logFormat, ...(parsedArgs.mcpPort ? {} : { sink: 'stderr' }) });

  const runtime = await createRuntime(parsed);
  const manager = new SessionManager({
    defaultExecutor: runtime.executor,
    defaultBrowserSession: runtime.session,
    provider: runtime.provider.id,
    config: parsed,
    ...(runtime.transport === 'ui'
      ? { factory: async () => createIsolatedUiSession(runtime.session, runtime.provider, parsed) }
      : {})
  });

  try {
    if (parsedArgs.mcpPort) {
      await serveHttpMcp(manager, runtime.provider.id, parsedArgs.mcpPort);
    } else {
      await serveStdio(() => createKittMcpServer(manager, runtime.provider.id));
    }
    return 0;
  } finally {
    await manager.close();
    await runtime.session.close();
  }
}
