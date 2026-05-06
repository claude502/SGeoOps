FROM oven/bun:1-alpine
WORKDIR /app
COPY package.json bun.lockb* ./
RUN if [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi
COPY prisma ./prisma
COPY src ./src
RUN bunx prisma generate --schema ./prisma/schema.prisma
CMD ["bun", "run", "src/index.ts"]
