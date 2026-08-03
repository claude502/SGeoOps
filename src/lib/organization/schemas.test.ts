import { describe, expect, it } from "vitest";

import {
  createBrandSchema,
  createClientSchema,
  createIntegrationSchema,
  createSiteMarketSchema,
  createSiteSchema,
  pathIdSchema,
} from "@/lib/organization/schemas";

describe("organization schemas", () => {
  it("normalizes names, slugs, hosts, and string arrays", () => {
    expect(
      createSiteSchema.parse({
        name: "  Docs  ",
        canonicalHost: "DOCS.Example.COM.",
        originHosts: [" origin.example.com:443 ", "ORIGIN.EXAMPLE.COM"],
        siteType: " content ",
        hostingMode: " hosted ",
        canonicalRules: { https: true },
        allowedPublishPaths: [" /guides ", "/guides", "/answers"],
      }),
    ).toEqual({
      name: "Docs",
      canonicalHost: "docs.example.com",
      originHosts: ["origin.example.com"],
      siteType: "content",
      hostingMode: "hosted",
      canonicalRules: { https: true },
      allowedPublishPaths: ["/guides", "/answers"],
      active: true,
    });
  });

  it("rejects unknown keys and dangerous host or path input", () => {
    expect(
      createClientSchema.safeParse({
        name: "Client",
        slug: "client",
        workspaceId: "workspace_attacker",
      }).success,
    ).toBe(false);
    expect(
      createClientSchema.safeParse({
        name: "Client\nInjected",
        slug: "client",
      }).success,
    ).toBe(false);
    expect(
      createSiteSchema.safeParse({
        name: "Site",
        canonicalHost: "https://example.com/path",
        originHosts: [],
        siteType: "content",
        hostingMode: "hosted",
        canonicalRules: {},
        allowedPublishPaths: ["../admin"],
      }).success,
    ).toBe(false);
    for (const allowedPublishPaths of [
      ["/guides/%2e%2e/admin"],
      ["/guides\\..\\admin"],
      ["/guides/\u0000admin"],
    ]) {
      expect(
        createSiteSchema.safeParse({
          name: "Site",
          canonicalHost: "example.com",
          originHosts: [],
          siteType: "content",
          hostingMode: "hosted",
          canonicalRules: {},
          allowedPublishPaths,
        }).success,
      ).toBe(false);
    }
  });

  it("requires and normalizes Prisma-backed fields", () => {
    expect(
      createBrandSchema.parse({
        name: " Brand ",
        slug: "Brand-One",
      }),
    ).toEqual({
      name: "Brand",
      slug: "brand-one",
      aliases: [],
      products: null,
      industry: null,
      goals: null,
      riskCategory: "standard",
    });

    expect(
      createSiteMarketSchema.parse({
        country: "my",
        locale: "en-my",
        timezone: " Asia/Kuala_Lumpur ",
      }),
    ).toEqual({
      country: "MY",
      locale: "en-MY",
      defaultDevice: "desktop",
      timezone: "Asia/Kuala_Lumpur",
      settings: null,
    });
  });

  it("does not allow a request body to supply path ownership IDs", () => {
    expect(
      createBrandSchema.safeParse({
        clientId: "client_b",
        name: "Brand",
        slug: "brand",
      }).success,
    ).toBe(false);
    expect(
      createIntegrationSchema.safeParse({
        siteId: "site_b",
        type: "wordpress",
        capabilities: ["publish"],
        adapterVersion: "1.0.0",
      }).success,
    ).toBe(false);
  });

  it.each([
    "file:../token",
    "file:/absolute/token",
    "file:nested/../../token",
    "file:nested\\token",
  ])("rejects unsafe integration secret references: %s", (secretRef) => {
    expect(
      createIntegrationSchema.safeParse({
        type: "wordpress",
        capabilities: ["publish"],
        adapterVersion: "1.0.0",
        secretRef,
      }).success,
    ).toBe(false);
  });

  it("rejects credentials embedded in an integration endpoint", () => {
    expect(
      createIntegrationSchema.safeParse({
        type: "wordpress",
        endpoint: "https://admin:secret@cms.example.com",
        capabilities: ["publish"],
        adapterVersion: "1.0.0",
      }).success,
    ).toBe(false);
  });

  it.each([
    "sc-domain:shop.example",
    "https://shop.example/search-console/",
  ])("accepts strict Search Console property endpoint %s", (endpoint) => {
    expect(createIntegrationSchema.parse({
      type: "search_console",
      endpoint,
      capabilities: ["search_analytics"],
      adapterVersion: "1.0.0",
      secretRef: "file:google/search-console",
    }).endpoint).toBe(endpoint);
  });

  it("keeps non-Search Console integration endpoints restricted to HTTP(S)", () => {
    expect(createIntegrationSchema.safeParse({
      type: "wordpress",
      endpoint: "sc-domain:shop.example",
      capabilities: ["publish"],
      adapterVersion: "1.0.0",
    }).success).toBe(false);
  });

  it.each([
    "sc-domain:localhost",
    "sc-domain:-shop.example",
    "https://user:password@shop.example/",
    "https://shop.example/?credential=value",
    "https://shop.example/#credential",
    "ftp://shop.example/",
  ])("rejects unsafe Search Console property endpoint %s", (endpoint) => {
    expect(createIntegrationSchema.safeParse({
      type: "search_console",
      endpoint,
      capabilities: ["search_analytics"],
      adapterVersion: "1.0.0",
      secretRef: "file:google/search-console",
    }).success).toBe(false);
  });

  it.each(["../client", "client/a", "client?a", "client\u0000a"])(
    "rejects unsafe path IDs: %s",
    (id) => {
      expect(pathIdSchema.safeParse(id).success).toBe(false);
    },
  );
});
