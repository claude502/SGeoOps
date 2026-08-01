import { pathToFileURL } from "node:url";

import { getPrisma } from "../src/lib/prisma";

const INTERNAL_WORKSPACE_ID = "workspace_internal";

type BootstrapStatusRuntime = {
  workspaceMember: {
    count(input: {
      where: { workspaceId: string; role: "Admin" };
    }): Promise<number>;
  };
  $disconnect(): Promise<void>;
};

type BootstrapStatusRuntimeLoader = () => Promise<BootstrapStatusRuntime>;

async function loadBootstrapStatusRuntime(): Promise<BootstrapStatusRuntime> {
  return getPrisma();
}

export async function runBootstrapAdminStatusCli(
  loadRuntime: BootstrapStatusRuntimeLoader = loadBootstrapStatusRuntime,
) {
  const prisma = await loadRuntime();

  try {
    const adminCount = await prisma.workspaceMember.count({
      where: {
        workspaceId: INTERNAL_WORKSPACE_ID,
        role: "Admin",
      },
    });

    if (adminCount < 1) {
      throw new Error("BOOTSTRAP_ADMIN_REQUIRED");
    }

    return { adminCount };
  } finally {
    await prisma.$disconnect();
  }
}

function isDirectExecution() {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint && import.meta.url === pathToFileURL(entrypoint).href,
  );
}

if (isDirectExecution()) {
  await runBootstrapAdminStatusCli().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "BOOTSTRAP_ADMIN_STATUS_FAILED",
    );
    process.exitCode = 1;
  });
}
