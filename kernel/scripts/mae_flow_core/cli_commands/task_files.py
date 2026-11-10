"""任务范围文件分组与执行目录推导(standalone 任务卡共用)。

2026-08-25 编排瘦身:主流程的 COMPILE/UT/CODECHECK 任务卡随编码段编排退役,
这两个纯计算助手被 standalone 独立任务卡继续使用,故从 agent_task 迁出留存。
"""

from .shared import (
    BUILD_DESCRIPTOR_EXTS, SOURCE_FILENAMES, os,
    quality_task_card_use_cases,
)
from .wiring import api


def _classify_task_files_from_runtime(files, st):
    """把子任务范围拆成业务源码、测试、构建三组；文档根本不应传进来。"""
    return quality_task_card_use_cases.task_file_groups(
        files,
        is_build=api._is_build_path,
        is_test=lambda path: api._is_test_file(path, st),
    ).as_legacy()


def _resolve_task_roots_from_runtime(files):
    """生成去重的模块执行目录和依据，供任务卡阻止根目录意外全量构建。"""
    plan = quality_task_card_use_cases.execution_roots(
        files,
        quality_task_card_use_cases.ExecutionRootPorts(
            repository=os.path.abspath(os.getcwd()),
            absolute=os.path.abspath,
            is_directory=os.path.isdir,
            list_directory=os.listdir,
            is_file=os.path.isfile,
            is_build_path=api._is_build_path,
            relative=os.path.relpath,
            dirname=os.path.dirname,
            join=os.path.join,
            separator=os.sep,
            source_filenames=tuple(
                str(name).lower()
                for name in SOURCE_FILENAMES),
            descriptor_suffixes=tuple(BUILD_DESCRIPTOR_EXTS),
        ),
    )
    return list(plan.roots), list(plan.unresolved)
