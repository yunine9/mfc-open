/** 大仓传输/整合与 clone 使用相同网络预算，不再被五分钟截断。 */
export const GIT_TRANSFER_TIMEOUT_MS = 30 * 60_000;
/** 重启清理必须晚于 detached Git 的最长传输预算，避免拔掉仍在使用的凭据。 */
export const GIT_RUNTIME_RETENTION_MS = 2 * GIT_TRANSFER_TIMEOUT_MS;
