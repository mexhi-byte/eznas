# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build
#
# Built on the machine doing the building, whatever the image is for. The
# build is TypeScript and Vite — pure JavaScript in, JavaScript out — and the
# runtime dependencies have no native code, so the output is the same for
# every architecture. Running the build under emulation for arm64 instead
# took several minutes and produced identical files.
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
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
FROM node:26-alpine
WORKDIR /app

# tzdata, so notification timestamps are in the household's own time.
# su-exec, so the entrypoint can drop from root to the console's user.
RUN apk add --no-cache tzdata su-exec

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# index.ts reads package.json at startup for the version it reports and
# compares against the published releases.
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint

# Everything the console knows about itself lives under one mounted volume,
# because a container that keeps its accounts and forgets its API keys is
# worse than one that keeps neither. RELEASE_CHANNEL tells the console it is
# running from an image, so it points at the image for updates rather than
# trying to rebuild itself in place.
ENV DATA_DIR=/data \
    PORT=8080 \
    NODE_ENV=production \
    RELEASE_CHANNEL=container

RUN mkdir -p /data && chown -R node:node /data /app

VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No USER line: the entrypoint drops privileges itself, after making /data
# writable. See docker-entrypoint.sh for why.
ENTRYPOINT ["docker-entrypoint"]
CMD ["node", "dist/server/index.js"]
