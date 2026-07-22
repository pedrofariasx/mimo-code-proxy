FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates openssl tar tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY mimo-proxy.js start.sh ./
COPY src/ src/
RUN chmod +x start.sh && \
    mkdir -p /app/sandbox/bin && \
    chown -R node:node /app

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8787/healthz || exit 1

ENTRYPOINT ["tini", "--", "./start.sh"]
