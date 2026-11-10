/** 离线构建可审阅源码对应的 Maven 扩展，固定 ZIP 时间，--check 验证发布物。 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const assets = fileURLToPath(new URL("../assets/maven-shared-cache", import.meta.url));
const parent = join(homedir(), ".cache", "mae-flow-cloud-tests");
mkdirSync(parent, { recursive: true });
const temporary = mkdtempSync(join(parent, "maven-extension-build-"));
try {
  execFileSync("docker", ["run", "--rm", "--network", "none", "--entrypoint", "sh",
    "--user", `${process.getuid!()}:${process.getgid!()}`, "-v", `${assets}/src:/source:ro`,
    "-v", `${temporary}:/out`, process.env.MFC_REAL_BUILD_IMAGE ?? "mae-flow-task-builder:dev", "-c",
    `set -eu
mkdir -p /out/classes/META-INF/plexus
javac -g:none --release 8 -encoding UTF-8 -cp "/usr/share/maven/lib/*" -d /out/classes /source/SharedCacheSpy.java
cp /source/components.xml /out/classes/META-INF/plexus/components.xml
python3 -c 'import pathlib,zipfile; root=pathlib.Path("/out/classes"); z=zipfile.ZipFile("/out/extension.jar","w"); [(z.writestr(zipfile.ZipInfo(str(p.relative_to(root)),(2000,1,1,0,0,0)),p.read_bytes())) for p in sorted(root.rglob("*")) if p.is_file()]; z.close()'`],
  { stdio: "pipe", timeout: 30_000 });
  const jar = readFileSync(join(temporary, "extension.jar"));
  const sourceHash = createHash("sha256");
  for (const name of ["SharedCacheSpy.java", "components.xml"]) sourceHash.update(readFileSync(join(assets, "src", name)));
  const manifest = JSON.stringify({ source_sha256: sourceHash.digest("hex"), jar_sha256: createHash("sha256").update(jar).digest("hex") }, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    assert.deepEqual(jar, readFileSync(join(assets, "extension.jar")), "源码重新编译结果必须与分发 JAR 一致");
    assert.equal(manifest, readFileSync(join(assets, "manifest.json"), "utf8"));
    console.log("Maven cache extension reproducible build verified");
  } else {
    writeFileSync(join(assets, "extension.jar"), jar);
    writeFileSync(join(assets, "manifest.json"), manifest);
    console.log("Maven cache extension built from source");
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
