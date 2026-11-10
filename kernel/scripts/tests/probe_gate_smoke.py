#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针①：gate 冒烟 + v5 改动面的证据全路径。

与 test_*.py 的单元测试互补，两部分：
1. gate 拦/放黑盒抽样（真实 CLI 子进程）：源码步放行/非源码步拦、领域真相源
   只读、领域归档步 docs/specs 可写、旧变更单兼容写入。
2. 证据函数全路径（selftest 同款 importlib 直调）：spec_validate 八路、
   tasks_checked 四路、glob/glob_absent 双布局。

风格同 selftest（check 打印 + 退出码），selftest 点名跑本探针。
注意：第 2 部分会 os.chdir 进临时仓，探针独立进程跑，不污染调用方。
"""
import json
import os
import subprocess
import sys
import tempfile
import time

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAE = os.path.join(SCRIPTS, "mae-flow.py")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
from mae_flow_core import cli_runtime as mf
# 非 UTF-8 控制台(公司 GBK 机器)下中文输出会编码崩——dispatch 同款自愈。
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
PASS = 0
FAIL = []


def check(name, ok, detail=""):
    global PASS
    print(("✅ " if ok else "❌ ") + name + ((" — " + detail) if detail and not ok else ""))
    if ok:
        PASS += 1
    else:
        FAIL.append(name)


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def make_repo(base, name, current, cn="probe-x", workflow="full"):
    root = os.path.join(base, name)
    os.makedirs(root, exist_ok=True)
    subprocess.run(["git", "init", "-q", root], check=True, capture_output=True)
    write(root, ".mae-flow.json", json.dumps({
        "current": current,
        "config": {"CHANGE_NAME": cn, "单号": "REQ probe"},
        "choices": {"workflow": workflow},
        "history": [],
        "started": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False))
    return root


def gate(root, kind, target):
    return subprocess.run([sys.executable, MAE, "gate", kind, target],
                          cwd=root, text=True, capture_output=True, timeout=120)


DELTA = ("## ADDED Requirements\n\n### Requirement: Probe rule\n"
         "The system SHALL do the probed thing.\n\n"
         "#### Scenario: Works\n- **WHEN** probed\n- **THEN** it works\n")
GOOD_DOC = ("# 变更：probe-x\n\n# 为什么\n\n动机。\n\n# 规格条目：dom\n\n"
            + DELTA + "\n# 方案\n\n方案结论。\n\n# 实现清单\n\n- [x] 1. 完成\n")


def main():
    base_ctx = tempfile.TemporaryDirectory(prefix="mae-probe-gate ")
    base = base_ctx.name

    # ---------- 1. gate 拦/放 ----------
    root = make_repo(base, "g1", "build")
    r = gate(root, "edit", "src/foo.c")
    check("build 步改源码放行", r.returncode == 0, r.stdout + r.stderr)
    r = gate(root, "edit", "docs/specs/dom.md")
    check("build 步改真相源放行(拦截已退役,交付清单在提交那一刻把关)",
          r.returncode == 0, r.stdout + r.stderr)
    r = gate(root, "edit", "openspec/changes/probe-x/change.md")
    check("build 步改本单 change.md 放行", r.returncode == 0, r.stdout + r.stderr)
    # 2026-08-25 编排瘦身:UT 由主 Agent 在宽 build 步随实现自由编写,
    # 抢跑提醒随 verify_ut 编排一同退役——新建与修改测试都必须干净放行。
    write(root, "tests/test_old.py", "def test_old():\n    pass\n")
    r = gate(root, "edit", "tests/test_old.py")
    check("build 步改已有测试放行", r.returncode == 0, r.stdout + r.stderr)
    r = gate(root, "edit", "tests/test_new.py")
    check("build 步新建测试文件放行且无提醒", r.returncode == 0,
          r.stdout + r.stderr)
    root = make_repo(base, "g2", "open")
    # 步骤级"本步禁改源码"2026-08-28 整体退役(编码阶段自由):
    # workflow 已选定后 open/grill 等中段步骤改码一律放行,
    # 完整性由头部纪律/绝对保护/提交侧范围闸把守。
    r = gate(root, "edit", "src/foo.c")
    check("open 步改源码放行(步骤级红线已退役)",
          r.returncode == 0, r.stdout + r.stderr)
    r = gate(root, "bash", "sed -i s/a/b/ src/foo.c")
    check("open 步 Bash 写源码同一条自由",
          r.returncode == 0, r.stdout + r.stderr)
    r = gate(root, "edit", "openspec/changes/probe-x/change.md")
    check("open 步写 change.md 放行", r.returncode == 0, r.stdout + r.stderr)
    root = make_repo(base, "g3", "domain_archive")
    r = gate(root, "edit", "docs/specs/dom.md")
    check("领域归档步写真相源放行", r.returncode == 0, r.stdout + r.stderr)

    # ---------- 1b. 提交链拦截时机(用户实战黑事件回归) ----------
    # 黑事件:git add openspec/.../proposal.md 的 "md" 曾误命中 mkdir 的 cmd
    # 别名,被拦"手动创建",而 clean_paths 证据又要求必须提交——门禁与证据
    # 互锁卡死。v5 的 change.md 同形态必须同样安全。
    def gate_bash(root, cmd):
        return subprocess.run([sys.executable, MAE, "gate", "bash", cmd],
                              cwd=root, text=True, capture_output=True,
                              timeout=120)
    root = make_repo(base, "gb", "archive")
    for cmd, expect_ok, name in (
            ("git add openspec/changes/probe-x/proposal.md", True,
             "黑事件原型:提交 proposal.md 放行"),
            ("git add openspec/changes/probe-x/change.md", True,
             "v5 同形态:提交 change.md 放行"),
            ('git add openspec/ && git commit -m "[REQ probe][fix]归档"', True,
             "整目录提交不再由流程文件分类否决"),
            ("mkdir openspec/changes/fake", True,
             "手动创建 openspec 不再拦(历史包袱规则已退役)"),
            ('git commit -m "错误格式"', True,
             "提交说明格式不再阻断本地提交"),
            ('git commit --message="错误格式"', True,
             "--message= 长参数形态同样放行"),
            ('git commit -m "[REQ probe][fix]合规提交"', True,
             "合规提交放行")):
        r = gate_bash(root, cmd)
        ok = (r.returncode == 0) == expect_ok
        check("提交链: " + name, ok, (r.stdout + r.stderr)[-150:])

    # ---------- 1c. 来源/产物分类不再否决本地提交或擅改暂存区 ----------
    root = make_repo(base, "artifact-strong", "build")
    write(root, "build/CMakeFiles/Foo.dir/Foo.cpp.o", "binary-ish")
    subprocess.run(
        ["git", "add", "build/CMakeFiles/Foo.dir/Foo.cpp.o"],
        cwd=root, check=True, capture_output=True)
    r = gate_bash(root, 'git commit -m "[REQ probe][fix]编译修复"')
    check("提交产物:新增 .o/CMakeFiles 不触发分类否决",
          r.returncode == 0,
          (r.stdout + r.stderr)[-300:])

    root = make_repo(base, "artifact-compound", "build")
    write(root, "module/cache/Foo.obj", "binary-ish")
    r = gate_bash(
        root,
        'git add module/cache/Foo.obj && git commit -m "[REQ probe][fix]编译修复"')
    check("提交产物:复合 add+commit 不因文件来源被拦",
          r.returncode == 0,
          (r.stdout + r.stderr)[-300:])

    root = make_repo(base, "artifact-direct-write", "build")
    write(root, "build/CMakeFiles/Foo.dir/Foo.cpp.o", "intentional-fixture")
    write(root, ".mae-flow.json.agent-writes", json.dumps({
        "paths": {
            "build/CMakeFiles/Foo.dir/Foo.cpp.o": {
                "at": "2026-07-26 12:00:00", "tool": "file-write",
            },
        },
    }, ensure_ascii=False))
    subprocess.run(
        ["git", "add", "build/CMakeFiles/Foo.dir/Foo.cpp.o"],
        cwd=root, check=True, capture_output=True)
    r = gate_bash(root, 'git commit -m "[REQ probe][fix]测试夹具"')
    check("提交候选:Agent 明确写过的产物正常放行",
          r.returncode == 0,
          (r.stdout + r.stderr)[-300:])

    root = make_repo(base, "artifact-ambiguous", "build")
    write(root, "dist/app.js", "console.log('release');\n")
    subprocess.run(
        ["git", "add", "dist/app.js"], cwd=root, check=True, capture_output=True)
    r = gate_bash(root, 'git commit -m "[REQ probe][fix]发布产物"')
    out = r.stdout + r.stderr
    check("提交产物:来源记录缺失不制造额外授权",
          r.returncode == 0 and "拦截编号" not in out,
          out[-300:])

    root = make_repo(base, "artifact-source", "build")
    write(root, "src/Foo.cpp", "int foo() { return 1; }\n")
    subprocess.run(
        ["git", "add", "src/Foo.cpp"], cwd=root, check=True, capture_output=True)
    r = gate_bash(root, 'git commit -m "[REQ probe][fix]正常源码"')
    check("提交候选:未记录的正常源码正常放行",
          r.returncode == 0,
          (r.stdout + r.stderr)[-300:])

    root = make_repo(base, "compile-side-effect", "build")
    generated = "internal/generated/build.properties"
    write(root, generated, "compiled=true\n")
    write(root, ".mae-flow.json.agent-writes", json.dumps({
        "paths": {},
        "compile_side_effects": {
            generated: {"task_sha256": "compile-probe"},
        },
    }, ensure_ascii=False))
    r = gate_bash(
        root,
        'git add internal/generated/build.properties && git commit -m "[REQ probe][fix]编译副作用"')
    check("提交产物:COMPILE 副作用记录不否决精确提交",
          r.returncode == 0,
          (r.stdout + r.stderr)[-300:])

    root = make_repo(base, "compile-side-effect-staged", "build")
    subprocess.run(
        ["git", "-c", "user.email=probe@test.invalid",
         "-c", "user.name=Probe Gate", "commit", "--allow-empty", "-qm", "base"],
        cwd=root, check=True, capture_output=True)
    generated = "internal/generated/staged.properties"
    write(root, generated, "compiled=true\n")
    write(root, ".mae-flow.json.agent-writes", json.dumps({
        "paths": {},
        "compile_side_effects": {generated: {"task_sha256": "compile-probe"}},
    }, ensure_ascii=False))
    subprocess.run(["git", "add", generated], cwd=root, check=True,
                   capture_output=True)
    r = gate_bash(root, 'git commit -m "[REQ probe][fix]编译副作用"')
    output = r.stdout + r.stderr
    check("提交产物:已暂存 COMPILE 副作用不阻断、不签发额外许可",
          r.returncode == 0
          and generated in subprocess.check_output(
              ["git", "diff", "--cached", "--name-only"], cwd=root, text=True)
          and not os.path.exists(os.path.join(root, ".mae-flow.json.gate-strikes"))
          and not os.path.exists(os.path.join(root, ".mae-flow.json.gate-permits")),
          output[-300:])
    subprocess.run(["git", "restore", "--staged", "--", generated], cwd=root,
                   check=True, capture_output=True)
    r = gate_bash(root, 'git commit -m "[REQ probe][fix]已纠正"')
    check("提交产物:restore 后本地文件保留且下一次提交门禁放行",
          r.returncode == 0 and os.path.isfile(os.path.join(root, generated)),
          (r.stdout + r.stderr)[-300:])

    root = make_repo(base, "compile-side-effect-compound", "build")
    generated = "internal/generated/compound.properties"
    write(root, generated, "compiled=true\n")
    write(root, ".mae-flow.json.agent-writes", json.dumps({
        "paths": {},
        "compile_side_effects": {generated: {"task_sha256": "compile-probe"}},
    }, ensure_ascii=False))
    r = gate_bash(
        root,
        'git add internal/generated/compound.properties && git commit -m "[REQ probe][fix]编译副作用"')
    output = r.stdout + r.stderr
    staged = subprocess.run(
        ["git", "diff", "--cached", "--name-only"], cwd=root, text=True,
        check=True, capture_output=True).stdout
    check("提交产物:复合命令放行且预检不替 Agent 暂存文件",
          r.returncode == 0 and not staged.strip(),
          output[-300:])

    root = make_repo(base, "compile-side-effect-many", "build")
    generated_paths = ["internal/generated/output-%d.properties" % index
                       for index in range(9)]
    for generated in generated_paths:
        write(root, generated, "compiled=true\n")
    write(root, ".mae-flow.json.agent-writes", json.dumps({
        "paths": {},
        "compile_side_effects": {
            generated: {"task_sha256": "compile-probe"}
            for generated in generated_paths
        },
    }, ensure_ascii=False))
    subprocess.run(["git", "add", *generated_paths], cwd=root, check=True,
                   capture_output=True)
    r = gate_bash(root, 'git commit -m "[REQ probe][fix]编译副作用"')
    output = r.stdout + r.stderr
    staged = subprocess.check_output(
        ["git", "diff", "--cached", "--name-only"], cwd=root, text=True).splitlines()
    check("提交产物:批量 COMPILE 副作用放行且暂存清单原样保留",
          r.returncode == 0 and set(staged) == set(generated_paths),
          output[-600:])

    # ---------- 2. 证据全路径（importlib 直调，selftest 同款） ----------
    def st(cn="probe-x"):
        return {"config": {"CHANGE_NAME": cn}, "choices": {"workflow": "full"}}

    root = make_repo(base, "ev", "open")
    os.chdir(root)
    write(root, "openspec/config.yaml", "schema: spec-driven\n")

    # spec_validate 八路
    write(root, "openspec/changes/probe-x/change.md",
          "# 为什么\n\nx\n\n# 实现清单\n\n- [ ] 1. x\n")
    ok, why = mf.ev_spec_validate({}, st())
    check("spec_validate: full 无 delta 拒", not ok and "change.md" in why, why)
    write(root, "openspec/changes/probe-x/change.md", GOOD_DOC)
    ok, why = mf.ev_spec_validate({}, st())
    check("spec_validate: 合法 v5 过", ok, why)
    write(root, "openspec/changes/probe-x/change.md",
          GOOD_DOC.replace("动机。", "（待填：动机）"))
    ok, why = mf.ev_spec_validate({}, st())
    check("spec_validate: （待填 残留拒", not ok and "待填" in why, why)
    write(root, "openspec/changes/probe-x/change.md",
          GOOD_DOC.replace("方案结论。", "（待设计：xx）"))
    ok, why = mf.ev_spec_validate({}, st())
    check("spec_validate: 默认不拦（待设计", ok, why)
    ok, why = mf.ev_spec_validate({"placeholders": ["（待填", "（待设计"]}, st())
    check("spec_validate: design 步配置拦（待设计", not ok and "待设计" in why, why)
    # allow_empty 是 hotfix/tweak 档的配置,必须节检查按真实档位走
    def st_hotfix(cn="probe-x"):
        return {"config": {"CHANGE_NAME": cn}, "choices": {"workflow": "hotfix"}}
    write(root, "openspec/changes/probe-x/change.md",
          "# 为什么\n\nx\n\n# 实现清单\n\n- [x] 1. x\n")
    ok, why = mf.ev_spec_validate({"allow_empty": True}, st_hotfix())
    check("spec_validate: allow_empty 无 delta 过(hotfix 档)", ok, why)
    # 必须节接线:full 档缺规格条目/方案节被拒(V5_TIER_REQUIRED 不再是死常量)
    ok, why = mf.ev_spec_validate({"allow_empty": True}, st())
    check("spec_validate: full 档缺必须节拒", not ok and "必须小节" in why, why)
    write(root, "openspec/changes/probe-x/change.md",
          "# 为什么\n\nx\n\n# 规格条目：dom\n\n## ADDED Requirements\n\n"
          "### Requirement: Bad\nNo keyword here.\n\n#### Scenario: s\n- x\n\n"
          "# 实现清单\n\n- [x] 1. x\n")
    ok, why = mf.ev_spec_validate({"allow_empty": True}, st_hotfix())
    check("spec_validate: allow_empty 有非法 delta 仍拒", not ok, why)
    write(root, "openspec/changes/probe-x/tasks.md", "- [ ] 1. old\n")
    write(root, "openspec/changes/probe-x/change.md", GOOD_DOC)
    ok, why = mf.ev_spec_validate({}, st())
    check("spec_validate: 布局混用拒", not ok and "混用" in why, why)
    os.remove(os.path.join(root, "openspec/changes/probe-x/tasks.md"))
    # 坏编码 change.md:证据必须"拒+可读指引"而不是裸 traceback(核心原则:
    # 流畅易用,不能因 hook/证据卡死;done 连拒自动亮 goto --force 出口)
    with open(os.path.join(root, "openspec/changes/probe-x/change.md"),
              "wb") as fh:
        fh.write("# 为什么\n\n动机".encode("gbk") + b"\xff\xfe\n")
    try:
        ok, why = mf.ev_spec_validate({}, st())
        check("spec_validate: 坏编码不 crash 且给指引",
              not ok and "UTF-8" in why, why)
        ok, why = mf.ev_tasks_checked({}, st())
        check("tasks_checked: 坏编码不 crash", not ok, why)
    except Exception as exc:
        check("spec_validate: 坏编码不 crash 且给指引", False, repr(exc))
        check("tasks_checked: 坏编码不 crash", False, repr(exc))
    r = subprocess.run([sys.executable, MAE, "spec", "validate"],
                       cwd=root, text=True, capture_output=True, timeout=120)
    check("CLI validate: 坏编码优雅报错(退出码 2 非 traceback)",
          r.returncode == 2 and "Traceback" not in r.stderr, r.stderr[-300:])
    write(root, "openspec/changes/probe-x/change.md", GOOD_DOC)

    # tasks_checked 四路
    write(root, "openspec/changes/probe-x/change.md",
          GOOD_DOC.replace("- [x] 1. 完成", "- [ ] 1. 未完成"))
    ok, why = mf.ev_tasks_checked({}, st())
    check("tasks_checked: v5 未勾拒且指向实现清单节",
          not ok and "实现清单" in why, why)
    write(root, "openspec/changes/probe-x/change.md", GOOD_DOC)
    ok, why = mf.ev_tasks_checked({}, st())
    check("tasks_checked: v5 全勾过", ok, why)
    write(root, "openspec/changes/legacy-x/tasks.md", "- [ ] 1. a\n- [x] 2. b\n")
    ok, why = mf.ev_tasks_checked({}, st("legacy-x"))
    check("tasks_checked: legacy 未勾拒且指向 tasks.md",
          not ok and "tasks.md" in why, why)
    ok, why = mf.ev_tasks_checked({}, st("no-such-change"))
    check("tasks_checked: 单不存在拒", not ok, why)

    # glob 双认 + glob_absent
    ok, why = mf.ev_glob({"any": ["openspec/changes/probe-x/change.md",
                                  "openspec/changes/probe-x/proposal.md"]}, st())
    check("glob: v5 change.md 命中双认清单", ok, why)
    ok, why = mf.ev_glob_absent(
        {"any": ["openspec/changes/probe-x/change.md",
                 "openspec/changes/probe-x/proposal.md",
                 "openspec/changes/probe-x/tasks.md"]}, st())
    check("glob_absent: change.md 残留拒(假定稿拦截)", not ok, why)
    import shutil as _sh
    _sh.rmtree(os.path.join(root, "openspec/changes/probe-x"))
    ok, why = mf.ev_glob_absent(
        {"any": ["openspec/changes/probe-x/change.md",
                 "openspec/changes/probe-x/proposal.md",
                 "openspec/changes/probe-x/tasks.md"]}, st())
    check("glob_absent: 移走后过", ok, why)

    # ---------- 3. 覆盖口径:CodeCheck 告警按本次修改行±3 过滤 ----------
    root = os.path.join(base, "scope")
    os.makedirs(root)
    subprocess.run(["git", "init", "-q", "-b", "main", root],
                   check=True, capture_output=True)
    gitc = ["git", "-c", "user.email=probe@test", "-c", "user.name=probe", "-C", root]
    src = os.path.join(root, "src")
    os.makedirs(src)
    with open(os.path.join(src, "a.c"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("".join("line %d\n" % i for i in range(1, 21)))
    subprocess.run(gitc + ["add", "-A"], check=True, capture_output=True)
    subprocess.run(gitc + ["commit", "-q", "-m", "base"], check=True,
                   capture_output=True)
    subprocess.run(gitc + ["checkout", "-q", "-b", "work"], check=True,
                   capture_output=True)
    content = ["line %d\n" % i for i in range(1, 21)]
    content[9] = "changed 10\n"
    content[10] = "changed 11\n"
    with open(os.path.join(src, "a.c"), "w", encoding="utf-8", newline="\n") as fh:
        fh.write("".join(content))
    subprocess.run(gitc + ["commit", "-aqm", "change"], check=True,
                   capture_output=True)
    os.chdir(root)
    st_scope = {"config": {"基线分支": "main", "CHANGE_NAME": "x"},
                "choices": {"workflow": "hotfix"}}
    changed, err = mf._changed_lines(st_scope, ["src/a.c"])
    check("范围口径: _changed_lines 解析变更行",
          not err and changed.get("src/a.c") == {10, 11}, str((changed, err)))
    result = {"total": 3, "pairs": [
        ("RuleA", "src/a.c", 11),    # 变更行内 → 保留
        ("RuleB", "src/a.c", 13),    # 窗口内(11+3) → 保留(近似"改动所在函数")
        ("RuleC", "src/a.c", 1),     # 存量行 → 滤除
    ], "commands": []}
    filtered, stock = mf._filter_codecheck_with_repository_facts(
        result, st_scope, ["src/a.c"])
    check("范围口径: 本次修改±3 内保留、存量滤除",
          filtered["total"] == 2 and stock == 1
          and all(r != "RuleC" for r, _f, _l in filtered["pairs"]),
          str((filtered, stock)))
    nodetail = {"total": 2, "pairs": [("R", "src/a.c", None),
                                      ("R2", "src/a.c", 5)], "commands": []}
    filtered, stock = mf._filter_codecheck_with_repository_facts(
        nodetail, st_scope, ["src/a.c"])
    check("范围口径: 明细缺行号保守全算(不静默漏报)",
          filtered["total"] == 2 and stock is None, str((filtered, stock)))

    # ---------- 4. 升级阈值机器化 + 环节裁剪 ----------
    ok, why = mf.ev_tier_scope({}, {"config": {"基线分支": "main"},
                                    "choices": {"workflow": "tweak"}})
    check("tier_scope: 限内(1 文件)放行", ok, why)
    for i in range(6):
        with open(os.path.join(src, "f%d.c" % i), "w", encoding="utf-8",
                  newline="\n") as fh:
            fh.write("int v%d = %d;\n" % (i, i))
    subprocess.run(gitc + ["add", "-A"], check=True, capture_output=True)
    subprocess.run(gitc + ["commit", "-qm", "more files"], check=True,
                   capture_output=True)
    st_tw = {"config": {"基线分支": "main"}, "choices": {"workflow": "tweak"}}
    ok, why = mf.ev_tier_scope({}, st_tw)
    check("tier_scope: tweak 超 5 文件拒且报出路",
          not ok and "升级阈值" in why and "accept-risk" in why, why)
    ok, why = mf.ev_tier_scope({}, {"config": {"基线分支": "main"},
                                    "choices": {"workflow": "full"}})
    check("tier_scope: full 档不限", ok, why)

    os.chdir(os.path.expanduser("~"))
    base_ctx.cleanup()
    print("\n探针①通过 %d 项, 失败 %d 项" % (PASS, len(FAIL)))
    if FAIL:
        print("失败: " + ", ".join(FAIL))
        sys.exit(1)


if __name__ == "__main__":
    main()
