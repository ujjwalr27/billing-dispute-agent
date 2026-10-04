# syntax=docker/dockerfile:1

# ---- Builder: install deps, generate Prisma client, build Next.js ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Prisma's query engine needs OpenSSL at build and run time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

# ---- Runner ----
# The built app plus node_modules are carried over so the entrypoint can run
# `prisma migrate deploy` and seed at startup, and the server runs via
# `next start`. (A leaner image could ship Next's standalone output and drop
# dev deps; full deps are kept here for a reliable one-command `docker compose
# up` that can also migrate and seed.)
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PRISMA_HIDE_UPDATE_MESSAGE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app ./
COPY docker-entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "run", "start"]
