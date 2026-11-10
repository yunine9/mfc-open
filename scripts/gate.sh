#!/usr/bin/env bash
# 推送前闸门(2026-09-06 立):类型检查 + 秒级契约测试。
#
# 为什么只有这些:全量 npm test 是分钟级、部分用例要 docker/PG,放进 hook
# 只会让人养成 --no-verify 的习惯;闸门专拦两类最常见的漏网——"tsx 不看
# 类型,字段名写错静默变 undefined"(实测吃过亏)和"契约测试明明能秒级
# 发现的回归"。全量测试与真件演练仍按 README 手动跑。
#
# 用法:npm run gate;装成 push 前自动跑:git config core.hooksPath .githooks
# 跳过一次(闸门自己坏了时):MFC_SKIP_GATE=1 git push,并在提交里说明。
set -euo pipefail
cd "$(dirname "$0")/.."
step() { printf '\n[gate] %s\n' "$1"; }

step "typecheck(根 + 契约 tsconfig)"
npm run -s typecheck

step "web 构建(TSX 的类型闸)"
(cd web && npm run -s build >/dev/null)

step "契约测试(源码断言,秒级)"
npx tsx --test --test-concurrency=1 --test-timeout=60000 \
  tests/taskServiceSizeRatchet.test.ts \
  tests/deliveryRecovery.test.ts \
  tests/containerSystemCheck.test.ts \
  tests/mergeWatch.test.ts \
  tests/pushReviewPolicy.test.ts \
  tests/cssOverrideRatchet.test.ts \
  tests/apiMirrorContract.test.ts \
  tests/taskFocusContract.test.ts \
  tests/stallPolicy.test.ts \
  tests/decisionContextLayout.test.ts \
  tests/uiWorkbenchScenarios.test.ts \
  tests/requirementGraphVisible.test.ts

printf '\n[gate] 通过。npm test=快层;全量:npm run test:full(单进程,别并行跑两份;平时交 CI 三分片)。\n'
