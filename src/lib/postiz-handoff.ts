import type { ChannelVariant } from "@/types/geo";

export interface PostizHandoffResult {
  status: "queued" | "not-configured";
  message: string;
  variants: ChannelVariant[];
}

export async function handoffVariantsToPostiz(
  variants: ChannelVariant[],
): Promise<PostizHandoffResult> {
  const webhookUrl = process.env.POSTIZ_WEBHOOK_URL;

  if (!webhookUrl) {
    return {
      status: "not-configured",
      message:
        "POSTIZ_WEBHOOK_URL is not configured, so variants were saved in the local review queue.",
      variants,
    };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.POSTIZ_API_KEY ? { authorization: `Bearer ${process.env.POSTIZ_API_KEY}` } : {}),
    },
    body: JSON.stringify({ variants }),
  });

  if (!response.ok) {
    throw new Error(`Postiz handoff failed with ${response.status}`);
  }

  return {
    status: "queued",
    message: "Variants were handed off to the Postiz publishing queue.",
    variants,
  };
}
