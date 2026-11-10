import { executeFile } from "./componentResearchTools.ts";
import type { KnowledgeCodeSnapshot } from "./domainKnowledgeCode.ts";
export interface ComponentInterfaceCandidate { repository_id: string; path: string; revision: string; public_path: boolean; export_marker: boolean; symbols: string[] }
/** 文本扫描仅提供候选信号，不将公开目录、public 或引用次数当作发布证明。 */
export async function scanComponentInterfaces(snapshots: KnowledgeCodeSnapshot[], signal: AbortSignal) {
  const candidates: ComponentInterfaceCandidate[] = [];
  for (const snapshot of snapshots) {
    const files = snapshot.files.filter(path => /\.(?:h|hh|hpp|hxx|java|idl|proto)$/.test(path));
    for (let start = 0; start < files.length; start += 4) {
      const rows = await Promise.all(files.slice(start, start + 4).map(async path => {
        signal.throwIfAborted();
        const text = await executeFile("git", ["show", `${snapshot.revision}:${path}`], snapshot.root, signal);
        const symbols = [...text.matchAll(/\b(?:class|struct|interface|enum|record|service|message)\s+(?:[A-Z_][A-Z0-9_]*\s+)*([A-Za-z_$][\w$]*)/g)].map(m => m[1]);
        return { repository_id: snapshot.repository.id, path, revision: snapshot.revision,
          public_path: /(^|\/)(?:include|interface|interfaces|api|sdk)(\/|$)/i.test(path),
          export_marker: /\b[A-Z][A-Z0-9_]*_(?:EXPORT|API)\b|\bpublic\s+(?:class|interface|record)\b/.test(text), symbols: [...new Set(symbols)] };
      }));
      candidates.push(...rows);
    }
  }
  return candidates;
}
