# kitt-reverse-proxy (Adaptive OpenAI Web Proxy v2)

Proxy local que transforma uma sessão de **chat web que você está autorizado a automatizar** em uma API compatível com OpenAI para uso por agentes e ferramentas locais.

A versão 2 foi redesenhada para uso real:

- TypeScript estrito;
- Chromium/Playwright permanece ativo durante todo o runtime;
- chamadas upstream usam `BrowserContext.request`, compartilhando o cookie jar da sessão;
- nenhum JavaScript é gerado ou executado pela LLM;
- mappings são profiles JSON declarativos, validados e reutilizáveis;
- suporte a IDs/timestamps dinâmicos e atualização de estado de conversa;
- fila serial por padrão para não misturar sessões stateful;
- `POST /v1/chat/completions`;
- shim de `POST /v1/responses` para texto;
- `GET /v1/models` e `GET /healthz`;
- API key obrigatória quando o bind não é loopback;
- cookies e headers de sessão nunca são gravados em profiles.

> O projeto não tenta resolver CAPTCHA, burlar autenticação, contornar anti-bot ou remover controles de acesso. Sites podem proibir automação em seus termos. Use somente onde você possui autorização.

## Por que o browser permanece aberto?

Muitos chats web dependem de cookies, CSRF, estado de sessão e tokens renovados pelo navegador. A versão final mantém o `BrowserContext` vivo e envia as chamadas de API pelo `APIRequestContext` associado a ele. Assim, cookies do contexto são reutilizados e atualizados sem copiá-los para disco.

## Arquitetura

```text
                 Chromium / Playwright
                         │
              usuário envia 1 mensagem
                         │
                         ▼
              Discovery + Candidate Score
                         │
              request/response sample
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
      Profile existente        Ollama local
             │                       │
             │                 Mapping JSON v2
             │                       │
             └───────────┬───────────┘
                         ▼
              Declarative Mapping Engine
             (sem eval / vm / código LLM)
                         │
              OpenAI-compatible Server
                         │
                  Serial Request Queue
                         │
                         ▼
                BrowserContext.request
                         │
                         ▼
                  endpoint do chat
```

## Requisitos

- Node.js 20+
- Ollama local, a menos que você use `--profile`
- Playwright Chromium

## Instalação

```bash
npm install
npx playwright install chromium
npm run build
```

Modelo sugerido:

```bash
ollama pull qwen2.5-coder:7b
```

## Uso básico

```bash
npm start -- https://site.example/chat
```

O Chromium abrirá visível. Abra o widget/chat e envie **uma mensagem**. O proxy selecionará a requisição candidata com maior score, aprenderá o profile e iniciará a API. Se o widget usar um backend legítimo em domínio de terceiro, o CLI mostra o host bloqueado e você pode autorizá-lo explicitamente com `--allow-endpoint-host`.

Exemplo de saída:

```text
[1/3] Descobrindo endpoint e sessão do chat...
[i] Chromium aberto. Envie uma mensagem no chat para ensinar o endpoint.
[+] Endpoint encontrado: https://... (score 104)
[2/3] Aprendendo mapping declarativo...
[+] Mapping pronto: ollama. Código gerado por LLM: nenhum.
[3/3] Iniciando API OpenAI-compatible...
[+] Proxy iniciado em http://127.0.0.1:3000
```

### Chat Completions

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "adaptive-web-chat",
    "messages": [
      {"role":"user","content":"Olá"}
    ],
    "stream": true
  }'
```

`stream: true` produz fluxo Server-Sent Events (SSE) com emissão progressiva de deltas em tempo real conforme retornados ou gerados pelo upstream.

### Responses API

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "model": "adaptive-web-chat",
    "input": "Olá",
    "stream": false
  }'
```

O endpoint `/v1/responses` suporta tanto requisições completas com `stream: false` quanto streaming SSE com eventos padrão (`response.created`, `response.text.delta`, `response.completed`, `[DONE]`) quando `stream: true`.

## Profiles reutilizáveis

Um profile contém apenas regras de estrutura; não contém cookies, authorization headers ou o request capturado.

Aprender e salvar:

```bash
npm start -- https://site.example/chat --save-profile ./site-profile.json
```

Reusar sem consultar o Ollama:

```bash
npm start -- https://site.example/chat --profile ./site-profile.json
```

A captura inicial continua necessária porque ela obtém a sessão web atual e o request-base atual.

## Mapping declarativo

Exemplo:

```json
{
  "version": 2,
  "request": {
    "bindings": [
      {
        "target": "$.message.text",
        "source": "openai.last_user_text"
      },
      {
        "target": "$.message.id",
        "source": "generated.uuid"
      }
    ]
  },
  "response": {
    "contentPaths": ["$.eventStream[*].delta.text"],
    "joinStrategy": "smart",
    "separator": ""
  },
  "state": {
    "updates": [
      {
        "responsePath": "$.conversationId",
        "requestTarget": "$.conversationId",
        "optional": true
      }
    ]
  }
}
```

Fontes aceitas incluem mensagens OpenAI, último texto do usuário, transcript, model/temperature, UUID/request ID e timestamps. Não existe uma fonte que execute código. Suporta payloads JSON e `application/x-www-form-urlencoded`.

## Uso com agentes

A compatibilidade oferecida é de transporte/mensagem. O chat web alvo continua definindo as capacidades reais do modelo.

- `system`, `user`, `assistant` e `tool` podem ser convertidos para texto/contexto;
- `tools` e `tool_choice` podem ser enviados ao mapping como JSON quando o endpoint alvo tiver um campo equivalente;
- o proxy **não inventa suporte nativo a function calling** se o site não o oferece;
- chats stateful são serializados para reduzir cross-talk;
- para conversas independentes simultâneas, prefira uma instância do proxy por sessão/conversa quando o site tiver estado no servidor.

## Opções

```text
--model <nome>
--ollama-url <url>
--host <host>
--port <porta>
--capture-timeout <segundos>
--upstream-timeout <segundos>
--profile <arquivo>
--save-profile <arquivo>
--api-key <chave>
--allow-endpoint-host <host>
--min-interval-ms <ms>
--max-queue <n>
--headless
--headed
--no-cors
--follow-redirects
--no-redirects
```

Variáveis:

```text
OLLAMA_MODEL
OLLAMA_URL
PROXY_HOST
PROXY_PORT
PROXY_API_KEY
PROXY_MAX_QUEUE
PROXY_MIN_INTERVAL_MS
PROXY_FOLLOW_REDIRECTS
CAPTURE_TIMEOUT_MS
CAPTURE_SETTLE_MS
RESPONSE_SAMPLE_TIMEOUT_MS
OLLAMA_TIMEOUT_MS
UPSTREAM_TIMEOUT_MS
```

## Limitações intencionais

- não há CAPTCHA solving, stealth plugin ou bypass de WAF/anti-bot;
- endpoints que assinam cada request com JavaScript proprietário podem exigir integração específica e não devem ser contornados por técnicas de bypass.

## Desenvolvimento

```bash
npm run check
npm test
npm run build
```

## Estrutura

```text
src/
  cli.ts
  config.ts
  types.ts
  discovery/
    capture.ts
    decoder.ts
    scoring.ts
  mapping/
    engine.ts
    factory.ts
    fallback.ts
    messages.ts
    ollama.ts
    profile.ts
  proxy/
    openai.ts
    server.ts
  runtime/
    serial-queue.ts
    upstream.ts
  security/
    headers.ts
    redaction.ts
    url-policy.ts
  util/
    json.ts
    path.ts
```
