/** 检视任务固定的图片来源与资源摘要；前后端共用，不依赖仓库读取实现。 */
export interface FrozenGitKnowledgeDocumentResources {
  source: { repository: string; branch: string; path: string; revision: string };
  resources: Record<string, { digest: string; content_type: string }>;
}
export type FrozenGitKnowledgeResources = Record<string, FrozenGitKnowledgeDocumentResources>;
