import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GeoDashboard } from "./geo-dashboard";

describe("GeoDashboard navigation", () => {
  it("exposes the Txpuro SEO workspace without changing the local panel navigation", () => {
    const markup = renderToStaticMarkup(<GeoDashboard initialSnapshot={{
      project: {
        id: "txpuro",
        name: "Txpuro",
        brand: "Txpuro",
        product: "Payments",
        locale: "en",
        competitors: [],
        targetKeywords: [],
        canonicalDomain: "txpuro.com",
      },
      assets: [],
      variants: [],
      runs: [],
      providerHealth: [],
      geoFlowLinks: [],
      auditEvents: [],
    }} />);

    expect(markup).toContain('href="/sites/site_txpuro_com/seo"');
    expect(markup).toContain("SEO workspace");
    expect(markup).toContain('aria-label="总览 / Overview"');
  });
});
