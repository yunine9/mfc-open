/** 告警只包含字段位置和规则，不能把 JSON 正文或底层异常中的凭据带到页面。 */
export class KnowledgeRecordFormatError extends Error {}

export function recordCheck(condition: unknown, path: string, expectation: string): asserts condition {
  if (!condition) throw new KnowledgeRecordFormatError(`${path} ${expectation}`);
}
export function recordObject(value: unknown, path: string): asserts value is Record<string, any> {
  recordCheck(value && typeof value === "object" && !Array.isArray(value), path, "必须是对象");
}
export function recordFields(value: Record<string, any>, names: string[], path = "", optional = false) {
  for (const name of names) if (!optional || value[name] !== undefined)
    recordCheck(typeof value[name] === "string", `${path}${name}`, "缺失或不是文本");
}
export function recordStrings(value: unknown, path: string) {
  recordCheck(Array.isArray(value) && value.every(item => typeof item === "string"), path, "必须是文本数组");
}
export function recordArray(value: unknown, path: string, visit: (item: any, path: string) => void) {
  recordCheck(Array.isArray(value), path, "必须是数组");
  value.forEach((item, index) => visit(item, `${path}[${index}]`));
}
export function recordReadReason(error: unknown): string {
  if (error instanceof KnowledgeRecordFormatError) return error.message;
  if (error instanceof SyntaxError) return "JSON 格式不完整或有语法错误，请检查原文件";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "ENOENT": return "文件不存在（ENOENT）";
    case "EACCES": case "EPERM": return `没有文件访问权限（${code}），请检查权限`;
    case "EIO": return "磁盘读写失败（EIO），请检查磁盘后重试";
    case "ENOSPC": return "磁盘空间不足（ENOSPC），请释放空间后重试";
    case "EISDIR": return "记录路径是目录（EISDIR），应为普通文件";
    default: return "文件操作失败，请检查文件与宿主日志";
  }
}
