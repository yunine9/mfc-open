import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { TaskService } from "../src/taskService.ts";

test("流水线材料原地刷新 bind 根，且空轮次不会遗留旧 SHA 日志", async () => {
  const platform = new FakeGitPlatform();
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-pipeline-artifacts-"));
  const service: any = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl },
  });
  try {
    const created = service.create("流水线材料挂载刷新");
    const task = service.tasks.get(created.id);
    task.summary.delivery = { sha: "a".repeat(40) };
    const pipeline = join(created.workspace, "pipeline");
    mkdirSync(join(pipeline, "stale-dir"), { recursive: true });
    writeFileSync(join(pipeline, "stale-dir", "old.log"), "old sha");
    const rootInode = lstatSync(pipeline).ino;

    platform.artifacts.push({
      name: "build.log",
      text: "current sha build failure",
    });
    assert.deepEqual(
      await service.mirrorPipelineArtifacts(task), ["build.log"]);
    assert.equal(lstatSync(pipeline).ino, rootInode,
      "刷新不能替换运行中容器已经绑定的目录 inode");
    assert.equal(existsSync(join(pipeline, "stale-dir")), false);
    assert.equal(readFileSync(join(pipeline, "build.log"), "utf-8"),
      "current sha build failure");
    assert.equal(lstatSync(join(pipeline, "build.log")).mode & 0o222, 0,
      "宿主落盘材料本身也不授予写权限");

    platform.artifacts.splice(0);
    assert.deepEqual(await service.mirrorPipelineArtifacts(task), []);
    assert.equal(lstatSync(pipeline).ino, rootInode);
    assert.equal(existsSync(join(pipeline, "build.log")), false,
      "平台明确返回空材料时必须清掉上一 SHA 的日志");
  } finally {
    await service.shutdown();
    await platform.stop();
  }
});
