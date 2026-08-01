FROM node:24-alpine AS deps
WORKDIR /app
RUN apk add --no-cache build-base
COPY package*.json ./
COPY native ./native
COPY packages ./packages
COPY geo-worker/package.json ./geo-worker/package.json
COPY scripts/build-renameat-helper.mjs ./scripts/build-renameat-helper.mjs
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
RUN apk add --no-cache build-base
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run prisma:generate
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.sgeo-native ./.sgeo-native
COPY --from=builder /app/scripts/bootstrap-admin.ts ./scripts/bootstrap-admin.ts
COPY --from=builder /app/src/lib/auth.ts ./src/lib/auth.ts
COPY --from=builder /app/src/lib/prisma.ts ./src/lib/prisma.ts

EXPOSE 3000
CMD ["npm", "run", "start"]
