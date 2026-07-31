const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface ArtifactCoordinates {
  runId: string;
  name: string;
  uri: string;
}

export class ArtifactUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUriError";
  }
}

function validateIdentifier(
  value: string,
  field: "runId" | "name",
  maximumLength: number,
) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value === "." ||
    value === ".." ||
    !identifierPattern.test(value)
  ) {
    throw new ArtifactUriError(`Invalid artifact ${field}.`);
  }
}

export function createArtifactCoordinates(
  runId: string,
  name: string,
): ArtifactCoordinates {
  validateIdentifier(runId, "runId", 128);
  validateIdentifier(name, "name", 255);
  return {
    runId,
    name,
    uri: `artifact://${runId}/${name}`,
  };
}

export function parseArtifactUri(uri: string): ArtifactCoordinates {
  if (
    typeof uri !== "string" ||
    uri.length > 512 ||
    uri.includes("\0") ||
    uri.includes("%") ||
    uri.includes("\\") ||
    uri.includes("?") ||
    uri.includes("#")
  ) {
    throw new ArtifactUriError("Artifact URI is not canonical.");
  }
  const match = /^artifact:\/\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match) {
    throw new ArtifactUriError("Artifact URI is not canonical.");
  }
  const parsed = createArtifactCoordinates(match[1], match[2]);
  if (parsed.uri !== uri) {
    throw new ArtifactUriError("Artifact URI is not canonical.");
  }
  return parsed;
}
