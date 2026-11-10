# mock/dts-tickets.json — 模拟 DTS 单据

`--dts-mock` 开发模式的单据数据源(`src/serve.ts` 加 `--dts-mock` 启用,
与 `--dts-mcp-url` 互斥)。`MockDtsGateway`(src/issueFlow/gateways.ts)
**每次拉单/查单都现读本文件**——改完保存,列表页点「刷新」即生效,不用重启。

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `ticket` | ✓ | 单号,唯一键;任意编(拉单按账号哈希错开展示顺序) |
| `title` | ✓ | 标题 |
| `status` | | 状态名。**只有「开发人员实施修改」会出现在可发起列表**,其他状态只进"存在但不可拉取"提示 |
| `version` | | B 版本串(如 `V100R025C10SPC010B009`);版本过滤器按剥掉 B 段后的组聚合 |
| `severity` / `submitter` / `url` | | 展开详情里的问题级别/提单人/问题链接 |
| `content` | | 纯文本正文,Agent 的 `dts_get_ticket` 看到的是它;缺省给罐头模板 |
| `description` | | HTML 描述,详情展开的富文本区(消毒后渲染) |

## 内嵌截图

`content`/`description` 里放 `<img src="/v1/nfs/mock/<单号短名>/xx.png">`
即成内嵌截图;二进制由 gateways.ts 的罐头 PNG 提供(当前只备了
`2026-1007` 的 `export-error.png`/`topology.png` 两张,要新图在
`MOCK_TICKET_IMAGES` 加条目)。

## 校验纪律

文件缺失、坏 JSON、条目缺 `ticket`/`title`:拉单当场报错并给出本文件
路径(fail-loud)——静默空列表看起来像"没单",会骗人。
