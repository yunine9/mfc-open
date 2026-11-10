import { useEffect, useState } from "react";
import { KnowledgeAnswers } from "./KnowledgeAnswers";

function readRoute() {
  const query = new URLSearchParams(location.search);
  return { answerId: query.get("kbAsk") || "", moduleKey: query.get("kbModule") || undefined, documentId: query.get("knowledgeDocument") || undefined };
}

/** 文档提问、侧栏入口和小鲁班链接共用同一个独立问答页面。 */
export function openKnowledgeAnswer(answerId = "", moduleKey?: string, documentId?: string) {
  const url = new URL(location.href);
  url.pathname = "/";
  url.search = new URLSearchParams({ kbPage: "ask", ...(answerId ? { kbAsk: answerId } : {}),
    ...(moduleKey ? { kbModule: moduleKey } : {}), ...(documentId ? { knowledgeDocument: documentId } : {}) }).toString();
  url.hash = "";
  history.pushState({ maeFlowView: "answers" }, "", url);
  dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

export function KnowledgeAnswerPage() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const sync = () => setRoute(readRoute());
    addEventListener("popstate", sync);
    return () => removeEventListener("popstate", sync);
  }, []);
  return <KnowledgeAnswers {...route} onSelect={id => openKnowledgeAnswer(id)} />;
}
