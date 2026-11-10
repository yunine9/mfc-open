import { resolveBusinessModuleId } from "./businessModuleIdentity.ts";
/**
 * DTS 单号→业务模块的人工改选映射(spec #57 起;ADR-0056 后只存人工
 * 改选:规则带出值不落账,发起时的解析=改选优先于带出)。
 *
 * 从简——一个 JSON 文件、读全量/写单条两个动作,并发写 last-write-wins,
 * 记 updated_by/updated_at 供对账。改选是团队共享事实:谁选了大家受益,
 * 人人可写(登录即可,不做 Owner 审核)。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { BusinessModuleError, readBusinessModule } from "./businessModuleLibrary.ts";

const FILE = "dts-module-bindings.json";
/** 与问题流服务端的单号同一把尺(service.ts 的 TICKET_PATTERN 镜像)。 */
const TICKET = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class DtsModuleBindingError extends Error {}

export interface DtsModuleBindingEntry {
  module_id: string;
  updated_by: string;
  updated_at: string;
}

export interface DtsModuleBindingFile {
  version: 1;
  bindings: Record<string, DtsModuleBindingEntry>;
}

function bindingsFile(dataDir: string): string {
  return join(dataDir, FILE);
}

/** 读全量映射。文件缺席或损坏一律当空(旁路数据不反噬主流程),写入
 * 时会原样重建。 */
export function readDtsModuleBindings(
  dataDir: string,
): Record<string, DtsModuleBindingEntry> {
  const path = bindingsFile(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed?.version !== 1 || typeof parsed.bindings !== "object"
        || parsed.bindings === null) return {};
    return Object.fromEntries(Object.entries(parsed.bindings as Record<string, DtsModuleBindingEntry>).map(([ticket, entry]) => [ticket, { ...entry, module_id: resolveBusinessModuleId(dataDir, entry.module_id) }]));
  } catch {
    return {};
  }
}

/** 写单条:moduleId 为空 = 解绑(没有绑定也当解绑成功,幂等);绑定
 * 校验模块真实存在且 active(fail-early;发起时 create() 再兜一道)。
 * 返回解绑前的旧条目(测试/调用方对账用)。 */
export function setDtsModuleBinding(
  dataDir: string,
  ticket: string,
  moduleId: string | null,
  updatedBy: string,
): { previous?: DtsModuleBindingEntry } {
  const id = ticket.trim();
  if (!TICKET.test(id)) {
    throw new DtsModuleBindingError(
      `单号 ${id || "(空)"} 格式不合法:只能是字母数字下划线连字符`);
  }
  const by = updatedBy.trim();
  if (!by) throw new DtsModuleBindingError("缺少操作人账号");
  const bindings = readDtsModuleBindings(dataDir);
  const previous = bindings[id];
  if (moduleId === null || moduleId.trim() === "") {
    if (!previous) return {};
    delete bindings[id];
  } else {
    const mid = moduleId.trim();
    let module_;
    try {
      module_ = readBusinessModule(dataDir, mid);
    } catch (error) {
      throw new DtsModuleBindingError(
        `业务模块 ${mid} 不存在或元数据不可读,不能绑定到单号 ${id}:`
        + (error instanceof BusinessModuleError
          ? error.message : String(error)));
    }
    if (module_.status !== "active") {
      throw new DtsModuleBindingError(
        `业务模块「${module_.name}」已归档,不能绑定到单号 ${id}`);
    }
    bindings[id] = {
      module_id: mid,
      updated_by: by,
      updated_at: new Date().toISOString(),
    };
  }
  const path = bindingsFile(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    version: 1,
    bindings,
  } satisfies DtsModuleBindingFile, null, 1), "utf-8");
  renameSync(temporary, path);
  return { ...(previous ? { previous } : {}) };
}
