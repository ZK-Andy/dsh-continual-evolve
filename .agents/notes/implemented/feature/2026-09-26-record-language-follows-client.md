# Agent Note: 记录语言跟随客户端（决议链 + 双语 copy）

Status: implemented

## Problem

自进化记录（refinement 摘要/rationale、条目 title/content、review 与 wrap-up 结论）一直英文优先。根因三层：① 写记录的 4 个 LLM 调用点（review/planner/memory-agent/wrap-up assessor）prompt 全英文、零语言指令；② 后端从没读过客户端语言（`inject` 无 `settings`/`locale`）；③ 无语言政策（无配置、无决议、无字典）——连 0.10.1 刚发的确认弹窗中文文案都是写死的，英文用户会看到反向 bug。

## Decision

- 新模块 `src/record-language.ts`：决议链 `显式 recordLanguage 配置（auto|zh|en，默认 auto）→ 持久化 locale.preference（复用上游 dsh-client-locale 的 locale 命名空间 + preference 字段，不自创键）→ 轨迹 Han 字信号（≥5 字，限扫 4000 字）→ en（与 DSH FALLBACK_LOCALE 对齐）`。持久化读取 fail-open（服务缺失/抛错/形状漂移一律 `undefined`，不断进化链）；`recordLanguageInstruction(lang)` 是往 prompt 追加的唯一一行指令（JSON 键/id/path/代码不动）。
- 4 个 options 包各加可选 `language`（`ReviewOptions`/`PlanOptions`/`MemoryAgentOptions`/`AssessOptions`）；缺席时模块内自决议（已有 ctx + trajectory），auto 管道显式透传（review/planner/memory/fate assess/skill consult）。
- 新模块 `src/copy.ts`：四个确认弹窗的 zh/en 字典（含 300 字截断、skill 单行本地化、fate 拆解行本地化）；dialog 入口可选 `lang`，缺席走 `resolveDialogLanguage(ctx)`（持久化偏好，否则 en）。解析器双语接受（批准/Approve、执行/Proceed、归档/Archive、固化/Solidify），严格性不变（唯一显式决定，否则抛错/保守拒绝）。
- 配置：`EvolveConfig.recordLanguage` + `AutoReviewConfig.recordLanguage`，`index.ts` 透传。
- 测试：`record-language` 13 例（链条各分支、fail-open 全形状、subtag）、`prompt-language` 6 例（四处 system prompt 真带指令）、`confirm-copy` 10 例（双语 copy + 双语解析 + en 兜底）；顺带修 `auto.test.ts` 里按中文子串区分项目/全局弹窗的旧启发式（改双语匹配），`fate.test.ts` 补 settings zh stub。

## Alternatives considered

- **实时跟随客户端切换**：non-loopback 页面的选择只留当前进程，后端看不见，承诺不了，拒绝。持久化偏好是后端能可靠读到的最鲜活信号。
- **双语存储（中英各一份）**：存储翻倍 + prompt token 税；recall 是 CJK-bigram BM25，同语言 query/entry 本就排分最高，单语（作者语言）存储对机检和人都够，拒绝。
- **迁移/重写存量英文记录**：append-only 历史 + 快照回滚链，改写破坏审计连续性且对 recall 零收益，拒绝。存量原样投影，混排是预期内。
- **模型自由发挥（不给指令）**：今天中文明天英文，审计不可读，拒绝。确定性指令是底线。
- **`metadata.lang` 标签**：recall 同语言加权和审计语言分布以后用得上，但要动 validate 合约面；本轮只打基础，deferred（见遗留），拒绝现在做。
- **往 `inject` 加 `settings`**：缺服务 fail-closed 影响加载；沿用 `questionServiceOf` 式 duck-typing 懒取 + fail-open，拒绝改 inject。

## Consequences

- 本机（`locale.preference=zh`）此后新记录全中文；英文用户全英文；`recordLanguage: "en"|"zh"` 可钉死。
- 无持久化偏好且无轨迹信号的弹窗走英文（DSH 兜底一致）；0.10.1 写死中文的行为被字典取代，对本用户零变化。
- `1075 测试 / 58 文件`，tsc/oxlint/覆盖率/文档门禁全绿；`metadata.lang` 与英文 trajectory 检测（纯英文用户无 durable 时的记录语言）留待后续。
