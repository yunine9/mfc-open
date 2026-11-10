import { test } from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, SkillLibraryError } from "../src/hostSkillLibrary.ts";
import { editResearchDocument } from "../src/componentResearchDocument.ts";
import { componentGuideOverview } from "./fixtures/componentGuide.ts";

test("结构化知识检查实际文本，JSON 转义不能隐藏正文中的口令", () => {
  const secret = 'password = "correct-horse-battery-staple"';
  for (const payload of [{overview:secret}, {sections:[{example:secret}]},
    {notes:JSON.stringify({example:secret})},
    JSON.parse('{"password":"correct\\u002dhorse\\u002dbattery\\u002dstaple"}')]) {
    assert.throws(() => scanForSecrets("draft.json", Buffer.from(JSON.stringify(payload))),
      error => error instanceof SkillLibraryError && !error.message.includes("correct-horse-battery-staple"));
  }
  assert.throws(() => scanForSecrets("draft.json", Buffer.from(
    '{"password":"correct\\u002dhorse\\u002dbattery\\u002dstaple"}')), SkillLibraryError);
  assert.doesNotThrow(() => scanForSecrets("draft.json", Buffer.from(JSON.stringify({
    examples:['X_ACCESS_TOKEN = "X-Access-Token"', 'API_KEY = "x-api-key"'],
  }))));
});

test("结构化代码引用不误判，JSON引号和转义仍不能豁免敏感字面量", () => {
  assert.doesNotThrow(() => scanForSecrets("draft.json", Buffer.from(JSON.stringify({
    examples: ["apiKey: args.apiKey,", "token: metadata.token,"],
    notes: JSON.stringify({ example: "password: options.password," }),
  }))));
  for (const payload of [{ apiKey: "args.apiKey" }, { example: "apiKey: 'args.apiKey'," },
    { example: '"apiKey: args.apiKey,"' }, { example: 'const cfg = "apiKey: args.apiKey,";' },
    { notes: JSON.stringify({ apiKey: "args.apiKey" }) },
    { example: 'apiKey: args.apiKey\n + "fixture-suffix",' },
    { examples: ["apiKey: args.apiKey,", 'password: "fixture-only-password",'] }]) {
    assert.throws(() => scanForSecrets("draft.json", Buffer.from(JSON.stringify(payload))), SkillLibraryError);
  }
});

test("JSON 解码后的键、凭据值和嵌套文本仍全部检查", () => {
  for (const content of [
    '{"pass\\u0077ord":"fixture\\u002donly\\u002dpassword"}',
    JSON.stringify({ examples: ["apiKey: args.apiKey,", "Bearer abcdefghijklmnopqrst"] }),
    JSON.stringify({ notes: JSON.stringify({ example: "-----BEGIN PRIVATE KEY-----" }) }),
    JSON.stringify({ "Bearer abcdefghijklmnopqrst": "description" }),
    JSON.stringify({ 'password: "fixture-only-password"': "description" }),
    JSON.stringify({ [JSON.stringify({ password: "fixture-only-password" })]: "description" }),
    '{"examples":["apiKey: args.apiKey,"],"password":"fixture-only-password"}',
    '{"password":"fixture-only-password","password":"<token>"}',
    '{"password":"fixture\\u002donly\\u002dpassword","password":"<token>"}',
    '{"password":"<token>","password":"fixture-only-password"}',
    '{"password":123456789e1}',
    '{"pass\\u0077ord":123456789e1,"password":"<token>"}',
    '{"example":"safe"}\npassword: "fixture-only-password",',
  ]) {
    assert.throws(() => scanForSecrets("draft.json", Buffer.from(content)),
      error => error instanceof SkillLibraryError
        && !error.message.includes("fixture-only-password")
        && !error.message.includes("abcdefghijklmnopqrst"), content);
  }
});

test("组件草稿的真实编辑入口放行头名，拒绝口令并保留原稿", () => {
  const original={overview:componentGuideOverview("原说明"),sections:[]};
  const safe=editResearchDocument(original,{action:"overview",overview:componentGuideOverview('请求头：X_ACCESS_TOKEN = "x-access-token"')},[]);
  assert.match(safe.overview,/x-access-token/);
  for (const secret of ['password = "correct-horse-battery-staple"', 'password = "example123456"']) {
    assert.throws(() => editResearchDocument(safe,{action:"overview",overview:safe.overview+"\n"+secret},[]),SkillLibraryError);
  }
  assert.equal(original.overview,componentGuideOverview("原说明"));
  assert.equal(safe.overview,componentGuideOverview('请求头：X_ACCESS_TOKEN = "x-access-token"'));
});
