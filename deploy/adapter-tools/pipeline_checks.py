"""CodeHub 检查事实：报告生成不等于测试执行，两条适配路径共用。"""
import re

TOOL_DIMENSION = {
    'CloudBuild2.0': 'COMPILE', 'build2.0': 'COMPILE',
    'codecheck': 'CODECHECK', 'CodeCheck': 'CODECHECK',
    'CodeCheckForTest': 'CODECHECK', 'codechecktest': 'CODECHECK',
    'SuperChecker': 'CODECHECK', 'CPP_UT': 'UT',
}
STATUS_PRIORITY = {'failed': 60, 'running': 50, 'pending': 40,
                   'canceled': 30, 'success': 20, 'skipped': 10, 'not_run': 5}


def report_stage(row):
    stage = row.get('stage') or row.get('stage_name') or ''
    if isinstance(stage, dict):
        stage = stage.get('name', '')
    return bool(re.search(r'review[\s_-]*tips?', str(stage), re.I))


def metrics_of(row):
    return [m for m in (row.get('metrics') or []) if isinstance(m, dict)]


def exceeded(metric):
    return metric.get('exceeded') is True or str(metric.get('exceeded')).lower() == 'true'


def report_only(row):
    if report_stage(row):
        return True
    metrics = metrics_of(row)
    # 老 CLI 不回 stage，但 ut_json 等指标只有报告地址，仍不是执行结果。
    return bool(metrics) and all(
        re.match(r'^https?://', str(m.get('real', '')).strip())
        or re.search(r'(?:_json|_url)$', str(m.get('field', '')), re.I)
        for m in metrics)


def metric_details(row):
    tool = str(row.get('tool') or row.get('tool_name') or '')
    return [{
        'message': f"{m['field']}={m.get('real', '')}(期望{m.get('expected', '')})"
                   + (' [超限]' if exceeded(m) else ''),
        'tool': tool, 'rule': 'quality_metric',
        **({'severity': 'error'} if exceeded(m) else {}),
    } for m in metrics_of(row) if m.get('field')]


def quality_check(row, statuses):
    tool = str(row.get('tool') or row.get('tool_name') or '')
    dimension = TOOL_DIMENSION.get(tool)
    if not dimension or report_only(row):
        return None
    # 只有一个 CPP_UT 工具状态、没有任何测试指标，也不能证明 UT 执行。
    if tool == 'CPP_UT' and not metrics_of(row):
        return None
    status = statuses.get(str(row.get('status') or '').lower(), 'pending')
    if any(exceeded(m) for m in metrics_of(row)):
        status = 'failed'
    stage = row.get('stage') or row.get('stage_name')
    if isinstance(stage, dict):
        stage = stage.get('name')
    return {
        'dimension': dimension, 'status': status, 'tool': tool, 'job': tool,
        **({'stage': str(stage)} if stage else {}),
        **({'url': str(row['log_url'])} if row.get('log_url') else {}),
        'details': metric_details(row),
    }


def report_note(row):
    tool = row.get('tool') or row.get('tool_name') or row.get('name') or '?'
    label = '报告生成状态' if report_only(row) else '工具状态'
    return (f"{tool}: {label}={row.get('status', '未知')}；"
            '未提供可确认的测试执行结果，不能据此判断 UT 通过或覆盖率达标。')


def merge_check(picked, candidate):
    dimension = candidate['dimension']
    old = picked.get(dimension)
    if old is None:
        picked[dimension] = candidate
        return
    winner = (candidate if STATUS_PRIORITY.get(candidate['status'], 0)
              > STATUS_PRIORITY.get(old['status'], 0) else old)
    # 同状态也补充明细；换成更严重状态也不丢另一工具的失败指标。
    details = []
    for detail in [*(old.get('details') or []), *(candidate.get('details') or [])]:
        if detail not in details:
            details.append(detail)
    picked[dimension] = {**winner, **({'details': details} if details else {})}


def checks_from_stages(stages, statuses):
    picked = {}
    rules = [(r'\but\b|unit[_-]?test|llt|coverage', 'UT'),
             (r'codecheck|codecheck|superchecker|lint', 'CODECHECK'),
             (r'build|compile|maven|cmake|package', 'COMPILE')]
    for stage in stages or []:
        stage_name = str(stage.get('name') or '')
        for job in stage.get('jobs') or []:
            if report_stage({'stage': stage_name}) or report_stage(job):
                continue
            name = str(job.get('name') or '')
            dimension = TOOL_DIMENSION.get(name)
            if not dimension:
                dimension = next((d for p, d in rules if re.search(p, name, re.I)), None)
            if not dimension:
                dimension = next((d for p, d in rules if re.search(p, stage_name, re.I)), None)
            if not dimension:
                continue
            raw = str(job.get('status') or '').lower()
            if raw not in statuses:
                raise ValueError(f'job {name} 状态 {raw!r} 不认识')
            merge_check(picked, {
                'dimension': dimension, 'status': statuses[raw],
                'job': name, 'tool': name, 'stage': stage_name,
                **({'url': str(job['web_url'])} if job.get('web_url') else {}),
            })
    return picked
