import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ComponentDocumentReader } from "./ComponentDocumentReader";
import { componentRequest } from "./componentResearchApi";
import { useKnowledgeStudio } from "./KnowledgeStudioContext";

export type PlatformSkillKind = "component" | "component-analysis" | "domain";
export const platformSkillLabels = { component: "组件用法萃取", "component-analysis": "组件模块分析", domain: "领域知识萃取" };
export interface PlatformSkill {
  name: string; digest: string; files: Record<string, string>; can_manage: boolean;
  versions: Array<{ version_id: string; archived_at: string; operator: string }>;
}
export const platformSkillRequest = (kind: PlatformSkillKind) =>
  componentRequest<PlatformSkill>(`/knowledge-extraction/skills/${kind}`);

/** 使用现有的萃取方法存储，不加入开发任务的 Skill 列表或知识索引。 */
export function PlatformSkillPane({ kind }: {
  kind: PlatformSkillKind;
}) {
  const studio = useKnowledgeStudio();
  const [skill, setSkill] = useState<PlatformSkill>();
  const [path, setPath] = useState("SKILL.md");
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true; setSkill(undefined); setError(""); setPath("SKILL.md");
    platformSkillRequest(kind).then(value => { if (live) setSkill(value); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [kind]);
  const files = skill?.files;
  return <div className="tw-root platform-skill-pane space-y-5 p-6" aria-label="平台 Skill 详情">
    <header className="flex items-start justify-between gap-4"><div>
      <h2 className="text-lg font-semibold">{skill?.name ?? platformSkillLabels[kind]}</h2>
      <p className="mt-2 text-sm text-muted-foreground">方法随平台版本更新，无需上传；已开始的研究继续使用固定版本。</p>
    </div>{studio && skill && <Button onClick={() => studio.openExecution(kind === "component-analysis" ? "component" : kind)}>使用此 Skill</Button>}</header>
    {kind === "domain" && <p className="text-sm text-muted-foreground">本 Skill 包含源码、上传资料与无线豆包的研究方法，以及规划、写作和评审要求。</p>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    {files ? <ComponentDocumentReader allowRaw collapseFolders height="max(500px, calc(100dvh - 290px))" treeLabel="平台 Skill 文件" contentLabel="Skill 文件正文"
      files={Object.keys(files).sort((a, b) => a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a.localeCompare(b)).map(name => ({ id: name, path: name.split("/"), content: files[name] }))}
      selected={path} onSelect={setPath} /> : !error && <p>正在读取 Skill…</p>}
    {!!skill?.versions.length && <details className="border-t border-line pt-4 text-sm"><summary className="cursor-pointer">更新记录 · {skill.versions.length}</summary><ul className="mt-3 space-y-2 text-muted-foreground">{skill.versions.map(v => <li key={v.version_id}>{new Date(v.archived_at).toLocaleString()} · {v.operator} 更新了 Skill</li>)}</ul></details>}
  </div>;
}
