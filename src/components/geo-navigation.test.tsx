import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar } from "@/components/geo-dashboard";
import {
  LOCAL_PANEL_NAV_ITEMS,
  OPERATIONS_NAV_ITEMS,
} from "@/components/geo-navigation";

describe("GEO dashboard navigation", () => {
  it("preserves all five local panel controls", () => {
    expect(LOCAL_PANEL_NAV_ITEMS.map((item) => item.id)).toEqual([
      "overview",
      "assets",
      "runs",
      "channels",
      "settings",
    ]);
  });

  it("provides a distinct route to client operations", () => {
    expect(OPERATIONS_NAV_ITEMS).toEqual([
      expect.objectContaining({
        href: "/clients",
        label: "客户 / Clients",
      }),
    ]);
  });

  it("renders five panel buttons and a Next route link to clients", () => {
    const markup = renderToStaticMarkup(
      <Sidebar activeSection="overview" onSelect={() => undefined} />,
    );

    expect(markup.match(/<button/g)).toHaveLength(5);
    expect(markup).toContain('<a aria-label="客户 / Clients"');
    expect(markup).toContain('href="/clients"');
  });
});
