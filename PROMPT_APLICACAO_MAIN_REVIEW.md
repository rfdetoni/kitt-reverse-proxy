# Prompt agentico — aplicar revisão completa do kitt-reverse-proxy

Você é o agente responsável por aplicar e validar uma revisão completa no repositório:

- Repositório: `rfdetoni/kitt-reverse-proxy`
- Branch base: `main`
- Commit base revisado: `f9f01ce0d2d7bd03ca392deaf71ab14b744cb46d`
- Pacote de implementação: conteúdo deste ZIP

Seu objetivo é substituir/aplicar os arquivos fornecidos sobre a `main`, preservar o que não foi alterado, validar integralmente a implementação e somente concluir após todos os checks passarem.

## Regras obrigatórias

1. Trabalhe em uma branch nova, por exemplo:

```bash
git checkout main
git pull --ff-only
git checkout -b fix/main-review-hardening
```

2. Confirme que a branch base contém ou descende do commit `f9f01ce0d2d7bd03ca392deaf71ab14b744cb46d`.
3. Faça backup/stash de alterações locais antes de substituir arquivos.
4. Copie o conteúdo do ZIP para a raiz do repositório, preservando a estrutura de diretórios.
5. **Não remova o `package-lock.json` existente da main.** O ZIP não o substitui porque as dependências não mudaram.
6. Não adicione CAPTCHA solver, stealth, fingerprint spoofing, WAF bypass, auth bypass ou técnicas de evasão. A implementação deve continuar usando apenas detecção + handoff manual para desafios.
7. Não introduza `eval`, `Function`, `vm` ou execução de código gerado por LLM.
8. Preserve TypeScript strict, KISS, DRY, Clean Code e compatibilidade Node.js 20+.

## Arquivos/áreas principais alterados

Aplique integralmente os arquivos fornecidos, incluindo:

```text
.github/workflows/ci.yml
.gitignore
README.md
SECURITY.md
VALIDATION.md
package.json
src/cli.ts
src/config.ts
src/logger.ts
src/types.ts
src/discovery/body-codec.ts
src/discovery/capture.ts
src/discovery/scoring.ts
src/mapping/engine.ts
src/mapping/fallback.ts
src/mapping/ollama.ts
src/mapping/profile.ts
src/providers/catalog.ts
src/proxy/openai.ts
src/proxy/server.ts
src/runtime/browser-session.ts
src/runtime/ui-dom.ts
src/runtime/ui-executor.ts
src/runtime/ui-history.ts
src/runtime/upstream.ts
test/body-codec.test.ts
test/config.test.ts
test/engine.test.ts
test/logger.test.ts
test/openai.test.ts
test/profile.test.ts
test/providers.test.ts
test/scoring.test.ts
test/security.test.ts
test/ui-dom.test.ts
test/ui-history.test.ts
test/upstream.test.ts
```

Os demais arquivos do ZIP também devem ser preservados/aplicados conforme fornecidos.

## Correções implementadas que não podem ser perdidas

### UI transport

- Streaming progressivo deve emitir deltas enquanto o DOM cresce, não somente após a resposta terminar.
- `developer` deve ser preservado como instrução de sistema quando necessário.
- Retries HTTP idênticos com histórico completo não podem reenviar o mesmo turno ao chat web.
- Divergência real de histórico deve resetar a conversa antes de reaplicar o contexto.
- Snapshot de resposta deve ser correlacionado por `selector` + `frameIndex`.
- Eco do prompt do usuário não pode ser interpretado como resposta do assistant.
- Reescritas não cumulativas do DOM não devem produzir deltas duplicados.
- Prompts grandes em elementos `contenteditable` devem usar `keyboard.insertText()` como fallback, evitando key events O(n).

### OpenAI compatibility

- `/v1/chat/completions` deve manter suporte streaming SSE.
- `/v1/responses` streaming deve usar:
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta`
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.output_item.done`
  - `response.completed`
- Não emitir o nome legado `response.text.delta`.
- `max_output_tokens` da Responses API deve virar `max_completion_tokens` no shim interno.
- Mapping `openai.max_tokens` deve aceitar `max_tokens` e `max_completion_tokens`.

### Network transport

- Playwright deve permanecer com `maxRedirects: 0`.
- Quando `--follow-redirects` estiver ativo, redirects devem ser seguidos manualmente.
- Máximo: 5 redirects.
- Somente redirects para o mesmo `origin` do endpoint inicial podem ser seguidos.
- Cross-origin deve lançar erro antes do replay de headers.
- Em 301/302 de POST e 303, a próxima chamada deve virar GET sem body/content-type/content-length.
- Headers rotativos retornados pelo upstream devem continuar sendo atualizados.

### Codec/discovery

- Form-urlencoded deve preservar chaves repetidas e ordem original.
- Campos como `f.req`, `payload`, `data`, `request`, `params`, `variables` e `body` podem conter JSON serializado aninhado e devem fazer round-trip corretamente.
- JSON body também pode conter strings com JSON estruturado e deve ser reencodado sem alterar o protocolo original.
- Request candidato > 2 MiB deve ser ignorado na captura.
- Response candidata > 5 MiB deve ser rejeitada antes do parsing quando `content-length` indicar excesso.
- Manter no máximo 128 candidatos em memória.
- Responses HTTP 4xx/5xx devem sofrer penalização de score.

### Segurança

- URLs em logs devem remover query string e fragmento para evitar exposição de tokens/assinaturas.
- Sanitização deve ser aplicada também a stack traces quando `DEBUG=1`.
- `--allow-endpoint-host` deve aceitar apenas hostname literal válido; rejeitar URL, wildcard, path, porta, credenciais e sintaxe malformada.
- Provider explícito conhecido deve corresponder ao host esperado; `generic` continua disponível para UIs customizadas.
- Diretório `--user-data-dir` deve ser criado com permissões `0700` quando a plataforma permitir.
- API key deve ser comparada por SHA-256 + `timingSafeEqual`, evitando diferença de comprimento no buffer comparado.
- Redaction do payload para Ollama deve ter limites globais de nós, arrays, chaves e profundidade.
- Prompt para mapping e envelope retornado pelo Ollama devem possuir limite máximo de tamanho.

### Engenharia/CI

- `npm test` deve funcionar em Windows/Linux/macOS; não usar `rm -rf` diretamente no script npm.
- `npm run verify` deve executar check + tests + build.
- Workflow GitHub Actions deve validar Node 20 e Node 22.
- `dist/` deve ser gerado a partir dos fontes finais.

## package-lock.json

As dependências de runtime/dev não foram modificadas. Portanto:

- preserve o `package-lock.json` já existente na `main`;
- rode `npm ci` para confirmar consistência;
- somente regenere o lock se estiver ausente/corrompido:

```bash
npm install --package-lock-only
```

Não faça upgrade oportunista de dependências nesta tarefa.

## Validação obrigatória

Instale a partir do lock existente:

```bash
npm ci
```

Instale Chromium se necessário:

```bash
npx playwright install chromium
```

Execute:

```bash
npm run verify
```

Resultado esperado da suíte entregue: **52 testes passando, 0 falhas**.

Faça também:

```bash
find dist -name '*.js' -type f -print0 | xargs -0 -n1 node --check
```

Em Windows, execute o equivalente PowerShell para validar todos os `.js` em `dist`.

## Smoke tests mínimos

### Provider routing

Verifique que estes URLs resolvem para UI transport em `auto`:

```text
https://chatgpt.com/          -> chatgpt/ui
https://claude.ai/new        -> claude/ui
https://gemini.google.com/app -> gemini/ui
https://www.kimi.com/        -> kimi/ui
https://chat.deepseek.com/   -> deepseek/ui
```

Um domínio desconhecido deve continuar usando `generic/network` por padrão.

### CLI security

Confirme que continuam rejeitados:

```text
--stealth
--captcha-solver
--bypass
```

### API

Confirme disponibilidade de:

```text
GET  /healthz
GET  /v1/models
GET  /v1/kitt/status
POST /v1/kitt/reset
POST /v1/chat/completions
POST /v1/responses
```

## Critérios de aceite

A tarefa só está concluída se:

- `npm ci` passar;
- `npm run verify` passar;
- todos os 52 testes passarem;
- `dist/` estiver atualizado;
- nenhum segredo/cookie/header de sessão tiver sido adicionado ao repositório;
- `package-lock.json` da main estiver preservado e consistente;
- nenhuma técnica de bypass/evasão tiver sido adicionada;
- `git diff` contiver apenas mudanças relacionadas à revisão;
- README e SECURITY estiverem coerentes com o comportamento final.

## Commit sugerido

```bash
git add .
git commit -m "fix: harden transports and OpenAI compatibility"
```

Antes do commit, revise:

```bash
git status
git diff --check
git diff --stat
```

Não reduza testes, não masque falhas e não altere assertions apenas para tornar a suíte verde.
