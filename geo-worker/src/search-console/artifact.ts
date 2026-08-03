export const SEARCH_CONSOLE_ARTIFACT_MAGIC = new TextEncoder().encode("SGEOSC1\n");
export const SEARCH_CONSOLE_ARTIFACT_PAGE_HEADER_BYTES = 8;
export const SEARCH_CONSOLE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const SEARCH_CONSOLE_ARTIFACT_MAX_PAGES = 4;

export type SearchConsoleArtifactPage = {
  startRow: number;
  rawBytes: Uint8Array;
};

export class SearchConsoleArtifactCapacityError extends Error {
  constructor() {
    super("Search Console artifact exceeds its byte limit.");
    this.name = "SearchConsoleArtifactCapacityError";
  }
}

export function searchConsoleResponseByteBudget(maximumArtifactBytes: number, maximumPages: number) {
  const framingBytes = SEARCH_CONSOLE_ARTIFACT_MAGIC.byteLength +
    maximumPages * SEARCH_CONSOLE_ARTIFACT_PAGE_HEADER_BYTES;
  return Math.floor((maximumArtifactBytes - framingBytes) / maximumPages);
}

export const SEARCH_CONSOLE_PROVIDER_RESPONSE_MAX_BYTES = searchConsoleResponseByteBudget(
  SEARCH_CONSOLE_ARTIFACT_MAX_BYTES,
  SEARCH_CONSOLE_ARTIFACT_MAX_PAGES,
);

export function encodeSearchConsoleArtifact(
  pages: readonly SearchConsoleArtifactPage[],
  maximumBytes: number,
) {
  let byteLength = SEARCH_CONSOLE_ARTIFACT_MAGIC.byteLength;
  for (const page of pages) {
    if (
      !Number.isInteger(page.startRow) || page.startRow < 0 || page.startRow > 0xffff_ffff ||
      !(page.rawBytes instanceof Uint8Array) || page.rawBytes.byteLength > 0xffff_ffff
    ) {
      throw new SearchConsoleArtifactCapacityError();
    }
    byteLength += SEARCH_CONSOLE_ARTIFACT_PAGE_HEADER_BYTES + page.rawBytes.byteLength;
    if (byteLength > maximumBytes) throw new SearchConsoleArtifactCapacityError();
  }

  const artifact = new Uint8Array(byteLength);
  artifact.set(SEARCH_CONSOLE_ARTIFACT_MAGIC, 0);
  let offset = SEARCH_CONSOLE_ARTIFACT_MAGIC.byteLength;
  for (const page of pages) {
    const header = new DataView(artifact.buffer, offset, SEARCH_CONSOLE_ARTIFACT_PAGE_HEADER_BYTES);
    header.setUint32(0, page.startRow, false);
    header.setUint32(4, page.rawBytes.byteLength, false);
    offset += SEARCH_CONSOLE_ARTIFACT_PAGE_HEADER_BYTES;
    artifact.set(page.rawBytes, offset);
    offset += page.rawBytes.byteLength;
  }
  return artifact;
}
