import { NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/lib/prisma";

const schema = z.object({
  status: z.enum(["approved", "rejected"]),
});

async function emitTrendApproved(topic: {
  id: string;
  keyword: string;
  platform: string;
}) {
  const apiUrl = process.env.TRIGGER_API_URL;
  const apiKey = process.env.TRIGGER_WORKER_API_KEY;
  const projectRef = process.env.TRIGGER_PROJECT_REF ?? "proj_geo_ops";

  if (!apiUrl || !apiKey) {
    return {
      ok: false,
      error: "Trigger.dev event delivery is not configured.",
    };
  }

  try {
    const response = await fetch(`${apiUrl}/api/v1/${projectRef}/events`, {
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

    if (!response.ok) {
      const body = await response.text().catch(() => "(no body)");
      return {
        ok: false,
        error: `Trigger.dev returned ${response.status}: ${body}`,
      };
    }

    return { ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown event delivery error";
    console.error("[trends/status] Failed to emit trend.approved event:", err);
    return {
      ok: false,
      error: detail,
    };
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

  if (parsed.data.status === "approved") {
    const delivery = await emitTrendApproved({
      id: existingTopic.id,
      keyword: existingTopic.keyword,
      platform: existingTopic.platform,
    });

    if (!delivery.ok) {
      return NextResponse.json(
        {
          error: "Failed to queue trend approval event.",
          detail: delivery.error,
        },
        { status: 502 },
      );
    }
  }

  const topic = await db.trendTopic.update({
    where: { id },
    data: { status: parsed.data.status },
  });

  return NextResponse.json(topic);
}
