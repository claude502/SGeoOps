import { describe, expect, it } from "vitest";
import {
  AuthConfigurationError,
  createAuth,
  readAuthRuntimeConfig,
} from "@/lib/auth";

const configuredEnvironment = {
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "https://geo.example.com",
};

describe("Better Auth runtime configuration", () => {
  it("uses explicit secret and base URL values", () => {
    expect(readAuthRuntimeConfig(configuredEnvironment)).toEqual({
      secret: configuredEnvironment.BETTER_AUTH_SECRET,
      baseURL: configuredEnvironment.BETTER_AUTH_URL,
      allowBootstrapSignUp: false,
    });
  });

  it("opens signup only for the exact bootstrap flag", () => {
    expect(
      readAuthRuntimeConfig({
        ...configuredEnvironment,
        SGEO_ALLOW_BOOTSTRAP_SIGNUP: "true",
      }).allowBootstrapSignUp,
    ).toBe(true);
    expect(
      readAuthRuntimeConfig({
        ...configuredEnvironment,
        SGEO_ALLOW_BOOTSTRAP_SIGNUP: "TRUE",
      }).allowBootstrapSignUp,
    ).toBe(false);
  });

  it("fails closed without a secret or base URL", () => {
    for (const environment of [
      { BETTER_AUTH_URL: "https://geo.example.com" },
      {
        BETTER_AUTH_SECRET: configuredEnvironment.BETTER_AUTH_SECRET,
      },
    ]) {
      try {
        readAuthRuntimeConfig(environment);
        throw new Error("EXPECTED_AUTH_CONFIGURATION_ERROR");
      } catch (error) {
        expect(error).toBeInstanceOf(AuthConfigurationError);
        expect(error).toMatchObject({
          name: "AuthConfigurationError",
          code: "AUTH_CONFIGURATION_REQUIRED",
          message: "AUTH_CONFIGURATION_REQUIRED",
        });
      }
    }
  });

  it("validates auth configuration before acquiring the database", () => {
    expect(() => createAuth(undefined, {})).toThrow(AuthConfigurationError);
  });

  it("fails closed for a short secret or invalid base URL", () => {
    expect(() =>
      readAuthRuntimeConfig({
        ...configuredEnvironment,
        BETTER_AUTH_SECRET: "too-short",
      }),
    ).toThrow("AUTH_CONFIGURATION_REQUIRED");
    expect(() =>
      readAuthRuntimeConfig({
        ...configuredEnvironment,
        BETTER_AUTH_URL: "not-a-url",
      }),
    ).toThrow("AUTH_CONFIGURATION_REQUIRED");
  });
});
