import { createServer } from "node:http";

const port = 8080;

function page({ title, canonical, body, structuredData = false }) {
  const titleTag = title === null ? "" : `<title>${title}</title>`;
  const canonicalTag = canonical === null
    ? ""
    : `<link rel="canonical" href="${canonical}">`;
  const jsonLd = structuredData
    ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture"}</script>'
    : "";
  return `<!doctype html><html lang="en"><head>${titleTag}${canonicalTag}${jsonLd}</head><body>${body}</body></html>`;
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
  const write = (status, body) => {
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    response.end(body);
  };

  if (path === "/healthz") return write(200, "ok");
  if (path === "/") {
    return write(200, page({
      title: "Healthy indexable page",
      canonical: "/",
      body: '<h1>Healthy indexable page</h1><a href="/missing">Broken fixture link</a>',
    }));
  }
  if (path === "/canonical") {
    return write(200, page({
      title: "Canonical mismatch",
      canonical: "https://incorrect.example/canonical",
      body: "<h1>Canonical mismatch</h1>",
    }));
  }
  if (path === "/missing-title") {
    return write(200, page({
      title: null,
      canonical: "/missing-title",
      body: "<h1>Page without a title</h1>",
    }));
  }
  if (path === "/structured") {
    return write(200, page({
      title: "Structured data page",
      canonical: "/structured",
      structuredData: true,
      body: "<h1>Structured data page</h1>",
    }));
  }
  if (path === "/slow") {
    return setTimeout(() => write(200, page({
      title: "Slow template",
      canonical: "/slow",
      body: "<h1>Intentionally slow template</h1>",
    })), 1_000);
  }
  return write(404, page({ title: "Missing", canonical: null, body: "Not found" }));
});

server.listen(port, "0.0.0.0");
