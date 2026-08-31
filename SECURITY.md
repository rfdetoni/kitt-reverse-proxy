# Security Model — kitt-reverse-proxy v3

## Uso pretendido

Use apenas com chats, contas, sessões e endpoints que você esteja autorizado a automatizar.

A v3 **não implementa**:

- CAPTCHA solving;
- stealth/evasão de detecção de automação;
- fingerprint spoofing para ocultar Playwright;
- bypass de WAF/anti-bot;
- bypass de autenticação/autorização;
- harvesting de credenciais;
- remoção de rate limits ou controles anti-abuso.

O CLI rejeita explicitamente `--stealth`, `--captcha-solver` e `--bypass`.

## Providers conhecidos: UI-first

ChatGPT, Claude, Gemini, Kimi e DeepSeek usam UI transport por padrão. A decisão é de segurança e manutenção: o navegador realiza a interação pelo fluxo normal do site, em vez de o proxy codificar ou tentar reproduzir mecanismos privados como tokens efêmeros, assinaturas, proof-of-work, RPC IDs ou challenges do backend web.

UI automation ainda é automação e pode estar sujeita aos termos e controles do site.

## CAPTCHA / anti-bot / login

`security/challenge.ts` detecta sinais comuns de:

- reCAPTCHA;
- hCaptcha;
- Cloudflare challenge;
- páginas com captcha/challenge/checkpoint;
- textos de verificação humana/anti-bot;
- login/autenticação.

Em modo headed, o proxy aguarda intervenção humana e retoma apenas quando o campo normal de chat volta a estar visível.

Em headless, um desafio que necessita de interação resulta em erro de intervenção manual. O projeto não tenta contorná-lo.

## Sessão persistente

`--user-data-dir` usa `chromium.launchPersistentContext()`.

Esse diretório pode conter cookies, tokens, localStorage e outros dados de sessão. Trate-o como credencial:

- não coloque dentro do repositório;
- não faça commit;
- proteja permissões do diretório; o runtime cria/ajusta o diretório para `0700` em plataformas POSIX quando possível;
- use um diretório separado por conta/provider quando possível;
- apague-o quando não precisar mais da sessão persistida.

Sem `--user-data-dir`, o browser context é temporário por padrão.

## Código produzido por LLM

Nenhum código produzido pela LLM é executado.

No network transport, Ollama pode gerar somente um profile JSON declarativo. O profile passa por allowlists de operações/sources e validação de JSON paths. Não existe source que invoque código arbitrário.

## JSON Path e prototype pollution

O interpretador de paths rejeita segmentos perigosos:

- `__proto__`;
- `prototype`;
- `constructor`.

A regra também vale para chaves quoted como `$["__proto__"]`.

Targets de escrita não aceitam wildcard.

## Material de sessão no network transport

O BrowserContext pode conter cookies, authorization, CSRF/XSRF e outros valores sensíveis.

- `cookie`, `host`, `content-length` e headers hop-by-hop não são capturados/reproduzidos manualmente;
- cookies vêm do próprio `BrowserContext.request`;
- profiles não armazenam headers capturados nem o request-base;
- exemplos enviados ao Ollama local passam por redaction;
- upstream error bodies não são encaminhados diretamente ao cliente;
- profiles salvos usam modo `0600` quando suportado.

## Redirects

Network redirects são desabilitados por padrão.

`--follow-redirects` é opt-in. O runtime mantém `maxRedirects: 0` no Playwright e segue redirects manualmente, no máximo cinco vezes, somente quando o próximo URL possui o **mesmo origin** do endpoint inicial. Redirect cross-origin é sempre bloqueado, independentemente do nome dos headers capturados.

## Endpoint allowlist

Discovery aceita automaticamente apenas:

- o mesmo host da página; ou
- subdomínios diretos/descendentes do host alvo.

Backends irmãos ou externos exigem `--allow-endpoint-host` explícito. O projeto evita inferir eTLD+1 sem uma Public Suffix List, porque isso poderia confiar indevidamente em tenants de hosts compartilhados.

## Proxy local

O servidor escuta em `127.0.0.1` por padrão.

Bind não-loopback é rejeitado sem `--api-key`/`PROXY_API_KEY`.

A comparação da chave calcula SHA-256 de ambos os valores e usa `timingSafeEqual` sobre buffers de tamanho constante.

CORS, quando habilitado, aceita apenas origens browser loopback (`localhost`, `127.0.0.1`, `::1`). Clientes CLI não dependem de CORS.

## Limites de recursos

- body Express limitado;
- request candidato de discovery limitado antes do parsing e quantidade de candidatos retidos limitada;
- resposta candidata/upstream limitada antes do parsing;
- fila serial limitada;
- timeouts separados para discovery, upstream, UI e intervenção manual;
- máximo de prompt UI;
- limites de profundidade/quantidade em profiles e parsing de frames;
- redaction enviada ao modelo possui orçamento global de nós/chaves/arrays e o envelope do Ollama é limitado;
- URLs em logs têm query string e fragmento removidos para evitar exposição acidental de assinaturas/tokens em query.

## Function calling

O proxy não afirma suporte nativo a function calling quando o chat web não possui uma interface equivalente. No UI transport, `tools`/`tool_choice` não são enviados como APIs de ferramentas; podem ser representados textualmente pelo cliente/histórico quando necessário.

## Relato de vulnerabilidades

Ao relatar um problema, não inclua cookies, tokens, sessões do navegador, dumps completos de requests autenticados ou outras credenciais. Forneça um caso mínimo sanitizado e os passos para reprodução.
