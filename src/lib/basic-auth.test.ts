import { describe, expect, it } from "vitest";
import {
  basicAuthChallenge,
  getBasicAuthConfig,
  isBasicAuthAuthorized,
  isBasicAuthConfigured,
  parseBasicAuthorization,
  shouldBypassAuthPath,
  timingSafeStringEqual,
} from "@/lib/basic-auth";

function basic(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

describe("basic auth", () => {
  it("defaults to enabled and reads admin credentials from env", () => {
    const config = getBasicAuthConfig({
      GEO_OPS_ADMIN_USERNAME: " admin ",
      GEO_OPS_ADMIN_PASSWORD: "secret",
      GEO_OPS_AUTH_REALM: " Wingheng GEO Ops ",
    });

    expect(config).toEqual({
      enabled: true,
      username: "admin",
      password: "secret",
      realm: "Wingheng GEO Ops",
    });
    expect(isBasicAuthConfigured(config)).toBe(true);
  });

  it("can be disabled explicitly for local development", () => {
    expect(getBasicAuthConfig({ GEO_OPS_AUTH_ENABLED: "false" }).enabled).toBe(false);
    expect(getBasicAuthConfig({ GEO_OPS_AUTH_ENABLED: "0" }).enabled).toBe(false);
  });

  it("parses valid basic authorization headers", () => {
    expect(parseBasicAuthorization(basic("geoops", "pass:with:colon"))).toEqual({
      username: "geoops",
      password: "pass:with:colon",
    });
  });

  it("rejects missing, malformed, and incorrect credentials", () => {
    const config = getBasicAuthConfig({
      GEO_OPS_ADMIN_USERNAME: "geoops",
      GEO_OPS_ADMIN_PASSWORD: "correct",
    });

    expect(isBasicAuthAuthorized(null, config)).toBe(false);
    expect(isBasicAuthAuthorized("Bearer token", config)).toBe(false);
    expect(isBasicAuthAuthorized("Basic not-base64", config)).toBe(false);
    expect(isBasicAuthAuthorized(basic("geoops", "wrong"), config)).toBe(false);
    expect(isBasicAuthAuthorized(basic("wrong", "correct"), config)).toBe(false);
    expect(isBasicAuthAuthorized(basic("geoops", "correct"), config)).toBe(true);
  });

  it("compares strings without leaking length through early returns", () => {
    expect(timingSafeStringEqual("same", "same")).toBe(true);
    expect(timingSafeStringEqual("same", "diff")).toBe(false);
    expect(timingSafeStringEqual("short", "longer")).toBe(false);
  });

  it("keeps framework assets outside the auth challenge", () => {
    expect(shouldBypassAuthPath("/_next/static/chunk.js")).toBe(true);
    expect(shouldBypassAuthPath("/_next/image/logo.png")).toBe(true);
    expect(shouldBypassAuthPath("/favicon.ico")).toBe(true);
    expect(shouldBypassAuthPath("/api/geo/runs")).toBe(false);
    expect(shouldBypassAuthPath("/")).toBe(false);
  });

  it("builds a safe auth challenge realm", () => {
    expect(basicAuthChallenge('Wingheng "GEO" Ops')).toBe(
      'Basic realm="Wingheng GEO Ops", charset="UTF-8"',
    );
  });
});
