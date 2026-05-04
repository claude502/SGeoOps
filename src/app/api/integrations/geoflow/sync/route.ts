import { NextResponse } from "next/server";
import { createGeoFlowBridgeService, integrationErrorResponse } from "@/lib/geoflow/server";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await createGeoFlowBridgeService().sync();
    return NextResponse.json(result);
  } catch (error) {
    const response = integrationErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
