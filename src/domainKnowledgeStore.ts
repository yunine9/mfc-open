import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readDomainArchiveProgress } from "./domainArchiveProgress.ts";
import { durableWriteFileSync } from "./durableWrite.ts";
import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import type { DomainKnowledgeJob } from "./domainKnowledgeTypes.ts";

type Evidence = DomainKnowledgeJob["evidence"];
interface EvidenceState { file: string; snapshot: Evidence }
interface EvidenceReference { version: 1; file: string }

/** 主文件保存任务状态，研究记录独立追加，避免每条记录重写所有文稿。 */
export class DomainKnowledgeStore {
  private evidence = new Map<string, EvidenceState>();
  constructor(private log?: (message: string) => void) {}

  read(path: string): unknown {
    const stored = JSON.parse(readFileSync(path, "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("知识任务记录格式不正确");
    const { _evidence_store: reference, ...job } = stored;
    if (reference !== undefined) {
      if (reference?.version !== 1 || typeof reference.file !== "string" || !/^evidence-[a-f0-9-]{36}\.jsonl$/.test(reference.file)) throw new Error("研究记录文件引用不正确");
      const file = join(dirname(path), reference.file);
      if (!existsSync(file)) throw new Error("研究记录文件缺失");
      const rows = readAppendOnlyJsonl<Record<string, unknown>>(file, { middleCorrupt: "throw", log: this.log });
      if (rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("研究记录格式不正确");
      job.evidence = rows;
      this.evidence.set(path, { file: reference.file, snapshot: structuredClone(rows) });
    } else {
      this.evidence.delete(path);
    }
    return readDomainArchiveProgress(path, job as DomainKnowledgeJob);
  }

  save(path: string, job: DomainKnowledgeJob): void {
    mkdirSync(dirname(path), { recursive: true });
    let state = this.state(path);
    const unchangedPrefix = state && job.evidence.length >= state.snapshot.length
      && state.snapshot.every((row, index) => isDeepStrictEqual(row, job.evidence[index]));
    if (state && unchangedPrefix) {
      this.append(path, state, job.evidence.slice(state.snapshot.length));
    } else {
      // 旧主文件保留原字节；迁移失败时仍可按原格式恢复。已有记录修改时也保留旧 JSONL。
      if (!state && existsSync(path)) {
        const backup = `${path}.inline-${randomUUID()}.bak`;
        copyFileSync(path, backup, constants.COPYFILE_EXCL);
        const descriptor = openSync(backup, "r");
        try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
      }
      const file = `evidence-${randomUUID()}.jsonl`;
      const content = job.evidence.map(row => JSON.stringify(row) + "\n").join("");
      durableWriteFileSync(join(dirname(path), file), content, { mode: 0o600 });
      state = { file, snapshot: structuredClone(job.evidence) };
    }
    const reference: EvidenceReference = { version: 1, file: state!.file };
    const revision = randomUUID();
    const { evidence: _rows, ...metadata } = job;
    durableWriteFileSync(path, JSON.stringify({ ...metadata, evidence: [], archive_progress_revision: revision, _evidence_store: reference }), { mode: 0o600 });
    this.evidence.set(path, state!);
    job.archive_progress_revision = revision;
  }

  appendEvidence(path: string, job: DomainKnowledgeJob, event: Record<string, unknown>): void {
    let state = this.state(path);
    if (!state || state.snapshot.length !== job.evidence.length) {
      this.save(path, job);
      state = this.evidence.get(path)!;
    }
    this.append(path, state, [event]);
    job.evidence.push(event);
  }

  private state(path: string): EvidenceState | undefined {
    if (!this.evidence.has(path) && existsSync(path)) this.read(path);
    return this.evidence.get(path);
  }

  private append(path: string, state: EvidenceState, rows: Evidence): void {
    const file = join(dirname(path), state.file);
    if (!existsSync(file)) throw new Error("研究记录文件缺失");
    if (!rows.length) return;
    const snapshot = structuredClone(rows);
    try {
      // 过程记录采用追加日志；任务状态仍使用 fsync + 原子替换。断写末行由读取侧修复。
      appendFileSync(file, rows.map(row => JSON.stringify(row) + "\n").join(""), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      // 下次写入前重新读取并修复可能的断写末行。
      this.evidence.delete(path);
      throw error;
    }
    for (const row of snapshot) state.snapshot.push(row);
  }
}
