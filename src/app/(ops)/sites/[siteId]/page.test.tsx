import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  notFound: vi.fn(),
  requireAccessScope: vi.fn(),
  getSite: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("@/lib/authorization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization")>()),
  requireAccessScope: mocks.requireAccessScope,
}));
vi.mock("@/lib/organization/repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organization/repository")>()),
  organizationRepository: { getSite: mocks.getSite },
}));

describe("site overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.headers.mockResolvedValue(new Headers());
    mocks.requireAccessScope.mockResolvedValue({
      actorId: "viewer_a",
      workspaceId: "workspace_internal",
      role: "Viewer",
      clientIds: ["client_a"],
    });
    mocks.getSite.mockResolvedValue({
      id: "site_a",
      name: "Site A",
      canonicalHost: "site-a.example.com",
      hostingMode: "hosted",
      allowedPublishPaths: ["/guides"],
    });
  });

  it("links every owned site to its SEO workspace", async () => {
    const { default: SiteOverviewPage } = await import("./page");
    const markup = renderToStaticMarkup(await SiteOverviewPage({
      params: Promise.resolve({ siteId: "site_a" }),
    }));

    expect(markup).toContain('href="/sites/site_a/seo"');
    expect(markup).toContain("Open SEO workspace");
  });
});
