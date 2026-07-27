FROM node:24.14.1-bookworm-slim AS build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @stay-fable/validation build \
    && pnpm --filter @stay-fable/api-contracts build
RUN pnpm --filter @stay-fable/job-worker build
RUN pnpm deploy --filter @stay-fable/job-worker --prod /out

FROM node:24.14.1-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /out ./

USER node

CMD ["node", "dist/main.js"]
