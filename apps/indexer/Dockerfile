# DarkSeek indexer. Build from the repository root:
#   docker build -f apps/indexer/Dockerfile -t darkseek-indexer .
#   docker run -p 8080:8080 -v darkseek-indexer:/data \
#     -e DS_RPC_URL=<rpc url> -e DS_PROGRAM_ID=<program id> darkseek-indexer

FROM node:22.22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sdk/package.json packages/sdk/
COPY apps/indexer/package.json apps/indexer/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY packages/sdk packages/sdk
COPY apps/indexer apps/indexer
RUN npm run build -w @darkseek/sdk && npm run build -w @darkseek/indexer \
 && npm prune --omit=dev --ignore-scripts

FROM node:22.22-alpine
ENV NODE_ENV=production DS_DB_PATH=/data/indexer.sqlite PORT=8080
WORKDIR /app
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/packages/sdk/package.json packages/sdk/package.json
COPY --from=build /src/packages/sdk/dist packages/sdk/dist
COPY --from=build /src/apps/indexer/package.json apps/indexer/package.json
COPY --from=build /src/apps/indexer/dist apps/indexer/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/indexer/dist/main.js"]
