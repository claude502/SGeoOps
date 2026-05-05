import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { isTxpuroHost, txpuroBaseUrl } from "@/lib/site-context";

export async function GET() {
  const host = (await headers()).get("host");
  if (!isTxpuroHost(host)) {
    return new NextResponse("User-agent: *\nDisallow: /\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new NextResponse(
    `User-agent: *\nAllow: /guides/\nSitemap: ${txpuroBaseUrl()}/sitemap-guides.xml\n`,
    {
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}
