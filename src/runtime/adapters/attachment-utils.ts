import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

import type { ChannelAttachment } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATTACHMENTS_DIR = "attachments";

// ---------------------------------------------------------------------------
// Save helpers
// ---------------------------------------------------------------------------

/**
 * Build the attachment directory for a channel session.
 * Path: data/sessions/<channelId>/attachments/
 */
function getAttachmentDir(rootDir: string, channelId: string): string {
  return path.resolve(rootDir, "data", "sessions", channelId, ATTACHMENTS_DIR);
}

/**
 * Sanitise a filename to remove path separators and other unsafe characters.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").replace(/\s+/g, "_");
}

/**
 * Save a buffer as an attachment file and return a ChannelAttachment descriptor.
 */
export async function saveAttachment(
  rootDir: string,
  channelId: string,
  filename: string,
  buffer: Buffer,
  mimeType?: string,
): Promise<ChannelAttachment> {
  const dir = getAttachmentDir(rootDir, channelId);
  fs.mkdirSync(dir, { recursive: true });

  const ts = Date.now();
  const safeName = sanitizeFilename(filename);
  const storedName = `${ts}-${safeName}`;
  const fullPath = path.join(dir, storedName);

  fs.writeFileSync(fullPath, buffer);

  return {
    filename,
    localPath: fullPath,
    mimeType,
    size: buffer.byteLength,
  };
}

/**
 * Download a file from a URL and save it as an attachment.
 */
export async function downloadAndSaveAttachment(
  rootDir: string,
  channelId: string,
  url: string,
  filename: string,
  mimeType?: string,
  headers?: Record<string, string>,
): Promise<ChannelAttachment> {
  const dir = getAttachmentDir(rootDir, channelId);
  fs.mkdirSync(dir, { recursive: true });

  const ts = Date.now();
  const safeName = sanitizeFilename(filename);
  const storedName = `${ts}-${safeName}`;
  const fullPath = path.join(dir, storedName);

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to download attachment from ${url}: ${response.status} ${response.statusText}`,
    );
  }

  const body = response.body;
  if (!body) {
    throw new Error(`Empty response body when downloading ${url}`);
  }

  const nodeStream = Readable.fromWeb(body as any);
  const writeStream = fs.createWriteStream(fullPath);
  await pipeline(nodeStream, writeStream);

  const stats = fs.statSync(fullPath);
  const detectedMime =
    mimeType || response.headers.get("content-type")?.split(";")[0] || undefined;

  return {
    filename,
    localPath: fullPath,
    mimeType: detectedMime,
    size: stats.size,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Check if a MIME type represents an image.
 */
export function isImageMime(mimeType?: string): boolean {
  return !!mimeType && mimeType.startsWith("image/");
}

/**
 * Format a human-readable file size.
 */
function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Format non-image attachments as a text block to inject into the agent prompt.
 *
 * Example output:
 * ```
 * [Attachments]
 * - report.pdf (application/pdf, 1.2MB) → /abs/path/to/report.pdf
 * ```
 */
export function formatAttachmentsPrompt(
  attachments: ChannelAttachment[],
): string {
  if (attachments.length === 0) return "";

  const lines = attachments.map((a) => {
    const meta = [a.mimeType, formatSize(a.size)].filter(Boolean).join(", ");
    return `- ${a.filename} (${meta}) → ${a.localPath}`;
  });

  return `[Attachments]\n${lines.join("\n")}`;
}

/**
 * Convert image attachments to ImageContent objects for direct LLM input.
 * Only processes attachments with image/* MIME types.
 */
export function attachmentsToImageContent(
  attachments: ChannelAttachment[],
): Array<{ type: "image"; data: string; mimeType: string }> {
  return attachments
    .filter((a) => isImageMime(a.mimeType))
    .map((a) => {
      const buffer = fs.readFileSync(a.localPath);
      return {
        type: "image" as const,
        data: buffer.toString("base64"),
        mimeType: a.mimeType || "image/png",
      };
    });
}
