#!/usr/bin/env bash
#
# Instala o "MiMo Code Proxy" em um comando.
# Baixa os arquivos, instala o MiMo Code e deixa pronto para usar.
#
# Uso:
#   curl -fsSL https://SEU-SCRIPT/setup.sh | bash
#   # ou localmente:
#   ./setup.sh
#
set -euo pipefail

INSTALL_DIR="${MIMO_CODE_PROXY_DIR:-$HOME/.mimo-code-proxy}"
REPO_RAW="${MIMO_CODE_PROXY_REPO:-https://raw.githubusercontent.com/SEU-USER/mimo-code-proxy/main}"

echo "==> Instalando MiMo Code Proxy em $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Baixa os arquivos do projeto (ou copia localmente se já existirem)
if [ -f "$(dirname "$0")/mimo-proxy.js" ]; then
  cp "$(dirname "$0")/mimo-proxy.js" "$INSTALL_DIR/"
  cp "$(dirname "$0")/start.sh" "$INSTALL_DIR/" 2>/dev/null || true
  cp "$(dirname "$0")/.env.example" "$INSTALL_DIR/" 2>/dev/null || true
else
  for f in mimo-proxy.js start.sh .env.example README.md; do
    curl -fsSL "$REPO_RAW/$f" -o "$INSTALL_DIR/$f" 2>/dev/null || true
  done
fi

chmod +x "$INSTALL_DIR/start.sh" 2>/dev/null || true

# Instala o MiMo Code se preciso
export PATH="$HOME/.mimocode/bin:$PATH"
if ! command -v mimo >/dev/null 2>&1; then
  echo "==> Instalando MiMo Code..."
  curl -fsSL https://mimo.xiaomi.com/install | bash
fi

echo ""
echo "Pronto! Para iniciar:"
echo "  bash $INSTALL_DIR/start.sh"
echo ""
echo "Ou sem autenticação (só rede local):"
echo "  bash $INSTALL_DIR/start.sh --no-auth"
