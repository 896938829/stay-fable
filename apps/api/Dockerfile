FROM node:24.14.1-bookworm-slim AS build

WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.17.0 --activate

COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @stay-fable/validation build \
    && pnpm --filter @stay-fable/api-contracts build
RUN DATABASE_URL=postgresql://container_build:container_build@localhost:5432/container_build \
    pnpm --filter @stay-fable/api-server prisma:generate
RUN pnpm --filter @stay-fable/api-server build
RUN pnpm deploy --filter @stay-fable/api-server --prod /out

FROM node:24.14.1-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /out ./

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
