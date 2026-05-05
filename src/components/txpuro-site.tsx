import Link from "next/link";
import { ArrowRight, BadgeCheck, CheckCircle2, ExternalLink, FileText, Globe2, Layers3, ShieldCheck } from "lucide-react";
import type { ContentAsset, ContentLocale } from "@/types/geo";
import { txpuroCompanyLabel, txpuroSiteLabel, txpuroStructuredSections } from "@/lib/txpuro";

function defaultSignupUrl() {
  return process.env.TXPURO_SELF_SIGNUP_URL || "/contact";
}

function defaultDemoUrl() {
  return process.env.TXPURO_DEMO_URL || "/contact";
}

function defaultContactUrl() {
  return process.env.TXPURO_CONTACT_URL || "/contact";
}

function localizedPath(locale: ContentLocale, path: string) {
  if (locale === "en") {
    return path === "/" ? "/en" : `/en${path}`;
  }
  return path;
}

function navItems(locale: ContentLocale) {
  return [
    { href: localizedPath(locale, "/pricing"), label: locale === "en" ? "Pricing" : "价格" },
    { href: localizedPath(locale, "/features"), label: locale === "en" ? "Features" : "功能" },
    { href: localizedPath(locale, "/faq"), label: locale === "en" ? "FAQ" : "常见问题" },
    {
      href: localizedPath(locale, "/guides/what-is-myinvois"),
      label: locale === "en" ? "Guides" : "指南",
    },
    { href: localizedPath(locale, "/contact"), label: locale === "en" ? "Contact" : "联系" },
  ];
}

function sectionLabel(asset: ContentAsset, locale: ContentLocale) {
  if (asset.assetType === "money-page") {
    return locale === "en" ? "Product page" : "产品页";
  }
  if (asset.assetType === "feature-page") {
    return locale === "en" ? "Feature" : "功能页";
  }
  if (asset.assetType === "faq-page") {
    return locale === "en" ? "FAQ" : "FAQ";
  }
  if (asset.assetType === "compare-page") {
    return locale === "en" ? "Comparison" : "对比页";
  }
  return locale === "en" ? "Guide" : "指南页";
}

function featureHighlights(locale: ContentLocale) {
  return locale === "en"
    ? [
        "MyInvois-aligned workflows for operational use",
        "Chinese and English collaboration support",
        "ERP and API integration readiness",
      ]
    : [
        "围绕 MyInvois 业务执行场景设计",
        "支持中文与英文协作流程",
        "适合 ERP 与 API 集成落地",
      ];
}

export function TxpuroSitePage({
  asset,
  locale,
}: {
  asset: ContentAsset;
  locale: ContentLocale;
}) {
  const sections = txpuroStructuredSections(asset.body);
  const signupUrl = defaultSignupUrl();
  const demoUrl = defaultDemoUrl();
  const contactUrl = defaultContactUrl();
  const isEnglish = locale === "en";
  const alternatePath =
    locale === "en"
      ? asset.slug === "home"
        ? "/"
        : `/${asset.slug || ""}`
      : asset.slug === "home"
        ? "/en"
        : `/en/${asset.slug || ""}`;
  const structuredData =
    asset.schemaType === "faq"
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: (asset.faqs || []).map((faq) => ({
            "@type": "Question",
            name: faq.question,
            acceptedAnswer: {
              "@type": "Answer",
              text: faq.answer,
            },
          })),
        }
      : asset.schemaType === "product"
        ? {
            "@context": "https://schema.org",
            "@type": "SoftwareApplication",
            name: txpuroSiteLabel(locale),
            applicationCategory: "BusinessApplication",
            operatingSystem: "Web",
            provider: {
              "@type": "Organization",
              name: txpuroCompanyLabel(locale),
            },
            areaServed: "Malaysia",
            availableLanguage: ["zh-CN", "en"],
            url: asset.canonicalUrl,
            description: asset.metaDescription || asset.summary,
          }
        : {
            "@context": "https://schema.org",
            "@type": "Article",
            headline: asset.title,
            about: txpuroSiteLabel(locale),
            inLanguage: locale,
            url: asset.canonicalUrl,
            author: {
              "@type": "Organization",
              name: txpuroCompanyLabel(locale),
            },
          };

  return (
    <main className="txpuro-shell">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <header className="txpuro-topbar">
        <Link className="txpuro-brand" href={localizedPath(locale, "/")}>
          <span className="txpuro-brand-mark">T</span>
          <div>
            <strong>{txpuroSiteLabel(locale)}</strong>
            <span>{txpuroCompanyLabel(locale)}</span>
          </div>
        </Link>
        <nav className="txpuro-nav" aria-label="Public navigation">
          {navItems(locale).map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="txpuro-nav-actions">
          <Link className="txpuro-link-button" href={alternatePath}>
            <Globe2 size={16} />
            {isEnglish ? "中文" : "EN"}
          </Link>
          <a className="txpuro-primary-link" href={signupUrl} rel="noreferrer" target="_blank">
            {isEnglish ? "Start trial" : "自助试用/注册"}
          </a>
        </div>
      </header>

      <section className="txpuro-hero">
        <div className="txpuro-hero-copy">
          <span className="txpuro-kicker">{sectionLabel(asset, locale)}</span>
          <h1>{asset.title}</h1>
          <p>{asset.summary}</p>
          <div className="txpuro-hero-actions">
            <a className="button button-primary" href={signupUrl} rel="noreferrer" target="_blank">
              <span>{isEnglish ? "Self-signup" : "自助试用/注册"}</span>
              <ArrowRight size={16} />
            </a>
            <a className="button button-secondary" href={demoUrl} rel="noreferrer" target="_blank">
              <span>{isEnglish ? "Book demo" : "预约 Demo"}</span>
            </a>
            <a className="button button-ghost" href={contactUrl} rel="noreferrer" target="_blank">
              <span>{isEnglish ? "Talk to integration team" : "联系集成团队"}</span>
            </a>
          </div>
        </div>
        <aside className="txpuro-hero-card">
          <div>
            <BadgeCheck size={18} />
            <strong>{isEnglish ? "Built for Malaysia e-Invoice" : "面向马来西亚电子发票场景"}</strong>
          </div>
          <ul>
            {featureHighlights(locale).map((item) => (
              <li key={item}>
                <CheckCircle2 size={16} />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <small>{asset.canonicalUrl.replace("https://", "")}</small>
        </aside>
      </section>

      <section className="txpuro-keyword-strip">
        {asset.targetKeywords.map((keyword) => (
          <span key={keyword}>{keyword}</span>
        ))}
      </section>

      <section className="txpuro-section-grid">
        {sections.map((section) => (
          <article className="txpuro-section-card" key={section.title}>
            <h2>{section.title}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </article>
        ))}
      </section>

      <section className="txpuro-proof-grid">
        <article className="txpuro-proof-card">
          <Layers3 size={18} />
          <h3>{isEnglish ? "Audience" : "适用对象"}</h3>
          <p>{asset.audience || (isEnglish ? "Malaysia finance and operations teams" : "马来西亚财务与运营团队")}</p>
        </article>
        <article className="txpuro-proof-card">
          <ShieldCheck size={18} />
          <h3>{isEnglish ? "Entity" : "实体归属"}</h3>
          <p>{txpuroCompanyLabel(locale)}</p>
        </article>
        <article className="txpuro-proof-card">
          <FileText size={18} />
          <h3>{isEnglish ? "Canonical source" : "标准来源"}</h3>
          <p>{asset.canonicalUrl}</p>
        </article>
      </section>

      {asset.faqs?.length ? (
        <section className="txpuro-faq">
          <div className="txpuro-section-heading">
            <span>{isEnglish ? "Common questions" : "常见问题"}</span>
            <h2>{isEnglish ? "FAQ for buyers and operators" : "采购与执行团队高频问题"}</h2>
          </div>
          <div className="txpuro-faq-list">
            {asset.faqs.map((faq) => (
              <article className="txpuro-faq-item" key={faq.question}>
                <h3>{faq.question}</h3>
                <p>{faq.answer}</p>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="txpuro-cta-band">
        <div>
          <span>{isEnglish ? "Ready for the next step?" : "准备进入下一步？"}</span>
          <h2>
            {isEnglish
              ? "Choose the path that matches your rollout stage."
              : "按你的上线阶段，选择最合适的推进方式。"}
          </h2>
        </div>
        <div className="txpuro-cta-actions">
          <a className="button button-primary" href={signupUrl} rel="noreferrer" target="_blank">
            <span>{isEnglish ? "Self-signup" : "自助试用/注册"}</span>
          </a>
          <a className="button button-secondary" href={demoUrl} rel="noreferrer" target="_blank">
            <span>{isEnglish ? "Book demo" : "预约 Demo"}</span>
          </a>
          <a className="button button-ghost" href={contactUrl} rel="noreferrer" target="_blank">
            <span>{isEnglish ? "Contact us" : "联系我们"}</span>
            <ExternalLink size={14} />
          </a>
        </div>
      </section>
    </main>
  );
}
