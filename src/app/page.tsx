import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { GeoDashboard } from "@/components/geo-dashboard";
import { TxpuroSitePage } from "@/components/txpuro-site";
import { getRuntimeDashboardSnapshot } from "@/lib/dashboard-snapshot";
import { isTxpuroHost } from "@/lib/site-context";
import { getTxpuroPublicAsset } from "@/lib/txpuro";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const host = (await headers()).get("host");
  if (!isTxpuroHost(host)) {
    return {};
  }
  const asset = await getTxpuroPublicAsset("home", "zh-CN");
  if (!asset) {
    return {};
  }
  return {
    title: asset.seoTitle || asset.title,
    description: asset.metaDescription || asset.summary,
    alternates: { canonical: asset.canonicalUrl },
  };
}

export default async function Home() {
  const host = (await headers()).get("host");
  if (isTxpuroHost(host)) {
    const asset = await getTxpuroPublicAsset("home", "zh-CN");
    if (!asset) {
      notFound();
    }
    return <TxpuroSitePage asset={asset} locale="zh-CN" />;
  }

  return <GeoDashboard initialSnapshot={await getRuntimeDashboardSnapshot()} />;
}
