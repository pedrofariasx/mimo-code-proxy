# MiMo Code Proxy

Use o **MiMo Code** (agente de IA da Xiaomi) de qualquer lugar, com uma API
compatível com OpenAI (`/v1/models`, `/v1/chat/completions`), streaming genuíno,
function calling nativo e acesso remoto via TUI/Web.

```
cliente remoto ──HTTP/WS (X-API-Key)──> proxy (8787) ──HTTP/WS (Basic Auth)──> mimo serve (127.0.0.1:7788)
```

## Pré-requisitos

- **Node.js >= 18**
- **bash**, **curl**, **openssl** (já presentes na maioria dos Linux/macOS)
- O binário do MiMo Code é baixado automaticamente para `./sandbox/bin` (sem instalação global)

## Início rápido

### Um comando (recomendado)

```bash
bash start.sh
```

Baixa o MiMo Code (se necessário), sobe o servidor e o proxy, e exibe as
credenciais geradas automaticamente.

| Flag | Efeito |
|------|--------|
| `--no-auth` | Desliga a exigência de `X-API-Key` (apenas rede local/confiável) |
| `--global` | Usa o `mimo` já instalado no PATH em vez de baixar para o sandbox |

### Docker

```bash
cp .env.example .env   # edite as senhas/tokens
docker compose up --build
```

Ou sem compose:

```bash
docker build -t mimo-code-proxy .
docker run --rm -p 8787:8787 --env-file .env mimo-code-proxy
```

O volume `mimo-sandbox` persiste o binário do MiMo entre reinícios do container.

## Uso

### Listar modelos

```bash
curl -H 'X-API-Key: SEU_TOKEN' http://localhost:8787/v1/models
```

### Chat (formato OpenAI, com streaming)

```bash
curl -H 'X-API-Key: SEU_TOKEN' -H 'Content-Type: application/json' \
  -d '{"model":"mimo-auto","messages":[{"role":"user","content":"Olá"}],"stream":true}' \
  http://localhost:8787/v1/chat/completions
```

### Function calling nativo

Envie o campo `tools` no formato OpenAI e o proxy converte a resposta em
`tool_calls` (com `arguments` em JSON tipado e `finish_reason: "tool_calls"`),
tanto em streaming quanto não-streaming. O histórico multi-turno
(assistant `tool_calls` + mensagens `role:"tool"`) é serializado automaticamente.

### Conectar o cliente MiMo de outra máquina

```bash
mimo attach http://SEU_IP:8787/
```

### Health check

```bash
curl http://localhost:8787/healthz
# {"ok":true,"upstream":"http://127.0.0.1:7788","ts":...}
```

## Modos de operação

Definidos pela variável `MIMO_PROXY_MODE`:

| Modo | Comportamento | Caso de uso |
|------|---------------|-------------|
| `raw` *(default)* | Desativa as ferramentas internas do MiMo (`tools:{"*":false}`) e repassa o `system` prompt do cliente. O raciocínio vai em `reasoning_content`. | Roo Code, Cline, Kilo — o **cliente dirige as próprias ferramentas** |
| `agent` | O agente do MiMo executa as próprias ferramentas (`read`, `edit`, `bash`, ...) e o uso aparece como `reasoning_content` (`🔧 tool(arg)`). | Uso direto via TUI/Web do MiMo |

O streaming é **genuíno** nos dois modos: os deltas são transmitidos em tempo
real via o canal de eventos `GET /event` do MiMo.

## Variáveis de ambiente

| Variável | Descrição | Default |
|----------|-----------|---------|
| `MIMO_PROXY_TOKEN` | Chave de acesso ao proxy (header `X-API-Key`) | aleatória |
| `MIMOCODE_SERVER_PASSWORD` | Senha do servidor MiMo (`mimo serve`) | aleatória |
| `MIMO_SERVER_URL` | URL do servidor MiMo | `http://127.0.0.1:7788` |
| `MIMO_PROXY_PORT` | Porta do proxy | `8787` |
| `MIMO_PROXY_HOST` | Host de escuta do proxy | `0.0.0.0` |
| `MIMO_PROXY_MODEL` | Modelo padrão quando o cliente não envia | `mimo-auto` |
| `MIMO_PROXY_MODE` | `raw` ou `agent` | `raw` |
| `MIMO_PROXY_REQUIRE_AUTH` | `false` desliga a auth do proxy | `true` |
| `MIMO_PORT` | Porta interna do `mimo serve` | `7788` |
| `MIMO_VERSION` | Versão do MiMo a baixar (sandbox) | latest |

## Estrutura do projeto

| Arquivo / Diretório | Função |
|---------------------|--------|
| `start.sh` | Sobe MiMo + proxy num comando (baixa o binário se necessário) |
| `setup.sh` | Instala o projeto em `~/.mimo-code-proxy` |
| `mimo-proxy.js` | Entry point do proxy (HTTP server + upgrade WebSocket) |
| `src/config.js` | Carrega e valida variáveis de ambiente |
| `src/auth.js` | Autenticação via `X-API-Key` |
| `src/openai.js` | Endpoint `/v1/models` e mapeamento de modelos |
| `src/routes.js` | Reverse proxy e handler de `/v1/chat/completions` |
| `src/mimo-client.js` | Cliente HTTP/EventStream para o `mimo serve` |
| `src/tools.js` | Conversão de function calling OpenAI <-> MiMo |
| `Dockerfile` / `docker-compose.yml` | Deploy em container |
| `sandbox/` | Binário do MiMo baixado localmente (gitignored) |

## Segurança

- Com `MIMO_PROXY_REQUIRE_AUTH=false`, **qualquer pessoa na rede** acessa seu
  MiMo. Use apenas em rede local confiável.
- Para expor na internet, coloque atrás de TLS (Caddy/Nginx) ou túnel
  (Cloudflare Tunnel, Tailscale, etc.).
- Nunca commite o arquivo `.env` — ele já está no `.gitignore`.

## Licença

MIT
