# kitt-reverse-proxy v3

Proxy local que transforma chats web que você está autorizado a automatizar em uma API compatível com OpenAI para uso por agentes e ferramentas locais.

A v3 combina dois modos de execução:

- **UI transport** para ChatGPT, Claude, Gemini, Kimi e DeepSeek. O Playwright envia a mensagem pela interface real do site e lê a resposta renderizada, evitando hardcode de APIs web privadas, tokens efêmeros, PoW/RPCs proprietários e endpoints frágeis.
- **Network transport** para chats genéricos e widgets. O proxy aprende um endpoint `POST`, decodifica JSON ou `application/x-www-form-urlencoded`, gera/valida um profile declarativo e reaproveita a sessão do BrowserContext.

O projeto não implementa stealth, CAPTCHA solver, WAF bypass, autenticação bypass ou qualquer mecanismo destinado a esconder automação. Quando um CAPTCHA, login ou challenge anti-bot aparece, a v3 detecta o estado e exige intervenção manual no Chromium visível.

## Principais recursos

- Node.js 20+ e TypeScript estrito;
- Playwright/Chromium permanece ativo durante todo o runtime;
- autodetecção de provider: `chatgpt`, `claude`, `gemini`, `kimi`, `deepseek` e `generic`;
- UI transport por padrão nos cinco grandes chats;
- network discovery para widgets/chats genéricos;
- profile Chromium persistente opcional com `--user-data-dir`;
- detecção de CAPTCHA, login e challenge anti-bot com retomada após resolução manual;
- sem `eval`, `Function`, `vm` ou código executável gerado pela LLM;
- profiles de mapping são JSON declarativo validado;
- codec reversível para JSON e `application/x-www-form-urlencoded`;
- suporte a campos form que contêm JSON serializado, como `f.req`;
- decoder para JSON, SSE, NDJSON e respostas JSON com prefixo XSSI/frames de tamanho;
- JSON Path seguro com wildcard e chaves quoted, por exemplo `$["f.req"]`;
- atualização declarativa de `conversationId`, `threadId`, `sessionId` e outros estados capturados;
- fila serial limitada para evitar cross-talk entre chamadas stateful;
- OpenAI Chat Completions e shim textual de Responses API;
- streaming SSE compatível no lado do cliente;
- `GET /v1/kitt/status` e `POST /v1/kitt/reset`;
- bind apenas em loopback por padrão; bind externo exige API key;
- cookies não são copiados para profiles nem logs de mapping.

## Arquitetura

```text
                         OpenAI-compatible client
                                  │
                     /v1/chat/completions
                         /v1/responses
                                  │
                                  ▼
                         Bounded Serial Queue
                                  │
                       Provider / Transport Router
                            ┌─────┴─────┐
                            │           │
                            ▼           ▼
                     UI transport    Network transport
                            │           │
             ChatGPT/Claude/Gemini     Discovery + score
               Kimi/DeepSeek           body codec
                            │           │
                            ▼           ▼
                   Browser page       Declarative mapper
                            │           │
                            └─────┬─────┘
                                  ▼
                         Chromium / Playwright
                                  │
                     sessão/cookies do usuário
                                  │
                                  ▼
                              chat web
```

## Estratégia por provider

| Provider | Detecção automática | Transporte padrão | Modelo exposto por padrão |
| --- | --- | --- | --- |
| ChatGPT | `chatgpt.com`, `chat.openai.com` | UI | `chatgpt-web` |
| Claude | `claude.ai` | UI | `claude-web` |
| Gemini | `gemini.google.com` | UI | `gemini-web` |
| Kimi | `kimi.com`, `kimi.moonshot.cn` | UI | `kimi-web` |
| DeepSeek | `chat.deepseek.com`, `deepseek.com` | UI | `deepseek-web` |
| Genérico | qualquer outro | Network | `adaptive-web-chat` |

Os seletores UI são fallbacks heurísticos centralizados em `src/providers/catalog.ts`. Não há reprodução fixa das APIs privadas desses cinco providers.

## Requisitos

- Node.js 20+
- npm
- Chromium do Playwright
- Ollama local apenas para **network transport** sem `--profile`

## Instalação

```bash
npm install
npx playwright install chromium
npm run build
npm test
```

Para network mapping automático, modelo local sugerido:

```bash
ollama pull qwen2.5-coder:7b
```

## Uso rápido

### ChatGPT

```bash
npm start -- https://chatgpt.com/ \
  --user-data-dir ~/.kitt-reverse-proxy/chatgpt
```

### Claude

```bash
npm start -- https://claude.ai/new \
  --user-data-dir ~/.kitt-reverse-proxy/claude
```

### Gemini

```bash
npm start -- https://gemini.google.com/app \
  --user-data-dir ~/.kitt-reverse-proxy/gemini
```

### Kimi

```bash
npm start -- https://www.kimi.com/ \
  --user-data-dir ~/.kitt-reverse-proxy/kimi
```

### DeepSeek

```bash
npm start -- https://chat.deepseek.com/ \
  --user-data-dir ~/.kitt-reverse-proxy/deepseek
```

Na primeira execução, conclua login, consentimentos e qualquer desafio humano manualmente no Chromium. O proxy aguarda o campo de chat e prossegue quando a UI estiver disponível.

### Chat genérico / widget

```bash
npm start -- https://site.example/chat
```

Envie uma mensagem manual pelo Chromium para ensinar o endpoint. Se o backend legítimo estiver em outro host, autorize-o explicitamente:

```bash
npm start -- https://site.example/chat \
  --allow-endpoint-host chat.vendor.example
```

## API OpenAI-compatible

### Chat Completions

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "chatgpt-web",
    "messages": [
      {"role":"user","content":"Explique este código em três pontos."}
    ],
    "stream": false
  }'
```

Com `stream: true`, o proxy responde usando SSE OpenAI-compatible. No **UI transport**, os deltas são enviados progressivamente conforme o DOM da resposta cresce. No **network transport**, o `BrowserContext.request` agrega a resposta upstream; depois disso o proxy converte SSE/NDJSON/frames capturados em chunks compatíveis, sem afirmar streaming byte-a-byte que o transporte não oferece.

### Responses API

```bash
curl http://127.0.0.1:3000/v1/responses \
  -H 'content-type: application/json' \
  -d '{
    "model": "gemini-web",
    "instructions": "Responda de forma objetiva.",
    "input": "Qual é a diferença entre TCP e UDP?",
    "stream": false
  }'
```

Em streaming, `/v1/responses` usa os eventos atuais `response.output_text.delta`, `response.output_text.done`, `response.content_part.done`, `response.output_item.done` e `response.completed`.

### Status

```bash
curl http://127.0.0.1:3000/v1/kitt/status
```

### Nova conversa/reset

```bash
curl -X POST http://127.0.0.1:3000/v1/kitt/reset
```

No UI transport, o reset navega para a URL de nova conversa configurada para o provider e limpa o histórico local do proxy.

## Semântica do histórico no UI transport

Clientes OpenAI normalmente reenviam o histórico completo. O UI transport mantém um histórico canônico local para não reenviar turnos já presentes no chat web.

- se o histórico recebido é uma extensão do histórico conhecido, somente os novos turnos são enviados;
- retries idênticos de clientes que reenviam histórico completo retornam o último resultado em vez de duplicar o turno no chat web;
- se o cliente envia apenas o novo turno, o proxy o aceita e confia no estado do chat web;
- se o histórico diverge, o proxy inicia uma nova conversa e reaplica o contexto recebido;
- mensagens `system`/`developer`, `user`, `assistant` e `tool` são convertidas para texto quando precisam ser enviadas pela UI;
- `tools`/`tool_choice` não viram function calling nativo quando o site não expõe essa capacidade.

## CAPTCHA, login e anti-bot

A v3 contém **detecção e handoff manual**, não bypass.

Quando o campo de chat não está disponível, o proxy procura sinais de:

- reCAPTCHA;
- hCaptcha;
- Cloudflare challenge;
- páginas/iframes com `captcha` ou `challenge`;
- verificações como "checking your browser" / "unusual traffic";
- páginas de login e inputs de senha.

Em modo headed:

1. o proxy registra o motivo;
2. mantém o Chromium aberto;
3. aguarda o usuário resolver login/CAPTCHA/challenge;
4. retoma automaticamente quando o campo de chat reaparece.

Em `--headless`, um challenge que exige interação gera erro `manual_intervention_required`/HTTP 503.

Flags `--stealth`, `--captcha-solver` e `--bypass` são explicitamente rejeitadas pelo CLI.

## Perfil Chromium persistente

```bash
--user-data-dir ~/.kitt-reverse-proxy/<provider>
```

Isso usa `chromium.launchPersistentContext()` e permite que o próprio Chromium persista login/cookies/localStorage no diretório escolhido.

O diretório contém material sensível de sessão. Não o versione e proteja-o como credencial.

## Network transport

Pode ser forçado com:

```bash
--transport network
```

O fluxo é:

1. interceptar candidatos `POST`;
2. decodificar JSON ou form-urlencoded;
3. pontuar request/response;
4. selecionar o melhor candidato;
5. aprender/carregar profile declarativo;
6. reconstruir o request com o codec original;
7. enviar via `BrowserContext.request` compartilhando o cookie jar do browser.

### Form/RPC

Campos form que contêm JSON são convertidos temporariamente para estruturas JSON durante o mapping e reserializados antes do replay.

Exemplo:

```text
f.req=<JSON serializado>
```

pode ser mapeado por paths como:

```text
$["f.req"][0][0][1]
```

Isso permite lidar com formatos RPC mutáveis sem codificar um `rpcid` fixo.

### Respostas

O decoder reconhece:

- JSON normal;
- `text/event-stream`;
- NDJSON / JSON sequence;
- prefixo XSSI `)]}'`;
- JSON em frames/linhas precedidos por tamanhos numéricos.

## Profiles declarativos

O Ollama não gera JavaScript. Ele produz apenas JSON que passa por validação estrita.

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
        "target": "$.requestId",
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

Salvar:

```bash
npm start -- https://site.example/chat \
  --save-profile ./profiles/site.json
```

Reusar:

```bash
npm start -- https://site.example/chat \
  --profile ./profiles/site.json
```

Profiles não armazenam cookies nem headers capturados.

## Redirects e headers sensíveis

Redirects no network transport são **bloqueados por padrão**.

```bash
--follow-redirects
```

é opt-in. Mesmo habilitados, redirects são tratados manualmente com `maxRedirects: 0`, limitados a cinco saltos e **somente dentro do mesmo origin** do endpoint inicial. Redirect cross-origin é bloqueado antes de qualquer replay de headers capturados.

## Opções CLI

```text
--provider <id>                    auto|generic|chatgpt|claude|gemini|kimi|deepseek
--transport <modo>                 auto|ui|network
--api-model <id>                   ID exposto em /v1/models
--model <nome>                     Modelo Ollama usado no network mapping
--ollama-url <url>                 Endpoint /api/generate do Ollama
--user-data-dir <dir>              Perfil Chromium persistente
--host <host>                      Bind HTTP
--port <porta>                     Porta HTTP
--capture-timeout <seg>            Timeout de discovery
--upstream-timeout <seg>           Timeout do network transport
--ui-response-timeout <seg>        Timeout para resposta UI
--ui-settle-ms <ms>                Tempo de estabilidade da resposta visual
--manual-intervention-timeout <s>  Timeout para login/CAPTCHA manual
--profile <arquivo>                Profile declarativo existente
--save-profile <arquivo>           Salvar profile aprendido
--api-key <chave>                  Chave do proxy local
--allow-endpoint-host <host>       Allowlist de backend externo, repetível
--min-interval-ms <ms>             Intervalo mínimo entre chamadas
--max-queue <n>                    Capacidade da fila serial
--headless
--headed
--no-cors
--follow-redirects
--no-redirects
```

Variáveis equivalentes relevantes:

```text
OLLAMA_MODEL
OLLAMA_URL
PROXY_MODEL_ID
PROXY_HOST
PROXY_PORT
PROXY_API_KEY
PROXY_PROVIDER
PROXY_TRANSPORT
PROXY_MAX_QUEUE
PROXY_MIN_INTERVAL_MS
PROXY_FOLLOW_REDIRECTS
BROWSER_USER_DATA_DIR
CAPTURE_TIMEOUT_MS
CAPTURE_SETTLE_MS
RESPONSE_SAMPLE_TIMEOUT_MS
OLLAMA_TIMEOUT_MS
UPSTREAM_TIMEOUT_MS
UI_RESPONSE_TIMEOUT_MS
UI_SETTLE_MS
MANUAL_INTERVENTION_TIMEOUT_MS
```

## Segurança operacional

- use apenas contas/sites que você está autorizado a automatizar;
- mantenha o proxy em `127.0.0.1` quando possível;
- bind externo exige `--api-key`;
- CORS aceita apenas origens loopback quando habilitado;
- não versione `--user-data-dir`;
- não exponha profiles de navegador compartilhados;
- respeite termos, rate limits e controles do site;
- não use este projeto para contornar CAPTCHA, WAF, autenticação ou controles anti-abuso.

Veja [SECURITY.md](./SECURITY.md).

## Desenvolvimento

```bash
npm install
npm run verify
```

A suíte revisada cobre codec form/RPC (incluindo chaves repetidas), XSSI/framing, mapping/state, roles `developer`, OpenAI shims/streaming, JSON Path seguro, providers, histórico UI, snapshots DOM, queue, scoring, redaction, logs, redirects same-origin e URL policy. O CI executa `npm run verify` em Node 20 e 22.

## Estrutura

```text
src/
  cli.ts
  config.ts
  types.ts
  providers/
    catalog.ts
  discovery/
    body-codec.ts
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
    browser-session.ts
    network-executor.ts
    serial-queue.ts
    ui-dom.ts
    ui-history.ts
    ui-executor.ts
    upstream.ts
  security/
    challenge.ts
    headers.ts
    redaction.ts
    url-policy.ts
  util/
    json.ts
    path.ts

test/
  body-codec.test.ts
  decoder.test.ts
  engine.test.ts
  fallback.test.ts
  openai.test.ts
  path.test.ts
  profile.test.ts
  providers.test.ts
  queue.test.ts
  scoring.test.ts
  security.test.ts
  upstream.test.ts
  url-policy.test.ts
```

## Limitações

Interfaces web mudam. Os seletores de provider devem ser tratados como compatibilidade best-effort e podem exigir manutenção quando o DOM do site mudar.

O UI transport converte texto. Ele não transforma automaticamente recursos proprietários do site (uploads, artifacts, search modes, voice, function calling etc.) em capacidades OpenAI equivalentes. Streaming visual é best-effort: se o site reescrever a resposta inteira de forma não cumulativa, o proxy evita emitir deltas potencialmente duplicados e usa o texto final como fonte canônica.

Este projeto não garante que o uso automatizado seja permitido pelos termos de um site. A autorização e conformidade são responsabilidade de quem executa o proxy.
