import { Button } from "@/components/ui/button";
import { extractionSkillSearch } from "./knowledgeNavigation";
import type { PlatformSkillKind } from "./PlatformSkill";

/** 萃取页只保留导航，在知识库的 Skill 页面阅读随平台发布的方法。 */
export function ExtractionSkillEditor({ kind, label = "萃取方法" }: { kind: PlatformSkillKind; label?: string }) {
  return <Button variant="outline" onClick={() => openExtractionSkill(kind)}>{label}</Button>;
}
export function openExtractionSkill(kind: PlatformSkillKind) {
  const url = new URL(location.href);
  url.search = extractionSkillSearch(url.search, kind);
  // 从未提交的研究表单过来，页面的返回与「使用此 Skill」都回到原入口。
  const fromResearch = new URLSearchParams(location.search).get("kbPage") === "research";
  history.pushState({ ...history.state, knowledgeResearchReturn: fromResearch ? location.search : undefined }, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}
