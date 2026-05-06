import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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
    globalForPrisma.__geoOpsPrisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL,
      }),
    });
  }

  return globalForPrisma.__geoOpsPrisma;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(getPrisma(), property, receiver);
  },
});
