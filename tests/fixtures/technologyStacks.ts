import { createTechnologyStack, listTechnologyStacks } from "../../src/technologyStacks.ts";

/** 用例显式声明实际使用的技术栈，不为测试环境注入默认清单。 */
export function seedTechnologyStacks(dataDir: string, ids: string[]): void {
  const existing = new Set(listTechnologyStacks(dataDir).map((stack) => stack.id));
  for (const id of new Set(ids)) {
    if (existing.has(id)) continue;
    createTechnologyStack(dataDir, { id, name: id }, "fixture");
    existing.add(id);
  }
}
