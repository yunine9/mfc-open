"""Self-contained capability runtime for Mae-Flow.

All workflow methodology and deterministic helpers live under ``runtime/vendor``.
The host only needs the same Python, Git and Node runtimes already required to run
CodeAgent itself.  No project-local Skill installation or reload is involved.
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

from .state_store import atomic_write_json, atomic_write_text


PLUGIN_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
VENDOR_ROOT = os.path.join(PLUGIN_ROOT, "runtime", "vendor")
OPENSPEC_ENTRY = os.path.join(
    VENDOR_ROOT, "openspec", "dist", "core", "artifact-graph", "openspec.mjs")
COMET_SCRIPT_ROOT = os.path.join(VENDOR_ROOT, "comet", "comet", "scripts")
MANIFEST_PATH = os.path.join(VENDOR_ROOT, "manifest.json")
CODECHECK_PACKAGE = "codecheckcli"
CODECHECK_REGISTRY = (
    "https://npm.example.com/artifactory/api/npm/product_npm/")


CAPABILITY_PACKS = {
    "open": [
        (
            "Comet 开启阶段规则",
            "comet/comet-open/SKILL.md",
            [
                "### 0. 输出语言约束",
                "### 1a. PRD 拆分预检（阻塞点）",
                "### 1c. Change 名称确认（阻塞点）",
                "### 2. 创建 Change 结构 + 初始化状态",
                "### 4. 内容完整性检查",
            ],
        ),
        (
            # 选段裁掉「Handling Different Entry Points」(~4KB '用户带模糊想法
            # 进场'的对话示例)——本仓 open 步入口固定为已确认需求文档+
            # clarifications,该章节与「不得重复质询」指令直接矛盾。
            "OpenSpec 需求探索",
            "openspec/skills/openspec-explore/SKILL.md",
            [
                "## The Stance",
                "## What You Might Do",
                "## OpenSpec Awareness",
                "## What You Don't Have To Do",
                "## Ending Discovery",
                "## What We Figured Out",
                "## Guardrails",
            ],
        ),
        ("OpenSpec 变更创建", "openspec/skills/openspec-new-change/SKILL.md"),
    ],
    "hotfix-open": [
        (
            "Comet 问题修复规则",
            "comet/comet-hotfix/SKILL.md",
            [
                "### 0. 输出语言约束",
                "### 1. 快速开启（preset open）",
                "## 升级条件",
            ],
        ),
        ("OpenSpec 变更创建", "openspec/skills/openspec-new-change/SKILL.md"),
    ],
    "tweak-open": [
        (
            "Comet 小改规则",
            "comet/comet-tweak/SKILL.md",
            [
                "### 0. 输出语言约束",
                "### 1. 快速开启（preset open）",
                "## 升级条件",
            ],
        ),
        ("OpenSpec 变更创建", "openspec/skills/openspec-new-change/SKILL.md"),
    ],
    "design": [
        (
            "Comet 设计阶段规则",
            "comet/comet-design/SKILL.md",
            [
                "### 1a. 生成 OpenSpec → Superpowers 交接包",
                "### 1b. 执行 Brainstorming（带上下文）",
                "### 1c. 用户确认设计方案（阻塞点）",
                "### 1d. Brainstorming 检查点定稿",
                "### 2. 创建 Design Doc",
            ],
        ),
        ("Superpowers 方案讨论", "superpowers/skills/brainstorming/SKILL.md"),
    ],
    "build": [
        (
            "Comet 构建阶段规则",
            "comet/comet-build/SKILL.md",
            [
                "### 1. 制定计划（Subagent Offload）",
                "### 3b. 执行中异常调试（异常调试协议）",
                "### 4. Spec 增量更新",
                "### 5. 上下文管理",
            ],
        ),
        (
            "Comet 问题修复根因检查",
            "comet/comet-hotfix/SKILL.md",
            ["### 3. 根因消除检查"],
        ),
        ("Superpowers 实现计划", "superpowers/skills/writing-plans/SKILL.md"),
        ("Superpowers 连续执行", "superpowers/skills/executing-plans/SKILL.md"),
        (
            # 选段保留 Iron Law/四阶段/Red Flags/速查(行为护栏),裁掉
            # When to Use(何时启用由步骤正文决定)与人际结对语境章节。
            "Superpowers 系统化调试",
            "superpowers/skills/systematic-debugging/SKILL.md",
            [
                "## Overview",
                "## The Iron Law",
                "## The Four Phases",
                "## Red Flags - STOP and Follow Process",
                "## Quick Reference",
            ],
        ),
        (
            # 选段裁掉 Intensity 档位表——档位已被步骤钉死(full 档,
            # _adapt_embedded_method 亦已重写 /ponytail 切换命令)。
            "Ponytail 精简纪律",
            "ponytail/skills/ponytail/SKILL.md",
            [
                "## Persistence",
                "## The ladder",
                "## Rules",
                "## Output",
                "## When NOT to be lazy",
                "## Boundaries",
            ],
        ),
    ],
    "review-fix": [
        ("Superpowers 评审意见处理",
         "superpowers/skills/receiving-code-review/SKILL.md"),
        (
            # 选段保留 Iron Law/四阶段/Red Flags/速查(行为护栏),裁掉
            # When to Use(何时启用由步骤正文决定)与人际结对语境章节。
            "Superpowers 系统化调试",
            "superpowers/skills/systematic-debugging/SKILL.md",
            [
                "## Overview",
                "## The Iron Law",
                "## The Four Phases",
                "## Red Flags - STOP and Follow Process",
                "## Quick Reference",
            ],
        ),
        (
            # 选段裁掉 Intensity 档位表——档位已被步骤钉死(full 档,
            # _adapt_embedded_method 亦已重写 /ponytail 切换命令)。
            "Ponytail 精简纪律",
            "ponytail/skills/ponytail/SKILL.md",
            [
                "## Persistence",
                "## The ladder",
                "## Rules",
                "## Output",
                "## When NOT to be lazy",
                "## Boundaries",
            ],
        ),
    ],
    "tweak-build": [
        (
            # 选段保留 Iron Law/四阶段/Red Flags/速查(行为护栏),裁掉
            # When to Use(何时启用由步骤正文决定)与人际结对语境章节。
            "Superpowers 系统化调试",
            "superpowers/skills/systematic-debugging/SKILL.md",
            [
                "## Overview",
                "## The Iron Law",
                "## The Four Phases",
                "## Red Flags - STOP and Follow Process",
                "## Quick Reference",
            ],
        ),
        (
            # 选段裁掉 Intensity 档位表——档位已被步骤钉死(full 档,
            # _adapt_embedded_method 亦已重写 /ponytail 切换命令)。
            "Ponytail 精简纪律",
            "ponytail/skills/ponytail/SKILL.md",
            [
                "## Persistence",
                "## The ladder",
                "## Rules",
                "## Output",
                "## When NOT to be lazy",
                "## Boundaries",
            ],
        ),
    ],
    "ponytail-review": [
        ("Ponytail 复杂度审查", "ponytail/skills/ponytail-review/SKILL.md"),
    ],
    "verify": [
        (
            "Comet 验证阶段规则",
            "comet/comet-verify/SKILL.md",
            [
                "### 1. 改动规模评估",
                "### 1b. 验证失败决策（阻塞点）",
                "### 2. 产物上下文加载（Hash 按需读）",
                "### 2a. 轻量验证（小改动）",
                "### 2b. 完整验证（大改动）",
                "### 4. 记录验证证据",
            ],
        ),
        ("Superpowers 完成前验证",
         "superpowers/skills/verification-before-completion/SKILL.md"),
        ("Superpowers 正确性审查",
         "superpowers/skills/requesting-code-review/SKILL.md"),
        ("OpenSpec 规格符合检查",
         "openspec/skills/openspec-verify-change/SKILL.md"),
    ],
    "archive": [
        (
            "Comet 归档阶段规则",
            "comet/comet-archive/SKILL.md",
            [
                "### 1. 归档前最终确认（阻塞点）",
                "### 2. 执行归档",
                "### 3. 生命周期闭环",
            ],
        ),
    ],
}
