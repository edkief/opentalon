# Stage 1: Install dependencies
FROM node:26-alpine AS deps
WORKDIR /app
RUN npm i -g pnpm
COPY .npmrc package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

# Stage 2: Build the application
FROM node:26-alpine AS builder
WORKDIR /app
RUN npm i -g pnpm

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# Stage 3: Production runner
FROM ubuntu:latest AS runner
WORKDIR /app

ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends jq curl wget ca-certificates nano vim build-essential procps file git ffmpeg python3 python3-pip python3-venv python-is-python3 sudo \
    libnspr4 libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libxkbcommon0 \
    libpango-1.0-0 libcairo2 libasound2t64 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libx11-xcb1 libxss1 libxtst6 fonts-liberation ripgrep \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages pydantic

RUN curl -sL https://deb.nodesource.com/setup_25.x | /bin/bash
RUN apt install nodejs -y
RUN node --version

RUN npm install -g agent-browser pnpm typescript-language-server typescript pyright
RUN npx playwright install-deps chromium

COPY --from=builder --chown=ubuntu:ubuntu /app/public ./public
COPY --from=builder --chown=ubuntu:ubuntu /app/.next/standalone ./
COPY --from=builder --chown=ubuntu:ubuntu /app/.next/static ./.next/static
COPY --from=builder --chown=ubuntu:ubuntu /app/drizzle.config.ts ./
COPY --from=builder --chown=ubuntu:ubuntu /app/drizzle ./drizzle
COPY --from=builder --chown=ubuntu:ubuntu /app/node_modules/drizzle-orm ./node_modules/drizzle-orm
COPY --from=builder --chown=ubuntu:ubuntu /app/assets ./assets

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER ubuntu
RUN agent-browser install

ENV PATH=/app/node_modules/.bin:$PATH
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
