import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { TxpuroSitePage } from "@/components/txpuro-site";
import { isTxpuroHost, normalizeLocaleFromGuidesSlug } from "@/lib/site-context";
import { getTxpuroPublicAsset, txpuroCompanyLabel, txpuroSiteLabel } from "@/lib/txpuro";

type PageProps = {
  params: Promise<{ slug?: string[] }>;
};

function slugKey(segments: string[]) {
  return segments.length ? segments.join("/") : "home";
}

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const host = (await headers()).get("host");
  if (!isTxpuroHost(host)) {
    return {};
  }

  const { slug } = await params;
  const { locale, pathSegments } = normalizeLocaleFromGuidesSlug(slug);
  const asset = await getTxpuroPublicAsset(slugKey(pathSegments), locale);
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
      siteName: txpuroSiteLabel(locale),
      type: "article",
    },
    other: {
      "application-name": txpuroSiteLabel(locale),
      "txpuro-company": txpuroCompanyLabel(locale),
    },
  };
}

export default async function TxpuroGuidesPage({ params }: PageProps) {
  const host = (await headers()).get("host");
  if (!isTxpuroHost(host)) {
    notFound();
  }

  const { slug } = await params;
  const { locale, pathSegments } = normalizeLocaleFromGuidesSlug(slug);
  const asset = await getTxpuroPublicAsset(slugKey(pathSegments), locale);
  if (!asset) {
    notFound();
  }

  return <TxpuroSitePage asset={asset} locale={locale} />;
}
