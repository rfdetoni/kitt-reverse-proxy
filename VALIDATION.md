# Validation — revisão da main

Base revisada: `rfdetoni/kitt-reverse-proxy` `main` em `f9f01ce0d2d7bd03ca392deaf71ab14b744cb46d`.

## Resultado

- TypeScript strict/noEmit: PASS
- Testes unitários: **52/52 PASS**
- Build `dist/`: PASS
- `node --check` em todos os JavaScript compilados: PASS
- Módulos JavaScript gerados em `dist/`: 30

## Melhorias implementadas

- streaming progressivo real no UI transport;
- Responses API com eventos `response.output_text.*` atuais;
- `max_completion_tokens` e `max_output_tokens` compatíveis;
- role `developer` tratada como instrução de sistema quando apropriado;
- retries idênticos de histórico completo não duplicam mensagens no chat web;
- histórico UI canônico e deltas cumulativos seguros;
- snapshots DOM correlacionados por frame + selector;
- `Keyboard.insertText()` para prompts grandes em contenteditable;
- redirects upstream manuais, limite de 5 e somente same-origin;
- 301/302/303 removem body/body headers quando a transição vira GET;
- query string/fragment removidos de URLs em logs;
- validação estrita de `--allow-endpoint-host`;
- provider conhecido não pode ser forçado em host não correspondente;
- `--user-data-dir` criado/protegido com `0700` quando suportado;
- forms preservam chaves repetidas e ordem original;
- JSON serializado dentro de JSON/form é decodificado e reencodado;
- discovery limita tamanho de requests/responses e número de candidatos;
- scoring penaliza respostas HTTP com erro;
- redaction possui orçamento global de profundidade/nós/chaves;
- prompt/envelope Ollama possuem limites de tamanho;
- API key comparada via SHA-256 + `timingSafeEqual` de tamanho constante;
- shutdown do HTTP server possui encerramento forçado de conexões remanescentes;
- scripts npm tornados cross-platform;
- workflow CI adicionado para Node 20 e 22.

## package-lock.json

O `package-lock.json` da `main` não foi incluído no overlay porque as dependências não foram alteradas e o registry npm ficou indisponível durante a tentativa de regeneração. Ao aplicar sobre uma cópia da `main`, **mantenha o `package-lock.json` existente**.

Se o arquivo tiver sido removido acidentalmente, regenere-o em ambiente com acesso ao registry:

```bash
npm install --package-lock-only
```

Depois valide com:

```bash
npm ci
npx playwright install chromium
npm run verify
```
