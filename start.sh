#!/usr/bin/env bash
#
# MiMo Code Proxy — um comando só para usar o MiMo Code de qualquer lugar.
#
# Por padrão roda em MODO SANDBOX: baixa o binário do MiMo para ./sandbox/bin
# e usa só ele, sem instalar nada globalmente (não mexe no ~/.bashrc).
#
# O que ele faz:
#   1. Baixa o binário do MiMo para o sandbox local (se necessário).
#   2. Sobe o servidor do MiMo (mimo serve) usando o binário do sandbox.
#   3. Sobe o proxy reverso + camada OpenAI (/v1/models, /v1/chat/completions).
#   4. Mostra como acessar de qualquer lugar.
#
# Uso:
#   ./start.sh              # sandbox + credenciais aleatórias
#   ./start.sh --no-auth    # desliga a exigência de X-API-Key (só rede local!)
#   ./start.sh --global     # usa o mimo instalado globalmente, se houver
#
set -euo pipefail

# Carrega .env se existir (variáveis do shell ainda têm prioridade).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi

NO_AUTH="false"
if [ "${MIMO_PROXY_REQUIRE_AUTH:-}" = "false" ]; then
  NO_AUTH="true"
fi
USE_GLOBAL="false"
for a in "$@"; do
  [ "$a" = "--no-auth" ] && NO_AUTH="true"
  [ "$a" = "--global" ] && USE_GLOBAL="true"
done

MIMO_PORT="${MIMO_PORT:-7788}"
PROXY_PORT="${MIMO_PROXY_PORT:-8787}"
MIMO_PASSWORD="${MIMOCODE_SERVER_PASSWORD:-$(openssl rand -hex 12)}"
PROXY_TOKEN="${MIMO_PROXY_TOKEN:-$(openssl rand -hex 12)}"

MIMO_BIN=""

# 1. Resolver o binário do mimo
if [ "$USE_GLOBAL" = "true" ] && command -v mimo >/dev/null 2>&1; then
  MIMO_BIN="$(command -v mimo)"
  echo "==> Usando MiMo global: $MIMO_BIN"
elif command -v mimo >/dev/null 2>&1 && [ "$USE_GLOBAL" != "true" ]; then
  # mimo no PATH mas queremos sandbox? se já é global, reaproveita sem baixar.
  MIMO_BIN="$(command -v mimo)"
  echo "==> mimo encontrado no PATH: $MIMO_BIN"
else
  # Baixa para o sandbox local (não global).
  SANDBOX="$SCRIPT_DIR/sandbox/bin"
  mkdir -p "$SANDBOX"
  if [ ! -x "$SANDBOX/mimo" ]; then
    echo "==> Baixando MiMo Code para o sandbox ($SANDBOX)..."
    OS=linux
    case "$(uname -m)" in
      aarch64|arm64) ARCH=arm64 ;;
      x86_64|amd64)  ARCH=x64 ;;
      *) echo "Arquitetura não suportada: $(uname -m)"; exit 1 ;;
    esac
    VER="${MIMO_VERSION:-$(curl -fsSL https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode/releases/latest 2>/dev/null | tr -d '[:space:]' | sed 's/^v//')}"
    URL="https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode/releases/v${VER}/mimocode-${OS}-${ARCH}.tar.gz"
    echo "    versão $VER de $URL"
    curl -fsSL "$URL" -o /tmp/mimo.tar.gz
    tar -xzf /tmp/mimo.tar.gz -C "$SANDBOX"
    chmod +x "$SANDBOX/mimo"
    rm -f /tmp/mimo.tar.gz
  fi
  MIMO_BIN="$SANDBOX/mimo"
  echo "==> Usando MiMo do sandbox: $MIMO_BIN"
fi

export PATH="$SCRIPT_DIR/sandbox/bin:$PATH"
MIMO_BIN_ABS="$(cd "$(dirname "$MIMO_BIN")" && pwd)/$(basename "$MIMO_BIN")"

# Garante que o node esteja acessível (preserva o PATH original do usuário).
if ! command -v node >/dev/null 2>&1; then
  for p in /usr/local/bin /opt/node/bin /usr/bin; do
    [ -x "$p/node" ] && export PATH="$p:$PATH"
  done
fi

echo ""
echo "=============================================="
echo "  MiMo Code Proxy está pronto"
echo "=============================================="
echo "  Binário         : $MIMO_BIN_ABS"
echo "  Proxy na porta  : $PROXY_PORT"
[ "$NO_AUTH" = "true" ] && echo "  Auth do proxy    : DESLIGADA" || echo "  API Key          : $PROXY_TOKEN"
echo "  Modelo padrão   : ${MIMO_PROXY_MODEL:-mimo-auto}"
echo ""
echo "  Exemplos de uso:"
echo "    Listar modelos :"
echo "      curl -H 'X-API-Key: $PROXY_TOKEN' http://localhost:$PROXY_PORT/v1/models"
echo "    Chat (OpenAI)  :"
echo "      curl -H 'X-API-Key: $PROXY_TOKEN' -H 'Content-Type: application/json' \\"
echo "        -d '{\"model\":\"mimo-auto\",\"messages\":[{\"role\":\"user\",\"content\":\"Olá\"}],\"stream\":true}' \\"
echo "        http://localhost:$PROXY_PORT/v1/chat/completions"
echo "    Cliente mimo   :"
echo "      $MIMO_BIN_ABS attach http://localhost:$PROXY_PORT/"
echo "=============================================="
echo ""

# 2. Servidor do MiMo (sandbox)
MIMOCODE_SERVER_PASSWORD="$MIMO_PASSWORD" \
  "$MIMO_BIN_ABS" serve --hostname 127.0.0.1 --port "$MIMO_PORT" --print-logs &
MIMO_PID=$!

# 3. Proxy reverso + OpenAI
MIMO_PROXY_TOKEN="$PROXY_TOKEN" \
MIMO_SERVER_URL="http://127.0.0.1:$MIMO_PORT" \
MIMO_SERVER_PASSWORD="$MIMO_PASSWORD" \
MIMO_PROXY_PORT="$PROXY_PORT" \
MIMO_PROXY_REQUIRE_AUTH="$([ "$NO_AUTH" = "true" ] && echo false || echo true)" \
  node "$SCRIPT_DIR/mimo-proxy.js" &
PROXY_PID=$!

trap 'kill $MIMO_PID $PROXY_PID 2>/dev/null' EXIT INT TERM
wait
