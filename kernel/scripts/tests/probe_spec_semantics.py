#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""探针②：spec 子命令语义端到端（v5 三档 + 布局混用 + 阶段机 + 定稿）。

与 test_*.py 的单元测试互补：这里全程黑盒跑真实 CLI（子进程 + 真实 git
临时仓 + 真实状态文件），复核用户视角的完整链路——
- hotfix 档：骨架无方案节 → 无规格轻量单 → verify-pass → archive 纯移动
- tweak 档：同上
- full 档：instructions change 的档位渲染 + 有规格单 validate/归档合并
- 布局混用拒、阶段跳跃拒、verify_result 直写拒、重复归档拒

风格同 selftest（check 打印 + 退出码），selftest 点名跑本探针。
"""
import json
import os
import subprocess
import sys
import tempfile
import time

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAE = os.path.join(SCRIPTS, "mae-flow.py")
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


def spec(root, *args):
    return subprocess.run([sys.executable, MAE, "spec", *args],
                          cwd=root, text=True, capture_output=True, timeout=120)


def write(root, rel, text):
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def read(root, rel):
    with open(os.path.join(root, rel), encoding="utf-8") as fh:
        return fh.read()


def make_repo(base, name, workflow, current="open"):
    root = os.path.join(base, name)
    os.makedirs(root)
    subprocess.run(["git", "init", "-q", root], check=True, capture_output=True)
    # CHANGE_NAME 留空:真实链路里它由 spec new 自动登记(dogfood 修复),
    # 探针顺带验证这条登记路径。
    write(root, ".mae-flow.json", json.dumps({
        "current": current,
        "config": {"CHANGE_NAME": "", "单号": "REQ probe"},
        "choices": {"workflow": workflow},
        "history": [],
        "started": time.strftime("%Y-%m-%d %H:%M:%S"),
    }, ensure_ascii=False))
    return root


CHANGE_DOC_LIGHT = (
    "# 变更：probe-%s\n\n# 为什么\n\n修一个已定位的小问题，动机说清楚。\n\n"
    "# 实现清单\n\n- [x] 1. 修改并自测\n")

DELTA = ("## ADDED Requirements\n\n### Requirement: Probe rule\n"
         "The system SHALL do the probed thing.\n\n"
         "#### Scenario: Works\n- **WHEN** probed\n- **THEN** it works\n")


def drive_to_archive(root, name):
    """init → phase design→build→verify → verify-pass → archive。返回 archive 结果。"""
    for args in (("init",), ("phase", "design"), ("phase", "build"),
                 ("phase", "verify")):
        r = spec(root, *args)
        if r.returncode != 0:
            return None, "%s 失败: %s" % (args, r.stderr)
    write(root, "docs/report.md", "# Verification\n\nAll pass.\n")
    r = spec(root, "set", "verification_report", "docs/report.md")
    if r.returncode != 0:
        return None, "set report 失败: " + r.stderr
    r = spec(root, "verify-pass")
    if r.returncode != 0:
        return None, "verify-pass 失败: " + r.stderr
    r = spec(root, "archive")
    if r.returncode != 0:
        return None, "archive 失败: " + r.stderr
    return r, ""


def main():
    with tempfile.TemporaryDirectory(prefix="mae-probe-spec ") as base:
        # --- hotfix 档 ---
        root = make_repo(base, "hf 仓", "hotfix")
        r = spec(root, "new", "probe-hotfix")
        info = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
        check("hotfix new 成功且 v5", r.returncode == 0 and info.get("layout") == "v5"
              and info.get("tier") == "hotfix", r.stderr)
        state = json.load(open(os.path.join(root, ".mae-flow.json"),
                               encoding="utf-8"))
        check("new 自动登记 CHANGE_NAME(消灭 init 鸡生蛋弯路)",
              state["config"].get("CHANGE_NAME") == "probe-hotfix",
              str(state["config"]))
        check("new 已自动初始化交付登记(phase=open,省独立 init)",
              state.get("spec", {}).get("phase") == "open"
              and state.get("spec", {}).get("initialized_at"),
              str(state.get("spec")))
        skeleton = read(root, ".mae-flow-work/spec/changes/probe-hotfix/change.md")
        check("hotfix 骨架无方案节", "# 方案" not in skeleton)
        check("hotfix 骨架无 .openspec.yaml", not os.path.exists(
            os.path.join(root, ".mae-flow-work/spec/changes/probe-hotfix/.openspec.yaml")))
        write(root, ".mae-flow-work/spec/changes/probe-hotfix/change.md",
              CHANGE_DOC_LIGHT % "hotfix")
        r, why = drive_to_archive(root, "probe-hotfix")
        check("hotfix 无规格单全链到定稿", r is not None, why)
        if r is not None:
            check("hotfix 定稿纯移动(无合并)", "(无规格变更)" in r.stdout, r.stdout)
            adirs = os.listdir(os.path.join(root, ".mae-flow-work/spec/changes/archive"))
            check("hotfix 档案目录存在", len(adirs) == 1, str(adirs))
            only = os.listdir(os.path.join(root, ".mae-flow-work/spec/changes/archive", adirs[0]))
            check("hotfix 档案里只有 change.md", only == ["change.md"], str(only))

        # --- tweak 档 ---
        root = make_repo(base, "tw 仓", "tweak")
        r = spec(root, "new", "probe-tweak")
        info = json.loads(r.stdout or "{}") if r.returncode == 0 else {}
        check("tweak new 成功且档位正确", r.returncode == 0
              and info.get("tier") == "tweak", r.stderr)
        write(root, ".mae-flow-work/spec/changes/probe-tweak/change.md",
              CHANGE_DOC_LIGHT % "tweak")
        # tweak 档改走优化后的合并命令:phase verify 快进(机器代劳三跳)
        r = spec(root, "phase", "verify")
        check("轻量单 phase verify 快进(open 直达)",
              r.returncode == 0 and "快进" in r.stdout, r.stdout + r.stderr)
        write(root, "docs/report.md", "# Verification\n\nAll pass.\n")
        r = spec(root, "verify-pass", "--report", "docs/report.md")
        check("verify-pass --report 一条命令登记+判定", r.returncode == 0,
              r.stderr)
        state = json.load(open(os.path.join(root, ".mae-flow.json"),
                               encoding="utf-8"))
        check("--report 已登记指针且判定通过",
              state["spec"].get("verification_report") == "docs/report.md"
              and state["spec"].get("verify_result") == "pass",
              str(state.get("spec")))
        r = spec(root, "archive")
        check("tweak 无规格单全链到定稿", r.returncode == 0, r.stderr)

        # --- full 档 + 规格合并 ---
        root = make_repo(base, "full 仓", "full")
        r = spec(root, "new", "probe-full")
        check("full new 成功", r.returncode == 0, r.stderr)
        skeleton = read(root, ".mae-flow-work/spec/changes/probe-full/change.md")
        check("full 骨架含方案节与（待设计", "# 方案" in skeleton and "（待设计" in skeleton)
        r = spec(root, "instructions", "change")
        check("instructions change 按 full 档渲染",
              r.returncode == 0 and "full（完整开发）" in r.stdout
              and "hotfix（已定位修复）" not in r.stdout
              and "<spec_format>" in r.stdout, r.stderr)
        # 占位未替换时 validate 只查结构(占位由 done 证据拦),无 delta 必须拒
        r = spec(root, "validate")
        check("full 无规格条目 validate 拒且指向 change.md",
              r.returncode != 0 and "change.md" in (r.stdout + r.stderr))
        write(root, ".mae-flow-work/spec/changes/probe-full/change.md",
              "# 变更：probe-full\n\n# 为什么\n\n完整开发探针。\n\n"
              "# 规格条目：probe\n\n" + DELTA + "\n"
              "# 方案\n\n用内置引擎。\n\n# 实现清单\n\n- [x] 1. 实现完成\n")
        r = spec(root, "validate")
        check("full 规格合法 validate 过", r.returncode == 0, r.stderr)
        r, why = drive_to_archive(root, "probe-full")
        check("full 有规格单全链到定稿", r is not None, why)
        if r is not None:
            merged = read(root, ".mae-flow-work/spec/specs/probe/spec.md")
            check("full 定稿真相源已合并", "### Requirement: Probe rule" in merged)
            check("full 定稿无 delta 泄漏", "## ADDED Requirements" not in merged)
        r = spec(root, "archive")
        check("重复定稿被拒", r.returncode != 0)

        # --- 布局混用与伪造通道 ---
        root = make_repo(base, "mix 仓", "full")
        spec(root, "new", "probe-full")
        write(root, ".mae-flow-work/spec/changes/probe-full/change.md",
              "# 为什么\n\nx\n\n# 规格条目：dom\n\n" + DELTA
              + "\n# 实现清单\n\n- [x] 1. x\n")
        write(root, ".mae-flow-work/spec/changes/probe-full/tasks.md", "- [ ] 1. old\n")
        r = spec(root, "validate")
        check("布局混用 validate 拒", r.returncode != 0
              and "布局混用" in (r.stdout + r.stderr))
        r = spec(root, "init")
        r = spec(root, "phase", "verify")
        err = r.stdout + r.stderr
        check("阶段跳跃拒", r.returncode != 0 and "跳跃" in err)
        # 审计补测:报错命令链用脚本真实绝对路径(字面量 mae-flow.py 照抄必失败)
        check("跳跃报错命令链含脚本绝对路径",
              'spec phase design' in err and MAE.replace("\\", "/") in err, err[-300:])
        r = spec(root, "phase", "archived")
        err = r.stdout + r.stderr
        check("跳到 archived 的命令链止步 verify(不引导绕过 verify-pass)",
              r.returncode != 0 and "spec phase verify" in err
              and "phase archive" not in err.replace("phase archived", ""), err[-300:])
        r = spec(root, "set", "verify_result", "pass")
        check("verify_result 直写拒", r.returncode != 0)
        # spec new 异值警告:已登记 CHANGE_NAME 与新目录不一致时警告不覆盖
        r = spec(root, "new", "probe-другой" if False else "probe-second")
        state = json.load(open(os.path.join(root, ".mae-flow.json"),
                               encoding="utf-8"))
        check("new 异名单警告且不覆盖已登记 CHANGE_NAME",
              "不一致" in (r.stderr or "")
              and state["config"]["CHANGE_NAME"] == "probe-full",
              (r.stderr or "") + str(state["config"]))

        # phase archive 直推拒(绕过 verify-pass 的通道关闭)
        root = make_repo(base, "pa 仓", "full", current="verify_comet")
        spec(root, "new", "probe-full")
        write(root, ".mae-flow-work/spec/changes/probe-full/change.md",
              "# 为什么\n\nx\n\n# 规格条目：dom\n\n" + DELTA
              + "\n# 方案\n\ny\n\n# 实现清单\n\n- [x] 1. x\n")
        spec(root, "init")
        for p in ("design", "build", "verify"):
            spec(root, "phase", p)
        r = spec(root, "phase", "archive")
        check("phase archive 直推拒(只能由 verify-pass 产生)",
              r.returncode != 0 and "verify-pass" in (r.stdout + r.stderr))

    print("\n探针②通过 %d 项, 失败 %d 项" % (PASS, len(FAIL)))
    if FAIL:
        print("失败: " + ", ".join(FAIL))
        sys.exit(1)


if __name__ == "__main__":
    main()
