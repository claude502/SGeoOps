import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { resolvePublicSite } from "@/lib/site-context";

export async function GET() {
  const host = (await headers()).get("host");
  const site = await resolvePublicSite(host).catch(() => null);
  if (!site || site.siteId !== "site_txpuro_com") {
    return new NextResponse("User-agent: *\nDisallow: /\n", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new NextResponse(
    `User-agent: *\nAllow: /guides/\nSitemap: https://${site.canonicalHost}/sitemap-guides.xml\n`,
    {
      headers: { "content-type": "text/plain; charset=utf-8" },
    },
  );
}
