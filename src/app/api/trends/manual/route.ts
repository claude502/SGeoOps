import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAccessScope, requireRole } from "@/lib/authorization";
import { businessRouteError } from "@/lib/business/http";
import { PrismaBusinessRepository } from "@/lib/business/repository";

const schema = z.object({
  siteId: z.string().min(1),
  keyword: z.string().min(1).max(200),
  platform: z.enum(["weibo", "google", "tiktok", "xiaohongshu", "linkedin", "reddit", "x", "manual"]),
  score: z.number().int().min(0).max(100).default(50),
  region: z.enum(["CN", "MY", "SG", "GLOBAL"]).default("CN"),
  expiresAt: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  try {
    const scope = await requireAccessScope(request);
    requireRole(scope, ["Admin", "Operator"]);
    const parsed = schema.safeParse(
      await request.json().catch(() => null),
    );

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { siteId, ...input } = parsed.data;
    const topic = await new PrismaBusinessRepository().createTrendTopic(
      scope,
      siteId,
      input,
      request,
    );

    return NextResponse.json(topic, { status: 201 });
  } catch (error) {
    return businessRouteError(error);
  }
}
