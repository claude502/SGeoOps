import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TxpuroSitePage } from "@/components/txpuro-site";
import { resolvePublicRoute } from "@/lib/site-context";
import { getTxpuroPublicAsset, txpuroCompanyLabel, txpuroSiteLabel } from "@/lib/txpuro";

type PageProps = {
  params: Promise<{ slug?: string[] }>;
};

function guidePath(slug: string[] | undefined) {
  return slug?.length ? `/guides/${slug.join("/")}` : "/guides";
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const host = (await headers()).get("host");
  const { slug } = await params;
  const route = await resolvePublicRoute(host, guidePath(slug));
  if (!route || route.siteId !== "site_txpuro_com") {
    return {};
  }

  const asset = await getTxpuroPublicAsset(
    route.siteId,
    route.slug,
    route.locale,
  );
  if (!asset) {
    return {};
  }

  return {
    title: asset.seoTitle || asset.title,
    description: asset.metaDescription || asset.summary,
    alternates: {
      canonical: asset.canonicalUrl,
    },
    openGraph: {
      title: asset.seoTitle || asset.title,
      description: asset.metaDescription || asset.summary,
      url: asset.canonicalUrl,
      siteName: txpuroSiteLabel(route.locale),
      type: "article",
    },
    other: {
      "application-name": txpuroSiteLabel(route.locale),
      "txpuro-company": txpuroCompanyLabel(route.locale),
    },
  };
}

export default async function TxpuroGuidesPage({ params }: PageProps) {
  const host = (await headers()).get("host");
  const { slug } = await params;
  const route = await resolvePublicRoute(host, guidePath(slug));
  if (!route || route.siteId !== "site_txpuro_com") {
    notFound();
  }

  const asset = await getTxpuroPublicAsset(
    route.siteId,
    route.slug,
    route.locale,
  );
  if (!asset) {
    notFound();
  }

  return <TxpuroSitePage asset={asset} locale={route.locale} />;
}
