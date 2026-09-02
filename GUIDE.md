# Guia completo — KITT Reverse Proxy R11

## 1. O que ele faz

O `kitt-reverse-proxy` abre um chat web autorizado em Chromium/Playwright e
expõe a sessão como uma API local compatível com OpenAI.

Fluxo típico:

```text
KITT / Agent / curl
        │
        ▼
http://127.0.0.1:3000/v1
        │
        ▼
kitt-reverse-proxy
        │
        ▼
Chromium Playwright
        │
        ▼
ChatGPT / Claude / Gemini / Kimi / DeepSeek / chat custom
```

Para ChatGPT, Claude, Gemini, Kimi e DeepSeek o transporte padrão é pela UI
real do site. Login, consentimento, CAPTCHA ou challenge são resolvidos
manualmente pelo usuário no Chromium. Não há stealth/bypass.

---

## 2. Instalação

```bash
cd kitt-reverse-proxy
npm ci
npx playwright install chromium
npm run verify
```

Para disponibilizar o comando no PATH da conta local:

```bash
npm link
```

Teste:

```bash
kitt-reverse-proxy --help
kitt-reverse-proxy presets
```

Se não quiser `npm link`, ainda é possível usar:

```bash
npm start -- chatgpt
```

Para o **Control Center** iniciar o processo, `kitt-reverse-proxy` deve estar no
PATH do `kittd` ou você deve configurar no ambiente do daemon:

```bash
KITT_REVERSE_PROXY_BIN=/caminho/para/kitt-reverse-proxy
```

Use um executável/script confiável controlado pelo usuário local.

---

## 3. Uso mais fácil pela CLI

### ChatGPT

```bash
kitt-reverse-proxy chatgpt
```

ou:

```bash
kitt-reverse-proxy start chatgpt
```

O preset resolve automaticamente:
- URL: `https://chatgpt.com/`
- provider: `chatgpt`
- transport: `ui`
- API model: `chatgpt-web`
- profile Chromium padrão: `~/.kitt-reverse-proxy/chatgpt`

### Claude

```bash
kitt-reverse-proxy claude
```

URL canônica: `https://claude.ai/new`

### Gemini

```bash
kitt-reverse-proxy gemini
```

URL canônica: `https://gemini.google.com/app`

### Kimi

```bash
kitt-reverse-proxy kimi
```

URL canônica: `https://www.kimi.com/`

### DeepSeek

```bash
kitt-reverse-proxy deepseek
```

URL canônica: `https://chat.deepseek.com/`

### Mostrar presets

```bash
kitt-reverse-proxy presets
```

### Chat customizado

```bash
kitt-reverse-proxy https://site.example/chat
```

ou:

```bash
kitt-reverse-proxy start https://site.example/chat
```

Forçando UI:

```bash
kitt-reverse-proxy https://site.example/chat \
  --provider generic \
  --transport ui
```

---

## 4. Primeira execução

Quando o Chromium abrir:

1. faça login normalmente;
2. aceite consentimentos necessários;
3. resolva CAPTCHA/challenge manualmente;
4. aguarde o proxy detectar o campo de chat;
5. quando o terminal informar que a API iniciou, a sessão está pronta.

O perfil Chromium persistente evita repetir login em toda execução.

Os presets usam diretórios separados:

```text
~/.kitt-reverse-proxy/chatgpt
~/.kitt-reverse-proxy/claude
~/.kitt-reverse-proxy/gemini
~/.kitt-reverse-proxy/kimi
~/.kitt-reverse-proxy/deepseek
```

Se `reverse_proxy.runtime.user_data_dir` ou `--user-data-dir` for configurado,
esse valor explícito prevalece.

---

## 5. Uso pelo KITT Control Center

Abra o Control Center do Assistant:

```text
http://127.0.0.1:41828/
```

Navegue para:

```text
Reverse Proxy
```

A seção R11 possui dois blocos:

### Configuração persistente

Configure, quando necessário:
- host/porta da API;
- provider/transport default;
- headed/headless;
- user data dir;
- timeouts;
- fila;
- CORS;
- allowed endpoint hosts;
- modelo Ollama opcional para network mapping.

Clique **Aplicar alterações** antes de iniciar uma nova sessão.

### Iniciar sessão web

Escolha:

```text
ChatGPT
Claude
Gemini
Kimi
DeepSeek
URL customizada
```

Então pressione:

```text
▶ Abrir chat / Iniciar proxy
```

O `kittd`:
1. inicia `kitt-reverse-proxy` sem shell;
2. mantém stdin do processo como lifecycle pipe;
3. abre Chromium se `headed=true`;
4. mostra PID e status;
5. monitora a porta local;
6. mantém o processo somente enquanto necessário.

Estados:

```text
○ Parado
◐ Chromium / login em preparação
● API pronta
● Proxy externo detectado
```

Para encerrar:

```text
■ Parar
```

O Control Center fecha primeiro o stdin para shutdown gracioso e força
encerramento apenas se o processo não terminar no prazo.

Um proxy iniciado fora do Control Center pode ser detectado, mas **não é morto**
pelo painel.

---

## 6. API local

Default:

```text
http://127.0.0.1:3000/v1
```

### Health

```bash
curl http://127.0.0.1:3000/healthz
```

### Status KITT

```bash
curl http://127.0.0.1:3000/v1/kitt/status
```

### Modelos

```bash
curl http://127.0.0.1:3000/v1/models
```

### Chat Completions — ChatGPT Web

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "chatgpt-web",
    "messages": [
      {"role":"user","content":"Explique o projeto KITT em três pontos."}
    ],
    "stream": false
  }'
```

### Claude Web

```json
{
  "model": "claude-web",
  "messages": [
    {"role":"user","content":"Revise este texto."}
  ]
}
```

### Gemini Web

Use:

```text
gemini-web
```

### Kimi Web

Use:

```text
kimi-web
```

### DeepSeek Web

Use:

```text
deepseek-web
```

---

## 7. Integrar em agentes/OpenAI-compatible clients

Configure:

```text
Base URL: http://127.0.0.1:3000/v1
```

A chave pode ficar vazia quando o proxy está apenas em loopback e sem
`PROXY_API_KEY`.

Escolha o model id correspondente ao preset:

```text
chatgpt-web
claude-web
gemini-web
kimi-web
deepseek-web
```

Se o cliente exigir uma chave não vazia mesmo em loopback, configure uma chave
local no Reverse Proxy e use a mesma no cliente.

---

## 8. Network transport

Para chats genéricos:

```bash
kitt-reverse-proxy https://site.example/chat --transport network
```

O fluxo tenta capturar/identificar um endpoint legítimo do chat.

### Sem modelo Ollama

R11 não possui mais modelo hardcoded.

Se nenhum mapping model estiver configurado, o proxy pula Ollama e usa o
profile heurístico determinístico.

### Com Ollama explicitamente

```bash
export OLLAMA_MODEL="<modelo-local>"
kitt-reverse-proxy https://site.example/chat --transport network
```

Ou:

```bash
kitt-reverse-proxy https://site.example/chat \
  --transport network \
  --model "<modelo-local>"
```

### Backend externo legítimo

```bash
kitt-reverse-proxy https://site.example/chat \
  --transport network \
  --allow-endpoint-host chat.vendor.example
```

Não use wildcards.

---

## 9. Profile declarativo

Salvar mapping aprendido:

```bash
kitt-reverse-proxy https://site.example/chat \
  --transport network \
  --save-profile ./profiles/site.json
```

Reutilizar:

```bash
kitt-reverse-proxy https://site.example/chat \
  --transport network \
  --profile ./profiles/site.json
```

Profiles não armazenam cookies.

---

## 10. Headless

Para sessões já autenticadas que não exigem intervenção:

```bash
kitt-reverse-proxy chatgpt --headless
```

Para primeira execução, prefira `headed`.

Se login/CAPTCHA exigir interação em headless, a operação falha de forma
explícita em vez de tentar bypass.

---

## 11. Porta customizada

```bash
kitt-reverse-proxy chatgpt --port 3100
```

API:

```text
http://127.0.0.1:3100/v1
```

Ou configure `reverse_proxy.runtime.port` no Control Center.

---

## 12. Segurança de bind

Loopback:

```bash
kitt-reverse-proxy chatgpt --host 127.0.0.1
```

Para host não-loopback, o proxy exige chave de API.

Exemplo:

```bash
export PROXY_API_KEY="uma-chave-local-forte"
kitt-reverse-proxy chatgpt --host 0.0.0.0
```

Não exponha a API diretamente na Internet.

---

## 13. Troubleshooting

### Control Center: “não foi possível iniciar kitt-reverse-proxy”

Confirme:

```bash
which kitt-reverse-proxy
kitt-reverse-proxy --help
```

Depois:

```bash
cd kitt-reverse-proxy
npm run build
npm link
```

Ou configure `KITT_REVERSE_PROXY_BIN`.

### Chromium não instalado

```bash
npx playwright install chromium
```

### Porta já ocupada

```bash
curl http://127.0.0.1:3000/healthz
```

Se já houver outro proxy, o Control Center exibirá `Proxy externo detectado` e
não tentará matar o processo.

### Login volta a ser solicitado

Verifique se o profile está persistente e gravável.

```bash
kitt-reverse-proxy presets
```

mostra o diretório padrão por provider.

### UI do site mudou

A automação usa seletores heurísticos centralizados no provider catalog. Rode os
testes, verifique o provider e atualize os seletores em vez de tentar reproduzir
APIs privadas.

### Network mapping ruim

Use um profile conhecido:

```bash
--profile ./profiles/site.json
```

ou configure explicitamente um modelo Ollama para auxiliar o mapping.

---

## 14. Encerramento

CLI:

```text
Ctrl+C
```

Control Center:

```text
■ Parar
```

No modo supervisionado, EOF no stdin também aciona shutdown gracioso. Isso
permite ao `kittd` encerrar a API e a sessão Playwright sem deixar um processo
residente desnecessário.

---

## 15. Comandos de referência

```bash
kitt-reverse-proxy presets
kitt-reverse-proxy chatgpt
kitt-reverse-proxy start claude
kitt-reverse-proxy gemini --headless
kitt-reverse-proxy kimi --port 3100
kitt-reverse-proxy deepseek
kitt-reverse-proxy https://site.example/chat --provider generic --transport ui
kitt-reverse-proxy https://site.example/chat --transport network
```

A regra operacional permanece: use somente chats/contas que você está
autorizado a utilizar e resolva desafios humanos manualmente.
