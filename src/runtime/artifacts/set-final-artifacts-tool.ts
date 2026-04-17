import { Type, type Static } from "@sinclair/typebox";

import type {
  AgentToolResult,
  ToolDefinition,
} from "@mariozechner/pi-coding-agent";

import { resolvePackFile } from "../files/metadata.js";
import type { FinalArtifactDeclaration } from "./types.js";

const FinalArtifactItem = Type.Object({
  filePath: Type.String({
    description:
      "Absolute path to the final artifact file. The file must exist, be readable, and be inside the current pack root.",
  }),
  title: Type.Optional(
    Type.String({
      description: "Optional short title shown in the dashboard.",
    }),
  ),
  description: Type.Optional(
    Type.String({
      description: "Optional description shown in the dashboard.",
    }),
  ),
  isPrimary: Type.Optional(
    Type.Boolean({
      description: "Mark this artifact as a primary output for the current declaration.",
    }),
  ),
});

const SetFinalArtifactsParams = Type.Object({
  artifacts: Type.Array(FinalArtifactItem, {
    minItems: 1,
    description: "The final artifact files produced by this run.",
  }),
});

type SetFinalArtifactsInput = Static<typeof SetFinalArtifactsParams>;

export type FinalArtifactsCallback = (
  artifacts: FinalArtifactDeclaration[],
) => void;

export interface FinalArtifactsCollector {
  addArtifacts: FinalArtifactsCallback;
  markInvalid: () => void;
}

function textResult(text: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text }], details: undefined };
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createSetFinalArtifactsTool(
  rootDir: string,
  collectorRef: { current: FinalArtifactsCollector | null },
): ToolDefinition<typeof SetFinalArtifactsParams> {
  return {
    name: "set_final_artifacts",
    label: "Set Final Artifacts",
    description: [
      "Declare the final artifact files produced by this run for dashboard indexing.",
      "Use this only for final outputs that should appear in the artifact catalog.",
      "You may call it multiple times if the final output set changes; earlier declarations will be kept as history for this run.",
      "Each filePath must be an absolute path inside the current pack root.",
    ].join("\n"),
    promptSnippet:
      "set_final_artifacts: Declare only the final output files that should appear in the artifact dashboard. Use absolute paths inside the current pack root.",
    parameters: SetFinalArtifactsParams,
    async execute(
      _toolCallId,
      params: SetFinalArtifactsInput,
      _signal,
      _onUpdate,
      _ctx,
    ): Promise<AgentToolResult<undefined>> {
      const collector = collectorRef.current;
      if (!collector) {
        throw new Error("Final artifact collection is not available for this run.");
      }

      try {
        const artifacts = params.artifacts.map((artifact) => {
          const metadata = resolvePackFile(rootDir, artifact.filePath);
          return {
            filePath: metadata.resolvedPath,
            fileName: metadata.fileName,
            mimeType: metadata.mimeType,
            sizeBytes: metadata.sizeBytes,
            title: normalizeOptionalText(artifact.title),
            description: normalizeOptionalText(artifact.description),
            isPrimary: artifact.isPrimary === true,
          } satisfies FinalArtifactDeclaration;
        });

        collector.addArtifacts(artifacts);
        return textResult(`Registered ${artifacts.length} final artifact(s) for this run.`);
      } catch (error) {
        collector.markInvalid();
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
  };
}
