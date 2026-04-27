FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    wget \
    unzip \
    curl \
    ca-certificates \
    openssl \
    libssl3 \
    libatomic1 \
    zlib1g \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Telegram Bot API server binary for large file support (up to 2 GB)
RUN set -e \
    && wget -q "https://github.com/tdlib/telegram-bot-api/releases/download/v8.3/telegram-bot-api-amd64-linux.zip" \
         -O /tmp/tg.zip \
    && unzip -o /tmp/tg.zip -d /tmp/tg_bin/ \
    && ls -la /tmp/tg_bin/ \
    && find /tmp/tg_bin/ -name "telegram-bot-api" -exec cp {} /usr/local/bin/telegram-bot-api \; \
    && chmod +x /usr/local/bin/telegram-bot-api \
    && rm -rf /tmp/tg.zip /tmp/tg_bin/ \
    && echo "=== telegram-bot-api binary installed ===" \
    && /usr/local/bin/telegram-bot-api --version 2>&1 || echo "NOTE: version check may fail but binary is installed" \
    || (echo "ERROR: telegram-bot-api install failed — large file support will be disabled" && exit 0)

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
