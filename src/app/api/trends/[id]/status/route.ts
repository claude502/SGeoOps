import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/prisma";

const schema = z.object({
  status: z.enum(["approved", "rejected"]),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const existingTopic = await db.trendTopic.findUnique({ where: { id } });
  if (!existingTopic) {
    return NextResponse.json({ error: "Trend topic not found" }, { status: 404 });
  }

  const topic = await db.trendTopic.update({
    where: { id },
    data: { status: parsed.data.status },
  });

  return NextResponse.json(topic);
}
