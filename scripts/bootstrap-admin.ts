import { pathToFileURL } from "node:url";

type BootstrapEnvironment = Record<string, string | undefined>;

export type BootstrapAdminInput = {
  email: string;
  name: string;
  password: string;
};

export type BootstrapTransaction = {
  countUsers(): Promise<number>;
  findInternalWorkspace(): Promise<{ id: string } | null>;
  signUpEmail(
    input: BootstrapAdminInput,
  ): Promise<{ user: { id: string } }>;
  createMembership(input: {
    workspaceId: string;
    userId: string;
    role: "Admin";
  }): Promise<unknown>;
};

export type BootstrapDependencies = {
  transaction<T>(
    operation: (transaction: BootstrapTransaction) => Promise<T>,
  ): Promise<T>;
};

export function readBootstrapAdminInput(
  env: BootstrapEnvironment = process.env,
): BootstrapAdminInput {
  const email = env.SGEO_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const name = env.SGEO_BOOTSTRAP_ADMIN_NAME?.trim();
  const password = env.SGEO_BOOTSTRAP_ADMIN_PASSWORD;

  if (!email || !name || !password?.trim()) {
    throw new Error("BOOTSTRAP_ENV_REQUIRED");
  }

  return { email, name, password };
}

export async function bootstrapAdmin(
  input: BootstrapAdminInput,
  dependencies: BootstrapDependencies,
) {
  return dependencies.transaction(async (transaction) => {
    if ((await transaction.countUsers()) > 0) {
      throw new Error("BOOTSTRAP_ALREADY_COMPLETED");
    }

    const workspace = await transaction.findInternalWorkspace();
    if (!workspace) {
      throw new Error("BOOTSTRAP_WORKSPACE_REQUIRED");
    }

    const created = await transaction.signUpEmail(input);
    await transaction.createMembership({
      workspaceId: workspace.id,
      userId: created.user.id,
      role: "Admin",
    });

    return { userId: created.user.id };
  });
}

async function main() {
  process.env.SGEO_ALLOW_BOOTSTRAP_SIGNUP = "true";
  const input = readBootstrapAdminInput();
  const [{ createAuth }, { getPrisma }] = await Promise.all([
    import("../src/lib/auth"),
    import("../src/lib/prisma"),
  ]);
  const prisma = getPrisma();

  await bootstrapAdmin(input, {
    transaction: (operation) =>
      prisma.$transaction(async (database) =>
        operation({
          countUsers: () => database.user.count(),
          findInternalWorkspace: () =>
            database.workspace.findUnique({
              where: { id: "workspace_internal" },
              select: { id: true },
            }),
          signUpEmail: (body) =>
            createAuth(database).api.signUpEmail({ body }),
          createMembership: (data) =>
            database.workspaceMember.create({ data }),
        }),
      ),
  });
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint && import.meta.url === pathToFileURL(entrypoint).href,
  );
}

if (isDirectExecution()) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "BOOTSTRAP_FAILED");
    process.exitCode = 1;
  });
}
