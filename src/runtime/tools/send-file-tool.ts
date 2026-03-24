import fs from "node:fs";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";

import type {
  ToolDefinition,
  AgentToolResult,
} from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

const SendFileParams = Type.Object({
  filePath: Type.String({
    description:
      "Absolute path to the file to send to the user. The file must exist and be readable.",
  }),
  caption: Type.Optional(
    Type.String({
      description: "Optional caption or description to accompany the file.",
    }),
  ),
});

type SendFileInput = Static<typeof SendFileParams>;

// ---------------------------------------------------------------------------
// Callback type for emitting file output events
// ---------------------------------------------------------------------------

export interface FileOutputEvent {
  type: "file_output";
  filePath: string;
  filename: string;
  mimeType?: string;
  caption?: string;
}

export type FileOutputCallback = (event: FileOutputEvent) => void;

// ---------------------------------------------------------------------------
// MIME detection helper
// ---------------------------------------------------------------------------

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

function detectMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext];
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create a `send_file` ToolDefinition.
 *
 * The tool is parameterised by a `fileOutputCallback` that will be called
 * when the LLM invokes the tool. The adapter should set this callback
 * before each agent run to route the file to the correct IM channel.
 */
export function createSendFileTool(
  fileOutputCallbackRef: { current: FileOutputCallback | null },
): ToolDefinition<typeof SendFileParams> {
  return {
    name: "send_file",
    label: "Send File",
    description:
      "Send a file to the user via the current chat channel (Telegram, Slack, or Web). " +
      "IMPORTANT: Do NOT proactively send files. Only use this tool when the user EXPLICITLY " +
      "asks you to send, share, or deliver a file (e.g. '把文件发给我', 'send me the file', " +
      "'share the result'). Never send intermediate/temporary files. When the user asks, " +
      "send only the specific file(s) the user requested, not all generated files.",
    promptSnippet:
      "send_file: Send a file to the user ONLY when they explicitly request it. " +
      "Never send files proactively or automatically.",
    parameters: SendFileParams,
    async execute(
      _toolCallId,
      params: SendFileInput,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<AgentToolResult<undefined>> {
      const { filePath, caption } = params;

      // Validate file exists
      if (!fs.existsSync(filePath)) {
        return {
          content: [{ type: "text", text: `Error: File not found: ${filePath}` }],
          details: undefined,
        };
      }

      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        return {
          content: [
            { type: "text", text: `Error: Path is not a file: ${filePath}` },
          ],
          details: undefined,
        };
      }

      const filename = path.basename(filePath);
      const mimeType = detectMimeType(filePath);

      // Emit the file output event
      const callback = fileOutputCallbackRef.current;
      if (callback) {
        callback({
          type: "file_output",
          filePath,
          filename,
          mimeType,
          caption,
        });
      }

      const sizeKB = (stats.size / 1024).toFixed(1);
      return {
        content: [
          {
            type: "text",
            text: `File "${filename}" (${sizeKB}KB) has been sent to the user.`,
          },
        ],
        details: undefined,
      };
    },
  };
}
