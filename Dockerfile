FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    wget \
    unzip \
    curl \
    jq \
    ca-certificates \
    openssl \
    libssl3 \
    libatomic1 \
    zlib1g \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install Telegram Bot API server binary (tries latest GitHub release, falls back to v8.2)
RUN set -eux; \
    # Try to get latest release URL from GitHub API
    LATEST_URL=$(curl -fsSL "https://api.github.com/repos/tdlib/telegram-bot-api/releases/latest" \
      | jq -r '.assets[] | select(.name | test("amd64-linux")) | .browser_download_url' \
      | head -1 2>/dev/null || true); \
    \
    # Fallback URLs if latest doesn't work
    URLS="${LATEST_URL} \
      https://github.com/tdlib/telegram-bot-api/releases/download/v8.3/telegram-bot-api-amd64-linux.zip \
      https://github.com/tdlib/telegram-bot-api/releases/download/v8.2/telegram-bot-api-amd64-linux.zip"; \
    \
    INSTALLED=0; \
    for URL in $URLS; do \
      [ -z "$URL" ] && continue; \
      echo "Trying: $URL"; \
      if wget -q "$URL" -O /tmp/tg.zip 2>/dev/null && [ -s /tmp/tg.zip ]; then \
        mkdir -p /tmp/tg_bin; \
        unzip -o /tmp/tg.zip -d /tmp/tg_bin/; \
        BIN=$(find /tmp/tg_bin/ -name "telegram-bot-api" -type f | head -1); \
        if [ -n "$BIN" ]; then \
          cp "$BIN" /usr/local/bin/telegram-bot-api; \
          chmod +x /usr/local/bin/telegram-bot-api; \
          rm -rf /tmp/tg.zip /tmp/tg_bin/; \
          echo "=== telegram-bot-api installed from: $URL ==="; \
          /usr/local/bin/telegram-bot-api --version 2>&1 || true; \
          INSTALLED=1; \
          break; \
        fi; \
        rm -rf /tmp/tg.zip /tmp/tg_bin/; \
      fi; \
    done; \
    \
    if [ "$INSTALLED" = "0" ]; then \
      echo "WARNING: telegram-bot-api binary could not be installed — files >20MB will not be supported"; \
    fi

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
