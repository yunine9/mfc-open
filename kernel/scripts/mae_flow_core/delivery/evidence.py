"""Delivery Evidence policies with explicit repository ports."""

import re
from .archive_commit import committed_archive_receipt
from dataclasses import dataclass

from ..foundation.models import EvidenceResult
from ..workflow.evidence import legacy_result


@dataclass(frozen=True)
class DeliveryEvidencePorts:
    moonlight: object
    source_changed_since: object
    archive_delivery_paths: object
    shell_output: object
    argv_output: object
    committed_initial_carryover: object
    committed_delivery_paths: object
    trusted_harness_commit_path: object
    dirty_paths: object
    path_fingerprint: object
    repo_path_identity: object
    agent_written_paths: object
    read_text_replace: object
    agent_ran: object
    push_runs_locally: object = lambda _state: True
    review_document: object = None


def review_status_count(text, status):
    count = 0
    for line in text.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [
            value.strip().strip("*`")
            for value in line.strip().strip("|").split("|")
        ]
        if (len(cells) < 4 or cells[0] == "#"
                or set(cells[0]) <= {"-", ":"}):
            continue
        if cells[-1] == status:
            count += 1
    return count


def review_statuses(text):
    result = {}
    section = "未分节"
    for line in text.splitlines():
        heading = re.match(r"^\s*##\s+(.+?)\s*$", line)
        if heading:
            section = re.sub(r"\s+", " ", heading.group(1)).strip()
            continue
        if not line.lstrip().startswith("|"):
            continue
        cells = [
            value.strip().strip("*`")
            for value in line.strip().strip("|").split("|")
        ]
        if (len(cells) < 4 or cells[0] == "#"
                or set(cells[0]) <= {"-", ":"}):
            continue
        base = "%s / #%s / %s" % (
            section, cells[0], re.sub(r"\s+", " ", cells[1])[:40])
        identity, duplicate = base, 2
        while identity in result:
            identity = "%s / 重复%d" % (base, duplicate)
            duplicate += 1
        result[identity] = cells[-1]
    return result


def review_has_confirmed_fix(text):
    return review_status_count(text, "修复(已确认)") > 0


def _dirty_outside_unchanged_receipts(
        dirty_paths, preserved, residue, path_fingerprint):
    leaked = []
    for path in dirty_paths:
        identity = str(path).replace("\\", "/").casefold()
        if identity in preserved:
            continue
        expected = residue.get(identity)
        if (
            expected
            and path_fingerprint is not None
            and path_fingerprint(path) == expected
        ):
            continue
        leaked.append(path)
    return leaked


def _unchanged_manifest_result(
        manifest, archive, dirty_paths, path_fingerprint=None):
    valid = (
        manifest.get("no_changes") is True
        and manifest.get("confirmed") is True
        and archive.get("status") == "applied"
    )
    if not valid:
        return EvidenceResult(
            False, "尚未生成精确交付清单；先执行 manifest set")

    try:
        receipt = committed_archive_receipt(archive)
    except ValueError as exc:
        return EvidenceResult(False, str(exc))
    if receipt != (manifest.get("committed_archive_receipt") or {}):
        return EvidenceResult(False, "归档提交内容已变化；执行 manifest set --unchanged 更新已提交文件凭证")

    def normalize(path):
        return str(path).replace("\\", "/").casefold()

    preserved = {
        normalize(path) for path in
        (manifest.get("unchanged_initial_dirty") or ())
    }
    residue = manifest.get("unchanged_build_residue") or {}
    residue = (
        {normalize(path): value for path, value in residue.items()}
        if isinstance(residue, dict) else {})
    leaked = _dirty_outside_unchanged_receipts(
        dirty_paths, preserved, residue, path_fingerprint)
    if leaked:
        return EvidenceResult(
            False, "空交付清单之后仍有新增未提交文件: "
            + "、".join(leaked[:8]))
    return EvidenceResult(True, "归档文件已就绪，无需创建空提交；已有提交继续交付")


class DeliveryEvidenceRules:
    def __init__(self, ports):
        self.ports = ports

    def archive_paths_clean(self, _spec, state):
        paths = self.ports.archive_delivery_paths(state)
        if not paths:
            return EvidenceResult(
                False,
                "缺少本次定稿的精确产物清单；重新执行 spec archive，"
                "或由维护人核对旧在途状态后再推进",
            )
        dirty = []
        for path in paths:
            output = self.ports.argv_output([
                "git", "status", "--porcelain", "--", path])
            if output:
                dirty.append(
                    "%s(%s)"
                    % (path, output.splitlines()[0][:2].strip()))
        if not dirty:
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            "本次定稿产物尚未提交: " + "、".join(dirty)
            + "。只精确 git add 上述路径并提交；不要 git add openspec/，"
            "它可能卷入上一单遗留文件",
        )

    def commit_tagged(self, _spec, state):
        ticket = state["config"].get("单号", "")
        message = self.ports.shell_output(
            "git log -1 --pretty=%s")
        if not message:
            return EvidenceResult(False, "无法读取最新 commit")
        if re.match(
                r"^\[" + re.escape(ticket) + r"\]\[(feat|fix)\]",
                message):
            return EvidenceResult(True, "")
        return EvidenceResult(
            False,
            "最新 commit「%s」不符合 [%s][feat|fix]描述 格式。"
            "修复只需一条命令(不动已提交的改动内容):"
            "git commit --amend -m \"[%s][fix|feat]<原描述>\""
            % (message, ticket, ticket),
        )

    def commit_tagged_after_entry(self, spec, state):
        step = state.get("current", "")
        base = (
            (state.get("step_heads", {}) or {}).get(step, ""))
        if (
            not base
            or self.ports.argv_output(
                ["git", "cat-file", "-t", base]) != "commit"
        ):
            return EvidenceResult(
                False,
                "缺少 %s 的入口 HEAD，无法证明本步真的产生过提交" % step,
            )
        commits = self.ports.argv_output([
            "git", "log", "--format=%H", base + "..HEAD"]).splitlines()
        if not commits:
            return EvidenceResult(
                False,
                "当前步骤之后没有新提交，不能拿上一步的提交冒充本步产出",
            )
        return self.commit_tagged(spec, state)

    def _branch_committed_paths(self, state):
        """本分支上已经提交过的路径——不只是本步入口之后那一段。

        交付清单是整单的产物清单,其中一部分文件常在更早的步骤就进了 commit
        (质量检视后的提交、build 之后的提交)。只比对本步入口 HEAD..HEAD 时,
        这些文件"没有形成提交",清单永远核不过——而它们其实早就提交了,
        Agent 拿着"仍未形成提交: X"也无从下手(X 已经在 HEAD 里了)。

        放宽的只是"在哪一段提交的",没放宽"必须已提交":diff 的两端都是 commit,
        工作区脏改动进不来;后面的 dirty 检查照旧;本步必须真的产生过提交由
        commit_tagged_after_entry 单独把关。
        """
        baseline = ((state.get("config") or {}).get("基线分支") or "").strip()
        if not baseline:
            return set()
        merge_base = self.ports.argv_output(
            ["git", "merge-base", baseline, "HEAD"]).strip()
        if not merge_base:
            return set()
        return set(self.ports.argv_output([
            "git", "diff", "--name-only", merge_base, "HEAD", "--",
        ]).splitlines())

    def delivery_manifest_committed(self, spec, state):
        manifest = state.get("delivery_manifest") or {}
        files = list(manifest.get("files") or ())
        if not files:
            return _unchanged_manifest_result(
                manifest, state.get("domain_archive") or {},
                self.ports.dirty_paths(),
                getattr(self.ports, "path_fingerprint", None))
        if manifest.get("confirmed") is not True:
            return EvidenceResult(
                False, "精确交付清单尚未确认，不能进入 push")
        step = state.get("current", "")
        base = (state.get("step_heads", {}) or {}).get(step, "")
        if not base:
            return EvidenceResult(
                False, "缺少交付检视入口 HEAD，无法核对清单提交")
        committed = set(self.ports.argv_output([
            "git", "diff", "--name-only", base, "HEAD", "--",
        ]).splitlines())
        committed |= self._branch_committed_paths(state)
        missing = [path for path in files if path not in committed]
        if missing:
            return EvidenceResult(
                False, "交付清单仍未形成提交: " + "、".join(missing[:8]))
        dirty = set(self.ports.dirty_paths())
        pending = [path for path in files if path in dirty]
        if pending:
            return EvidenceResult(
                False, "交付清单提交后仍有未提交/暂存差异: "
                + "、".join(pending[:8]))
        return self.commit_tagged_after_entry(spec, state)

    def _push_head_result(self, state):
        current = self.ports.shell_output(
            "git branch --show-current")
        wanted = state.get("config", {}).get("分支名", "")
        if wanted and current != wanted:
            return EvidenceResult(
                False,
                "当前分支 %s != 本单约定分支 %s，禁止在错误分支结束交付"
                % (current or "未知", wanted),
            )
        head = self.ports.shell_output(
            "git rev-parse --verify HEAD")
        upstream = self.ports.shell_output(
            "git rev-parse --verify @{u}")
        if not head:
            return EvidenceResult(False, "无法读取 HEAD")
        if not upstream:
            return EvidenceResult(
                False,
                "分支无上游跟踪——用 git push -u origin HEAD 推送并建立跟踪",
            )
        if head != upstream:
            return EvidenceResult(
                False,
                "本地 HEAD 与远端上游不一致(未推送/推送失败/远端有新提交):"
                "先尝试普通 git push -u origin HEAD；若远端领先，执行 git fetch "
                "后展示分叉，不要自动 rebase、reset 或 force-push"
                "（可能改写已检视代码）",
            )
        return None

    def pushed(self, _spec, state):
        # Publication is a Git/platform fact. File provenance, local leftovers
        # and earlier archive preferences cannot overrule the human selection.
        if self.ports.push_runs_locally(state):
            result = self._push_head_result(state)
            if result is not None:
                return result
        return EvidenceResult(True, "")
