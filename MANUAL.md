# Manual do K.I.T.T. Reverse Proxy (`kitt-reverse-proxy`)

> Ponte de tradução de APIs Web para a especificação OpenAI (`/v1/chat/completions` e `/v1/responses`), com suporte a streaming Server-Sent Events (SSE), controle de taxa, segurança de origem e proteção anti-CSRF.

---

## 1. Visão Geral e Arquitetura

O **`kitt-reverse-proxy`** permite que ferramentas padrão do ecossistema de IA utilizem provedores web ou interfaces locais como se fossem endpoints nativos da OpenAI.

### Funcionalidades:
- **Padrão OpenAI**: Endpoints `/v1/chat/completions`, `/v1/models` e `/v1/responses`.
- **Proteção Anti-CSRF (R5)**: Bloqueio estrito de requisições com mutação vindas de navegadores remotos ou domínios não-loopback. Apenas origens em `localhost`, `127.0.0.1` e `[::1]` são aceitas para conexões browser.
- **Fila Serializada com Backpressure**: Limita chamadas concorrentes para evitar sobrecarga de modelos locais.
- **Redação Automática de Segredos**: Redação de tokens, cookies e payloads sensíveis em logs de diagnóstico.

---

## 2. Requisitos de Sistema

- **Node.js**: LTS 20.x ou 22.x
- **npm**: 10.x+
- **TypeScript**: 5.x+ (gerenciado via dependências)

---

## 3. Instalação e Compilação por Sistema Operacional

### 🐧 A. LINUX
```bash
npm ci
npm run build
npm run verify
```

### 🍏 B. macOS
```bash
npm ci
npm run build
npm run verify
```

### 🪟 C. WINDOWS (PowerShell)
```powershell
npm ci
npm run build
npm run verify
```

---

## 4. Configuração e Variáveis de Ambiente

### Arquivo `config.json` ou Variáveis de Ambiente:
```bash
# Porta do servidor (Padrão: 3000)
export PORT=3000

# Host de bind (Padrão: 127.0.0.1)
export HOST=127.0.0.1

# Chave de API esperada do cliente (Opcional)
export API_KEY="sua-chave-secreta"

# Capacidade máxima da fila de requisições
export MAX_QUEUE_SIZE=100
```

---

## 5. Guia de Uso e Inicialização

### Iniciar o Servidor Proxy:
```bash
npm start
```
*O proxy estará escutando em: `http://127.0.0.1:3000`.*

### Exemplo de Chamada via `curl` (Chat Completion):
```bash
curl -X POST http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-coder",
    "messages": [
      {"role": "user", "content": "Explique o que é Clean Architecture em 1 frase"}
    ],
    "temperature": 0.3
  }'
```

---

## 6. Validação e Testes
```bash
npm run check    # Verificação de tipos TypeScript
npm test         # Execução dos 56 testes unitários e de segurança
npm run verify   # Pipeline completa (check + test + build)
```
