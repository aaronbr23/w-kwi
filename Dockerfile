# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# arduino-cli + AVR core (Uno/Nano/Mega). GPL toolchains (avr-gcc etc.) run as a separate
# process via arduino-cli, never linked into this image's own code.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh -s -- v1.1.1 && \
    mv bin/arduino-cli /usr/local/bin/ && rmdir bin && \
    arduino-cli core install arduino:avr && \
    apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/server ./src/server
COPY src/sim ./src/sim
COPY src/parts ./src/parts
COPY --from=build /app/dist/web ./dist/web

ENV DATA_DIR=/data PORT=8080 NODE_ENV=production
VOLUME /data
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/server/index.ts"]
