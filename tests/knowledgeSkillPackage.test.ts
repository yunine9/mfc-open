import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { submitHostSkill, approveSkillSubmission, readHostSkillPackage, readSkillSubmissionPackage } from "../src/hostSkillLibrary.ts";
import { saveKnowledgeSkillContext, readKnowledgeSkillContext } from "../src/knowledgeSkillContext.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
const metadata = { nature:"engineering" as const, form:"skill" as const, business_module_ids:[], repositories:[],technologies:["typescript"] };
const files=[{path:"SKILL.md",content_base64:Buffer.from("---\nname: test-package\ndescription: Review timer callbacks.\n---\n# Timer review\nRead references/rules.md before editing.\n").toString("base64")},{path:"references/rules.md",content_base64:Buffer.from("# Cancellation\nVerify the callback is not scheduled again.\n").toString("base64")}];
test("Skill提交与上架按完整包读取，未通过版本不可覆盖当前包",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-package-"));try{
 seedTechnologyStacks(dir,["typescript"]);
 const record=await submitHostSkill(dir,"test-package",files,"reviewer",metadata);
 assert.deepEqual(readSkillSubmissionPackage(dir,"test-package",record.id).files.map(f=>f.path),["SKILL.md","references/rules.md"]);
 await approveSkillSubmission(dir,"test-package",record.id,"reviewer");
 assert.equal(readHostSkillPackage(dir,"test-package").files[1].content,"# Cancellation\nVerify the callback is not scheduled again.\n");
 assert.throws(()=>readHostSkillPackage(dir,"../outside"));
 assert.throws(()=>readSkillSubmissionPackage(dir,"test-package","../outside"));
 const next=await submitHostSkill(dir,"test-package",[{...files[0],content_base64:Buffer.from(Buffer.from(files[0].content_base64,"base64").toString()+"\nDraft change").toString("base64")},files[1]],"reviewer",metadata);
 assert.ok(readSkillSubmissionPackage(dir,"test-package",next.id).files[0].content?.includes("Draft change"));
 assert.ok(!readHostSkillPackage(dir,"test-package").content.includes("Draft change"));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("Skill完整包预览拒绝软链接，不读取包外文件",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"knowledge-package-path-"));try{
 seedTechnologyStacks(dir,["typescript"]);
 const record=await submitHostSkill(dir,"test-package",files,"reviewer",metadata);await approveSkillSubmission(dir,"test-package",record.id,"reviewer");
 writeFileSync(join(dir,"outside.txt"),"private");symlinkSync(join(dir,"outside.txt"),join(dir,"skills","test-package","references","outside.txt"));
 assert.throws(()=>readHostSkillPackage(dir,"test-package"));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("Skill制作任务归属跨读取保留，编号不允许越界",()=>{const dir=mkdtempSync(join(tmpdir(),"knowledge-skill-context-"));try{saveKnowledgeSkillContext(dir,"extract-1",metadata);assert.deepEqual(readKnowledgeSkillContext(dir,"extract-1"),metadata);assert.equal(readKnowledgeSkillContext(dir,"extract-2"),undefined);assert.throws(()=>readKnowledgeSkillContext(dir,"../extract-1"));}finally{rmSync(dir,{recursive:true,force:true});}});
