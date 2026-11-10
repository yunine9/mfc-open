import type { ResearchSection } from "../../src/componentResearchDocument.ts";

export const componentGuideUsageId = `everycode-${"a".repeat(24)}`;
export const componentGuideTestId = `everycode-${"b".repeat(24)}`;
export const componentGuideOverview = (purpose = "文件组件提供文件创建、写入与关闭能力。", configuration = "使用 C++17，链接标准库。") =>
  `## 组件用途\n${purpose}\n\n## 接入配置\n${configuration}`;
const contentPrefix = "### 适用场景\n需要创建并释放临时文件。\n\n### 使用步骤\n创建文件，写入数据，处理返回值，最后关闭文件。\n\n### 使用约束\n";
export const componentGuideContent = (constraints = "调用方负责关闭已创建的文件并处理失败返回值。") => `${contentPrefix}${constraints}`;
/** 共享审阅契约只比较被编辑的文字；组件模板在真实写入口接受校验。 */
export const componentGuideText = (content: string) => content.startsWith(contentPrefix) ? content.slice(contentPrefix.length) : content;

const cppExample = "```cpp\n#include <cstdio>\nint main() {\n  std::FILE* file = std::tmpfile();\n  if (!file) return 1;\n  const bool written = std::fputs(\"hello\", file) >= 0;\n  const bool closed = std::fclose(file) == 0;\n  return written && closed ? 0 : 1;\n}\n```";
const cppTests = "```cpp\n#include <cassert>\n#include <cstdio>\nint main() {\n  std::FILE* file = std::tmpfile();\n  assert(file != nullptr);\n  assert(std::fputs(\"hello\", file) >= 0);\n  std::rewind(file);\n  char buffer[6] = {};\n  assert(std::fread(buffer, 1, 5, file) == 5);\n  assert(buffer[0] == 'h' && buffer[4] == 'o');\n  assert(std::fclose(file) == 0);\n}\n```\n\n在示例目录执行：`c++ -std=c++17 file_test.cpp -o file_test && ./file_test`。";
const javaExample = "```java\nimport java.nio.file.Files;\nimport java.nio.file.Path;\npublic class FileExample {\n  public static void main(String[] args) throws Exception {\n    Path file = Files.createTempFile(\"example\", \".txt\");\n    try { Files.writeString(file, \"hello\"); }\n    finally { Files.deleteIfExists(file); }\n  }\n}\n```";
const javaTests = "```java\nimport java.nio.file.Files;\nimport java.nio.file.Path;\npublic class FileExampleTest {\n  public static void main(String[] args) throws Exception {\n    Path file = Files.createTempFile(\"test\", \".txt\");\n    try {\n      Files.writeString(file, \"hello\");\n      assert Files.readString(file).equals(\"hello\");\n    } finally { Files.deleteIfExists(file); }\n    assert !Files.exists(file);\n  }\n}\n```\n\n在示例目录执行：`javac FileExampleTest.java && java -ea FileExampleTest`。";

/** 状态、预算和发布测试的模拟研究结果，不作为真实 everycode 取证。 */
export function componentGuideSection(id: string, repositoryIds: string[], options: {
  title?: string; content?: string; language?: string; component?: string;
} = {}): Omit<ResearchSection, "selected" | "revision"> {
  const language = options.language ?? "cpp", java = language === "java";
  return { id, title: options.title ?? "文件处理", repository_ids: repositoryIds, content: componentGuideContent(options.content),
    interfaces: java ? "Files.createTempFile、Files.writeString、Files.deleteIfExists" : "std::tmpfile、std::fputs、std::fclose",
    integration: java ? "使用 JDK 11 或更新版本的 java.nio.file。" : "使用 C++17，链接标准库。",
    example: java ? javaExample : cppExample, unit_tests: java ? javaTests : cppTests, sources: "", related_ids: [],
    paradigm: { kind: "paradigm", component: options.component ?? "files", language, status: "recommended", need: options.title ?? "文件处理",
      api: [java ? "Files.createTempFile" : "std::tmpfile"], applicability: java ? "JDK 11 及以上。" : "支持 C++17 的环境。",
      replaces: { identifiers: [], imports: [], patterns: [] },
      evidence: [{ repository_id: repositoryIds[0], path: java ? "src/FileExample.java" : "src/file.cpp", revision: "a".repeat(40), start: 1, end: 3 }],
      usage_evidence: [componentGuideUsageId], test_evidence: [componentGuideTestId], open_questions: [] } };
}

export function componentGuideEvidence(language = "cpp", repositoryIds: string[] = []): Array<Record<string, unknown>> {
  return [
    ...repositoryIds.map(component_id => ({ tool: "component_source", action: "read", status: "returned", component_id,
      path: language === "java" ? "src/FileExample.java" : "src/file.cpp", revision: "a".repeat(40), start: 1, end: 3 })),
    { evidence_id: componentGuideUsageId, tool: "code_search", action: "read", status: "returned", purpose: "usage", content: language === "java" ? javaExample : cppExample },
    { evidence_id: componentGuideTestId, tool: "code_search", action: "read", status: "returned", purpose: "unit-test", content: language === "java" ? javaTests : cppTests },
  ];
}
