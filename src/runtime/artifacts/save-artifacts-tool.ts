import { Type, type Static } from "@sinclair/typebox";

import type {
  AgentToolResult,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { resolvePackFile } from "../files/metadata.js";
import type { FinalArtifactDeclaration } from "./types.js";

const ArtifactItem = Type.Object({
  filePath: Type.String({
    description:
      "Absolute path to the artifact file. The file must exist, be readable, and be inside the current pack root.",
  }),
  title: Type.Optional(
    Type.String({
      description: "Optional short title shown in the dashboard.",
    }),
  ),
  isPrimary: Type.Optional(
    Type.Boolean({
      description: "Mark this artifact as a primary output.",
    }),
  ),
});

const SaveArtifactsParams = Type.Object({
  artifacts: Type.Array(ArtifactItem, {
    minItems: 1,
    description: "The artifact files to save for this run.",
  }),
});

type SaveArtifactsInput = Static<typeof SaveArtifactsParams>;

export type SaveArtifactsCallback = (
  artifacts: FinalArtifactDeclaration[],
) => number | Promise<number>;

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createSaveArtifactsTool(
  rootDir: string,
  saveCallbackRef: { current: SaveArtifactsCallback | null },
): ToolDefinition<typeof SaveArtifactsParams> {
  return {
    name: "save_artifacts",
    label: "Save Artifacts",
    description: [
      "Save artifact files produced by this run for dashboard indexing.",
      "Use this only for output files that should appear in the artifact catalog.",
      "Each filePath must be an absolute path inside the current pack root.",
    ].join("\n"),
    promptSnippet:
      "save_artifacts: Save only the output files that should appear in the artifact dashboard. Use absolute paths inside the current pack root.",
    parameters: SaveArtifactsParams,
    async execute(
      _toolCallId,
      params: SaveArtifactsInput,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<AgentToolResult<undefined>> {
      const saveArtifacts = saveCallbackRef.current;
      if (!saveArtifacts) {
        throw new Error("Artifact saving is not available for this run.");
      }

      const artifacts = params.artifacts.map((artifact) => {
        const metadata = resolvePackFile(rootDir, artifact.filePath);
        return {
          filePath: metadata.resolvedPath,
          fileName: metadata.fileName,
          mimeType: metadata.mimeType,
          sizeBytes: metadata.sizeBytes,
          title: normalizeOptionalText(artifact.title),
          isPrimary: artifact.isPrimary === true,
        } satisfies FinalArtifactDeclaration;
      });

      const savedCount = await saveArtifacts(artifacts);
      return textResult(`Saved ${savedCount} artifact(s).`);
    },
  };
}
