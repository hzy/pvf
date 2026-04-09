import type { EquStatementNode } from "@pvf/equ-ast";

export interface GeneratedSupportFile {
  className: string;
  supportPath: string;
  equipmentId: number;
  outputPath: string;
  sourcePartsets: string[];
  skillEntryCount: number;
}

export interface SkippedSupportFile {
  className: string;
  supportPath: string;
  reason: string;
}

export interface SkillEntryBlock {
  pieceCount: number;
  sourcePartsetPath: string;
  statements: EquStatementNode[];
}

export interface ChoroPartsetSkillUpModSummary {
  files: GeneratedSupportFile[];
  skipped: SkippedSupportFile[];
}
