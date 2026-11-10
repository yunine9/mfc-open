/**
 * 验图工具:把文档里的 PlantUML 块用**真组件、真样式**渲成静态 HTML,
 * 配 headless chrome 截图,肉眼核对。
 *
 *   npx tsx render-cd.tsx <文档> <输出.html> [第几块,默认 1]
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --headless --screenshot=out.png --window-size=1300,1700 out.html
 *
 * 为什么非得走 <PlantUml> 这个真入口:第一版图省事直接调 ClassDiagram,
 * 结果绕开了"谁来画"的判定,截图好看得很——而页面上那张图其实被时序
 * 解析器抢去画了。绕开一层就验不到那一层的坑。
 */
import { readFileSync, writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PlantUml } from "./src/PlantUml.tsx";

const [, , docPath, outPath, which = "1"] = process.argv;
const source = readFileSync(docPath, "utf8")
  .split("```plantuml")[Number(which)]?.split("```")[0];
if (!source) throw new Error(`文档里没有第 ${which} 个 plantuml 块`);

const read = (name: string) =>
  readFileSync(new URL(`./src/${name}`, import.meta.url), "utf8");
const body = renderToStaticMarkup(<PlantUml source={source} />);
writeFileSync(outPath, `<!doctype html><meta charset="utf-8"><style>
${read("tailwind.css")}
body{background:var(--surface);margin:0;padding:16px}
</style>${body}`);

console.log("渲成了:", body.match(/<figcaption[^>]*>([^<]*)</)?.[1]);
