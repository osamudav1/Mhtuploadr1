FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    wget \
    unzip \
    curl \
    ca-certificates \
    openssl \
    libssl3 \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

RUN wget -qO /tmp/tg.zip \
    "https://github.com/tdlib/telegram-bot-api/releases/download/v8.3/telegram-bot-api-amd64-linux.zip" \
    && unzip -qo /tmp/tg.zip -d /usr/local/bin/ \
    && chmod +x /usr/local/bin/telegram-bot-api \
    && rm /tmp/tg.zip \
    && echo "telegram-bot-api installed: $(telegram-bot-api --version 2>&1 || true)" \
    || echo "WARNING: telegram-bot-api download failed — large-file support disabled"

RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./

COPY lib/ lib/
COPY artifacts/api-server/ artifacts/api-server/

RUN pnpm install --frozen-lockfile

RUN pnpm --filter @workspace/api-server run build

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "--enable-source-maps", "/workspace/artifacts/api-server/dist/index.mjs"]
