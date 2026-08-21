# Build stage: install deps and produce the self-contained Nitro output.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN pnpm build

# Runtime stage: .output is self-contained, no node_modules install needed.
FROM node:22-alpine AS runtime
WORKDIR /app
# Containers must accept external connections; Nitro defaults to localhost.
ENV NODE_ENV=production \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000
# Create the user and the state dir in one layer. State lives under .data
# (NEURALWATT_DATA_DIR defaults to <cwd>/.data/neuralwatt).
RUN addgroup -S neuralwatt && adduser -S -G neuralwatt -h /app neuralwatt \
    && mkdir -p /app/.data && chown neuralwatt:neuralwatt /app/.data
# --chown here replaces the old `chown -R /app` layer, which duplicated all of .output.
COPY --from=build --link --chown=neuralwatt:neuralwatt /app/.output ./.output
USER neuralwatt
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", ".output/server/index.mjs"]
