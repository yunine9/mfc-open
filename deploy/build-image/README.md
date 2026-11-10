# Mae-Flow Cloud 统一任务构建镜像

这个镜像只承载任务的命令执行面，不承载 Mae-Flow 内核、Pi 会话、Git
凭据、模型配置或 Docker Socket。首版兼容基线为 JDK 21、Maven 3.9.9、
Node 18.16.1/npm 9.5.1，以及 JavaScript、Java、C++ 仓需要的常见本地
工具链。

可选的需求与问题单 AI 代码归因见 [Git AI 接入](git-ai.md)。该能力不增加
交付状态或审批，也不以归因成败决定代码能否推送。

## 镜像契约（不是一次性 `docker commit` 清单）

Cloud 把镜像当作 `mae-flow-task-builder/1` 使用。任何内部基础镜像都必须
在 Dockerfile 中可重复地满足下面的条件，不能只在某台机器上手工修好：

- 最终用户必须是非 root；`/etc/passwd` 中该 UID 的 HOME 必须与 `$HOME`
  相同。Maven 会通过 `getpwuid()` 找 `.m2`，只改环境变量不够。
- `mvn --version` 报告的实际 Java 必须是 21，且该输出中的 runtime 下
  `lib/security/cacerts` 可读。`java -version` 是 21 但 Maven 仍选到 JDK 8
  也不合格。
- `/home`、`/etc/mae-flow`、`/etc/mae-flow/maven`、`/etc/profile.d`、
  系统 CA 路径逐级可遍历；JDK/Maven/Node/C++ 工具及可选平台 CLI 对最终
  用户可执行。
- 内部 CA 必须导入 Maven 实际使用的 JDK truststore，或把已经合并好的
  cacerts 只读挂到那个 JDK 的默认路径。不得以 `sslVerify=false`、
  `strict-ssl=false` 或 `curl -k` 代替证书治理。
- 镜像不预建 `/cpp_sdk_repository`，也不放仓名软链接。Cloud 按仓库隔离
  SDK 缓存并挂到代码仓同级的 `cpp_sdk_repository`，代码仓保持
  `<任务目录>/<仓名>` 的真实父子拓扑。
- `TMPDIR` 固定指向 `/tmp`，不依赖 entrypoint 预建子目录。流水线运行器
  即使覆盖镜像 entrypoint、并把 `/tmp` 重新挂成空 tmpfs，构建工具也不会
  拿到一个不存在的临时目录。宿主 `/tmp` 可以且建议保持 `noexec`；只有
  任务容器自己的 `/tmp` 需要 `exec`，用于 Maven Jansi/JNA/native 临时库。

镜像带 `com.mae-flow.builder.contract=mae-flow-task-builder/1` 标签仅用于
识别；真正的放行依据是管理页「部署自检」启动真实非 root 容器后的行为
验证，不会只信标签。

## 构建

开发机可用 Dockerfile 中已经固定 manifest digest 的公共默认镜像验证：

```bash
docker build \
  -f deploy/build-image/Dockerfile \
  -t mae-flow-task-builder:dev \
  deploy/build-image
```

内网生产构建必须把两个基础镜像同步到内部镜像仓，并使用审批过的
digest，不能依赖可漂移的 tag：

```bash
docker build \
  --build-arg JAVA_MAVEN_BASE_IMAGE=registry.intra/build/maven-jdk21@sha256:<approved-digest> \
  --build-arg NODE_BASE_IMAGE=registry.intra/build/node-18.16.1@sha256:<approved-digest> \
  -f deploy/build-image/Dockerfile \
  -t registry.intra/mae-flow/task-builder:2026.08 \
  deploy/build-image
```

若内网完全离线，先由运维导入上述两个镜像。如果内部 Java/Maven
基础镜像已经包含 Dockerfile 列出的 OS 工具，可加
`--build-arg INSTALL_OS_PACKAGES=false`，构建过程仍会逐项校验工具，缺失
时立即失败。否则基础镜像必须已配置能访问的内部 apt 镜像。

`BUILDER_UID`、`BUILDER_GID` 默认都是 `10001`。生产环境优先用运行
Mae-Flow Cloud 的服务账号 UID/GID 重建镜像。服务若由 root 守护进程
启动，必须显式配置数字形式的 `--isolate-user <uid>:<gid>`；Cloud 会在
每次任务容器启动前，只把实际 bind 的代码工作区和平台构建缓存交给该
用户；宿主 Write/Edit 与内核状态换新后也会立即修正对应文件，不会改任务
控制面或凭据目录。禁止用 `umask 0000` 代替所有权处理。

最终镜像不能假设任务用户属于 root 组。所有预装 CLI、JDK/Node 环境脚本
必须让普通用户可读/执行，CA 路径的每一级目录必须可遍历，证书文件必须
可读。标准 Dockerfile 会在切换到 `USER builder:builder` 后用 `sh -lc`
再次验证这些条件；基于自有 rootfs 派生镜像时也必须保留同等检查。

## 运行时挂载约定

Maven 远端下载（包括 C++ SDK zip）跨仓共享；本地 `install`、旧 Maven
缓存、npm、ccache、XDG 和 C++ SDK 解压目录仍按仓隔离。任务
代码保持 `<任务目录>/<仓名>` 的父子层级；内部 C++ 构建脚本可自然通过
`build/../..` 找到聚合根，不允许把仓库拍扁挂到固定 `/workspace`。下面仅展示挂载
约定，具体 CPU、内存、PID、临时磁盘和网络限制由 Cloud 运行时统一
下发：

```text
<task-workspace>:<same-absolute-path>:rw
<cache-root>/<repository-id>/maven:/cache/maven:rw
<cache-root>/shared-maven/remote:/cache/maven/repository/.mfc-remote:rw
<cloud>/assets/maven-shared-cache:/opt/mae-flow-cache:ro
<cache-root>/<repository-id>/npm:/cache/npm:rw
<cache-root>/<repository-id>/ccache:/cache/ccache:rw
<cache-root>/<repository-id>/xdg:/cache/xdg:rw
<cache-root>/<repository-id>/cpp-sdk:<task-parent>/cpp_sdk_repository:rw
<deploy-config>/settings.xml:/etc/mae-flow/maven/settings.xml:ro
<deploy-config>/company-ca.pem:/etc/mae-flow/ca/company-ca.pem:ro
<deploy-config>/java-cacerts:/opt/java/openjdk/lib/security/cacerts:ro
tmpfs:/home/mae-flow:rw,nosuid,nodev,mode=1777
tmpfs:/tmp:rw,exec,nosuid,nodev,mode=1777
```

- 共享下载配置对应 Maven 3.9.9 / Resolver 1.9.22。`maven.repo.local`
  仍为 `/cache/maven/repository`，使用 Resolver 的 local/remote 拆分，
  localPrefix 为空，保留原有本地工件路径；远端按 repository ID 分目录。
  所有容器使用共享目录内的 `file-lock` / `file-gav` 文件锁，禁用
  `deleteLockFiles`，防止 Unix 上打开即 unlink 导致各进程锁到不同文件。
  空锁文件随整个共享区回收，单次等待上限
  300 秒。部署使用本地文件系统和一致 UID/GID；镜像或 Resolver 升级须重跑
  共享构建验证，不把 NFS 等远端文件系统当作已验收环境。
- C++ 插件从 Maven 获取 zip 后仍在分仓 `cpp_sdk_repository` 解压、修改
  mtime、清理旧目录；该目录不能改成共享可写或只读。共享的是 zip 下载，
  不会消除各仓解压目录的占用。
- 保留 settings 的 SNAPSHOT 更新策略，不强制 `-U` 或固定旧版本。
  关闭 snapshotNormalization，保留远端时间戳文件名，避免另一容器更新
  快照时覆盖正在编译的 jar/zip；新构建仍按 settings 选择当前快照。
  在线构建可能读取更新的快照，离线构建依赖已缓存版本；上线须验证业务仓
  对最新快照的兼容性。旧分仓缓存不自动搬迁或删除，不能承诺部署立即释放
  全部重复数据。
- Maven 通过只读扩展在 Java Compiler 的 compile/testCompile 入口比较
  实际 classpath 与上次成功编译的记录。依赖变化时只使当前模块的 Compiler
  状态失效，由 Compiler 重新编译；不删除源码、资源、SDK 或 native 产物。
  依赖不变继续增量，失败/跳过不登记成功，不要求每次 clean。解决了其他仓
  先更新共享快照、Compiler 只看本轮开始时间而漏编的问题。
  源码和可复现构建见 `assets/maven-shared-cache/README.md`；已验证
  Maven 3.9.9 / Compiler 3.13.0，内网私有插件仍按实际业务构建验收。
- 管理页将共享 Maven/SDK 下载作为一条缓存统计，只计一次。实际挂载的
  容器从创建到停止共同保护共享区；最后一个容器停止后，沿用构建缓存的
  保留期、容量上限及手动闲置清理策略。仅保留工作区的任务不永久阻止共享
  下载回收，下次运行按需重新下载。问题单构建产物的 24 小时冷却配置不变。
- 本地真实构建验证：
  `MFC_REAL_BUILD_IMAGE=<含 Maven 3.9.9/JDK/C++/Python 的镜像> npx tsx --test --test-timeout=180000 --test-force-exit tests/sharedBuildCacheReal.test.ts`。
  测试使用临时容器和 Maven 源，不预先清理编译产物，覆盖双仓下载、离线编译、install 隔离、
  SDK 原生链接、快照更新、回收重建；不替代内网私有 C++ 插件的业务构建验收。

- `settings.xml` 可从 `maven-settings.example.xml` 复制后填写内部 mirror，
  **不得包含可复用用户名、密码或 Token**。Agent 与仓库构建脚本共享容器
  身份，任何能供 Maven 读取的静态秘密也能被业务代码读取。内部依赖仓应
  使用隔离网络内的只读代理/机器身份；若平台不得不鉴权，只能给每 attempt
  短时、只读、最小范围凭据，并把“业务代码可见”纳入风险接受。
- `company-ca.pem` 供 Git/npm 扩展系统信任链；TLS 校验始终保持开启。
- Java 使用合并了公司 CA 的 `java-cacerts`。它是公开证书的信任库，不应
  包含客户端私钥。也可以直接使用已经导入公司 CA 的内部 JDK 基础镜像，
  此时无需挂载这两个 CA 文件。
- 不挂载宿主 `HOME`、Cloud 数据目录、模型/Git/通知凭据或
  `/var/run/docker.sock`。Git clone/fetch/push 仍由宿主可信控制面完成。
- 只读根文件系统下，运行时必须给 `/home/mae-flow` 和 `/tmp` 提供任务
  专属 tmpfs，并挂载四个 `/cache` 子目录；入口脚本会在空 tmpfs 中重建
  `.m2` 等用户目录，绝不能因缺挂载而回退宿主执行。
- `/tmp` 必须显式带 `exec`。Docker tmpfs 的隐含 `noexec` 会让 Maven
  Jansi、SQLite/JNA 等 Java 原生库无法加载；任务本来就能在工作区执行
  构建产物，因此这里使用 `exec` 不会扩大既有命令执行权限。

入口脚本会在容器启动时检查所有缓存目录是否可写，并仅在对应只读文件
存在时接入 Maven settings 和公司 CA。任何挂载或权限错误都会直接失败，
不会退回宿主执行。

## 发布前验证

至少执行一次真实容器自检：

```bash
docker run --rm --init mae-flow-task-builder:dev sh -lc '
  passwd_home="$(awk -F: -v uid="$(id -u)" '\''$3 == uid {print $6; exit}'\'' /etc/passwd)" &&
  test "$passwd_home" = "$HOME" &&
  java -version &&
  mvn_info="$(mvn --version 2>&1)" && printf "%s\n" "$mvn_info" &&
  printf "%s\n" "$mvn_info" | grep -Eq "Java version: 21([., ]|$)" &&
  node --version && npm --version &&
  gcc --version && g++ --version && bison --version && flex --version &&
  ccache --version && git --version && python3 --version
'
```

启动 Cloud 后还必须在管理页执行「部署自检」。它会使用正式挂载、正式
UID/GID 和正式资源限制，验证 passwd HOME、Maven 实际 JDK/cacerts、已配置
settings、五类缓存、C++ 仓父子拓扑及三类工具链。每次推送前，平台还会在
模型启动前做同一组与当前仓语言相关的快速预检；失败直接显示基础设施
缺项，不会消耗模型去盲探网络。

然后分别用 Java、JS 和 C++ 代表仓验证增量编译与 UT。仍需由部署方给出
的值只有：两个基础镜像 digest、内部 apt/Maven/npm 地址及 CA、Cloud
服务账号 UID/GID、缓存根目录，以及任务容器的资源与网络限额。
