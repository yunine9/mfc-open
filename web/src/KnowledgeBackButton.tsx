import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export function KnowledgeBackButton({ onClick, destination = "知识库" }: { onClick: () => void; destination?: string }) {
  return <Button type="button" variant="outline" className="knowledge-back-button" onClick={onClick}><ArrowLeft size={17} /><span>返回{destination}</span></Button>;
}
