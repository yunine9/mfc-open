import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { perRepoBuildCacheMounts } from "../src/buildCacheMounts.ts";
import { reclaimBuildCaches } from "../src/buildCache.ts";

const exec = promisify(execFile);
const image = process.env.MFC_REAL_BUILD_IMAGE;

// 真 Maven/Resolver、javac 和 C++ 编译器；私有 SDK 插件不在外网镜像内。
test("#586 双容器共享下载：增量编译、install 隔离、SDK 编译、快照更新与回收重建", {
  skip: !image && "设置 MFC_REAL_BUILD_IMAGE 为含 Maven 3.9.9、JDK、C++、Python 的镜像",
  timeout: 180_000,
}, async t => {
  const parent = join(homedir(), ".cache", "mae-flow-cloud-tests");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "shared-build-cache-"));
  const cacheRoot = join(root, "cache");
  const fixture = join(root, "fixture");
  mkdirSync(fixture);
  const network = `mfc-cache-test-${process.pid}`;
  const server = `${network}-repo`;
  const containers = new Set<string>();
  const docker = async (...args: string[]) => {
    try { return (await exec("docker", args, { timeout: 150_000, maxBuffer: 8 * 1024 ** 2 })).stdout; }
    catch (error) {
      const failed = error as Error & { stdout?: string; stderr?: string };
      throw new Error(`docker ${args[0]} failed\n${failed.stdout?.slice(-10000) ?? ""}\n${failed.stderr?.slice(-3000) ?? ""}`);
    }
  };
  t.after(async () => {
    const logs = await docker("logs", server).catch(() => "");
    if (logs.includes("PROXY_ERROR")) t.diagnostic(logs.slice(-4000));
    await Promise.all([...containers, server].map(name => docker("rm", "-f", name).catch(() => {})));
    await docker("network", "rm", network).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });
  const write = (path: string, body: string | Buffer) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, body);
  };
  // 构造真实 jar / 原生 SDK，避免把外网业务依赖冒充内网插件验收。
  write(join(fixture, "prepare.sh"), `set -eu
cd /fixture
for value in 7 8 9 11 22; do
  mkdir -p classes
  printf 'package probe; public class Library { public static final int COMPILED_VALUE = %s; public static int value() { return %s; } }' "$value" "$value" > Library.java
  javac -d classes Library.java
  jar --create --file "library-$value.jar" -C classes .
done
mkdir -p sdk/include sdk/lib
printf 'int sdk_value();' > sdk/include/sdk.hpp
printf 'int sdk_value() { return 42; }' > sdk.cpp
c++ -shared -fPIC sdk.cpp -o sdk/lib/libsdk.so
python3 -c 'import zipfile,pathlib; z=zipfile.ZipFile("sdk.zip","w"); [z.write(p,str(p.relative_to("sdk"))) for p in pathlib.Path("sdk").rglob("*") if p.is_file()]; z.close()'
`);
  await docker("run", "--rm", "--user", `${process.getuid!()}:${process.getgid!()}`, "--entrypoint", "sh",
    "-v", `${fixture}:/fixture`, image!, "/fixture/prepare.sh");
  const remote = join(fixture, "remote");
  const artifact = (path: string, data: Buffer | string) => {
    const full = join(remote, path);
    write(full, data);
    write(`${full}.sha1`, createHash("sha1").update(data).digest("hex"));
  };
  const pom = (id: string, version: string) => `<project><modelVersion>4.0.0</modelVersion><groupId>org.mae.cache</groupId><artifactId>${id}</artifactId><version>${version}</version></project>`;
  const prefix = "org/mae/cache";
  artifact(`${prefix}/library/1.0/library-1.0.jar`, readFileSync(join(fixture, "library-7.jar")));
  artifact(`${prefix}/library/1.0/library-1.0.pom`, pom("library", "1.0"));
  artifact(`${prefix}/sdk/1.0/sdk-1.0-X86_EULER.zip`, readFileSync(join(fixture, "sdk.zip")));
  artifact(`${prefix}/sdk/1.0/sdk-1.0.pom`, pom("sdk", "1.0"));
  const snapshot = (build: number, value: number) => {
    const version = `1.0-20260101.00000${build}-${build}`;
    artifact(`${prefix}/snapshot/1.0-SNAPSHOT/snapshot-${version}.jar`, readFileSync(join(fixture, `library-${value}.jar`)));
    artifact(`${prefix}/snapshot/1.0-SNAPSHOT/snapshot-${version}.pom`, pom("snapshot", "1.0-SNAPSHOT"));
    artifact(`${prefix}/snapshot/1.0-SNAPSHOT/maven-metadata.xml`, `<metadata><groupId>org.mae.cache</groupId><artifactId>snapshot</artifactId><version>1.0-SNAPSHOT</version><versioning><snapshot><timestamp>20260101.00000${build}</timestamp><buildNumber>${build}</buildNumber></snapshot><lastUpdated>2026010100000${build}</lastUpdated><snapshotVersions>${["jar", "pom"].map(ext => `<snapshotVersion><extension>${ext}</extension><value>${version}</value><updated>2026010100000${build}</updated></snapshotVersion>`).join("")}</snapshotVersions></versioning></metadata>`);
  };
  snapshot(1, 11);
  // 一个测试专用 Maven 源：业务 fixture 直接返回，构建插件从 Central 获取并缓存。
  write(join(fixture, "server.py"), `import http.server, pathlib, urllib.request, time
root=pathlib.Path('/fixture/remote')
public=pathlib.Path('/tmp/public'); public.mkdir(exist_ok=True)
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def do_GET(self):
  path=self.path.split('?')[0].lstrip('/')
  if '..' in pathlib.PurePosixPath(path).parts: self.send_error(400); return
  file=root/path
  try:
   if file.is_file():
    data=file.read_bytes(); print('FIXTURE '+path,flush=True)
   elif path.startswith('org/mae/cache/'):
    self.send_error(404); return
   else:
    file=public/path
    if file.is_file(): data=file.read_bytes()
    else:
     data=urllib.request.urlopen('https://repo.maven.apache.org/maven2/'+path,timeout=45).read()
     file.parent.mkdir(parents=True,exist_ok=True); file.write_bytes(data)
   self.send_response(200); self.send_header('Content-Length',str(len(data))); self.end_headers()
   if path.endswith('X86_EULER.zip'):
    middle=len(data)//2; self.wfile.write(data[:middle]); self.wfile.flush(); time.sleep(0.5); self.wfile.write(data[middle:])
   else: self.wfile.write(data)
  except Exception as e:
   print('PROXY_ERROR '+path+' '+str(e),flush=True); self.send_error(404,str(e))
http.server.ThreadingHTTPServer(('0.0.0.0',8000),Handler).serve_forever()
`);
  await docker("network", "create", network);
  // 部分本机 VPN 不转发 Docker 自定义网络的 DNS；从默认网络实际解析，
  // 只为测试源固定本次地址，HTTPS 仍按原主机名校验证书。
  const centralAddress = (await docker("run", "--rm", "--entrypoint", "python3", image!,
    "-c", 'import socket; print(socket.gethostbyname("repo.maven.apache.org"))')).trim();
  await docker("run", "-d", "--rm", "--name", server, "--network", network,
    "--add-host", `repo.maven.apache.org:${centralAddress}`,
    "--network-alias", "cache-repo", "--log-driver", "local", "--log-opt", "max-size=1m", "--log-opt", "max-file=2",
    "-v", `${fixture}:/fixture:ro`, "--entrypoint", "python3", image!, "/fixture/server.py");
  const mounts = (name: string) => perRepoBuildCacheMounts({ cacheRoot, cacheKeySource: name, volumes: [],
    cppSdkDestination: "/work/cpp_sdk_repository" });
  const makeProject = (name: string, dependency = "library", version = "1.0") => {
    const project = join(root, name);
    write(join(project, "pom.xml"), `<project><modelVersion>4.0.0</modelVersion><groupId>org.mae.probe</groupId><artifactId>app</artifactId><version>1</version><properties><maven.compiler.release>17</maven.compiler.release></properties><dependencies><dependency><groupId>org.mae.cache</groupId><artifactId>${dependency}</artifactId><version>${version}</version></dependency><dependency><groupId>org.mae.cache</groupId><artifactId>sdk</artifactId><version>1.0</version><type>zip</type><classifier>X86_EULER</classifier></dependency></dependencies><repositories><repository><id>fixture</id><url>http://cache-repo:8000</url><snapshots><enabled>true</enabled><updatePolicy>always</updatePolicy></snapshots></repository></repositories></project>`);
    write(join(project, "settings.xml"), '<settings><mirrors><mirror><id>fixture</id><mirrorOf>*</mirrorOf><url>http://cache-repo:8000</url></mirror></mirrors></settings>');
    write(join(project, "src/main/java/Main.java"), 'public class Main { public static void main(String[] args) { int expected = Integer.parseInt(args[0]); if (probe.Library.value() != expected || probe.Library.COMPILED_VALUE != expected) throw new AssertionError(probe.Library.value() + "/" + probe.Library.COMPILED_VALUE); } }');
    write(join(project, "main.cpp"), '#include "sdk.hpp"\nint main() { return sdk_value() == 42 ? 0 : 1; }\n');
    return project;
  };
  let sequence = 0;
  const run = async (name: string, command: string, extra: string[] = []) => {
    const mounted = mounts(name);
    const container = `${network}-${++sequence}`;
    containers.add(container);
    try {
      return await docker("run", "--rm", "--name", container, "--network", network,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
        "--tmpfs", "/tmp:rw,exec,nosuid,nodev,mode=1777,size=512m",
        "--user", `${process.getuid!()}:${process.getgid!()}`, "--entrypoint", "sh", "-w", "/work/project",
        "-e", "HOME=/tmp/home", "-e", "MAVEN_CONFIG=/tmp/home/.m2",
        ...Object.entries(mounted.environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
        ...mounted.volumes.flatMap(volume => ["-v", volume]), "-v", `${join(root, name)}:/work/project`,
        "-v", `${fixture}:/fixture:ro`, ...extra, image!, "-c", `set -eu; mkdir -p "$MAVEN_CONFIG"; ${command}`);
    } finally { await docker("rm", "-f", container).catch(() => {}); containers.delete(container); }
  };
  const mvn = "mvn -B -ntp -s settings.xml";
  const compile = `${mvn} org.apache.maven.plugins:maven-compiler-plugin:3.13.0:compile`;
  const sharedArtifact = (id: string, version: string, extension: string, fileVersion = version) =>
    `/cache/maven/repository/.mfc-remote/fixture/${prefix}/${id}/${version}/${id}-${fileVersion}.${extension}`;
  const snapshotVersion = (value: number) => `1.0-20260101.00000${value === 11 ? 1 : 2}-${value === 11 ? 1 : 2}`;
  const build = (expected: number, offline = false, id = "library", version = "1.0", local = false, options = "") =>
    `${compile} ${offline ? "-o" : ""} ${options}; java -cp target/classes:${local ? `/cache/maven/repository/${prefix}/${id}/${version}/${id}-${version}.jar` : sharedArtifact(id, version, "jar", version.endsWith("SNAPSHOT") ? snapshotVersion(expected) : version)} Main ${expected}; `
    + `python3 -c 'import zipfile; zipfile.ZipFile("/cache/maven/repository/.mfc-remote/fixture/${prefix}/sdk/1.0/sdk-1.0-X86_EULER.zip").extractall("/work/cpp_sdk_repository/sdk")'; `
    + "c++ main.cpp -I/work/cpp_sdk_repository/sdk/include -L/work/cpp_sdk_repository/sdk/lib -Wl,-rpath,/work/cpp_sdk_repository/sdk/lib -lsdk -o target/native; target/native";

  let warmed = false;
  await t.test("空缓存首次构建，第二仓离线复用 jar 与 SDK zip", async () => {
    makeProject("a"); makeProject("b");
    assert.match(await run("a", build(7)), /BUILD SUCCESS/);
    const before = await docker("logs", server);
    assert.match(await run("b", build(7, true)), /BUILD SUCCESS/);
    assert.equal(await docker("logs", server), before, "第二仓离线构建不能重复下载");
    assert.match(await run("b", build(7, true)), /Nothing to compile/,
      "依赖未变时必须保留增量，不能每次强制全量编译");
    assert.equal(readFileSync(join(cacheRoot, "shared-maven/remote/fixture", prefix, "sdk/1.0/sdk-1.0-X86_EULER.zip")).compare(readFileSync(join(fixture, "sdk.zip"))), 0);
    warmed = true;
  });
  if (!warmed) return;
  await t.test("同 GAV 的两个本地 install 互不覆盖共享下载", async () => {
    for (const [name, value] of [["a", 8], ["b", 9]] as const) {
      await run(name, `${mvn} org.apache.maven.plugins:maven-install-plugin:3.1.3:install-file -Dfile=/fixture/library-${value}.jar -DgroupId=org.mae.cache -DartifactId=library -Dversion=1.0 -Dpackaging=jar`);
    }
    await Promise.all([run("a", build(8, true, "library", "1.0", true)), run("b", build(9, true, "library", "1.0", true))]);
    const downloaded = join(cacheRoot, "shared-maven/remote/fixture", prefix, "library/1.0/library-1.0.jar");
    assert.deepEqual(readFileSync(downloaded), readFileSync(join(fixture, "library-7.jar")));
  });
  await t.test("共享缓存回收后两仓同时下载 SDK，私有解压与编译都成功", async () => {
    const result = await reclaimBuildCaches({ cacheRoot, activeKeys: () => new Set(), retentionDays: 0, maxBytes: 0, allUnused: true });
    assert.equal(result.failed.length, 0); assert.equal(result.status.total_bytes, 0);
    makeProject("c"); makeProject("d");
    const requests = async () => (await docker("logs", server)).split("\n")
      .filter(line => line.endsWith("sdk-1.0-X86_EULER.zip")).length;
    const before = await requests();
    const output = await Promise.all([run("c", build(7)), run("d", build(7))]);
    output.forEach(log => assert.match(log, /BUILD SUCCESS/));
    assert.equal(await requests() - before, 1, "跨容器文件锁必须让同一 SDK 只下载一次");
    const sdk = (name: string) => mounts(name).volumes.find(volume => volume.endsWith(":/work/cpp_sdk_repository"))!.split(":")[0];
    writeFileSync(join(sdk("c"), "sdk/include/sdk.hpp"), "private change");
    assert.equal(readFileSync(join(sdk("d"), "sdk/include/sdk.hpp"), "utf8"), "int sdk_value();");
  });
  await t.test("SNAPSHOT 遵循 always 更新，两仓都能编译新版本", async () => {
    makeProject("s1", "snapshot", "1.0-SNAPSHOT"); makeProject("s2", "snapshot", "1.0-SNAPSHOT");
    await run("s1", build(11, false, "snapshot", "1.0-SNAPSHOT"));
    write(join(root, "s1/src/test/java/TestProbe.java"), 'public class TestProbe { public static void main(String[] args) { if (probe.Library.COMPILED_VALUE != Integer.parseInt(args[0])) throw new AssertionError(probe.Library.COMPILED_VALUE); } }');
    const testCompile = (expected: number) => `${mvn} org.apache.maven.plugins:maven-compiler-plugin:3.13.0:testCompile; java -cp target/test-classes:${sharedArtifact("snapshot", "1.0-SNAPSHOT", "jar", snapshotVersion(expected))} TestProbe ${expected}`;
    await run("s1", testCompile(11));
    snapshot(2, 22);
    await run("s2", build(22, false, "snapshot", "1.0-SNAPSHOT"));
    await run("s1", `java -cp target/classes:${sharedArtifact("snapshot", "1.0-SNAPSHOT", "jar", snapshotVersion(11))} Main 11`);
    const record = join(root, "s1/target/maven-status/maven-compiler-plugin/compile/default-cli/mfc-dependencies-v1.sha256");
    const previous = readFileSync(record, "utf8");
    await run("s1", `${compile} -Dmaven.main.skip=true`);
    assert.equal(readFileSync(record, "utf8"), previous, "跳过编译不能登记依赖已验证");
    const mainSource = join(root, "s1/src/main/java/Main.java");
    const source = readFileSync(mainSource, "utf8");
    writeFileSync(mainSource, "broken syntax");
    await assert.rejects(run("s1", `${compile}`), /COMPILATION ERROR/);
    assert.equal(readFileSync(record, "utf8"), previous, "编译失败不能登记依赖已验证");
    writeFileSync(mainSource, source);
    await run("s1", build(22, false, "snapshot", "1.0-SNAPSHOT", false, "-Dmaven.compiler.useIncrementalCompilation=false"));
    await run("s1", testCompile(22));
    assert.match(await run("s1", build(22, true, "snapshot", "1.0-SNAPSHOT")), /Nothing to compile/);
  });
  await t.test("既有本地仓工件升级后仍可离线使用", async () => {
    makeProject("legacy");
    const mounted = mounts("legacy");
    const privateRoot = mounted.volumes.find(volume => volume.endsWith(":/cache/maven"))!.split(":")[0];
    const path = join(privateRoot, "repository", prefix, "library/1.0");
    write(join(path, "library-1.0.jar"), readFileSync(join(fixture, "library-8.jar")));
    write(join(path, "library-1.0.pom"), pom("library", "1.0"));
    write(join(path, "_remote.repositories"), "library-1.0.jar>fixture=\nlibrary-1.0.pom>fixture=\n");
    await run("legacy", build(8, true, "library", "1.0", true));
    assert.ok(existsSync(join(path, "library-1.0.jar")));
  });
});
