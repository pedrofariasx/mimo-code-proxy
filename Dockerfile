FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates openssl tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json mimo-proxy.js start.sh ./
COPY src/ src/
RUN chmod +x start.sh

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8787/healthz || exit 1

ENTRYPOINT ["./start.sh"]
