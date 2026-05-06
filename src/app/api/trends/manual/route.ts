import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/prisma";

const schema = z.object({
  keyword: z.string().min(1).max(200),
  platform: z.enum(["weibo", "google", "tiktok", "xiaohongshu", "linkedin", "reddit", "x", "manual"]),
  score: z.number().int().min(0).max(100).default(50),
  region: z.enum(["CN", "MY", "SG", "GLOBAL"]).default("CN"),
  expiresAt: z.string().datetime().optional(),
});

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const topic = await db.trendTopic.create({
    data: {
      ...parsed.data,
      sourceType: "manual",
      capturedAt: new Date(),
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
    },
  });

  return NextResponse.json(topic, { status: 201 });
}
