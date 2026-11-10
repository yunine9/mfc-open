/**
 * 环境台账探活(票 #151,ADR-0020):用条目的后台密码以 operator 账号对
 * 主 IP 发起一次 SSH password 认证,三态落账(unverified → ok/failed),
 * 失败二分为 auth(密码改了)/ unreachable(机器关了)。root 密码不参与
 * 探测(ADR-0020 裁定),用户名恒为 operator。
 *
 * 传输层注入 seam(147 的"探活 seam,唯一新 seam"):探测只认一个
 * 连接器 `({host, port, username, password}) => {ok:true} |
 * {ok:false, reason}`。测试用假连接器驱动三态分类与调度,绝不真连
 * SSH;生产缺省连接器 sshProbeConnector 用 ssh2(纯 JS,进程内完成,
 * 不依赖宿主机 ssh 客户端)实现:认证被拒 → auth;连不上/超时/其他
 * 网络错误 → unreachable;ready 即成功并立即关闭连接。
 *
 * 轮询(serve.ts 独占接线):probeAllEnvironments 是一轮全量扫描——
 * 逐条串行(台账量级几十条),单条抛错只记日志不抛、不影响其余条目;
 * startEnvironmentProbePolling 用 setInterval + unref 挂到正式入口。
 * 定时器绝不进 createTaskServer:测试直连形态(server.test.ts 等)只
 * 构造 server,不起轮询——这是本仓"定时器只住 serve.ts"的既有纪律
 * (与现场回收的每日 sweep 同款)。
 */

import { Client } from "ssh2";
import {
  EnvironmentNotFoundError,
  type EnvironmentProbeFailureReason,
  type EnvironmentRegistry,
  type EnvironmentRegistryView,
} from "./environmentRegistry.ts";

/** 探测账号恒为 operator(ADR-0020:root 密码不参与探测)。 */
export const PROBE_USERNAME = "operator";

/** 连接超时:认证不回音/网络黑洞时的兜底上限(~5 秒,可容内网抖动)。 */
export const PROBE_CONNECT_TIMEOUT_MS = 5_000;

/** 轮询间隔缺省:约 10 分钟一轮全量(#151)。 */
export const DEFAULT_ENVIRONMENT_PROBE_INTERVAL_MS = 10 * 60_000;

/** 部署可用环境变量覆盖轮询间隔(毫秒,正整数)。 */
export const ENVIRONMENT_PROBE_INTERVAL_MS_ENV = "MFC_ENVIRONMENT_PROBE_INTERVAL_MS";

/** 一次探测的结论:成功,或失败二分(认证失败 / 不可达)。 */
export type ProbeOutcome =
  | { ok: true }
  | { ok: false; reason: EnvironmentProbeFailureReason };

/** 连接器入参:一次 SSH 认证所需的全部信息(密码是解密后的明文,
 * 只在进程内流转,绝不进日志与 HTTP 面)。 */
export interface ProbeTarget {
  host: string;
  port: number;
  username: string;
  password: string;
}

/** 传输层 seam:给一次目标,回一个结论。测试注入假连接器。 */
export type ProbeConnector = (target: ProbeTarget) => Promise<ProbeOutcome>;

/** ssh2 错误 → 失败二分:认证失败有专属 level('client-authentication',
 * ssh2 client.js:864),其余——握手超时('client-timeout')、套接字错
 * (ECONNREFUSED 等,'client-socket')——都归 unreachable。消息再兜一
 * 道,防版本措辞漂移漏判。导出只为测试用合成错误对象钉死二分口径,
 * 不测 ssh2 库本身。 */
export function isSshAuthFailure(error: unknown): boolean {
  const shaped = error as { level?: unknown; message?: unknown } | null;
  if (shaped?.level === "client-authentication") return true;
  return /authentication methods failed/i
    .test(String(shaped?.message ?? error ?? ""));
}

/** 缺省连接器:ssh2 password 认证。所有错误(认证拒/握手超时/套接字
 * 错)都从 error 事件出来;外层再挂一个 5 秒硬超时,连接器绝不悬挂
 * ——轮询是旁路,一条探活卡死不能拖住整轮扫描。ready 即成功,立即
 * end() 关连接,不在对方机器上留会话。 */
export const sshProbeConnector: ProbeConnector = (target) =>
  new Promise<ProbeOutcome>((resolve) => {
    const client = new Client();
    let settled = false;
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try {
        client.end();
      } catch {
        // 连接本就没建起来时 end 可能再抛,结论已定,不值得为它翻转。
      }
      resolve(outcome);
    };
    // ssh2 自带 readyTimeout,这里再兜一层:任何路径下 5 秒必出结论。
    const hardTimer = setTimeout(
      () => finish({ ok: false, reason: "unreachable" }),
      PROBE_CONNECT_TIMEOUT_MS,
    );
    hardTimer.unref?.();
    client.on("ready", () => finish({ ok: true }));
    client.on("error", (error: unknown) => {
      finish({
        ok: false,
        reason: isSshAuthFailure(error) ? "auth" : "unreachable",
      });
    });
    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      password: target.password,
      readyTimeout: PROBE_CONNECT_TIMEOUT_MS,
    });
  });

/** 表单草稿探测(/environments/test)用:把用户现输的值装进 seam
 * 入参。用户名仍恒为 operator——测试连接验的是后台密码本身。 */
export function buildProbeTarget(
  host: string,
  port: number,
  password: string,
): ProbeTarget {
  return { host, port, username: PROBE_USERNAME, password };
}

/** 对已存条目探测一次并持久化(#151:探活只改 probe 字段)。返回
 * 更新后的视图;未知条目 404。密码走台账既有解密路径(secrets),
 * 用后台密码——继承语义在解析侧,探活不需要知道 root 密码。 */
export async function probeEnvironmentEntry(
  registry: EnvironmentRegistry,
  id: string,
  connector: ProbeConnector = sshProbeConnector,
): Promise<EnvironmentRegistryView> {
  const entry = registry.list().find((item) => item.id === id);
  if (!entry) throw new EnvironmentNotFoundError(id);
  const password = registry.secrets(id)?.backendPassword;
  if (password === undefined) throw new EnvironmentNotFoundError(id);
  const outcome = await connector(
    buildProbeTarget(entry.ip, entry.port, password),
  );
  return registry.recordProbe(id, outcome);
}

export interface EnvironmentProbeRound {
  /** 本轮快照里的条目总数。 */
  total: number;
  /** 实际写出结论的条数(单条抛错不计入,只进日志)。 */
  probed: number;
  ok: number;
  failed: number;
}

/** 轮询的一轮(tick):全量快照、逐条串行(几十条的量级不需要并发),
 * 单条抛错只记日志不抛——一条坏数据/一次连接器异常不能挡住其余条目
 * 的探活,更不能把后台定时器炸停。 */
export async function probeAllEnvironments(
  registry: EnvironmentRegistry,
  connector: ProbeConnector = sshProbeConnector,
  log?: (message: string) => void,
): Promise<EnvironmentProbeRound> {
  const entries = registry.list();
  const round: EnvironmentProbeRound = {
    total: entries.length,
    probed: 0,
    ok: 0,
    failed: 0,
  };
  for (const entry of entries) {
    try {
      const view = await probeEnvironmentEntry(registry, entry.id, connector);
      round.probed += 1;
      if (view.probe.state === "ok") round.ok += 1;
      else round.failed += 1;
    } catch (error) {
      log?.(`环境 ${entry.ip}(条目 ${entry.id})探活失败,跳过不影响其余: `
        + String(error instanceof Error ? error.message : error));
    }
  }
  return round;
}

/** 轮询间隔:常量缺省,正整数环境变量可覆盖(MFC_ENVIRONMENT_PROBE_
 * INTERVAL_MS);坏值(非数/非正/小数)一律回落常量,配置错误不能让
 * 探活停摆。 */
export function environmentProbeIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env[ENVIRONMENT_PROBE_INTERVAL_MS_ENV]);
  return Number.isInteger(raw) && raw > 0
    ? raw
    : DEFAULT_ENVIRONMENT_PROBE_INTERVAL_MS;
}

export interface EnvironmentProbePoller {
  /** 停轮询(serve.ts 的进程退出靠 unref 即可,stop 留给显式关停)。 */
  stop(): void;
}

/** 后台轮询:间隔约 10 分钟(环境变量可覆盖),定时器 unref——探活是
 * 旁路,不许它吊住进程不肯退。只该从 serve.ts(正式入口)接线;
 * 测试与旁路形态直接调 probeAllEnvironments,不起真定时器。 */
export function startEnvironmentProbePolling(options: {
  registry: EnvironmentRegistry;
  connector?: ProbeConnector;
  intervalMs?: number;
  log?: (message: string) => void;
}): EnvironmentProbePoller {
  const intervalMs = options.intervalMs ?? environmentProbeIntervalMs();
  const timer = setInterval(() => {
    void probeAllEnvironments(options.registry, options.connector, options.log)
      .catch((error) => options.log?.(`环境探活轮次异常: ${String(error)}`));
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
