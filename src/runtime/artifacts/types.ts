export type RunStatus = "running" | "completed" | "error" | "aborted";

export interface FinalArtifactDeclaration {
  filePath: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  title?: string;
  description?: string;
  isPrimary: boolean;
}

export interface ArtifactDeclarationBatch {
  declarationSeq: number;
  declaredAt: string;
  artifacts: FinalArtifactDeclaration[];
}

export interface SnapshotArtifactRecord {
  declarationSeq: number;
  artifactOrder: number;
  declaredAt: string;
  originalPath: string;
  snapshotPath: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
  title?: string;
  description?: string;
  isPrimary: boolean;
}

export interface ResultRunRecord {
  runId: string;
  channelId: string;
  userText: string;
  assistantText: string | null;
  status: RunStatus;
  stopReason: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface ResultArtifactRecord {
  artifactId: string;
  runId: string;
  channelId: string;
  declarationSeq: number;
  artifactOrder: number;
  originalPath: string;
  snapshotPath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  title: string | null;
  description: string | null;
  isPrimary: boolean;
  declaredAt: string;
}

export interface ListRunsOptions {
  channelId?: string;
  limit?: number;
}

export interface ListArtifactsOptions {
  channelId?: string;
  limit?: number;
}
