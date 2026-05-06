import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/prisma";

const schema = z.object({
  status: z.enum(["approved", "rejected"]),
});

/**
 * Fire a `trend.approved` event to Trigger.dev via HTTP so the
 * geo-worker's content-generate job picks it up automatically.
 * Non-blocking: if Trigger.dev is unavailable we log and continue.
 */
async function emitTrendApproved(topic: {
  id: string;
  keyword: string;
  platform: string;
}) {
  const apiUrl = process.env.TRIGGER_API_URL;
  const apiKey = process.env.TRIGGER_WORKER_API_KEY;
  const projectRef = process.env.TRIGGER_PROJECT_REF ?? "proj_geo_ops";

  if (!apiUrl || !apiKey) return; // Trigger.dev not configured — skip silently

  try {
    await fetch(`${apiUrl}/api/v1/${projectRef}/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        name: "trend.approved",
        payload: {
          topicId: topic.id,
          keyword: topic.keyword,
          platform: topic.platform,
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    // Non-fatal: log and continue — content generation can be re-triggered manually
    console.error("[trends/status] Failed to emit trend.approved event:", err);
  }
}

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

  // Fire content-generate job when a topic is approved
  if (parsed.data.status === "approved") {
    void emitTrendApproved({
      id: topic.id,
      keyword: topic.keyword,
      platform: topic.platform,
    });
  }

  return NextResponse.json(topic);
}
