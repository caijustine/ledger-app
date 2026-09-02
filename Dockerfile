FROM node:22-alpine
WORKDIR /app

# --- Litestream: streams the SQLite file to off-host object storage ---
ARG TARGETARCH=amd64
ARG LITESTREAM_VERSION=0.3.13
ADD https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${TARGETARCH}.tar.gz /tmp/litestream.tar.gz
RUN tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz && rm /tmp/litestream.tar.gz

COPY package.json ./
RUN npm install --omit=dev
COPY . .
COPY litestream.yml /etc/litestream.yml
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
