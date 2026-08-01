export interface StoredArtifact {
  uri: string;
  checksum: string;
  mediaType: string;
  byteSize: number;
}

/** A private, not-yet-published artifact upload. */
export interface ArtifactUpload {
  write(chunk: Uint8Array): Promise<void>;
  commit(expected: StoredArtifact): Promise<StoredArtifact>;
  abort(): Promise<void>;
}

export interface ArtifactStore {
  put(
    runId: string,
    name: string,
    body: Uint8Array,
    mediaType: string,
  ): Promise<StoredArtifact>;
  beginUpload(
    runId: string,
    name: string,
    mediaType: string,
    maximumByteSize: number,
  ): Promise<ArtifactUpload>;
  getMetadata(uri: string): Promise<StoredArtifact>;
  get(uri: string): Promise<Uint8Array>;
}
