# Build stage: install dependencies and produce the self-contained Nitro output.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN pnpm build

# DeepInfra's anonymous route needs a headed Chrome renderer. Xvfb supplies a
# virtual display and SwiftShader supplies WebGL on GPU-less Linux hosts.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb fonts-liberation fonts-noto-core fonts-noto-cjk \
      fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 101 deepinfra \
    && useradd --system --uid 100 --gid 101 --home /app deepinfra \
    && mkdir -p /app/.data/deepinfra-profile \
    && chown -R 100:101 /app/.data
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000 \
    DEEPINFRA_BROWSER_PATH=/usr/bin/chromium \
    DEEPINFRA_DISPLAY=:99 \
    DEEPINFRA_PROFILE_DIR=/app/.data/deepinfra-profile
COPY --from=build --link --chown=100:101 /app/.output ./.output
COPY --chown=100:101 docker-entrypoint.sh /usr/local/bin/deepinfra-entrypoint
RUN chmod 0755 /usr/local/bin/deepinfra-entrypoint
USER deepinfra
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["/usr/local/bin/deepinfra-entrypoint"]
