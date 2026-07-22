# MiMo Code Proxy

Proxy reverso que expõe o **MiMo Code** (agente de IA da Xiaomi) para acesso remoto, com API compatível com OpenAI, streaming genuíno e function calling nativo.

```
cliente remoto ──HTTP/WS (X-API-Key)──> proxy (:8787) ──HTTP/WS (Basic Auth)──> mimo serve (127.0.0.1:PORTA)
```

## Por que este proxy?

- **Acesso remoto** — conecte Roo Code, Cline, Kilo ou qualquer cliente OpenAI ao seu MiMo local
- **Streaming real** — deltas transmitidos em tempo real via EventSource (`GET /event`)
- **Function calling** — envie `tools` no formato OpenAI e receba `tool_calls` com JSON tipado
- **Zero dependências** — apenas `jsonrepair`, `node:http` puro, sem Express
- **Dois modos** — `raw` (cliente dirige as tools) ou `agent` (MiMo executa as tools)

## Pré-requisitos

- **Node.js >= 18**
- **bash**, **curl**, **openssl** (Linux/macOS)
- O binário do MiMo é baixado automaticamente para `./sandbox/bin`

## Instalação rápida

### Opção 1: Um comando

```bash
bash start.sh
```

Baixa o MiMo (se necessário), sobe o servidor + proxy e exibe as credenciais.

| Flag | Efeito |
|------|--------|
| `--no-auth` | Desliga a exigência de `X-API-Key` (rede local apenas) |
| `--global` | Usa o `mimo` já instalado no PATH |

### Opção 2: Docker

```bash
cp .env.example .env   # edite as senhas/tokens
docker compose up --build
```

Ou sem compose:

```bash
docker build -t mimo-code-proxy .
docker run --rm -p 8787:8787 --env-file .env mimo-code-proxy
```

### Opção 3: Manualmente

```bash
npm install
# Copie .env.example para .env e configure
node mimo-proxy.js
```

## Uso

### Listar modelos disponíveis

```bash
curl -H 'X-API-Key: SEU_TOKEN' http://localhost:8787/v1/models
```

### Chat com streaming

```bash
curl -H 'X-API-Key: SEU_TOKEN' -H 'Content-Type: application/json' \
  -d '{
    "model": "mimo-auto",
    "messages": [{"role": "user", "content": "Olá"}],
    "stream": true
  }' \
  http://localhost:8787/v1/chat/completions
```

### Function calling

Envie o campo `tools` no formato OpenAI. O proxy converte a resposta em `tool_calls` com `arguments` em JSON e `finish_reason: "tool_calls"`, tanto em streaming quanto não-streaming.

```bash
curl -H 'X-API-Key: SEU_TOKEN' -H 'Content-Type: application/json' \
  -d '{
    "model": "mimo-auto",
    "messages": [{"role": "user", "content": "Qual a temperatura em SP?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          }
        }
      }
    }]
  }' \
  http://localhost:8787/v1/chat/completions
```

O histórico multi-turno (assistant com `tool_calls` + mensagens `role:"tool"`) é serializado automaticamente.

### Conectar cliente MiMo remotamente

```bash
mimo attach http://SEU_IP:8787/
```

### Health check

```bash
curl http://localhost:8787/healthz
```

## Modos de operação

Definidos pela variável `MIMO_PROXY_MODE`:

| Modo | Comportamento | Quando usar |
|------|---------------|-------------|
| `raw` *(default)* | Desativa tools internas do MiMo (`tools:{"*":false}`), repassa o system prompt do cliente. Raciocínio em `reasoning_content`. | Roo Code, Cline, Kilo — o cliente dirige as próprias tools |
| `agent` | O MiMo executa suas próprias tools (`read`, `edit`, `bash`...). Uso das tools aparece em `reasoning_content`. | Uso direto via TUI/Web |

## Variáveis de ambiente

| Variável | Descrição | Default |
|----------|-----------|---------|
| `MIMO_PROXY_TOKEN` | Chave de acesso (header `X-API-Key`) | *obrigatório se auth ativa* |
| `MIMO_SERVER_URL` | URL do `mimo serve` | `http://127.0.0.1:4096` |
| `MIMO_SERVER_PASSWORD` | Senha do `mimo serve` | vazio |
| `MIMO_PROXY_PORT` | Porta do proxy | `8787` |
| `MIMO_PROXY_HOST` | Host de escuta | `0.0.0.0` |
| `MIMO_PROXY_MODEL` | Modelo padrão | `mimo-auto` |
| `MIMO_PROXY_MODE` | `raw` ou `agent` | `raw` |
| `MIMO_PROXY_REQUIRE_AUTH` | `false` desliga auth | `true` |
| `MIMO_PROXY_WATCHDOG_MS` | Timeout de inatividade (ms) | `600000` |
| `MIMO_PROXY_POOL_SIZE` | Tamanho do pool de sessões | `2` |

Veja `.env.example` para a referência completa.

## Estrutura do projeto

```
mimo-code-proxy/
├── mimo-proxy.js          # Entry point (HTTP + WebSocket upgrade)
├── src/
│   ├── config.js          # Carrega variáveis de ambiente
│   ├── auth.js            # Autenticação X-API-Key + Bearer + query param
│   ├── routes.js          # Reverse proxy + /v1/chat/completions
│   ├── mimo-client.js     # Cliente HTTP/EventStream para mimo serve
│   ├── openai.js          # Formatação de respostas OpenAI
│   └── tools.js           # Parsing de function calling (XML + [Called])
├── test/                  # Suite de testes (node:test)
├── start.sh               # Launcher (baixa binário + sobe tudo)
├── setup.sh               # Instalador em ~/.mimo-code-proxy
├── Dockerfile             # Container
└── docker-compose.yml     # Compose
```

## Testes

```bash
# Com env vars (como no CI)
MIMO_PROXY_REQUIRE_AUTH=false MIMO_PROXY_TOKEN=test MIMO_PROXY_PORT=0 npm test

# Lint
npm run lint
```

## Segurança

- Com `MIMO_PROXY_REQUIRE_AUTH=false` **qualquer pessoa na rede** acessa seu MiMo. Use apenas em rede local.
- Para expor na internet, coloque atrás de TLS (Caddy/Nginx) ou túnel (Cloudflare Tunnel, Tailscale).
- Nunca commite o arquivo `.env` — já está no `.gitignore`.

## Licença

MIT