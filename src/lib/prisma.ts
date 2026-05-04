import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as typeof globalThis & {
  __geoOpsPrisma?: PrismaClient;
};

export function isDatabaseConfigured(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.DATABASE_URL?.trim());
}

export function getPrisma() {
  if (!isDatabaseConfigured()) {
    throw new Error("DATABASE_URL is required for persistent GEOFlow bridge state.");
  }

  if (!globalForPrisma.__geoOpsPrisma) {
    globalForPrisma.__geoOpsPrisma = new PrismaClient();
  }

  return globalForPrisma.__geoOpsPrisma;
}
