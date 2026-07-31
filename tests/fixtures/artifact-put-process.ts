import { LocalArtifactStore } from "../../src/lib/artifacts/local-store";

const root = process.env.SGEO_PROCESS_ARTIFACT_ROOT;
const name = process.env.SGEO_PROCESS_ARTIFACT_NAME;
const body = process.env.SGEO_PROCESS_ARTIFACT_BODY;

if (!root || !name || body === undefined) {
  process.exitCode = 1;
} else {
  try {
    await new LocalArtifactStore(root).put(
      "run_process",
      name,
      new TextEncoder().encode(body),
      "application/octet-stream",
    );
  } catch (error) {
    process.exitCode = (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ARTIFACT_CONFLICT"
      )
      ? 2
      : 1;
  }
}
