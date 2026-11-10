import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DomainKnowledgeExtraction, type DomainKnowledgeJob, type DomainPublication } from "../../src/domainKnowledgeExtraction.ts";
import { KnowledgeMrPublisher } from "../../src/knowledgeMrPublisher.ts";
import { createBusinessModule, readBusinessModule } from "../../src/businessModuleLibrary.ts";
import type { KnowledgeDocument } from "../../src/knowledgeDocuments.ts";
import { writeGitKnowledgeSnapshot, writeModuleKnowledgeSync } from "../../src/knowledgeRepositorySnapshots.ts";
import { saveKnowledgeRepoConfig } from "../../src/knowledgeRepoConfig.ts";
import { resolveModuleKnowledgeLocation } from "../../src/businessModuleKnowledge.ts";

export async function completedDomainTask(service: DomainKnowledgeExtraction, id: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = service.get(id);
    if (job.status === "done") return job;
    if (job.status === "failed") throw new Error(job.error);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("候选文稿没有在测试预算内完成");
}
export async function submitDomainCandidates(service: DomainKnowledgeExtraction, id: string, input: { issue_no?: string; issue_description?: string; replace_existing?: boolean } = {}) {
  const preview = service.previewArchive(id);
  return service.createArchive(id, { issue_no: input.issue_no ?? service.get(id).issue_no ?? "REQ-FIXTURE", ...input,
    expected_archive_revision: preview.archive_revision, expected_revisions: preview.expected_revisions }, "user");
}
/** Git 写入、改名、删除和合入均用临时真仓；MR 服务替身只提供建单和状态事实。 */
export async function domainArchiveFixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix)), dataDir = join(root, "data"), source = join(root, "source");
  const code = "https://example.test/code.git", knowledge = "https://example.test/knowledge.git";
  const locations: Record<string, string> = { [code]: join(root, "code.git"), [knowledge]: join(root, "knowledge.git") };
  const git = (...args: string[]) => execFileSync("git", args.map(value => locations[value] ?? value), { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(source); git("-C", source, "init", "-q", "-b", "main");
  git("-C", source, "config", "user.name", "fixture"); git("-C", source, "config", "user.email", "fixture@example.test");
  writeFileSync(join(source, "README.md"), "# Fixture repository\n"); git("-C", source, "add", "."); git("-C", source, "commit", "-qm", "fixture");
  git("clone", "--bare", source, code); git("clone", "--bare", source, knowledge);
  saveKnowledgeRepoConfig(dataDir, knowledge, { branch: "main" });
  let creates = 0, state: "opened" | "closed" | "merged" = "opened", closed = 0;
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/mr/gates")) { response.end(JSON.stringify({ mr_state: state, gates: [] })); return; }
    if (request.url === "/mr") {
      let body = ""; for await (const part of request) body += part;
      requests.push(JSON.parse(body)); const id = ++creates;
      response.end(JSON.stringify({ id, url: `https://example.test/mr/${id}` })); return;
    }
    response.writeHead(404); response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const publisher = new KnowledgeMrPublisher({ dataDir, platformUrl: () => `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    credential: () => ({ username: "user", password: "fixture-token", email: "fixture@example.test" }) });
  const localTarget = <T extends { repository: string }>(value: T) => ({ ...value, repository: locations[value.repository] ?? value.repository });
  const options: ConstructorParameters<typeof DomainKnowledgeExtraction>[2] = {
    publish: (job, target, ...args) => publisher.publish({ ...job, knowledge_target: localTarget(job.knowledge_target), repositories: job.repositories.map(localTarget),
      archive_batches: job.archive_batches?.map(batch => ({ ...batch, targets: batch.targets.map(localTarget) })) }, localTarget(target), ...args),
    refreshPublication: (target, ...args) => publisher.refreshPublication(localTarget(target), ...args),
    closePublication: async () => { closed++; throw new Error("候选续推不应关闭原 MR"); },
  };
  const module = (id: string, name = id, docs_path = `domains/${name}`) => createBusinessModule(dataDir, { id, name, description: `${name}业务规则`, owner: "user", repositories: [code],
    knowledge_path: docs_path }, "user");
  const merge = (publication: DomainPublication, repository: string) => {
    assert.ok(publication.revision); git("-C", repository, "update-ref", "refs/heads/main", publication.revision!);
  };
  const content = (repository: string, revision: string, path: string) => git("-C", repository, "show", `${revision}:${path}`);
  const exists = (repository: string, revision: string, path: string) => {
    try { git("-C", repository, "cat-file", "-e", `${revision}:${path}`); return true; } catch { return false; }
  };
  // 本组核对候选 MR 与目录合同；正式视图装入真实 Git main 的正文，网络同步另有真 Git 回归。
  const sync = async (moduleId: string) => {
    const module = readBusinessModule(dataDir, moduleId), location = resolveModuleKnowledgeLocation(dataDir, moduleId)!, at = new Date().toISOString();
    const documents: KnowledgeDocument[] = [], repositories: Array<{ repository: string; branch: string; revision: string; scope: "module" | "repository" }> = [];
    for (const [repository, domain] of [[location.repository, true], ...module.repositories.map(repository => [repository, false])] as Array<[string, boolean]>) {
      const revision = git("-C", repository, "rev-parse", "main"); repositories.push({ repository, branch: "main", revision, scope: domain ? "module" : "repository" });
      for (const path of git("-C", repository, "-c", "core.quotePath=false", "ls-tree", "-r", "--name-only", "main").split("\n").filter(path => /\.md$/i.test(path)
        && (domain ? path.startsWith(`${location.docs_path}/`) : path === "AGENTS.md" || path.startsWith("docs/")))) {
        const content = git("-C", repository, "show", `main:${path}`), hash = createHash("sha256").update(JSON.stringify([repository, path, content])).digest("hex");
        documents.push({ id: `kg-${createHash("sha256").update(JSON.stringify([repository, "main", path])).digest("hex")}`, title: path.split("/").at(-1)!, content,
          scope: domain ? "module" : "repository", module_ids: domain ? [moduleId] : [], repositories: domain ? [] : [repository], technologies: [], product_versions: [], active: true,
          when_to_use: "", revision: hash, source: { repository, branch: "main", path, revision }, archive_target: { repository, branch: "main", path }, history: [{ at, operator: "fixture", action: "从真实 Git main 同步", revision: hash }] });
      }
    }
    writeGitKnowledgeSnapshot(dataDir, { module_id: moduleId, location, synced_at: at, documents, resources: {}, repositories });
    writeModuleKnowledgeSync(dataDir, { module_id: moduleId, location, state: "ready", attempted_at: at, synced_at: at, commit: repositories[0].revision, document_count: documents.length, repositories });
    return { state: "ready" as const };
  };
  return { root, dataDir, source, code, knowledge, git, module, options, publisher, merge, content, exists, requests, sync,
    get creates() { return creates; }, get closed() { return closed; }, setState(value: typeof state) { state = value; },
    manager(execute: ConstructorParameters<typeof DomainKnowledgeExtraction>[1]) { return new DomainKnowledgeExtraction(dataDir, execute, options); },
    async cleanup() { await publisher.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); },
  };
}
export function publicationFor(job: DomainKnowledgeJob, targetId = "domain") {
  const publication = job.publications.find(publication => publication.target_id === targetId);
  assert.ok(publication?.revision, `${targetId} 应有实际 Git 提交`); return publication;
}
