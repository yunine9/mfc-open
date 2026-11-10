#!/usr/bin/env bash
# export-changes.sh — 把相对 main 的所有变更打成一个 zip，外网可直接 apply
#
# 用法:
#   ./scripts/export-changes.sh              # 默认对比 main
#   ./scripts/export-changes.sh origin/main  # 指定基准
#
# 产出: changes-<时间戳>.zip
#   ├── MANIFEST.md        变更摘要 + 文件清单
#   ├── changes.patch      已跟踪文件的改动（git diff，含二进制）
#   ├── full-files/        所有变更文件的完整副本（patch 失败时的兜底）
#   ├── new-files.txt      未跟踪新文件清单
#   ├── deleted-files.txt  被删除的文件清单
#   └── apply.sh           外网一键应用脚本
#
# apply.sh 逻辑:
#   1. 优先 git apply changes.patch（干净合并，保留 git 语义）
#   2. patch 无法干净应用时回退到全量文件覆盖（full-files/）
#   3. 删除的文件按 deleted-files.txt 清理
#   正常情况下直接 ./apply.sh 即可，不需要 AI 介入。

set -euo pipefail

BASE="${1:-origin/main}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

git rev-parse --verify "$BASE" >/dev/null 2>&1 || {
  echo "错误: 基准 '$BASE' 不存在"; exit 1; }

BASE_COMMIT="$(git rev-parse "$BASE")"
BRANCH="$(git branch --show-current 2>/dev/null || echo detached)"
HEAD_SHA="$(git rev-parse --short HEAD)"
TS="$(date +%Y%m%d-%H%M%S)"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
OUTPUT="changes-${TS}.zip"

echo "基准: $BASE (${BASE_COMMIT:0:12})"
echo "来源: $BRANCH ($HEAD_SHA)"
echo ""

# ── 收集变更 ──────────────────────────────────────────────────

# patch: 已跟踪文件的全部改动（修改/删除/已暂存新增/重命名/复制，含二进制）
git diff "$BASE" --binary > "$STAGING/changes.patch"

# 变更文件清单
git diff --name-only "$BASE" > "$STAGING/changed-tracked.txt" 2>/dev/null || true
git diff --name-only "$BASE" --diff-filter=D > "$STAGING/deleted-files.txt" 2>/dev/null || true
git ls-files --others --exclude-standard > "$STAGING/new-files.txt"

# 没有任何变更就退出
if [ ! -s "$STAGING/changes.patch" ] && [ ! -s "$STAGING/new-files.txt" ]; then
  echo "没有变更（相对 $BASE）"
  exit 0
fi

# ── 复制完整文件内容（patch 失败时的兜底）──────────────────────

mkdir -p "$STAGING/full-files"

copy_file() {
  local f="$1"
  [ -z "$f" ] && return 0
  [ -f "$f" ] || return 0        # 跳过已删除的/目录
  mkdir -p "$STAGING/full-files/$(dirname "$f")"
  cp "$f" "$STAGING/full-files/$f"
}

while IFS= read -r f; do copy_file "$f"; done < "$STAGING/changed-tracked.txt"
while IFS= read -r f; do copy_file "$f"; done < "$STAGING/new-files.txt"

# ── MANIFEST.md ──────────────────────────────────────────────

MOD=$(git diff --name-only "$BASE" --diff-filter=M 2>/dev/null | wc -l)
ADD=$(git diff --name-only "$BASE" --diff-filter=A 2>/dev/null | wc -l)
DEL=$(wc -l < "$STAGING/deleted-files.txt" 2>/dev/null || echo 0)
NEW=$(wc -l < "$STAGING/new-files.txt" 2>/dev/null || echo 0)
FULL_COUNT=$(find "$STAGING/full-files" -type f | wc -l)

cat > "$STAGING/MANIFEST.md" << EOF
# 变更导出包

| 项目 | 值 |
|---|---|
| 导出时间 | $(date '+%Y-%m-%d %H:%M:%S') |
| 基准 | \`$BASE\` @ ${BASE_COMMIT:0:12} |
| 来源 | \`$BRANCH\` @ $HEAD_SHA |

## 统计

| 类型 | 数量 |
|---|---|
| 修改 | $MOD |
| 新增(已跟踪) | $ADD |
| 新增(未跟踪) | $NEW |
| 删除 | $DEL |
| 全量副本 | $FULL_COUNT |

## 文件清单

\`\`\`
$(cat "$STAGING/changed-tracked.txt" "$STAGING/new-files.txt" 2>/dev/null)
\`\`\`

## 应用方式

在目标仓库根目录执行:

\`\`\`bash
./apply.sh
\`\`\`

优先 \`git apply\`（干净合并），失败回退逐文件覆盖。
fallback 路径会先检查所有目标文件是否相对基准有本地修改，
有任何一个冲突就全部不执行，退出并报告冲突文件。
确认后用 --force 强制覆盖，或手动/AI 合并。
正常情况下（对端 main 未偏移）直接执行即可，不需要 AI 介入。
EOF

# ── apply.sh ─────────────────────────────────────────────────

cat > "$STAGING/apply.sh" << 'APPLY_EOF'
#!/usr/bin/env bash
# apply.sh — 在目标仓库根目录执行，一键应用变更
# 用法: ./apply.sh            (在仓库根目录执行)
#       ./apply.sh /path/to/repo
#       ./apply.sh --force     (跳过冲突检测，强制覆盖)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=false
TARGET_DIR=""
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) TARGET_DIR="$arg" ;;
  esac
done
TARGET_DIR="${TARGET_DIR:-$(pwd)}"
cd "$TARGET_DIR"

echo "=== 应用变更 ==="
if git rev-parse --git-dir >/dev/null 2>&1; then
  echo "当前 HEAD: $(git rev-parse --short HEAD)"
else
  echo "当前目录: 非 git 仓库（将使用全量文件覆盖）"
fi
echo ""

# ── 1. 尝试 git apply（干净合并）─────────────────────────────
if [ -s "$SCRIPT_DIR/changes.patch" ] && git apply --check "$SCRIPT_DIR/changes.patch" 2>/dev/null; then
  git apply "$SCRIPT_DIR/changes.patch"
  echo "[OK] patch 已干净应用 (git apply)"
  # 补未跟踪新文件（patch 不含这些）
  if [ -s "$SCRIPT_DIR/new-files.txt" ]; then
    while IFS= read -r f; do
      [ -f "$SCRIPT_DIR/full-files/$f" ] || continue
      mkdir -p "$(dirname "$f")"
      cp "$SCRIPT_DIR/full-files/$f" "$f"
      echo "[OK] 新增: $f"
    done < "$SCRIPT_DIR/new-files.txt"
  fi
  echo ""
  echo "=== 完成 ==="
  exit 0
fi

echo "[WARN] patch 无法干净应用（基准可能已偏移），走逐文件覆盖"
echo ""

# ── 2. 先检查所有文件，有冲突就全部不执行 ─────────────────────
if [ "$FORCE" = false ]; then
  CONFLICTS=""
  CONFLICT_COUNT=0

  # 检查已跟踪变更文件
  if [ -s "$SCRIPT_DIR/changed-tracked.txt" ]; then
    while IFS= read -r f; do
      [ -f "$SCRIPT_DIR/full-files/$f" ] || continue
      [ -f "$f" ] || continue   # 不存在的文件不算冲突
      # 目标文件与 git HEAD 基准对比:相同=安全,不同=冲突
      BASE_HASH=$(git show HEAD:"$f" 2>/dev/null | sha256sum | cut -d' ' -f1 || echo "NO_GIT")
      CURR_HASH=$(sha256sum < "$f" | cut -d' ' -f1)
      if [ "$BASE_HASH" != "NO_GIT" ] && [ "$BASE_HASH" != "$CURR_HASH" ]; then
        CONFLICTS="${CONFLICTS}  $f\n"
        CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
      fi
    done < "$SCRIPT_DIR/changed-tracked.txt"
  fi

  # 检查未跟踪新文件是否与目标同名
  if [ -s "$SCRIPT_DIR/new-files.txt" ]; then
    while IFS= read -r f; do
      [ -f "$SCRIPT_DIR/full-files/$f" ] || continue
      if [ -f "$f" ]; then
        CONFLICTS="${CONFLICTS}  $f (目标已存在同名文件)\n"
        CONFLICT_COUNT=$((CONFLICT_COUNT + 1))
      fi
    done < "$SCRIPT_DIR/new-files.txt"
  fi

  if [ "$CONFLICT_COUNT" -gt 0 ]; then
    echo "=== 检测到 $CONFLICT_COUNT 个冲突，未执行任何操作 ==="
    echo ""
    echo "冲突文件:"
    printf "$CONFLICTS"
    echo ""
    echo "选项:"
    echo "  1. 手动对比 $SCRIPT_DIR/full-files/ 里的版本与目标文件做三方合并"
    echo "  2. 确认要强制覆盖: ./apply.sh --force"
    echo "  3. 交给 AI: 把 full-files/ 里的内容和目标文件都给 AI，让它合并"
    exit 1
  fi

  echo "[OK] 冲突检查通过，所有目标文件与基准一致"
  echo ""
fi

# ── 3. 无冲突（或 --force），执行覆盖 ────────────────────────
OVERWRITTEN=0
ADDED=0

# 已跟踪变更文件
if [ -s "$SCRIPT_DIR/changed-tracked.txt" ]; then
  while IFS= read -r f; do
    [ -f "$SCRIPT_DIR/full-files/$f" ] || continue
    mkdir -p "$(dirname "$f")"
    cp "$SCRIPT_DIR/full-files/$f" "$f"
    if [ -f "$f" ]; then
      OVERWRITTEN=$((OVERWRITTEN + 1))
      echo "[OK] 覆盖: $f"
    else
      ADDED=$((ADDED + 1))
      echo "[OK] 新增: $f"
    fi
  done < "$SCRIPT_DIR/changed-tracked.txt"
fi

# 未跟踪新文件
if [ -s "$SCRIPT_DIR/new-files.txt" ]; then
  while IFS= read -r f; do
    [ -f "$SCRIPT_DIR/full-files/$f" ] || continue
    mkdir -p "$(dirname "$f")"
    cp "$SCRIPT_DIR/full-files/$f" "$f"
    ADDED=$((ADDED + 1))
    echo "[OK] 新增: $f"
  done < "$SCRIPT_DIR/new-files.txt"
fi

# 删除的文件
if [ -s "$SCRIPT_DIR/deleted-files.txt" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    rm -f "$f"
    echo "[OK] 删除: $f"
  done < "$SCRIPT_DIR/deleted-files.txt"
fi

echo ""
echo "=== 完成: 覆盖 $OVERWRITTEN, 新增 $ADDED ==="
APPLY_EOF

chmod +x "$STAGING/apply.sh"

# ── 打 zip ────────────────────────────────────────────────────

if command -v zip >/dev/null 2>&1; then
  (cd "$STAGING" && zip -r -q "$REPO_ROOT/$OUTPUT" .)
else
  python3 - "$STAGING" "$REPO_ROOT/$OUTPUT" << 'PY'
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in sorted(files):
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, src))
PY
fi

echo ""
echo "导出完成: $OUTPUT"
echo "路径:     $REPO_ROOT/$OUTPUT"
echo ""
echo "内容:"
echo "  changes.patch      $(wc -l < "$STAGING/changes.patch" 2>/dev/null || echo 0) 行"
echo "  full-files/        $FULL_COUNT 个完整文件副本"
echo "  new-files.txt      $NEW 个未跟踪新文件"
echo "  deleted-files.txt  $DEL 个删除"
echo "  apply.sh           外网一键应用"
echo ""
echo "外网用法: 解压到目标仓库根目录 → ./apply.sh"
