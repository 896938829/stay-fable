FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile
RUN pnpm --filter @stay-fable/validation build \
    && pnpm --filter @stay-fable/api-contracts build
RUN pnpm --filter @stay-fable/job-worker build
RUN pnpm deploy --filter @stay-fable/job-worker --prod /out

FROM node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /out ./

USER node

CMD ["node", "dist/main.js"]
