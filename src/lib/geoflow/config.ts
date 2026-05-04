export interface GeoFlowConfig {
  baseUrl: string;
  apiToken: string;
  publicBaseUrl: string | null;
  titleLibraryId: number;
  promptId: number;
  aiModelId: number;
  authorId: number | null;
  knowledgeBaseId: number | null;
  fixedCategoryId: number | null;
}

export interface GeoFlowConfigResult {
  ok: boolean;
  missing: string[];
  config: GeoFlowConfig | null;
}

function parseRequiredInt(env: Partial<NodeJS.ProcessEnv>, key: string, missing: string[]) {
  const raw = env[key]?.trim();
  if (!raw) {
    missing.push(key);
    return 0;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    missing.push(key);
    return 0;
  }

  return parsed;
}

function parseOptionalInt(env: Partial<NodeJS.ProcessEnv>, key: string) {
  const raw = env[key]?.trim();
  if (!raw) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function readGeoFlowConfig(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): GeoFlowConfigResult {
  const missing: string[] = [];
  const baseUrl = env.GEOFLOW_BASE_URL?.trim();
  const apiToken = env.GEOFLOW_API_TOKEN?.trim();

  if (!baseUrl) {
    missing.push("GEOFLOW_BASE_URL");
  }
  if (!apiToken) {
    missing.push("GEOFLOW_API_TOKEN");
  }

  const titleLibraryId = parseRequiredInt(env, "GEOFLOW_TITLE_LIBRARY_ID", missing);
  const promptId = parseRequiredInt(env, "GEOFLOW_PROMPT_ID", missing);
  const aiModelId = parseRequiredInt(env, "GEOFLOW_AI_MODEL_ID", missing);

  if (missing.length > 0 || !baseUrl || !apiToken) {
    return { ok: false, missing: Array.from(new Set(missing)), config: null };
  }

  return {
    ok: true,
    missing: [],
    config: {
      baseUrl: trimTrailingSlash(baseUrl),
      apiToken,
      publicBaseUrl: env.GEOFLOW_PUBLIC_BASE_URL?.trim()
        ? trimTrailingSlash(env.GEOFLOW_PUBLIC_BASE_URL.trim())
        : null,
      titleLibraryId,
      promptId,
      aiModelId,
      authorId: parseOptionalInt(env, "GEOFLOW_AUTHOR_ID"),
      knowledgeBaseId: parseOptionalInt(env, "GEOFLOW_KNOWLEDGE_BASE_ID"),
      fixedCategoryId: parseOptionalInt(env, "GEOFLOW_FIXED_CATEGORY_ID"),
    },
  };
}
