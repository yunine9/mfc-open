/** 规则候选由结构化替代关系生成。仅供预览/自测，不接入运行中的代码门禁。 */
export function componentRuleFiles(rules: Array<{ id: string; language: string; kind: string; value: string; component: string; paradigm_id: string; applicability: string }>) {
  const files: Record<string, string> = {}, unsupported: string[] = [];
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const candidate of rules) {
    const { language, kind, value } = candidate;
    if (!["c", "cpp", "java"].includes(language)) { unsupported.push(`${candidate.id}：${language} 暂无语法规则适配器`); continue; }
    let rule: Record<string, unknown>, invalid: string[], valid: string[];
    if (kind === "imports") {
      if (language === "java") {
        if (!/^[a-z_][\w]*(\.[A-Za-z_$][\w$]*)+(\.\*)?$/.test(value)) throw new Error(`Java 导入格式无效：${value}`);
        const regex = "^import\\s+(static\\s+)?" + escape(value.replace(/\.\*$/, "")) + (value.endsWith(".*") ? "\\.[\\w$.*]+" : "(\\.[\\w$]+|\\.\\*)?") + "\\s*;";
        rule = { kind: "import_declaration", regex }; invalid = [`import ${value};`]; valid = ["import com.example.Unrelated;", `// import ${value};`];
      } else {
        if (!/^(<[^<>\s]+>|"[^"\s]+")$/.test(value)) throw new Error(`C/C++ include 格式无效：${value}`);
        rule = { kind: "preproc_include", has: { kind: value.startsWith("<") ? "system_lib_string" : "string_literal", regex: "^" + escape(value) + "$" } };
        invalid = [`#include ${value}`]; valid = ["void f() {}", `// #include ${value}`];
      }
    } else if (language === "java") {
      const parts = value.split("."), last = parts.at(-1)!;
      if (/^[A-Z]/.test(last)) { rule = { kind: "type_identifier", regex: "^" + escape(last) + "$" }; invalid = [`class A { Object f() { return new ${last}(); } }`]; }
      else { rule = { kind: "method_invocation", regex: "^" + parts.map(escape).join("\\s*\\.\\s*") + "\\s*\\(" }; invalid = [`class A { void f() { ${value}(); } }`]; }
      valid = ["class A { int n = 1; }", `// ${value}`, `class A { String text = "${value}"; }`];
    } else if (value.includes("::") && language === "cpp") {
      rule = { kind: "qualified_identifier", regex: "^" + escape(value) + "(\\s*<[\\s\\S]*)?$" };
      invalid = [`void f() { ${value} x; }`]; valid = ["void f() { int x = 1; }", `// ${value}`, `const char* text = "${value}";`];
    } else {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) { unsupported.push(`${candidate.id}：无法可靠表达 ${language} 标识符 ${value}`); continue; }
      rule = { kind: "call_expression", has: { field: "function", kind: "identifier", regex: "^" + escape(value) + "$" } };
      invalid = [`void f() { ${value}(0); }`]; valid = ["void f() { int x = 1; }", `// ${value}(0)`, `const char* text = "${value}(0)";`];
    }
    const id = `component-${candidate.id}`;
    files[`derived/ast-grep/rules/${id}.yml`] = JSON.stringify({ id, language: { cpp: "Cpp", c: "C", java: "Java" }[language], severity: "warning",
      message: `核对是否应使用 ${candidate.component}；范式 ${candidate.paradigm_id}`,
      note: `尚未启用的候选。适用条件：${candidate.applicability}。Java 简单类型名及未解析的依赖可能误报，需先验证允许场景。`, rule }, null, 2) + "\n";
    files[`derived/ast-grep/rule-tests/${id}-test.yml`] = JSON.stringify({ id, valid, invalid }, null, 2) + "\n";
  }
  files["derived/ast-grep/sgconfig.yml"] = "ruleDirs:\n  - rules\ntestConfigs:\n  - testDir: rule-tests\n";
  files["derived/rule-report.md"] = ["# 规则候选报告", "规则尚未启用，语法匹配不等于业务违规。先验证正反例、依赖版本、适用范围及例外。", ...unsupported.map(s => "- " + s)].join("\n\n") + "\n";
  return files;
}
