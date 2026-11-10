# Maven 共享缓存与增量编译

共享快照可能在另一个仓库构建时更新。Maven Compiler 3.13.0 只按本轮
开始时间检查依赖修改，可能出现 BUILD SUCCESS 却仍使用旧 class 的情况。
本扩展在 compile / testCompile 前比较实际 classpath 与上次成功的记录。
变化时删除当前 Compiler execution 的 inputFiles.lst，并让 Compiler
使用其增量检查来触发本模块重编；保留 createdFiles.lst，由 Compiler 自己
处理输出文件。依赖相同时保留用户原有编译设置，不强制全量或 clean。

记录位于项目 build directory 的 maven-status 中，clean 时自然清理。
编译失败、skipMain、skipTests 或无源码不会登记新依赖为已验证。检查失败
会进入 Maven 构建结果的错误列表，避免 EventSpy 的 warning 掩盖旧产物。
本地 install 的文件和 reactor class 使用内容摘要；共享远端文件使用解析后
的版本路径及文件属性，避免逐模块读取大 SDK zip。共享快照必须保留时间戳
文件名，不能重新启用 snapshotNormalization。

Cloud 以只读方式挂载此目录，通过 maven.ext.class.path 加载 extension.jar，
并保留部署 MAVEN_OPTS 中已有的扩展路径。无平台缓存时不注入；非 Java
Compiler 插件（包括私有 C++ SDK 插件）不受本扩展处理。

源码在 src/，JAR 使用 Java 8 字节码，只依赖 Maven 自带 API。使用仓内
构建镜像离线生成，ZIP 时间固定；manifest.json 用于防止源码与发布物脱节：

```sh
npx tsx scripts/build-maven-cache-extension.ts
npx tsx scripts/build-maven-cache-extension.ts --check
MFC_REAL_BUILD_IMAGE=mae-flow-task-builder:dev npx tsx --test --test-timeout=180000 --test-force-exit tests/sharedBuildCacheReal.test.ts
```

构建镜像需包含 Maven 3.9.9（/usr/share/maven）、JDK 21 和 Python 3。
已验证 Compiler 3.13.0 的直接 goal、compile/testCompile、显式关闭增量、
失败后重试与跳过编译。更新 Maven/Compiler 大版本时须重新运行验证；真实
内网业务仓和私有 SDK 插件的验收与本机模拟业务依赖验证分开记录。
