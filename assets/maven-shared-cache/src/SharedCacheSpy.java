package com.maeflow.cache;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.apache.maven.eventspy.AbstractEventSpy;
import org.apache.maven.execution.ExecutionEvent;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.project.MavenProject;
import org.codehaus.plexus.util.xml.Xpp3Dom;

/** 共享依赖可能在本轮开始前已更新，不能只靠 Compiler 的本轮时间判断。 */
public final class SharedCacheSpy extends AbstractEventSpy {
    private final Map<Path, String> pending = new ConcurrentHashMap<>();
    private final Map<String, String> digests = new ConcurrentHashMap<>();

    @Override
    public void onEvent(Object value) throws Exception {
        if (!(value instanceof ExecutionEvent)) return;
        ExecutionEvent event = (ExecutionEvent) value;
        MojoExecution mojo = event.getMojoExecution();
        if (mojo == null || !"org.apache.maven.plugins".equals(mojo.getGroupId())
                || !"maven-compiler-plugin".equals(mojo.getArtifactId())
                || !("compile".equals(mojo.getGoal()) || "testCompile".equals(mojo.getGoal()))) return;
        MavenProject project = event.getProject();
        Path base = Paths.get(project.getBuild().getDirectory(), "maven-status",
                "maven-compiler-plugin", mojo.getGoal()).toAbsolutePath().normalize();
        Path directory = base.resolve(mojo.getExecutionId()).normalize();
        try {
            if (!directory.startsWith(base)) throw new IllegalArgumentException("Compiler execution ID escapes status directory");
            Path record = directory.resolve("mfc-dependencies-v1.sha256");
            if (event.getType() == ExecutionEvent.Type.MojoStarted) {
                String current = signature(project, "testCompile".equals(mojo.getGoal()));
                String previous = Files.isRegularFile(record)
                        ? new String(Files.readAllBytes(record), StandardCharsets.UTF_8) : "";
                if (!current.equals(previous)) {
                    // 只使 Java 编译状态失效；由 Compiler 自己处理输出文件，不删除
                    // 源码、资源、native 库或其他语言编译器的产物。
                    Files.deleteIfExists(directory.resolve("inputFiles.lst"));
                    Xpp3Dom configuration = mojo.getConfiguration();
                    if (configuration == null) {
                        configuration = new Xpp3Dom("configuration");
                        mojo.setConfiguration(configuration);
                    }
                    Xpp3Dom incremental = configuration.getChild("useIncrementalCompilation");
                    if (incremental == null) {
                        incremental = new Xpp3Dom("useIncrementalCompilation");
                        configuration.addChild(incremental);
                    }
                    // 显式 false 只按源码时间判断，也会漏掉变化的依赖。仅此次依赖
                    // 变化时启用 Compiler 的全模块重编，后续相同依赖仍保留用户配置。
                    incremental.setValue("true");
                }
                pending.put(directory, current);
            } else if (event.getType() == ExecutionEvent.Type.MojoSucceeded) {
                String current = pending.remove(directory);
                // skipMain / skipTests / 无源码不能把一次未执行的编译登记为成功。
                if (current != null && Files.isRegularFile(directory.resolve("inputFiles.lst"))) {
                    Path temporary = Files.createTempFile(directory, ".mfc-dependencies-", ".tmp");
                    try {
                        Files.write(temporary, current.getBytes(StandardCharsets.UTF_8));
                        Files.move(temporary, record, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
                    } finally { Files.deleteIfExists(temporary); }
                }
            } else if (event.getType() == ExecutionEvent.Type.MojoFailed) {
                pending.remove(directory);
            }
        } catch (Exception failure) {
            pending.remove(directory);
            // EventSpy 本身的异常会被 Maven 吞成 warning；同时登记构建失败，
            // 避免无法检查依赖时把旧 class 的 BUILD SUCCESS 当成正确结果。
            event.getSession().getResult().addException(
                    new IllegalStateException("Cannot validate shared Maven dependency state for " + project.getId(), failure));
            throw failure;
        }
    }

    private String signature(MavenProject project, boolean test) throws Exception {
        Path output = Paths.get(test ? project.getBuild().getTestOutputDirectory()
                : project.getBuild().getOutputDirectory()).toAbsolutePath().normalize();
        List<String> classpath = test ? project.getTestClasspathElements() : project.getCompileClasspathElements();
        MessageDigest result = MessageDigest.getInstance("SHA-256");
        for (String element : classpath) {
            Path path = Paths.get(element).toAbsolutePath().normalize();
            if (path.equals(output)) continue; // 不能把本次输出反过来作为下次重编的依赖。
            add(result, path.toString());
            if (Files.isDirectory(path)) {
                // reactor / 主模块 class 也可能在前一条命令更新；只读取 class，
                // 不扫描资源或 native 构建目录。
                List<Path> classes;
                try (Stream<Path> files = Files.walk(path)) {
                    classes = files.filter(p -> p.toString().endsWith(".class") && Files.isRegularFile(p))
                            .sorted(Comparator.comparing(Path::toString)).collect(Collectors.toList());
                }
                for (Path file : classes) { add(result, path.relativize(file).toString()); add(result, digest(file)); }
            } else if (Files.isRegularFile(path)) {
                if (path.toString().contains("/repository/.mfc-remote/")) {
                    // 共享下载不改写时间戳快照，路径包含已解析版本；避免逐模块反复
                    // 读取数 GB 的 SDK zip。重新下载/替换的文件由 inode/时间/大小区分。
                    add(result, stamp(path));
                } else {
                    // 分仓 install 可覆盖相同坐标，必须检查内容而非只看版本名。
                    add(result, digest(path));
                }
            } else { add(result, "missing"); }
        }
        return hex(result.digest());
    }

    private String digest(Path path) throws Exception {
        String key = path.toString() + "\n" + stamp(path);
        String existing = digests.get(key);
        if (existing != null) return existing;
        MessageDigest result = MessageDigest.getInstance("SHA-256");
        try (InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[65536];
            int length;
            while ((length = input.read(buffer)) != -1) result.update(buffer, 0, length);
        }
        String digest = hex(result.digest());
        digests.put(key, digest);
        return digest;
    }

    private static String stamp(Path path) throws Exception {
        BasicFileAttributes stat = Files.readAttributes(path, BasicFileAttributes.class);
        return stat.size() + ":" + stat.lastModifiedTime() + ":" + stat.fileKey();
    }

    private static void add(MessageDigest digest, String value) {
        digest.update(value.getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder();
        for (byte b : bytes) value.append(String.format("%02x", b & 255));
        return value.toString();
    }
}
