FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile
COPY src ./src
CMD ["bun", "run", "src/index.ts"]
