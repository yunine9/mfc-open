/**
 * 重启演练的独立假模型网关(harness/restart-drill.sh 专用)。
 *
 * 演练要求模型网关比 serve 进程活得久(杀的是 serve 不是模型),
 * 且前世/今生的剧本不同:前世把任务带到等待人工,今生的重建会话
 * 直接收口。两个 ScriptedModelServer 各占一个环回端口,把各自的
 * models.json 写到 argv 指定的两个路径;进程保活,由演练脚本按
 * PID 收尾。
 */

import { writeFileSync } from "node:fs";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) {
  console.error("用法: tsx harness/scripted-gateway.ts <modelsA.json> <modelsB.json>");
  process.exit(2);
}

// 前世:走到等待人工;若决定被误注回旧会话,第二幕的文案会暴露它。
const LIFE_A: Scene[] = [
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "重启演练:方案确认吗?",
                                   options: ["确认", "打回"],
                                   recommended: "确认" }] } } },
  { text: "不该走到这里:决定应由重建会话消费" },
];
// 今生:重建会话不带旧上下文,首回合即收口。
const LIFE_B: Scene[] = [
  { text: "已收到用户答复,继续并完成任务。" },
];

const lifeA = new ScriptedModelServer(LIFE_A);
const lifeB = new ScriptedModelServer(LIFE_B);
await lifeA.start();
await lifeB.start();
writeFileSync(pathA, JSON.stringify(lifeA.modelsJson()));
writeFileSync(pathB, JSON.stringify(lifeB.modelsJson()));
console.log(`READY ${lifeA.baseUrl} ${lifeB.baseUrl}`);
setInterval(() => {}, 60_000); // 保活;演练脚本负责收尾
