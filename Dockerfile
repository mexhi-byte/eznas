# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /app

# Dependencies first, so an edit to the source does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY web ./web
COPY server ./server
RUN npm run build

# Drop to what is needed to run, in place, so the layer below copies one tree.
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM node:22-alpine
WORKDIR /app

# git, because the in-place updater under Settings shells out to it. Without
# it the console reports that it cannot update itself, which is true but
# avoidable.
# tzdata, so notification timestamps are in the household's own time.
RUN apk add --no-cache git tzdata

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# index.ts reads package.json at startup for the version it reports and
# compares against the published releases.
COPY package.json ./

# Everything the console knows about itself lives under one mounted volume,
# because a container that keeps its accounts and forgets its API keys is
# worse than one that keeps neither. The file names inside it are the ones
# earlier images set one variable at a time, so an existing volume carries on.
ENV DATA_DIR=/data \
    PORT=8080 \
    NODE_ENV=production

# Unprivileged: this process needs to read its own data directory and talk to
# the NAS over the network, and nothing else. The node image ships a `node`
# user for exactly this.
#
# Ordering matters and is easy to get wrong: anything written to a path after
# VOLUME has declared it is discarded, so a chown placed below would vanish and
# the container would start as node against a root-owned /data. A bind mount
# overrides image ownership regardless, which is why install.sh chowns the
# dataset to the same uid.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
