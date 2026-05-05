import { NextResponse } from "next/server";
import { recordAuditEvent } from "@/lib/audit-log";
import { initializeTxpuroWorkspace } from "@/lib/txpuro";

export async function POST(request: Request) {
  try {
    const result = await initializeTxpuroWorkspace();
    await recordAuditEvent({
      request,
      action: "workspace.txpuro.init",
      entityType: "Workspace",
      entityId: result.project.id,
      outcome: "success",
      metadata: {
        promptCount: result.prompts.length,
        assetCount: result.assets.length,
      },
    });

    return NextResponse.json({
      project: result.project,
      prompts: result.prompts,
      assets: result.assets,
    });
  } catch (error) {
    await recordAuditEvent({
      request,
      action: "workspace.txpuro.init",
      entityType: "Workspace",
      entityId: "proj_txpuro_workspace",
      outcome: "failure",
      metadata: {
        reason: error instanceof Error ? error.message : "unknown_error",
      },
    });
    return NextResponse.json({ error: "Txpuro workspace initialization failed." }, { status: 500 });
  }
}
