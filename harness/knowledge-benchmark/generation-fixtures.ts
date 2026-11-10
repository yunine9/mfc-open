/** Synthetic incidents and acceptance criteria, fixed before running the model. Not examples injected into its mission. */
export interface GenerationFixture {
  id: string; split: 'development' | 'holdout'; context: string;
  before: string; after: string; evidence: Array<{id:string;note:string;resolution:string}>;
  requiredEvidence?: string; forbiddenEvidence: string[];
  concepts: Array<{name:string; alternatives:string[]}>;
  empty?: boolean;
}
export const generationFixtures: GenerationFixture[] = [
  {id:'owned-resource',split:'development',context:'export 模块 C++ ReportWriter 交付复盘。验证记录：未执行自动测试。',
    before:'bool save(ReportWriter& owned) { if (!owned.open()) return false; bool ok=owned.write(); owned.close(); return ok; }\nbool append(ReportWriter& borrowed) { return borrowed.write(); }\n',
    after:'bool save(ReportWriter& owned) { if (!owned.open()) { owned.close(); return false; } bool ok=owned.write(); owned.close(); return ok; }\nbool append(ReportWriter& borrowed) { return borrowed.write(); }\n',
    evidence:[
      {id:'annotation:owned',note:'本函数自己持有的 ReportWriter.open 失败前也可能分配资源，失败分支必须 close。',resolution:'采纳并修复。契约只针对本函数拥有的句柄；借用的已打开句柄归调用方管理，append 不得 close。'},
      {id:'annotation:borrowed',note:'append 无论成功失败都应 close。',resolution:'否决。这是借用的句柄，不能关闭调用方资源。'},
      {id:'feedback:format',note:'希望把变量名改成长一点。',resolution:'个人偏好，未采纳，无团队命名约定。'},
    ],requiredEvidence:'annotation:owned',forbiddenEvidence:['annotation:borrowed','feedback:format'],
    concepts:[{name:'打开失败路径',alternatives:['open.{0,24}失败','打开.{0,24}失败']},
      {name:'资源所有权条件',alternatives:['自[己行].{0,20}(持有|创建|拥有)','拥有','所有权']},
      {name:'释放动作',alternatives:['close','关闭','释放']},{name:'借用例外',alternatives:['借用','调用方.{0,24}(管理|释放|关闭)']}]},
  {id:'versioned-config',split:'development',context:'export 模块组件 2.7B。旧产品 2.6 保留原契约。记录只有人工 diff 确认，没有测试执行结果。',
    before:'int timeoutMillis() { return Config::value("request_timeout_ms"); }\n',
    after:'int timeoutMillis() { return Config::value("request_timeout_seconds") * 1000; }\n',
    evidence:[{id:'annotation:units',note:'2.7B 将超时配置改为 request_timeout_seconds（秒），边界调用要求毫秒。',resolution:'已改用新键并乘 1000。仅 2.7B 适用；2.6 仍使用 request_timeout_ms，不能全版本统一替换。'},
      {id:'feedback:feature',note:'新增支持关闭超时的新需求。',resolution:'后续独立需求，不是本次首次交付缺陷，当前没有实现。'}],
    requiredEvidence:'annotation:units',forbiddenEvidence:['feedback:feature'],concepts:[
      {name:'当前版本',alternatives:['2\\.7B']},{name:'新配置键',alternatives:['request_timeout_seconds']},
      {name:'单位换算',alternatives:['1000','秒.{0,30}毫秒']},{name:'旧版本例外',alternatives:['2\\.6']}]},
  {id:'non-idempotent-retry',split:'development',context:'billing 模块：提交支付请求。网络超时无法确认服务端是否已扣款；接口目前不支持幂等键。没有测试执行记录。',
    before:'Result pay() { auto r=charge(); if (r.timeout) return charge(); return r; }\n',
    after:'Result pay() { auto r=charge(); if (r.timeout) return pendingConfirmation(); return r; }\n',
    evidence:[{id:'annotation:retry',note:'超时后直接重试可能重复扣款，因为未知第一次请求是否成功且接口无幂等保障。',resolution:'采纳：超时进入待核实状态，查询交易结果后再决定；明确有服务端幂等保障的接口不受这项禁重试约束。'},
      {id:'feedback:all',note:'建议所有网络错误都无限重试。',resolution:'否决，会重复产生副作用，不能当作团队规范。'}],
    requiredEvidence:'annotation:retry',forbiddenEvidence:['feedback:all'],concepts:[
      {name:'不确定结果',alternatives:['未知','不确定','无法确认','未确认']},{name:'幂等条件',alternatives:['幂等']},
      {name:'重复副作用',alternatives:['重复.{0,12}(扣款|支付|副作用|执行)']},{name:'核实后处理',alternatives:['查询','核实','确认交易','待确认']}]},
  {id:'no-defect',split:'development',context:'交付后只增加了需求范围并讨论格式偏好；没有发现首次实现缺陷。所有意见处理结果在完整证据中。',
    before:'std::string render() { return "CSV"; }\n',after:'std::string render(bool json) { return json ? "JSON" : "CSV"; }\n',
    evidence:[{id:'feedback:new-format',note:'现在需要增加 JSON 输出。',resolution:'首次需求仅要求 CSV；这属于新增需求，不是首次遗漏。'},
      {id:'annotation:style',note:'所有变量应使用大写。',resolution:'个人偏好，团队无此规范，已否决。'}],
    forbiddenEvidence:['feedback:new-format','annotation:style'],concepts:[],empty:true},
  {id:'conditional-update',split:'holdout',context:'export 模块的文档编辑客户端。服务端支持 ETag 和 If-Match；412 表示版本冲突。未执行测试。',
    before:'void save() { put(body); }\n',after:'void save() { auto r=put(body, "If-Match", etag); if(r.status==412) showConflict(); }\n',
    evidence:[{id:'annotation:etag',note:'覆盖保存会抹掉其他人的编辑；读取时保留 ETag，提交时带 If-Match，412 时提示冲突而不能直接重试覆盖。',resolution:'已采纳。此约定仅适用于支持条件更新的服务端；不支持的接口不能伪造 ETag 或宣称已防止并发覆盖。'}],
    requiredEvidence:'annotation:etag',forbiddenEvidence:[],concepts:[{name:'版本标识',alternatives:['ETag']},{name:'条件更新头',alternatives:['If-Match']},{name:'冲突状态',alternatives:['412']},{name:'服务端前提',alternatives:['服务端','服务器','接口支持']}]},
  {id:'zero-is-valid',split:'holdout',context:'export 模块 C++ 配置读取。0 表示禁用缓存，未配置才使用默认 30 秒；未执行测试。',
    before:'int ttl() { auto v=cacheTtl(); return (!v || *v==0) ? 30 : *v; }\n',after:'int ttl() { return cacheTtl().value_or(30); }\n',
    evidence:[{id:'annotation:zero',note:'0 是有效的禁用缓存值，不能用真假值判断当作缺省；未配置（nullopt）才默认 30 秒。',resolution:'采纳，区分未配置和显式零值。其他配置项是否允许 0 应核对其契约，不能统一把 0 解释为禁用。'}],
    requiredEvidence:'annotation:zero',forbiddenEvidence:[],concepts:[{name:'显式零值',alternatives:['0','零']},{name:'缺省条件',alternatives:['未配置','nullopt','缺省','缺失']},{name:'默认值',alternatives:['30']},{name:'禁用含义',alternatives:['禁用','关闭缓存']}]},
];
