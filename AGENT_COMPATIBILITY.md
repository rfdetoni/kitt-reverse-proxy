# KITT Reverse Proxy R13 — Compatibilidade com agentes

## Visão geral

O `kitt-reverse-proxy` pode ser usado como um **provider OpenAI-compatible
local** por qualquer agente ou SDK que permita configurar uma Base URL.

Ele não depende do `kitt-agent-cli`.

Base URL padrão:

```text
http://127.0.0.1:3000/v1
```

Model IDs dos presets:

```text
chatgpt-web
claude-web
gemini-web
kimi-web
deepseek-web
```

## Protocolos suportados pelo R13

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /v1/models/:model`
- `GET /v1/capabilities (alias legado: /v1/kitt/capabilities)`
- `POST /api/chat` (Ollama-compatible)
- streaming
- `tools`
- `tool_choice`
- `parallel_tool_calls`
- legacy `functions` / `function_call`
- Responses `function_call` / `function_call_output`

## Regra fundamental das tools

O Reverse Proxy **não executa tools**.

A responsabilidade fica com o agente:

```text
agente define tools
      ↓
Reverse Proxy apresenta o protocolo mínimo ao chat web
      ↓
chat escolhe uma function
      ↓
Reverse Proxy converte para tool_calls
      ↓
agente executa a tool
      ↓
agente envia o resultado
      ↓
Reverse Proxy encaminha envelope mínimo de tool result
      ↓
chat gera resposta final
```

Isso evita que um chat web tenha permissão para executar código, shell, arquivos
ou ações locais diretamente.

## Injeção mínima no navegador

Uma requisição comum:

```json
{
  "messages": [
    {"role":"user","content":"Explique TCP em uma frase."}
  ]
}
```

envia ao navegador apenas:

```text
Explique TCP em uma frase.
```

Não há diretiva global de estilo.

O R13 injeta conteúdo adicional somente quando necessário para preservar a
semântica da API:

- `system` / `developer`;
- definição/choice de tools;
- resultado de tool.

O histórico `assistant` já existente na conversa web não é reinjetado.

## OpenAI Python SDK — Chat Completions + tool calling

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="local",
)

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the weather for a city",
        "parameters": {
            "type": "object",
            "properties": {
                "city": {"type": "string"}
            },
            "required": ["city"],
            "additionalProperties": False
        }
    }
}]

messages = [
    {"role": "user", "content": "Como está o tempo em Joinville?"}
]

first = client.chat.completions.create(
    model="chatgpt-web",
    messages=messages,
    tools=tools,
    tool_choice="auto",
)

assistant = first.choices[0].message
messages.append(assistant)

for call in assistant.tool_calls or []:
    # A aplicação/agente executa a função.
    result = '{"temperature_c":23,"condition":"cloudy"}'

    messages.append({
        "role": "tool",
        "tool_call_id": call.id,
        "content": result,
    })

final = client.chat.completions.create(
    model="chatgpt-web",
    messages=messages,
    tools=tools,
)

print(final.choices[0].message.content)
```

## Tool choice

Suportados:

```json
"auto"
```

```json
"none"
```

```json
"required"
```

Forced function:

```json
{
  "type": "function",
  "function": {
    "name": "get_weather"
  }
}
```

Também é aceito o shape equivalente da Responses API.

`parallel_tool_calls: false` restringe a no máximo uma chamada no turno.

## Responses API

Primeiro request:

```json
{
  "model": "chatgpt-web",
  "input": "Qual é o tempo em Joinville?",
  "tools": [{
    "type": "function",
    "name": "get_weather",
    "description": "Get weather",
    "parameters": {
      "type": "object",
      "properties": {
        "city": {"type": "string"}
      },
      "required": ["city"],
      "additionalProperties": false
    }
  }]
}
```

O output pode conter:

```json
{
  "type": "function_call",
  "call_id": "call_...",
  "name": "get_weather",
  "arguments": "{\"city\":\"Joinville\"}"
}
```

Depois que o agente executar a tool:

```json
{
  "model": "chatgpt-web",
  "input": [{
    "type": "function_call_output",
    "call_id": "call_...",
    "output": "{\"temperature_c\":23}"
  }],
  "tools": [{
    "type": "function",
    "name": "get_weather",
    "parameters": {
      "type": "object",
      "properties": {
        "city": {"type": "string"}
      }
    }
  }]
}
```

## Streaming

### Chat Completions

Quando houver tool call:
1. chunk com `delta.tool_calls`;
2. `finish_reason` permanece `null` nesse chunk;
3. chunk final com `finish_reason: "tool_calls"`;
4. `[DONE]`.

O JSON/tag usado internamente pelo browser não deve aparecer como conteúdo
streamado ao agente.

### Responses API

Tool calling em stream usa eventos:

```text
response.output_item.added
response.function_call_arguments.delta
response.function_call_arguments.done
response.output_item.done
response.completed
```

## Ollama-compatible

Exemplo:

```bash
curl http://127.0.0.1:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{
    "model":"chatgpt-web",
    "stream":false,
    "messages":[
      {"role":"user","content":"Qual é o tempo em Joinville?"}
    ],
    "tools":[{
      "type":"function",
      "function":{
        "name":"get_weather",
        "description":"Get weather",
        "parameters":{
          "type":"object",
          "properties":{"city":{"type":"string"}}
        }
      }
    }]
  }'
```

O retorno pode conter:

```json
{
  "message": {
    "role": "assistant",
    "content": "",
    "tool_calls": [{
      "function": {
        "name": "get_weather",
        "arguments": {
          "city": "Joinville"
        }
      }
    }]
  }
}
```

## Frameworks/agentes

Qualquer framework que aceite OpenAI-compatible pode apontar para:

```text
http://127.0.0.1:3000/v1
```

Exemplos de classes de cliente que devem funcionar após os smoke tests do R13:

- OpenAI Python/Node SDK;
- LangChain / LangGraph;
- LiteLLM;
- AutoGen;
- CrewAI;
- OpenCode e outros agentes configuráveis;
- clientes Ollama-compatible.

Não há import ou dependência do KITT nesses clientes.

## Multiagente

Uma instância do proxy corresponde a uma conversa/browser.

Para agentes independentes, use uma instância por porta + profile:

```bash
kitt-reverse-proxy chatgpt \
  --port 3001 \
  --user-data-dir ~/.kitt-reverse-proxy/agent-a
```

```bash
kitt-reverse-proxy claude \
  --port 3002 \
  --user-data-dir ~/.kitt-reverse-proxy/agent-b
```

Então:

```text
Agent A → http://127.0.0.1:3001/v1
Agent B → http://127.0.0.1:3002/v1
```

Isso evita cross-talk entre conversas.

## Network transport

Se o profile aprendido possui binding nativo de tools, o R13 usa esse binding.

Caso contrário, o mesmo protocolo emulado do UI transport é aplicado somente
ao turno acionável.

O retorno tenta extrair tool calls estruturadas do upstream antes do fallback
textual.

## Validação e limites

O R13 valida:

- máximo de 64 functions por request;
- nome de function permitido;
- tamanho total de definições;
- JSON de arguments;
- tamanho dos arguments;
- máximo de 16 chamadas paralelas;
- tool escolhida precisa existir no request;
- `parallel_tool_calls=false`;
- `required`/forced choice.

A tool solicitada pelo chat não é executada pelo Reverse Proxy.

## Limites declarados da Responses API

O R13 converte `function_call` e `function_call_output`, mas não implementa o
state store oficial da OpenAI. Portanto `previous_response_id` não é anunciado
como suportado. O contexto vive na conversa do browser; para continuidade, o
agente deve manter a mesma instância e enviar o novo turno/tool output.

Tools hospedadas específicas da OpenAI (`web_search`, `file_search`, etc.) não
são convertidas em functions locais. O endpoint declara `function_tools_only`.

Structured Outputs nativo também é declarado como indisponível; schemas de
functions são best effort no UI transport.

## `strict: true`

A definição é preservada e apresentada ao chat, mas o UI transport não oferece
Structured Outputs nativo do provider por meio dessa automação.

Portanto:

```text
strict_json_schema_enforcement = false
```

deve ser exposto em `/v1/kitt/capabilities`.

A validação final da aplicação continua sendo responsabilidade do agente.

## Capability discovery

```bash
curl http://127.0.0.1:3000/v1/capabilities
```

Também:

```bash
curl http://127.0.0.1:3000/v1/models
curl http://127.0.0.1:3000/v1/models/chatgpt-web
```

## Segurança

O Reverse Proxy:

- não executa functions;
- não aceita function name inventado fora da allowlist do request;
- não aceita arguments inválidos como tool call;
- não registra arguments/resultados completos por padrão;
- não usa `eval`;
- não usa código gerado pelo modelo;
- não faz stealth/CAPTCHA bypass;
- mantém login/challenges como intervenção humana.

## Troubleshooting para agentes

Se um agente não funcionar, verifique:

1. Base URL termina em `/v1`;
2. model id existe em `/v1/models`;
3. qual endpoint ele usa: Chat Completions ou Responses;
4. se exige tool calling;
5. se exige `strict` Structured Outputs nativo;
6. se usa streaming;
7. se há uma instância exclusiva para sua conversa.

Status:

```bash
curl http://127.0.0.1:3000/v1/kitt/status
curl http://127.0.0.1:3000/v1/capabilities
```
