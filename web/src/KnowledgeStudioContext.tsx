import { createContext, useContext } from "react";

export type KnowledgeStudioView = "skills" | "workbench" | "knowledge";
export type ExtractionKind = "domain" | "component";

export const KnowledgeStudioContext = createContext<{
  view: KnowledgeStudioView;
  openExecution: (kind: ExtractionKind, id?: string) => void;
  openResult: (kind: ExtractionKind, id: string) => void;
} | null>(null);

export const useKnowledgeStudio = () => useContext(KnowledgeStudioContext);
