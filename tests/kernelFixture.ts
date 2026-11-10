/**
 * 内核集成用例的共用前置:内核在哪、Java 样例仓在哪、缺了怎么说。
 *
 * 抽出来的理由和 src/kernelDiscovery.ts 一样——同一条发现链写两遍
 * 就会两边漂移。更重要的是**跳过理由要指名道姓**:原来两处都写
 * "缺 mae-flow 内核或 fieldtest-java",内网首跑的人看到这句话以为
 * ZIP 里没带内核(其实内核随仓收编在 kernel/,缺的是外部 Java 样例
 * 仓)——两者后果天差地别:前者是发布件残缺要停下,后者跟部署无关。
 *
 * 文件名不带 .test.ts:测试 glob 是 tests/*.test.ts,它不会被当用例跑。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

export const KERNEL_ROOT = discoverKernelRoot(REPO_ROOT)
  ?? resolve(REPO_ROOT, "kernel"); // 兜底给探测一个必然落空的路径
export const FIELDTEST = process.env.MAE_FLOW_FIELDTEST_JAVA
  ?? resolve(REPO_ROOT, "..", "mae-flow-fieldtest-java");

const HAS_KERNEL = existsSync(join(KERNEL_ROOT, "hooks", "dispatch.py"));
const HAS_FIELDTEST = existsSync(FIELDTEST);

export const READY = HAS_KERNEL && HAS_FIELDTEST;

/** false = 可以跑;字符串 = 跳过理由(跳过≠通过,理由要能照着补齐)。 */
export const KERNEL_SKIP: false | string = READY ? false
  : !HAS_KERNEL
    ? `缺内核:找不到 ${KERNEL_ROOT}/hooks/dispatch.py。`
      + "仓内 kernel/ 快照随仓自带,缺了说明发布件不完整(ZIP 被裁剪?)"
      + ",这条要停下来查,不是环境问题"
    : `缺 Java 样例仓 ${FIELDTEST}(外部仓,不随本仓分发)。`
      + "克隆它或设 MAE_FLOW_FIELDTEST_JAVA 后重跑;内核在场,与部署无关";
