#!/usr/bin/env bash
# 重启演练(上线自查清单第 6 项的可执行版):真实地杀进程再重启,
# 验证"进程可死任务不死"——等待人工的任务跨进程存活,决定走重建
# 会话续跑到完成。
#
# 与 tests/recovery.test.ts 的区别:那是进程内语义测试;这里起的是
# 真 serve 进程,真 kill -9,真 HTTP。假模型网关(scripted-gateway)
# 独立进程,比 serve 活得久——杀的是服务,不是模型。
#
# 纪律:所有进程按记下的 PID 精确收尾,绝不 pkill 大面积扫射;
# 退出码真实核验;失败保留现场目录并打印路径。
set -u
cd "$(dirname "$0")/.."

PORT=8796
BASE="http://127.0.0.1:$PORT"
DRILL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mfc-restart-drill-XXXXXX")
DATA_DIR="$DRILL_DIR/data"
# 不用 node_modules/.bin/tsx:它会再 spawn 一个子 node,kill 包装
# 进程会留下孤儿监听(实测)。node --import tsx 直跑;函数放后台时
# bash 会 fork 子 shell,必须 exec 让子 shell 变身 node 本体,
# $! 才是真正要杀的进程(两坑都实测踩过)。
tsx_run() { exec node --import tsx "$@"; }
# serve 后来加了"首次启动必须注入管理员密码",这个脚本自建立起没动过,
# 于是上线清单第 6 项其实一直跑不起来(2026-08-22 发现)。演练用的是
# 一次性数据目录,密码不外泄也不复用。
export MAE_FLOW_ADMIN_USER="${MAE_FLOW_ADMIN_USER:-admin}"
export MAE_FLOW_ADMIN_PASSWORD="${MAE_FLOW_ADMIN_PASSWORD:-drill-only-passw0rd}"
GATEWAY_PID=""; SERVE_PID=""
FAILED=0

# 服务后来加了本地登录,业务 API 一律要会话 cookie。演练脚本原来直接
# 裸 curl,于是 POST /tasks 只拿得到 401(2026-08-22 和密码要求一起发现)。
COOKIE_JAR="$DRILL_DIR/cookies.txt"
req() { curl -s --noproxy '*' -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$@"; }

login() { # login <账号> <密码>
  req -X POST "$BASE/auth/login" -H 'content-type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | grep -q '"username"'
}

# 角色分离后管理员不发起任务(第三处陈旧,同日发现):管理员只配置和
# 管账号,下单必须用开发者账号。演练照真流程走一遍,而不是绕过它。
DEV_USER="drill-dev"
DEV_PASSWORD="drill-only-passw0rd"
ensure_developer() {
  login "$MAE_FLOW_ADMIN_USER" "$MAE_FLOW_ADMIN_PASSWORD" || return 1
  # 已存在会 400,那不是错——重启后第二次调用走的就是这条路。
  req -X POST "$BASE/auth/users" -H 'content-type: application/json' \
    -d "{\"username\":\"$DEV_USER\",\"password\":\"$DEV_PASSWORD\",\"role\":\"developer\"}" \
    > /dev/null
  login "$DEV_USER" "$DEV_PASSWORD"
}

say()  { echo "$@"; }
ok()   { say "✅ $1"; }
bad()  { say "❌ $1"; FAILED=1; finish; }

finish() {
  # 只杀自己记下的 PID;kill 不到(已死)不算错。
  [ -n "$SERVE_PID" ] && kill -9 "$SERVE_PID" 2>/dev/null
  [ -n "$GATEWAY_PID" ] && kill -9 "$GATEWAY_PID" 2>/dev/null
  if [ "$FAILED" -eq 0 ]; then
    rm -rf "$DRILL_DIR"
    say "🎉 重启演练全绿:进程可死,任务不死。"
    exit 0
  fi
  say "现场保留供排查: $DRILL_DIR (serve1.log / serve2.log / gateway.log / data/)"
  exit 1
}

wait_until() { # wait_until <描述> <秒数> <函数名>
  local what=$1 budget=$2 probe=$3
  local deadline=$(( $(date +%s) + budget ))
  until "$probe"; do
    [ "$(date +%s)" -gt "$deadline" ] && return 1
    sleep 0.3
  done
}

task_json() { req "$BASE/tasks/$TASK_ID"; }
task_field() { # task_field <字段路径>
  task_json | python3 -c "
import json, sys
try:
    value = json.load(sys.stdin)
except Exception:
    value = None
for key in '$1'.split('.'):
    value = (value or {}).get(key)
print(value if value is not None else '')"
}

serve_up()       { req -o /dev/null "$BASE/tasks"; }
serve_down()     { ! serve_up; }
task_waiting()   { task_json | grep -q waiting_for_human; }
task_completed() { task_json | grep -q '"completed"'; }
gateway_ready()  { test -s "$DRILL_DIR/modelsB.json"; }

say "== 重启演练(现场: $DRILL_DIR) =="

# 1. 假模型网关(独立进程,比 serve 活得久)
tsx_run harness/scripted-gateway.ts \
  "$DRILL_DIR/modelsA.json" "$DRILL_DIR/modelsB.json" \
  > "$DRILL_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
disown "$GATEWAY_PID" # kill -9 是剧本的一部分,不要 bash 的讣告刷屏
wait_until "网关就绪" 15 gateway_ready \
  || bad "1. 假模型网关没起来(gateway.log)"
ok "1. 假模型网关就绪(PID $GATEWAY_PID)"

# 2. 前世 serve:真模型模式(--models)=保数据、可恢复
tsx_run src/serve.ts --models "$DRILL_DIR/modelsA.json" \
  --provider maeflow --model scripted-v1 \
  --port "$PORT" --data "$DATA_DIR" > "$DRILL_DIR/serve1.log" 2>&1 &
SERVE_PID=$!
disown "$SERVE_PID"
wait_until "serve#1 就绪" 20 serve_up || bad "2. serve#1 没起来(serve1.log)"
ensure_developer || bad "2. 建开发者账号/登录失败(serve1.log)"

TASK_ID=$(req -X POST "$BASE/tasks" -H 'content-type: application/json' \
  -d '{"requirement":"重启演练:等待人工时杀进程"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])") \
  || bad "2. 发任务失败(serve1.log)"
[ -n "$TASK_ID" ] || bad "2. 发任务没拿到任务号"
wait_until "任务进入等待人工" 30 task_waiting \
  || bad "2. 任务没走到等待人工(serve1.log)"
WAITING_ID=$(task_field "waiting.waiting_id")
STATE_VERSION=$(task_field "waiting.state_version")
ok "2. 任务 $TASK_ID 等待人工(waiting_id=$WAITING_ID)"

# 3. 崩溃:kill -9,不给任何收尾机会
kill -9 "$SERVE_PID" || bad "3. 杀不掉 serve#1"
wait_until "端口释放" 10 serve_down || bad "3. 端口没释放"
ok "3. serve#1 已被 kill -9(PID $SERVE_PID)"

# 4. 今生 serve:同数据目录恢复
tsx_run src/serve.ts --models "$DRILL_DIR/modelsB.json" \
  --provider maeflow --model scripted-v1 \
  --port "$PORT" --data "$DATA_DIR" > "$DRILL_DIR/serve2.log" 2>&1 &
SERVE_PID=$!
disown "$SERVE_PID"
wait_until "serve#2 就绪" 20 serve_up || bad "4. serve#2 没起来(serve2.log)"
ensure_developer || bad "4. serve#2 登录失败(serve2.log)"
STATUS=$(task_field "status")
RESTORED_WAITING=$(task_field "waiting.waiting_id")
[ "$STATUS" = "waiting_for_human" ] \
  || bad "4. 重启后任务状态是 $STATUS,不是 waiting_for_human"
[ "$RESTORED_WAITING" = "$WAITING_ID" ] \
  || bad "4. 重启后 waiting_id 变了($RESTORED_WAITING ≠ $WAITING_ID)"
ok "4. 重启后任务还在、待办原样($STATUS / $WAITING_ID)"

# 5. 决定 → 重建会话续跑到完成
HTTP=$(req -o /dev/null -w "%{http_code}" -X POST \
  "$BASE/tasks/$TASK_ID/decision" -H 'content-type: application/json' \
  -d "{\"state_version\":$STATE_VERSION,\"decision\":\"确认\",\"notes\":\"重启演练\"}")
[ "$HTTP" = "200" ] || bad "5. 决定提交失败 HTTP $HTTP(serve2.log)"
wait_until "重建会话续跑到完成" 30 task_completed \
  || bad "5. 决定后没跑到 completed(serve2.log)"
ok "5. 决定生效,重建会话续跑到 completed"

finish
