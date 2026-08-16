# syntax=docker/dockerfile:1

# Build stage: install deps and produce the self-contained Nitro output.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Runtime stage: .output is self-contained, no node_modules install needed.
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Containers must accept external connections; Nitro defaults to localhost.
ENV NITRO_HOST=0.0.0.0
ENV NITRO_PORT=3000
COPY --from=build /app/.output ./.output
# Account data lives in .data (NEURALWATT_DATA_FILE defaults to <cwd>/.data/...);
# pre-create it so a host bind mount keeps node-writable ownership.
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
