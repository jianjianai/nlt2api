# The minter runs TypeScript directly via Node's type stripping, so there is no
# build stage: only the browser runtime and the sources are needed.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb fonts-liberation fonts-noto-core fonts-noto-cjk \
      fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 101 minter \
    && useradd --system --uid 100 --gid 101 --home /app minter \
    && mkdir -p /app/.data/profile \
    && chown -R 100:101 /app/.data
ENV NODE_ENV=production \
    MINTER_BROWSER_PATH=/usr/bin/chromium \
    MINTER_DISPLAY=:99 \
    MINTER_PROFILE_DIR=/app/.data/profile
COPY --chown=100:101 package.json ./
COPY --chown=100:101 src ./src
COPY --chown=100:101 docker-entrypoint.sh /usr/local/bin/minter-entrypoint
RUN chmod 0755 /usr/local/bin/minter-entrypoint
USER minter
CMD ["/usr/local/bin/minter-entrypoint"]
