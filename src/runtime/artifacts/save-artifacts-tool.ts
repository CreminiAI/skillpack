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
      "Save the final output files produced by this run.",
      "Always use this for user-facing deliverables that are part of the final result.",
      "Do not use this for intermediate, temporary, draft, or scratch files.",
      "Each filePath must be an absolute path inside the current pack root.",
    ].join("\n"),
    promptSnippet:
      "save_artifacts: Save final result files for this task. Always call this for user-facing final deliverables, and never for intermediate files. Use absolute paths inside the current pack root.",
    promptGuidelines: [
      "Whenever you create a final result file for the user, call `save_artifacts` before finishing the response.",
      "Do not call `save_artifacts` for intermediate, temporary, draft, or scratch files.",
    ],
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
