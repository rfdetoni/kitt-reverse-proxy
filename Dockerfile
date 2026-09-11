# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --strict-allow-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kitt \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin kitt

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /data/browser \
    && chown -R kitt:kitt /data/browser /app

USER kitt

VOLUME ["/data/browser"]
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/cli.js"]
CMD ["start", "chatgpt", "--host", "0.0.0.0", "--port", "3000", "--user-data-dir", "/data/browser"]

# Standalone target: includes the Playwright-managed Chromium fallback.
# The ecosystem Compose uses the lighter `runtime` target and a browser sidecar.
FROM runtime AS standalone

USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright
USER kitt

CMD ["start", "chatgpt", "--headless", "--host", "0.0.0.0", "--port", "3000", "--user-data-dir", "/data/browser"]
