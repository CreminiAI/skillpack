export interface FinalArtifactDeclaration {
  filePath: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  title?: string;
  isPrimary: boolean;
}

export interface SnapshotArtifactRecord {
  declaredAt: string;
  originalPath: string;
  snapshotPath: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  title?: string;
  isPrimary: boolean;
}

export interface ResultArtifactRecord {
  artifactId: string;
  runId: string;
  channelId: string;
  originalPath: string;
  snapshotPath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  title: string | null;
  isPrimary: boolean;
  declaredAt: string;
}

export interface ListArtifactsOptions {
  channelId?: string;
  limit?: number;
  offset?: number;
}
