import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { isTxpuroHost } from "@/lib/site-context";
import { listTxpuroPublicAssets } from "@/lib/txpuro";

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export async function GET() {
  const host = (await headers()).get("host");
  if (!isTxpuroHost(host)) {
    return new NextResponse("<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset></urlset>", {
      headers: { "content-type": "application/xml; charset=utf-8" },
    });
  }

  const assets = await listTxpuroPublicAssets();
  const urls = assets
    .filter((asset) => asset.isPublic)
    .map(
      (asset) =>
        `<url><loc>${escapeXml(asset.canonicalUrl)}</loc><lastmod>${escapeXml(
          asset.updatedAt,
        )}</lastmod></url>`,
    )
    .join("");

  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    {
      headers: { "content-type": "application/xml; charset=utf-8" },
    },
  );
}
