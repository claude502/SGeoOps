import { NextResponse } from "next/server";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { organizationRouteError, readJson } from "@/lib/organization/http";
import { organizationRepository } from "@/lib/organization/repository";
import { createClientSchema } from "@/lib/organization/schemas";

export async function GET(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    const clients = await organizationRepository.listClients(scope);
    return NextResponse.json({ clients });
  } catch (error) {
    return organizationRouteError(error);
  }
}
export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin"]);

    const parsed = createClientSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid client", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const client = await organizationRepository.createClient(
      scope,
      parsed.data,
    );
    return NextResponse.json({ client }, { status: 201 });
  } catch (error) {
    return organizationRouteError(error);
  }
}
