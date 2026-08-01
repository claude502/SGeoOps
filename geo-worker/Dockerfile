FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3
ARG TARGETARCH
WORKDIR /app
COPY package.json package-lock.json ./
COPY geo-worker/package.json ./geo-worker/package.json
COPY packages/analysis-contract/package.json ./packages/analysis-contract/package.json
COPY packages/internal-protocol/package.json ./packages/internal-protocol/package.json
RUN npm ci --ignore-scripts --workspace geo-worker
RUN set -eux; \
    apk add --no-cache ca-certificates chromium; \
    test -x /usr/bin/chromium; \
    /usr/bin/chromium --version; \
    apk add --no-cache --virtual .siteone-fetch curl; \
    case "$TARGETARCH" in \
      amd64) \
        asset="siteone-crawler-v2.5.1-linux-musl-x64.tar.gz"; \
        checksum="bd96b9502563aea2581fc248625871e69b60d7f1bb68a484f226c551c73706fd"; \
        ;; \
      arm64) \
        asset="siteone-crawler-v2.5.1-linux-musl-arm64.tar.gz"; \
        checksum="cad85649c09a4181ae36e47269caff647fe7e2bb556dc388b5f7aede6e420e20"; \
        ;; \
      *) \
        echo "Unsupported TARGETARCH: $TARGETARCH"; \
        exit 1; \
        ;; \
    esac; \
    curl --fail --location --silent --show-error \
      "https://github.com/janreges/siteone-crawler/releases/download/v2.5.1/$asset" \
      -o /tmp/siteone.tar.gz; \
    echo "$checksum  /tmp/siteone.tar.gz" | sha256sum -c -; \
    mkdir -p /tmp/siteone; \
    tar -xzf /tmp/siteone.tar.gz -C /tmp/siteone; \
    cp /tmp/siteone/siteone-crawler/siteone-crawler /usr/local/bin/siteone-crawler; \
    chmod 0755 /usr/local/bin/siteone-crawler; \
    rm -rf /tmp/siteone /tmp/siteone.tar.gz; \
    apk del .siteone-fetch
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
RUN addgroup -S -g 10001 sgeo && adduser -S -D -H -u 10001 -G sgeo sgeo
COPY --chown=10001:10001 geo-worker ./geo-worker
COPY --chown=10001:10001 packages/analysis-contract ./packages/analysis-contract
COPY --chown=10001:10001 packages/internal-protocol ./packages/internal-protocol
WORKDIR /app/geo-worker
USER 10001:10001
