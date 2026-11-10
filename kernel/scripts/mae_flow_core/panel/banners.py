"""面板顶部的状态横幅:独立任务等"正在发生的事"。

与 page 分家的理由:横幅是纯展示片段,没有布局与数据组装职责;
页面模块已顶到 500 行红线,再往里塞只会让它继续变成什么都装的抽屉。
"""

from .markdown import escape


def standalone_section(action):
    """独立任务横幅:有就说清在跑什么、范围确认没有、产物在哪。"""
    if not action:
        return ""
    scope = ("范围已确认 · %d 个文件" % len(action["files"])
             if action["scope_confirmed"]
             else "范围待你确认（当前为机器推断的 %d 个文件）"
                  % len(action["files"]))
    where = ('<a href="file://%s">%s</a>' % (escape(action["work_dir"]),
                                             escape(action["work_dir"]))
             if action["work_dir"] else "产物目录尚未创建")
    return ('<section class="current-action has"><h2>独立任务进行中</h2>'
            '<div class="action-card"><div class="ask-title">%s</div>'
            '<div class="ask-sub">%s · 开始于 %s</div>'
            '<div class="ask-sub">%s</div>'
            '<div class="ask-sub">本次不是完整交付流程，'
            '下面的阶段轨道与交付信息属于上一单，仅供参考。</div>'
            '</div></section>'
            % (escape(action["label"]), escape(scope),
               escape(action["created_at"] or "未知"), where))
