/**
 * 逐仓上屏的呈现派生(纯函数,不碰 React;组件只渲染这里的结果)。
 *
 * 数据侧按仓记账(pushes/mrs/pipelines 的键都是仓地址),但没有专门的
 * "变更仓"标记字段——变更仓的判定权归 AI(它对哪些仓调用交付工具),
 * 平台不推断。呈现层能拿到的唯一交付事实是推送账:AI 对某仓调用过
 * push_branch 才会有推送记录。所以本模块的口径(界面文案同此):
 * - 有推送记录 → 变更仓(已交付);
 * - 无推送记录 → 未交付(只说"没有交付事实",不说"AI 拒绝"——
 *   原因前端不知道,不硬造)。
 * 流水线徽标只认 pipelines 里该仓的 status 字段;记录缺席就不出徽标,
 * 不在前端补逻辑硬造状态。
 * 转正会话(#31)另有一本只读引用的旧账(inherited_accounts 指向旧
 * 会话):repoDeliveryRows 按仓把它捞成各卡的 inherited 事实,标注
 * 「转正前」陈列,不参与本会话的已交付判定——两本账不混。
 */

/** 服务端 workspaceDiffAll 的分段标记(service.ts 逐仓拼接时写入,
 * 前端只按它切分,不自造仓边界)。 */
const REPO_SECTION_MARK = /^===== 仓库 (.+) =====$/;

export interface RepoLedgerInput {
  /** 登记的全部关联仓(彼此平等,都可读可改)。 */
  repo_urls?: string[];
  /** 首个登记仓(兼容别名;服务端 loadState 已保证与 repo_urls 同步)。 */
  repo_url?: string;
  pushes?: Array<{ repo: string; branch: string; sha: string; at: string }>;
  mrs?: Array<{
    repo: string; branch: string; title: string;
    url?: string; iid?: string; at: string;
  }>;
  pipelines?: Record<string, {
    sha: string;
    status: "running" | "success" | "failed";
    watching: boolean;
    last_error?: string;
    round?: number;
    checks?: Array<{ dimension: string; status: string; job?: string }>;
  }>;
}

/** 转正前账的一仓事实(#31 只读引用,来自 inherited_accounts 指向的
 * 旧会话):与本会话账分开陈列,渲染层加「转正前」标识,两本账不混。
 * 流水线只给陈列词(与 repoPipelineBadge 同一套),不出头部徽标——
 * 徽标位置留给本会话的当前事实。 */
export interface RepoInheritedFacts {
  push?: { branch: string; sha: string; at: string };
  mr?: { branch: string; title: string; url?: string; iid?: string };
  pipeline?: { label: string; failedChecks: string[] };
}

/** 一个仓一张卡的全部呈现事实:角色(变更仓/未交付)、MR、推送、流水线,
 * 以及该仓的转正前账(有才带)。 */
export interface RepoDeliveryRow {
  /** 仓地址(API 各账的 repo 字段原样)。 */
  repo: string;
  /** 展示名:地址末段去 .git,与克隆目录同名规则一致(纯展示,重名
   * 不加序号——卡片以完整地址作 title,不冒充目录名)。 */
  name: string;
  /** 口径见文件头:有推送记录 = 已交付(变更仓)。 */
  delivered: boolean;
  push?: { branch: string; sha: string; at: string };
  mr?: { branch: string; title: string; url?: string; iid?: string };
  pipeline?: {
    status: "running" | "success" | "failed";
    watching: boolean;
    last_error?: string;
    /** checks 里 status=failed 的项(失败项文案直接用 API 的
     * dimension/job 原文,不翻译不推断)。 */
    failedChecks: string[];
  };
  /** 转正前账(只读引用,见 RepoInheritedFacts);该仓在旧会话确有
   * 记录时在场。 */
  inherited?: RepoInheritedFacts;
}

/** 展示名:地址末段去 .git(与服务端 issueRepoWorkspaces 的取名同源;
 * 尾斜杠容忍 Windows 风格反斜杠)。 */
export function repoName(url: string): string {
  const tail = url.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return tail.replace(/\.git$/i, "") || url;
}

/** 转正前流水线的陈列词:与 repoPipelineBadge 同一套,不硬造第四种。 */
function inheritedPipelineLabel(status: "running" | "success" | "failed"): string {
  if (status === "success") return "流水线通过";
  if (status === "failed") return "流水线失败";
  return "流水线运行中";
}

/** 从旧账(只读引用拉回的旧会话账)里捞起某仓的转正前事实;旧账缺席
 * 或该仓无任何记录 → undefined(仓卡不加「转正前」行,与现状无异)。 */
function inheritedFactsOf(
  inherited: RepoLedgerInput | undefined, repo: string,
): RepoInheritedFacts | undefined {
  if (!inherited) return undefined;
  const push = inherited.pushes?.find((item) => item.repo === repo);
  const mr = inherited.mrs?.find((item) => item.repo === repo);
  const watch = inherited.pipelines?.[repo];
  if (!push && !mr && !watch) return undefined;
  return {
    ...(push ? { push } : {}),
    ...(mr ? {
      mr: {
        branch: mr.branch, title: mr.title,
        ...(mr.url ? { url: mr.url } : {}),
        ...(mr.iid ? { iid: mr.iid } : {}),
      },
    } : {}),
    ...(watch ? {
      pipeline: {
        label: inheritedPipelineLabel(watch.status),
        failedChecks: (watch.checks ?? [])
          .filter((check) => check.status === "failed")
          .map((check) => check.job
            ? `${check.dimension} · ${check.job}`
            : check.dimension),
      },
    } : {}),
  };
}

/** 逐仓交付账:登记仓为骨架,按仓地址捞起各自的推送/MR/流水线记录。
 * 账里出现登记清单之外的仓(形状漂移/极端旧现场)时追加在尾部,不丢账;
 * inherited(转正前账,只读引用)同尺参与捞取与补尾,但只进各卡自己的
 * 「转正前」行,不影响本会话的已交付判定。 */
export function repoDeliveryRows(
  issue: RepoLedgerInput, inherited?: RepoLedgerInput,
): RepoDeliveryRow[] {
  const urls = issue.repo_urls?.length
    ? [...issue.repo_urls]
    : issue.repo_url ? [issue.repo_url] : [];
  for (const extra of [
    ...(issue.pushes ?? []).map((item) => item.repo),
    ...(issue.mrs ?? []).map((item) => item.repo),
    ...Object.keys(issue.pipelines ?? {}),
    ...(inherited?.pushes ?? []).map((item) => item.repo),
    ...(inherited?.mrs ?? []).map((item) => item.repo),
    ...Object.keys(inherited?.pipelines ?? {}),
  ]) {
    if (extra && !urls.includes(extra)) urls.push(extra);
  }
  return urls.map((repo) => {
    const push = issue.pushes?.find((item) => item.repo === repo);
    const mr = issue.mrs?.find((item) => item.repo === repo);
    const watch = issue.pipelines?.[repo];
    const old = inheritedFactsOf(inherited, repo);
    return {
      repo,
      name: repoName(repo),
      delivered: Boolean(push),
      ...(push ? { push } : {}),
      ...(mr ? {
        mr: {
          branch: mr.branch, title: mr.title,
          ...(mr.url ? { url: mr.url } : {}),
          ...(mr.iid ? { iid: mr.iid } : {}),
        },
      } : {}),
      ...(watch ? {
        pipeline: {
          status: watch.status,
          watching: watch.watching,
          ...(watch.last_error ? { last_error: watch.last_error } : {}),
          failedChecks: (watch.checks ?? [])
            .filter((check) => check.status === "failed")
            .map((check) => check.job
              ? `${check.dimension} · ${check.job}`
              : check.dimension),
        },
      } : {}),
      ...(old ? { inherited: old } : {}),
    };
  });
}

export interface RepoPipelineBadge {
  tone: "success" | "failed" | "running";
  label: string;
}

/** 流水线徽标:只认该仓 pipeline 记录的 status;记录缺席 → undefined
 * (卡片不出徽标,让位给推送事实,绝不硬造"未知/等待"这类状态)。 */
export function repoPipelineBadge(
  row: RepoDeliveryRow,
): RepoPipelineBadge | undefined {
  if (!row.pipeline) return undefined;
  if (row.pipeline.status === "success") {
    return { tone: "success", label: "流水线通过" };
  }
  if (row.pipeline.status === "failed") {
    return { tone: "failed", label: "流水线失败" };
  }
  return { tone: "running", label: "流水线运行中" };
}

export interface RepoRoleTag {
  tone: "delivered" | "undelivered";
  tag: string;
  title: string;
}

/** MR 行的陈列标签:「!123 branch」(无 iid 只给 branch);mr 缺席给
 * 空串,调用方以 mr 在场与否决定整行渲染——陈列派生住在本模块,
 * 组件只渲染结果(文件头宪法)。 */
export function mrDisplayLabel(
  mr: { branch: string; iid?: string } | undefined,
): string {
  if (!mr) return "";
  return `${mr.iid ? `!${mr.iid} ` : ""}${mr.branch}`;
}

/** 仓角色词(界面词汇纪律:变更仓/未交付,不用废除的主仓/参考仓)。 */
export function repoRole(row: RepoDeliveryRow): RepoRoleTag {
  return row.delivered
    ? {
        tone: "delivered", tag: "变更仓",
        title: "该仓有推送记录(AI 对它调用过交付工具)",
      }
    : {
        tone: "undelivered", tag: "未交付",
        title: "该仓没有推送记录——AI 未对它调用交付工具",
      };
}

/** 把聚合 diff 按服务端自己的分段标记切成逐仓片段(workspaceDiffAll
 * 对每仓一段 `===== 仓库 <名> =====`;无标记的单段原文兜底返回,名字
 * 留空——现网服务端恒有标记,空名只在形状漂移时出现)。 */
export function splitDiffByRepo(diff: string): Array<{ name: string; diff: string }> {
  if (!diff.trim()) return [];
  const sections: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | undefined;
  for (const line of diff.split("\n")) {
    const mark = REPO_SECTION_MARK.exec(line);
    if (mark) {
      current = { name: mark[1], lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      current = { name: "", lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections.map(({ name, lines }) => ({ name, diff: lines.join("\n") }));
}
