# syntax=docker/dockerfile:1

FROM node:22.18.0-slim AS build

WORKDIR /app

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    git \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY skills ./skills
COPY assets ./assets
COPY workers ./workers
COPY acp_registry ./acp_registry
COPY scripts ./scripts
COPY README.md LICENSE NOTICE ./

RUN pnpm run build
RUN pnpm prune --prod

FROM node:22.18.0-slim AS runtime

ENV NODE_ENV=production
ENV HOME=/home/estacoda

WORKDIR /app

RUN groupadd --system estacoda \
  && useradd --system --create-home --gid estacoda --home-dir /home/estacoda estacoda \
  && mkdir -p /home/estacoda/.estacoda \
  && chown -R estacoda:estacoda /home/estacoda

COPY --from=build --chown=estacoda:estacoda /app/package.json ./package.json
COPY --from=build --chown=estacoda:estacoda /app/node_modules ./node_modules
COPY --from=build --chown=estacoda:estacoda /app/dist ./dist
COPY --from=build --chown=estacoda:estacoda /app/skills ./skills
COPY --from=build --chown=estacoda:estacoda /app/assets ./assets
COPY --from=build --chown=estacoda:estacoda /app/workers ./workers
COPY --from=build --chown=estacoda:estacoda /app/acp_registry ./acp_registry
COPY --from=build --chown=estacoda:estacoda /app/scripts ./scripts
COPY --from=build --chown=estacoda:estacoda /app/README.md /app/LICENSE /app/NOTICE ./

USER estacoda

VOLUME ["/home/estacoda/.estacoda"]

ENTRYPOINT ["node", "dist/index.js"]
