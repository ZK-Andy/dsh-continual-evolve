# Agent Note: secret-leak-guard

Status: implemented

## Problem

harness 状态层的三个写入汇入口（晋升进全局 store、`evolve_add`/`evolve_update` 直写、`/evolve mount` 物化成可执行插件文件）此前都**没有凭据形态筛查**。2026-08-28 pi/dsh 生态竞品调研确认：dsh 生态全员缺席该守卫，pi 生态仅 pi-hermes-memory 一家有（见 `docs/research/pi-dsh-competitor-gap-analysis.md` §4/§5）。本项目是公开插件——`as_sk_…`/`ghp_…`/`AKIA…`/私钥块一旦被沉淀进跨会话 store 或写盘进 mounted 插件，就是真实泄漏面；promotion 守卫的三重拦截（项目标记/薄内容/近重复）对此全部无感。

## Decision

在 `src/promotion.ts` 增加**固定不可配置**的 secret 模式集与 `secretLeakReason(content)`（命中返回「类别 + 截断脱敏值 + rotate 指令」，永不回显完整凭据），并在三个汇入口同时接线：

- **引擎咽喉**（`service.apply`）：global scope 的 create 与 update 编辑在快照与任何副作用之前筛查 `title`/`content`，命中即 throw（`create blocked: …` / `update blocked: …`）；审计与 store 均不产生。
- **晋升路径**（`filterPromotable` / `splitPromoteBlocked`，wrapup 与 fate 两路共享构造器自动生效）：secret 检查排在 scoped 之后、thin 之前，命中按 skipped/blocked 处理并带可解释 reason。
- **mount 物化检疫**（`renderMountPackage`）：条目内容会逐字嵌入生成的 index.js，命中在**创建任何文件之前** throw。

模式集覆盖：AnySearch/Anthropic/OpenAI（含 proj）key、GitHub 三段 token 与 fine-grained PAT、AWS `AKIA/ASIA`、Google `AIza`、Slack `xox*`、npm grant token、`-----BEGIN … PRIVATE KEY-----` 块、以及「凭据类字段名 = 引号长字面量」赋值形态（内置 lookahead 排除 `YOUR_API_KEY_HERE` 类全大写占位符）。豁免与 R2 冲突守卫同构：`rollbackOf` 再建豁免（回滚是确定性重建，拦截会破坏回滚不变式）、local scope 不设防（草稿空间，出口在晋升路径）。

## Alternatives considered

- **进 `PromotionPolicy` 让用户可配置**：安全不变量必须固定（AGENTS.md 编码约定：协议常量与安全不变量不进配置）——用户正则写错就静默关掉漏扫码，违背 fail loud。
- **高熵通用检测**（Shannon 熵/字典）代替前缀族：误报率不可控，会把合法示例代码整片拦死；前缀族 + 赋值形态零依赖且可解释，漏网家族后续按真实案例追加。
- **只查晋升路径不查引擎**：`evolve_add … global:true` 与门禁规划的 create 都绕开晋升路径（R2 已证明同一绕行事实）；引擎是唯一变更入口，漏检即失效。
- **错误信息回显完整命中值**：reason 会落 reviews.jsonl、审批问题文本与 plugin.log——回显即二次泄漏；截断到「能认出家族」的长度。

## Consequences

- 三个汇入口的凭据泄漏面从「靠模型自觉」变为「代码拒绝」；secret 检查是两个生态的稀缺硬安全属性（竞品对照 §4）。
- `secretLeakReason` 抛错/skip 的 reason 均含截断凭据前缀，用户能在审批流/日志里定位是哪把 key 泄漏。
- 固定模式集意味着新凭据家族需要改代码发版——接受：安全不变量的变更频率本来就低。
- 已入库的历史条目不受影响（守卫只拦新增写入）；存量清洗留待 R3 巩固循环按需扩展。

## Testing

- `test/promotion.test.ts`：11 个凭据家族逐一命中、脱敏断言（含完整值不回显）、干净散文/裸提及/占位符不误报、filterPromotable 与 splitPromoteBlocked 集成路径。
- `test/conflict-guard.test.ts`：引擎级——global create/update 命中即 throw 且零审计产生、local 放行、rollbackOf 豁免。
- `test/mount.test.ts`：命中在创建任何文件之前 throw（`evolve/mounted` 目录不存在）。

## Related

- [pi/dsh 生态竞品差距分析](../../../../docs/research/pi-dsh-competitor-gap-analysis.md)：§5.2 P0 项，证据源。
- [write-time-conflict-guard](2026-08-24-write-time-conflict-guard.md)：同一引擎咽喉的姊妹守卫；豁免语义（rollbackOf/local）刻意保持同构。
- [sediment-quality-token-economy](2026-08-22-sediment-quality-token-economy.md)：promotion 咽喉的原始守卫决定（三重拦截），本守卫在其上扩展第四类拦截并接线 mount。
