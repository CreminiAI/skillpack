import type {
  ArtifactDeclarationBatch,
  FinalArtifactDeclaration,
} from "./types.js";

export class RunArtifactCoordinator {
  private assistantText = "";
  private declarationSeq = 0;
  private readonly declarations: ArtifactDeclarationBatch[] = [];
  private invalidArtifacts = false;

  appendAssistantDelta(delta: string): void {
    this.assistantText += delta;
  }

  setAssistantText(text: string): void {
    this.assistantText = text;
  }

  addDeclaration(
    artifacts: FinalArtifactDeclaration[],
  ): ArtifactDeclarationBatch {
    const declaration: ArtifactDeclarationBatch = {
      declarationSeq: ++this.declarationSeq,
      declaredAt: new Date().toISOString(),
      artifacts: artifacts.map((artifact) => ({ ...artifact })),
    };
    this.declarations.push(declaration);
    return declaration;
  }

  markArtifactDeclarationInvalid(): void {
    this.invalidArtifacts = true;
  }

  hasInvalidArtifactDeclarations(): boolean {
    return this.invalidArtifacts;
  }

  getAssistantText(): string {
    return this.assistantText;
  }

  getDeclarations(): ArtifactDeclarationBatch[] {
    return this.declarations.map((declaration) => ({
      declarationSeq: declaration.declarationSeq,
      declaredAt: declaration.declaredAt,
      artifacts: declaration.artifacts.map((artifact) => ({ ...artifact })),
    }));
  }
}
