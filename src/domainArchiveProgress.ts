import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { durableWriteFileSync } from "./durableWrite.ts";
import type { DomainKnowledgeJob, DomainPublication } from "./domainKnowledgeTypes.ts";

const progressPath = (path: string) => join(dirname(path), "archive-progress.json");
const bodyDirectory = (path: string) => join(dirname(path), "archive-progress-bodies");

export function copyDomainPublication(value: DomainPublication): DomainPublication {
  return { ...value,
    documents: value.documents.map(document => ({ ...document })),
    attempted_documents: value.attempted_documents?.map(document => ({ ...document })),
    navigation_files: value.navigation_files?.map(file => ({ ...file })),
    mr_participants: value.mr_participants && structuredClone(value.mr_participants),
  };
}

/** 只复制归档可变字段；已固定的文稿正文和研究历史不参与每次进度复制。 */
export function copyDomainArchiveState(job: DomainKnowledgeJob): DomainKnowledgeJob {
  return { ...job, publications: job.publications.map(copyDomainPublication),
    archive_batches: job.archive_batches?.map(batch => ({ ...batch, publications: batch.publications.map(copyDomainPublication),
      replacements: batch.replacements?.map(item => ({ ...item, publication: copyDomainPublication(item.publication) })),
    })),
  };
}

/** 正文只保存一次，后续归档检查点只写状态、MR 信息和正文引用。 */
export class DomainArchiveProgressStore {
  private bodies = new Map<string, Map<string, string>>();
  save(path: string, job: DomainKnowledgeJob) {
    if (!job.archive_progress_revision) throw new Error("任务尚未保存主文件版本，不能保存归档进度");
    let known = this.bodies.get(path);
    if (!known) { known = new Map(); this.bodies.set(path, known); }
    const data = { version: 1, revision: job.archive_progress_revision, publications: job.publications,
      batches: job.archive_batches?.map(({ id, state, error, publications, replacements }) => ({ id, state, error, publications, replacements })) ?? [] };
    const serialized = JSON.stringify(data, (key, value) => {
      if ((key !== "content" && key !== "base_content") || typeof value !== "string") return value;
      let digest = known!.get(value);
      if (!digest) {
        digest = createHash("sha256").update(value).digest("hex");
        const directory = bodyDirectory(path), body = join(directory, digest);
        mkdirSync(directory, { recursive: true });
        if (!existsSync(body)) durableWriteFileSync(body, value, { mode: 0o600 });
        known!.set(value, digest);
      }
      return { archive_body: digest };
    });
    durableWriteFileSync(progressPath(path), serialized, { mode: 0o600 });
  }
}

export function readDomainArchiveProgress(path: string, job: DomainKnowledgeJob): DomainKnowledgeJob {
  const file = progressPath(path);
  if (!existsSync(file)) return job;
  // 先核对主文件版本，旧检查点即使正文文件缺失，也不能影响新主文件读取。
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!job.archive_progress_revision || raw.revision !== job.archive_progress_revision) return job;
  if (raw.version !== 1 || !Array.isArray(raw.batches) || !Array.isArray(raw.publications)) throw new Error("归档进度文件格式不正确");
  const bodies = new Map<string, string>();
  const restored = JSON.parse(JSON.stringify(raw), (key, value) => {
    if ((key !== "content" && key !== "base_content") || !value || typeof value !== "object") return value;
    const digest = value.archive_body;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("归档正文引用不正确");
    let content = bodies.get(digest);
    if (content === undefined) {
      content = readFileSync(join(bodyDirectory(path), digest), "utf8");
      if (createHash("sha256").update(content).digest("hex") !== digest) throw new Error("归档正文文件损坏");
      bodies.set(digest, content);
    }
    return content;
  });
  const batches = new Map(restored.batches.map((batch: { id: string }) => [batch.id, batch]));
  for (const batch of job.archive_batches ?? []) {
    const saved = batches.get(batch.id) as { state: typeof batch.state; error?: string; publications: DomainPublication[]; replacements?: typeof batch.replacements } | undefined;
    if (saved) Object.assign(batch, { state: saved.state, error: saved.error, publications: saved.publications, replacements: saved.replacements });
  }
  job.publications = restored.publications;
  return job;
}
