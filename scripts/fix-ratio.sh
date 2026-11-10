#!/usr/bin/env bash
# 每周复测"修 bug 占比"(质量加固计划第五步,2026-09-06 立)。
#
# 为什么要有:2026-09-06 的基线是 12 天 245 个 fix 提交、40% 落在
# src/taskService.ts——重构值不值、往哪儿重构,得拿这个数说话而不是凭感觉。
# 口径:按提交说明前缀 fix 计数(本仓 commit 规范 type(scope): …);
# 文件维度数"被 fix 提交触碰的次数"。用法:scripts/fix-ratio.sh [天数,默认 7]
set -euo pipefail
cd "$(dirname "$0")/.."
days="${1:-7}"
since="${days} days ago"
total=$(git log --since="$since" --pretty=format:%s | wc -l | tr -d ' ')
fixes=$(git log --since="$since" --pretty=format:%s | grep -c -E '^fix(\(|:)' || true)
if [ "$total" -eq 0 ]; then echo "近 ${days} 天没有提交"; exit 0; fi
ratio=$(( fixes * 100 / total ))
printf '近 %s 天:提交 %s,fix %s(%s%%)\n' "$days" "$total" "$fixes" "$ratio"
printf 'src/taskService.ts 现在 %s 行(棘轮见 tests/taskServiceSizeRatchet.test.ts)\n' \
  "$(grep -c '' src/taskService.ts)"
printf '\n被 fix 提交触碰最多的文件(次数 文件):\n'
git log --since="$since" --pretty=format:"COMMIT %s" --name-only \
  | awk '/^COMMIT fix(\(|:)/{f=1;next} /^COMMIT/{f=0} f&&NF{print}' \
  | sort | uniq -c | sort -rn | head -10
