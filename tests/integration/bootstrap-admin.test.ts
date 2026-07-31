import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "../../src/lib/auth";
import {
  acquireBootstrapAdvisoryLock,
  bootstrapAdmin,
  type BootstrapAdminInput,
  type BootstrapDependencies,
  type BootstrapTransaction,
} from "../../scripts/bootstrap-admin";

const integrationEnabled = process.env.SGEO_DATABASE_INTEGRATION === "1";
const databaseUrl = process.env.TEST_DATABASE_URL ?? "";
const authEnvironment = {
  BETTER_AUTH_SECRET: "integration-test-only-secret-not-for-deployment",
  BETTER_AUTH_URL: "http://localhost:3000",
  SGEO_ALLOW_BOOTSTRAP_SIGNUP: "true",
};

let adminClient: Client;
let prisma: PrismaClient;
let schema = "";

function quoteIdentifier(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function input(email: string): BootstrapAdminInput {
  return {
    email,
    name: "Integration Admin",
    password: "integration-test-password",
  };
}

function createDependencies(): BootstrapDependencies {
  return {
    transaction: (operation) =>
      prisma.$transaction(async (database) =>
        operation({
          acquireBootstrapLock: () =>
            acquireBootstrapAdvisoryLock(database),
          countUsers: () => database.user.count(),
          findInternalWorkspace: () =>
            database.workspace.findUnique({
              where: { id: "workspace_internal" },
              select: { id: true },
            }),
          signUpEmail: (body) =>
            createAuth(
              database as Prisma.TransactionClient,
              authEnvironment,
            ).api.signUpEmail({ body }),
          createMembership: (data) =>
            database.workspaceMember.create({ data }),
        } as BootstrapTransaction),
      ),
  };
}

describe.skipIf(!integrationEnabled).sequential(
  "bootstrap admin PostgreSQL concurrency",
  () => {
    beforeAll(async () => {
      if (!databaseUrl) {
        throw new Error(
          "TEST_DATABASE_URL is required for database integration tests",
        );
      }

      const parsedUrl = new URL(databaseUrl);
      const databaseName = decodeURIComponent(parsedUrl.pathname.slice(1));
      if (!/^sgeo_task[0-9]+_test(?:_|$)/.test(databaseName)) {
        throw new Error(
          `Refusing database integration tests against unguarded database ${databaseName}`,
        );
      }
      parsedUrl.searchParams.delete("schema");
      const connectionString = parsedUrl.toString();

      adminClient = new Client({
        connectionString,
        application_name: "sgeo-task5-bootstrap-test",
      });
      await adminClient.connect();

      const database = await adminClient.query<{
        current_database: string;
        server_version_num: string;
      }>(`
        SELECT current_database(), current_setting('server_version_num')
          AS server_version_num
      `);
      expect(database.rows[0]?.current_database).toBe(databaseName);
      const version = Number(database.rows[0]?.server_version_num);
      expect(version).toBeGreaterThanOrEqual(160_000);
      expect(version).toBeLessThan(170_000);

      schema = `sgeo_task5_bootstrap_${process.pid}_${randomUUID()
        .replaceAll("-", "")
        .slice(0, 10)}`;
      await adminClient.query(
        `CREATE SCHEMA ${quoteIdentifier(schema)}`,
      );
      await adminClient.query(
        `SET search_path TO ${quoteIdentifier(schema)}`,
      );
      await adminClient.query(`
        CREATE TYPE "MemberRole" AS ENUM (
          'Admin', 'Operator', 'Reviewer', 'Viewer'
        );

        CREATE TABLE "Workspace" (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "slug" TEXT NOT NULL UNIQUE,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );

        CREATE TABLE "User" (
          "id" TEXT PRIMARY KEY,
          "name" TEXT NOT NULL,
          "email" TEXT NOT NULL UNIQUE,
          "emailVerified" BOOLEAN NOT NULL DEFAULT false,
          "image" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );

        CREATE TABLE "Session" (
          "id" TEXT PRIMARY KEY,
          "expiresAt" TIMESTAMP(3) NOT NULL,
          "token" TEXT NOT NULL UNIQUE,
          "ipAddress" TEXT,
          "userAgent" TEXT,
          "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );
        CREATE INDEX "Session_userId_idx" ON "Session"("userId");

        CREATE TABLE "Account" (
          "id" TEXT PRIMARY KEY,
          "accountId" TEXT NOT NULL,
          "providerId" TEXT NOT NULL,
          "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "accessToken" TEXT,
          "refreshToken" TEXT,
          "idToken" TEXT,
          "accessTokenExpiresAt" TIMESTAMP(3),
          "refreshTokenExpiresAt" TIMESTAMP(3),
          "scope" TEXT,
          "password" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          UNIQUE ("providerId", "accountId")
        );
        CREATE INDEX "Account_userId_idx" ON "Account"("userId");

        CREATE TABLE "Verification" (
          "id" TEXT PRIMARY KEY,
          "identifier" TEXT NOT NULL,
          "value" TEXT NOT NULL,
          "expiresAt" TIMESTAMP(3) NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL
        );
        CREATE INDEX "Verification_identifier_idx"
          ON "Verification"("identifier");

        CREATE TABLE "WorkspaceMember" (
          "id" TEXT PRIMARY KEY,
          "workspaceId" TEXT NOT NULL
            REFERENCES "Workspace"("id") ON DELETE CASCADE,
          "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
          "role" "MemberRole" NOT NULL,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL,
          UNIQUE ("workspaceId", "userId")
        );
        CREATE INDEX "WorkspaceMember_userId_role_idx"
          ON "WorkspaceMember"("userId", "role");

        INSERT INTO "Workspace" (
          "id", "name", "slug", "createdAt", "updatedAt"
        ) VALUES (
          'workspace_internal',
          'Internal GEO SEO Operations',
          'internal',
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        );
      `);

      prisma = new PrismaClient({
        adapter: new PrismaPg(
          { connectionString },
          { schema },
        ),
      });
    });

    afterAll(async () => {
      await prisma?.$disconnect();
      if (!adminClient) return;
      await adminClient.query("SET search_path TO public");
      if (schema.startsWith("sgeo_task5_bootstrap_")) {
        await adminClient.query(
          `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
        );
      }
      await adminClient.end();
    });

    it("allows exactly one concurrent bootstrap", async () => {
      const dependencies = createDependencies();
      const results = await Promise.allSettled([
        bootstrapAdmin(
          input("admin-one@example.com"),
          dependencies,
        ),
        bootstrapAdmin(
          input("admin-two@example.com"),
          dependencies,
        ),
      ]);
      const rejectedMessages = results
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        )
        .map((result) =>
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        );

      expect({
        fulfilled: results.filter(
          (result) => result.status === "fulfilled",
        ).length,
        rejectedMessages,
        users: await prisma.user.count(),
        accounts: await prisma.account.count(),
        adminMemberships: await prisma.workspaceMember.count({
          where: {
            workspaceId: "workspace_internal",
            role: "Admin",
          },
        }),
      }).toEqual({
        fulfilled: 1,
        rejectedMessages: ["BOOTSTRAP_ALREADY_COMPLETED"],
        users: 1,
        accounts: 1,
        adminMemberships: 1,
      });
    });
  },
);
