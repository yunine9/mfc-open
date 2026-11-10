#!/bin/bash
# 收编内核快照 → kernel/:发布形态一个仓=完整产品(用户拍板"cloud
# 应该是独立的集成产品")。运行时优先使用随 Cloud 版本发布的 kernel/；
# 需要联调 ../mae-flow 活内核时显式设置 MAE_FLOW_HOME，避免开发机上
# 恰好存在另一版本的兄弟仓时发生静默降级。发布/推送前跑本脚本刷新快照。
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
# 这里选择的是“快照来源”而非运行时内核：显式参数 > MAE_FLOW_HOME >
# 兄弟目录。写死 ../mae-flow 在 git worktree 里会当场找不到
# (worktree 的上一级是 .claude/worktrees,不是 dev/)。
kernel_src="${1:-${MAE_FLOW_HOME:-$root/../mae-flow}}"

if [ ! -d "$kernel_src/.git" ]; then
  echo "找不到内核仓: $kernel_src" >&2
  echo "用法: harness/sync-kernel.sh [内核仓路径](或设 MAE_FLOW_HOME)" >&2
  exit 2
fi
if ! git -C "$kernel_src" diff --quiet HEAD 2>/dev/null; then
  echo "警告: 内核仓有未提交改动——收编的是 HEAD 快照,工作区改动不在内" >&2
fi

sha="$(git -C "$kernel_src" rev-parse HEAD)"
ref="$(git -C "$kernel_src" symbolic-ref --quiet --short HEAD 2>/dev/null || printf 'detached')"
# Cloud 专属分支会持续前进，来源 SHA 只能说明“这次收编了什么”，不能
# 回答“它最初从哪版 Mae-Flow 分出来”。把与本地 main 的 merge-base 一并
# 写入 VENDORED；后续 rebase 后基线自然更新，审计时不靠人回忆。
baseline="$sha"
if [ "$ref" != "main" ] && git -C "$kernel_src" rev-parse --verify main >/dev/null 2>&1; then
  baseline="$(git -C "$kernel_src" merge-base main HEAD)"
fi
rm -rf "$root/kernel"
mkdir -p "$root/kernel"
git -C "$kernel_src" archive HEAD | tar -x -C "$root/kernel"
{
  printf '来源: mae-flow@%s\n' "$sha"
  printf '分支: %s\n' "$ref"
  printf '基线: mae-flow@%s\n' "$baseline"
  printf '收编时间: %s\n' "$(date +%F)"
  printf '纪律: 此目录是快照,不许手改;更新跑 harness/sync-kernel.sh\n'
} > "$root/kernel/VENDORED"
echo "内核已收编: mae-flow:${ref}@${sha:0:12} → kernel/ ($(find "$root/kernel" -type f | wc -l | tr -d ' ') 个文件)"
