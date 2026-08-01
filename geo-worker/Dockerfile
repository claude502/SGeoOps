FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY geo-worker/package.json ./geo-worker/package.json
COPY packages/analysis-contract/package.json ./packages/analysis-contract/package.json
COPY packages/internal-protocol/package.json ./packages/internal-protocol/package.json
RUN npm ci --ignore-scripts --workspace geo-worker
COPY geo-worker ./geo-worker
COPY packages/analysis-contract ./packages/analysis-contract
COPY packages/internal-protocol ./packages/internal-protocol
WORKDIR /app/geo-worker
