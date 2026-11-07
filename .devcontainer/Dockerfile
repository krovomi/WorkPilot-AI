# Development container: the toolchain CI uses, plus what the E2E suite needs to
# start Electron without a display. Versions follow CI: Python 3.13
# (ci.yml), Node 22 (.github/actions/setup-node-frontend), pnpm from the root
# package.json `packageManager`, uv from .github/actions/setup-python-backend.
FROM node:22-bookworm-slim AS node

FROM mcr.microsoft.com/devcontainers/python:1-3.13-bookworm

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && npm install -g pnpm@12.5.1 \
 && pip install --no-cache-dir uv==0.11.32 \
 && node --version && pnpm --version && uv --version

# Electron's runtime libraries and a virtual display, for `pnpm run test:e2e`
# and the start-up smoke test (run them under `xvfb-run -a`).
# The base image ships a Yarn apt source whose signing key expires now and then,
# which fails `apt-get update`; nothing here uses Yarn.
RUN rm -f /etc/apt/sources.list.d/yarn.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    xvfb xauth libgtk-3-0 libnss3 libxss1 libasound2 libgbm1 libxshmfence1 \
    libatk-bridge2.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libcups2 libpango-1.0-0 libatspi2.0-0 \
 && rm -rf /var/lib/apt/lists/*
