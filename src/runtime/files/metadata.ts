import fs from "node:fs";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".xml": "application/xml",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export interface ResolvedFileMetadata {
  resolvedPath: string;
  fileName: string;
  mimeType?: string;
  sizeBytes: number;
}

export function detectMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext];
}

export function isWithinDirectory(parentDir: string, targetPath: string): boolean {
  const relativePath = path.relative(path.resolve(parentDir), path.resolve(targetPath));
  return relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath);
}

export function toPackRelativePath(rootDir: string, filePath: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedFile = path.resolve(filePath);
  if (!isWithinDirectory(resolvedRoot, resolvedFile)) {
    throw new Error(`Path is outside the pack root: ${resolvedFile}`);
  }

  return path.relative(resolvedRoot, resolvedFile).split(path.sep).join("/");
}

export function resolvePackFile(
  rootDir: string,
  filePath: string,
): ResolvedFileMetadata {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`filePath must be absolute: ${filePath}`);
  }

  const resolvedPath = path.resolve(filePath);
  if (!isWithinDirectory(rootDir, resolvedPath)) {
    throw new Error(`File is outside the pack root: ${resolvedPath}`);
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Path is not a file: ${resolvedPath}`);
  }

  fs.accessSync(resolvedPath, fs.constants.R_OK);

  return {
    resolvedPath,
    fileName: path.basename(resolvedPath),
    mimeType: detectMimeType(resolvedPath),
    sizeBytes: stats.size,
  };
}
