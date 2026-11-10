/**
 * 下单落盘失败时的回滚契约。
 *
 * 为什么单开一个文件:回滚路径平时不走,坏了也没人当场发现——它只在
 * "磁盘满/权限不对"这类倒霉时刻执行,而那正是最需要它别再添乱的时候。
 * 2026-08-29 实测踩过:回滚里的 removeTaskTree 被改成裸 rmSync,而任务
 * 快照(Skill/知识)是只读的,macOS 上摘不掉目录项报 ENOTEMPTY——回滚
 * 二次抛错,把真正的落盘错误盖掉,还留下一个没人回收得了的孤儿工作区。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";

test("下单落盘失败:带只读快照的工作区也要回滚干净,原始错误不被掩盖", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-create-rollback-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });

  // 真实现场里 Skill/知识快照是只读的(hostSkillRuntime chmod 0o444/
  // 0o555)。这里在"落盘失败"的同一拍把工作区做成同样的形状,让回滚在
  // 它真正要防御的故障下跑一遍——不然测的只是空目录能不能删。
  let workspace = "";
  const persisted = (service as any).persist.bind(service);
  (service as any).persist = (task: any, ...rest: any[]) => {
    if (!workspace) {
      workspace = task.summary.workspace;
      const snapshot = join(workspace, "skills", "pinned");
      mkdirSync(snapshot, { recursive: true });
      writeFileSync(join(snapshot, "SKILL.md"), "# pinned\n");
      chmodSync(join(snapshot, "SKILL.md"), 0o444);
      chmodSync(snapshot, 0o555);
      throw new Error("磁盘满,task.json 落不下去");
    }
    return persisted(task, ...rest);
  };

  // 原始错误必须原样上浮:回滚自己炸出来的 ENOTEMPTY 会顶掉它,
  // 让人对着"目录非空"排查半天,真正的原因(磁盘满)一个字都看不到。
  assert.throws(() => service.create("随便一个需求"), /磁盘满/);
  assert.ok(workspace, "应当已经建过工作区");
  assert.equal(existsSync(workspace), false,
    "回滚必须把工作区删干净,不留没有 task.json、谁也回收不了的孤儿现场");
  assert.equal((service as any).tasks.size, 0, "内存里也不许留半张任务");
});
