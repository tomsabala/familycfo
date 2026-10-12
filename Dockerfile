# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# better-sqlite3 falls back to a source build when no prebuilt matches; the builder is discarded
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# Chromium comes from Debian in the runtime stage, so puppeteer must not download its own
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY .npmrc package.json package-lock.json ./
COPY web/.npmrc web/package.json web/package-lock.json web/
RUN npm ci
COPY tsconfig.json ./
COPY src src
COPY web web
ARG FAMILYCFO_BASE_PATH=""
ENV FAMILYCFO_BASE_PATH=${FAMILYCFO_BASE_PATH}
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
WORKDIR /app
# chromium pulls its own library dependencies, which is why the scraper gets a browser without a
# hand-maintained list of libs; xvfb is the virtual display the entrypoint starts (no xauth: the
# server is local-socket only and this container runs nothing else); the fonts are for Hebrew pages
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb fonts-liberation fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*
ARG FAMILYCFO_BASE_PATH=""
ENV NODE_ENV=production \
    HOSTED=1 \
    PORT=4310 \
    FAMILYCFO_BASE_PATH=${FAMILYCFO_BASE_PATH} \
    BANK_DB=/data/demo.db \
    POLICIES_DIR=/data/policies \
    REPORTS_DIR=/data/reports \
    PUPPETEER_SKIP_DOWNLOAD=true
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
COPY package.json ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /data && chown node:node /data
USER node
EXPOSE 4310
CMD ["/usr/local/bin/entrypoint.sh"]
