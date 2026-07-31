export interface StoredArtifact {
  uri: string;
  checksum: string;
  mediaType: string;
  byteSize: number;
}

export interface ArtifactStore {
  put(
    runId: string,
    name: string,
    body: Uint8Array,
    mediaType: string,
  ): Promise<StoredArtifact>;
  get(uri: string): Promise<Uint8Array>;
}
