/**
 * 分仓构建缓存 → 容器挂载与环境的唯一合并点(2026-09-03, issue #78)。
 *
 * 需求侧(taskService.containerMountsForRepository)与问题流侧
 * (issueFlow ensureContainer)此前各养一份近似实现,几轮改动后只在
 * 三处入参上真有差异:cpp_sdk_repository 的容器内挂载点、touchBuildCache
 * 的分区键、任务侧独有的宿主身份透传。防覆盖守卫、合并顺序
 * (isolation.environment 种子 → MAVEN_OPTS 追加 -Dmaven.repo.local)、
 * touch/mkdir 时机两侧本就逐行一致——统一到这里,差异全走参数,
 * 本模块不做任何"顺手归一"。
 */

import { mkdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { touchBuildCache, touchSharedBuildCache } from "./buildCache.ts";

export const SHARED_MAVEN_DESTINATION = "/cache/maven/repository/.mfc-remote";
const MAVEN_EXTENSION_DESTINATION = "/opt/mae-flow-cache";
const MAVEN_EXTENSION_ASSETS = fileURLToPath(new URL("../assets/maven-shared-cache", import.meta.url));

export interface PerRepoBuildCacheMountsInput {
  /** 分仓构建缓存宿主根;缺席 = 该容器不挂平台缓存,只回种子环境
   *  (任务侧此时仍要透传宿主身份,见 maeFlowHost)。 */
  cacheRoot?: string;
  /** touchBuildCache 的分区键输入。两侧语义不同,由调用方定,这里只
   *  透传:任务侧=仓库 URL;问题流侧=会话首个仓 URL,缺了退会话 id。 */
  cacheKeySource: string;
  /** 调用方既有挂载("宿主:容器"形状);分仓缓存卷原序追加在其后,
   *  不覆盖、不去重。 */
  volumes: string[];
  /** isolation.environment 种子:通用变量先进环境,缓存变量后追加
   *  (#75 的 npm_config_registry 能与缓存变量共存,靠的就是这个顺序)。 */
  seedEnvironment?: NodeJS.ProcessEnv;
  /** cpp_sdk_repository 的容器内挂载点;缺席 = 本容器不挂 SDK 缓存。
   *  C++ Maven 插件约定 ${project.basedir}/../cpp_sdk_repository,所以
   *  挂载点必须按调用方自己的工作区布局算,不能拍扁到 /workspace:
   *  任务侧=仓名的同级目录;问题流侧=live.root/repo/ 下(多仓共享同一处)。 */
  cppSdkDestination?: string;
  /** CCACHE_BASEDIR 的相对化基准,本函数内做 dirname(resolve())。
   *  不同任务克隆路径不同,ccache 按绝对路径做 key 永远 miss;基准
   *  目录之下克隆与 cpp_sdk_repository 的相对布局恒定,跨任务才命中。
   *  任务侧传任务工作区,问题流侧传 live.root——保持两侧既有取值。 */
  ccacheBaseDirSource?: string;
  /** 任务侧独有:宿主 MAE_FLOW_HOST 透传进容器,且发生在 cacheRoot
   *  早退之前。问题流侧没有这一步,不传即不透传——不是所有容器都
   *  需要宿主身份。由调用方传值,本模块不读 process.env 藏全局依赖。 */
  maeFlowHost?: string;
}

/**
 * 组装单仓维度的构建缓存挂载与环境变量,返回 { volumes, environment },
 * 形状与两个调用方原先各自的返回完全一致。
 */
export function perRepoBuildCacheMounts(
  input: PerRepoBuildCacheMountsInput,
): { volumes: string[]; environment: NodeJS.ProcessEnv } {
  const environment: NodeJS.ProcessEnv = { ...(input.seedEnvironment ?? {}) };
  // 宿主身份必须跟进容器:内核靠 MAE_FLOW_HOST 区分"用户是否坐在终端
  // 前",漏传时容器里的 current 按本地宿主渲染,云端确认类步骤的
  // --auto 路径整个失效(run8b 实测:领域归档在云端又弹了人工卡)。
  if (input.maeFlowHost && !environment.MAE_FLOW_HOST) {
    environment.MAE_FLOW_HOST = input.maeFlowHost;
  }
  if (!input.cacheRoot) return { volumes: input.volumes, environment };

  const cppSdkDestination = input.cppSdkDestination;
  // 自定义挂载不能覆盖平台缓存目录:覆盖后容器写的缓存进不了分仓
  // 分区,还会把宿主任意目录暴露在平台缓存路径上。回显用归一后的
  // 目的地(此前任务侧回显原样值,差异无契约依赖,按红线归一)。
  const destinations = new Set([
    "/cache/maven", "/cache/npm", "/cache/ccache", "/cache/xdg",
    ...(cppSdkDestination ? [cppSdkDestination] : []),
  ]);
  for (const volume of input.volumes) {
    const destination = volume.split(":")[1];
    const normalized = destination && posix.resolve(destination);
    if (normalized && (destinations.has(normalized)
        || [SHARED_MAVEN_DESTINATION, MAVEN_EXTENSION_DESTINATION].some(path =>
          normalized === path || normalized.startsWith(`${path}/`) || path.startsWith(`${normalized}/`))
        || normalized === "/")) {
      throw new Error(`自定义挂载不能覆盖平台的分仓缓存目录: ${normalized}`);
    }
  }
  const { base: cacheBase } = touchBuildCache(input.cacheRoot, input.cacheKeySource);
  const { base: sharedBase } = touchSharedBuildCache(input.cacheRoot, "shared-maven");
  const sharedRemote = join(sharedBase, "remote");
  mkdirSync(sharedRemote, { recursive: true });
  const caches: Array<[string, string]> = [
    ["maven", "/cache/maven"],
    ["npm", "/cache/npm"],
    ["ccache", "/cache/ccache"],
    ["xdg", "/cache/xdg"],
    ...(cppSdkDestination
      ? [["cpp-sdk", cppSdkDestination] as [string, string]]
      : []),
  ];
  for (const [name] of caches) mkdirSync(join(cacheBase, name), { recursive: true });
  // 提前建好嵌套挂载点，让属主准备包含其父目录；否则 Docker 会以 root 创建，
  // 非 root 的 Maven 无法在 repository 下 install 或写旧式元数据。
  mkdirSync(join(cacheBase, "maven", "repository", ".mfc-remote"), { recursive: true });
  const mavenOptions = String(environment.MAVEN_OPTS ?? "").trim();
  const existingExtensions = [...mavenOptions.matchAll(/(?:^|\s)-Dmaven\.ext\.class\.path=([^\s]+)/g)].at(-1)?.[1];
  const extensionPath = [existingExtensions, `${MAVEN_EXTENSION_DESTINATION}/extension.jar`].filter(Boolean).join(":");
  return {
    volumes: [
      ...input.volumes,
      ...caches.map(([name, destination]) =>
        `${join(cacheBase, name)}:${destination}`),
      `${sharedRemote}:${SHARED_MAVEN_DESTINATION}`,
      `${MAVEN_EXTENSION_ASSETS}:${MAVEN_EXTENSION_DESTINATION}:ro`,
    ],
    environment: {
      ...environment,
      // Resolver 1.9.22：下载包括 SDK zip，共享；install 与旧缓存仍在原分仓根。
      // SDK 插件会修改解压内容和 mtime，cpp-sdk 不能改成共享可写目录。
      MAVEN_OPTS: [mavenOptions,
        "-Dmaven.repo.local=/cache/maven/repository",
        `-Dmaven.ext.class.path=${extensionPath}`,
        "-Daether.enhancedLocalRepository.split=true",
        "-Daether.enhancedLocalRepository.localPrefix=",
        "-Daether.enhancedLocalRepository.remotePrefix=.mfc-remote",
        "-Daether.enhancedLocalRepository.splitLocal=false",
        "-Daether.enhancedLocalRepository.splitRemote=false",
        "-Daether.enhancedLocalRepository.splitRemoteRepository=true",
        // 保留时间戳文件名，避免另一容器更新快照时改写本次编译正在读的 jar/zip。
        "-Daether.artifactResolver.snapshotNormalization=false",
        "-Daether.syncContext.named.factory=file-lock",
        "-Daether.syncContext.named.nameMapper=file-gav",
        // Resolver 默认 DELETE_ON_CLOSE 在 Unix 打开时就 unlink，跨 JVM 会锁到
        // 不同 inode。必须保留锁文件，随整个闲置共享缓存一起回收。
        "-Daether.named.file-lock.deleteLockFiles=false",
        // 锁必须与下载区共用宿主目录；每仓自己的 .locks 无法跨容器同步。
        `-Daether.syncContext.named.basedir.locksDir=${SHARED_MAVEN_DESTINATION}/.locks`,
        "-Daether.syncContext.named.time=300"]
        .filter(Boolean).join(" "),
      npm_config_cache: "/cache/npm",
      NPM_CONFIG_CACHE: "/cache/npm",
      MFC_MAVEN_CACHE: "/cache/maven/repository",
      // 容器内 Node 信任系统 CA 存储(2026-09-04,现场 npm debug 日志
      // 实锤:部署镜像 v2-euleros-jdk21-mvn36-node18-node24 默认 node
      // 是 v24.19.0,repository 默认走 npm@11)。内网端点(cmc npm 镜像)
      // 签发链只在内网镜像的系统信任库里,Node 默认不信——npm install
      // 全量 UNABLE_TO_VERIFY_LEAF_SIGNATURE 重试到超时。与宿主 serve
      // 进程的 systemd drop-in 同款修复;该变量要求 Node ≥22.15/23.8,
      // 镜像若回退 node18 备用二进制会静默 no-op,届时换 NODE_EXTRA_CA_
      // CERTS 指系统 bundle。Maven/JDK 的信任在 java-cacerts/内部基底
      // 已闭环,与 node 互不影响。
      NODE_USE_SYSTEM_CA: "1",
      CCACHE_DIR: "/cache/ccache",
      XDG_CACHE_HOME: "/cache/xdg",
      // launcher 在容器登录 shell 内确认 ccache 存在后接入，不能假设标准镜像必装。
      ...(input.ccacheBaseDirSource
        ? { CCACHE_BASEDIR: dirname(resolve(input.ccacheBaseDirSource)) } : {}),
      CCACHE_NOHASHDIR: "1",
      // 30w 行 C++ 仓一轮对象 5.7G(内网实测),默认 5G 上限会被
      // 自己的下一轮淘汰光;分仓缓存目录彼此隔离,放大到 20G。
      CCACHE_MAXSIZE: "20G",
    },
  };
}
