import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/prisma";

const schema = z.object({
  impressions: z.number().int().min(0),
  clicks: z.number().int().min(0),
  shares: z.number().int().min(0),
  recordedAt: z.string().datetime().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const variant = await db.channelVariant.findUnique({ where: { id } });
  if (!variant) {
    return NextResponse.json({ error: "Variant not found" }, { status: 404 });
  }

  const metric = await db.variantMetric.create({
    data: {
      channelVariantId: id,
      ...parsed.data,
      recordedAt: parsed.data.recordedAt ? new Date(parsed.data.recordedAt) : new Date(),
    },
  });

  return NextResponse.json(metric, { status: 201 });
}
