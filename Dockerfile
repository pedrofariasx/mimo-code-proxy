FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates openssl tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json mimo-proxy.js start.sh ./
RUN chmod +x start.sh

EXPOSE 8787

ENTRYPOINT ["./start.sh"]
