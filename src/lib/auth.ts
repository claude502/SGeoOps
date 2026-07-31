import type { Prisma, PrismaClient } from "@prisma/client";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { betterAuth } from "better-auth/minimal";
import { getPrisma } from "@/lib/prisma";

type AuthDatabase = PrismaClient | Prisma.TransactionClient;
type AuthEnvironment = Record<string, string | undefined>;

export type AuthRuntimeConfig = {
  secret: string;
  baseURL: string;
  allowBootstrapSignUp: boolean;
};

export class AuthConfigurationError extends Error {
  readonly code = "AUTH_CONFIGURATION_REQUIRED" as const;

  constructor() {
    super("AUTH_CONFIGURATION_REQUIRED");
    this.name = "AuthConfigurationError";
  }
}

export function readAuthRuntimeConfig(
  env: AuthEnvironment = process.env,
): AuthRuntimeConfig {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const baseURL = env.BETTER_AUTH_URL?.trim();

  if (!secret || secret.length < 32 || !baseURL) {
    throw new AuthConfigurationError();
  }

  try {
    const parsedBaseURL = new URL(baseURL);
    if (!["http:", "https:"].includes(parsedBaseURL.protocol)) {
      throw new AuthConfigurationError();
    }
  } catch {
    throw new AuthConfigurationError();
  }

  return {
    secret,
    baseURL,
    allowBootstrapSignUp:
      env.SGEO_ALLOW_BOOTSTRAP_SIGNUP === "true",
  };
}

export function createAuth(
  database: AuthDatabase | undefined = undefined,
  env: AuthEnvironment = process.env,
) {
  const config = readAuthRuntimeConfig(env);
  const authDatabase = database ?? getPrisma();

  return betterAuth({
    database: prismaAdapter(authDatabase, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !config.allowBootstrapSignUp,
      minPasswordLength: 12,
    },
    secret: config.secret,
    baseURL: config.baseURL,
  });
}

type AuthInstance = ReturnType<typeof createAuth>;
type GetSessionInput = Parameters<AuthInstance["api"]["getSession"]>[0];
type SignUpEmailInput = Parameters<AuthInstance["api"]["signUpEmail"]>[0];

let authInstance: AuthInstance | undefined;

export function getAuth() {
  authInstance ??= createAuth();
  return authInstance;
}

export const auth = {
  handler(request: Request) {
    return getAuth().handler(request);
  },
  api: {
    getSession(input: GetSessionInput) {
      return getAuth().api.getSession(input);
    },
    signUpEmail(input: SignUpEmailInput) {
      return getAuth().api.signUpEmail(input);
    },
  },
};
