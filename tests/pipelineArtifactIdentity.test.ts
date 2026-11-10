import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// pipeline-detail 走 GitLab MR 端点(返回 sha/pipeline_id)，用
// require_pipeline_identity 检查版本归属；pipeline-info/codecheck 走
// CodeCheck 质量端点(返回 {pipelineStatus, defects}，无 sha)，改由
// require_codecheck_identity 检查前置版本确认。两套 guard 不可混用——
// b4141066 用 GitLab 字段 guard CodeCheck 格式，pipeline-info/codecheck
// 从 9-12 起全 skip，build-logs 拿不到 record_ids 全 failed(实测踩坑)。

test("采集器拒绝 MR 残留旧 SHA，按提交取证；缺少版本不猜测", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import sys
sys.path.insert(0, 'deploy/adapter-tools')
import pipeline_log as p

new, old = 'b' * 40, 'a' * 40
data = p.PipelineData('group/repo', new, 'task', 'https://codehub/group/repo/merge_requests/7')
data.project_id, data.mr_iid = 42, 7
class Context:
    def __init__(self): self.writes = {}; self.queries = []; self.info = {}
    def mcp_call(self, *args, **kwargs): return {'sha': old, 'id': 99, 'status': 'failed'}
    def fetch_json(self, url):
        self.queries.append(url)
        if '/pipelines?' in url:
            return [{'sha': old, 'id': 99, 'status': 'failed'}, {'sha': new, 'id': 100, 'status': 'running'}]
        assert url.endswith('/pipelines/100/jobs'), url
        return []
    def write_json(self, name, value): self.writes[name] = value
    def log(self, message): pass
    def sse_client(self): return self
    def get_mr_pipeline_info(self, url): return self.info
ctx = Context()
p.strategy_pipeline_detail(data, ctx)
assert data.pipeline_id == 100 and data.commit_id == new
assert ctx.writes['pipeline_detail.json']['pipeline']['sha'] == new
# pipeline-detail 的 GitLab MR guard：旧 SHA / 无效版本要 skip
for detail in ({'sha': old, 'pipeline_id': 100}, {'sha': new, 'is_valid': False}):
    saved = dict(ctx.writes)
    data2 = p.PipelineData('group/repo', new, 'task', 'https://codehub/group/repo/merge_requests/7')
    data2.project_id, data2.mr_iid = 42, 7
    ctx2 = Context()
    ctx2.queries = []
    ctx2.info = detail
    # actual_head_pipeline 返回旧 SHA → guard skip → 转 REST 降级
    ctx2.mcp_call = lambda *a, **k: detail
    p.strategy_pipeline_detail(data2, ctx2)
    # 降级后 REST 按 SHA 查到新流水线
    assert data2.commit_id == new, f'降级后应按 SHA 取新版本, got {data2.commit_id}'
`], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("CodeCheck 质量材料靠前置版本确认放行，不查不存在的 sha 字段", () => {
  const result = spawnSync("python3", ["-c", String.raw`
import sys
sys.path.insert(0, 'deploy/adapter-tools')
import pipeline_log as p

new = 'b' * 40
data = p.PipelineData('group/repo', new, 'task', 'https://codehub/group/repo/merge_requests/7')
data.project_id, data.mr_iid = 42, 7
# 前置 pipeline-detail 已确认版本：commit_id==sha, pipeline_id 已设
data.commit_id = new
data.pipeline_id = 100

class Context:
    def __init__(self): self.writes = {}; self.info = {}
    def write_json(self, name, value): self.writes[name] = value
    def log(self, message): pass
    def sse_client(self): return self
    def get_mr_pipeline_info(self, url): return self.info
    def mcp_call(self, *args, **kwargs): return self.info

# 真实 CodeCheck 质量格式：{pipelineStatus, defects}，无 sha/pipeline_id
ctx = Context()
ctx.info = {'pipelineStatus': 'failed', 'defects': [
    {'toolName': 'build2.0', 'record_ids': ['r1'], 'defectInfos': []}]}
p.strategy_pipeline_info(data, ctx)
assert ctx.writes['pipeline_info.json'] == ctx.info, 'CodeCheck 格式应放行'

# 同样格式走 codecheck 策略
ctx.writes.clear()
ctx.info = {'data': {'pipelineStatus': 'failed', 'defects': []}, 'success': True}
p.strategy_codecheck(data, ctx)
assert 'codecheck_detail.json' in ctx.writes, 'query_mr_info CodeCheck 格式应放行'

# 缺前置版本确认(模拟 pipeline-detail 没跑通)→ skip
data2 = p.PipelineData('group/repo', new, 'task', 'https://codehub/group/repo/merge_requests/7')
data2.project_id, data2.mr_iid = 42, 7
# data2.commit_id='' data2.pipeline_id=None(初始值)——前置未确认
ctx.info = {'pipelineStatus': 'failed', 'defects': []}
try:
    p.strategy_pipeline_info(data2, ctx)
    raise AssertionError('前置版本未确认却放行了 CodeCheck 材料')
except p.StrategySkipped: pass
assert 'pipeline_info.json' not in ctx.writes

# 无效内容(is_valid=False)→ skip
ctx.info = {'pipelineStatus': 'failed', 'is_valid': False}
try:
    p.strategy_pipeline_info(data, ctx)
    raise AssertionError('无效内容被放行')
except p.StrategySkipped: pass
`], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
