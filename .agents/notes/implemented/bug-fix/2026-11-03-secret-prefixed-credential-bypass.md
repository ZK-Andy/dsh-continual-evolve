# Agent Note: secret 门禁覆盖带前缀凭据名

Status: implemented

## Problem

`src/data/secret.ts:32` 的 credential-assignment 模式以 `\b` 开头。JS 的 `\b` 只在「词字符与非词字符之间」成立，而 `_` 本身是词字符——所以名字前带下划线的标准 env 写法全部绕过门禁：`MY_API_KEY="…"`、`OPENAI_API_KEY="…"`、`GITHUB_TOKEN="…"`、`DB_PASSWORD="…"`、`APP_SECRET="…"` 实测均返回 `undefined`（CLEAN），只有裸 `API_KEY="…"`、`apiKey: '…'` 被拦。dsh-bounty 的公开报告 #904（2026-10-18，P2）正是此缺陷，仓库当时未修、无回归测试（`test/memory-rules.test.ts:67` 只覆盖裸名）。

这不是理论问题：`*_API_KEY` / `*_TOKEN` 是 `.env` 与 CI 配置最常见的命名形态，而命中内容会被沉淀进跨会话记忆库并在开局注入。守卫的现有承诺是「凭据类字段名 = 引号长字面量即拦」，前缀名绕过让该承诺对真实写法失效。

## Decision

把该模式的首个 `\b` 换成零宽后顾 `(?<![A-Za-z0-9])`；名字组、名字后的 `\b`、`[:=]` 两侧的可选引号与空白，以及全大写占位符负向前瞻全部不动。

- 前置字符只要是 `_`、`-`、空白或标点即可，前缀名段无需被匹配，单次命中的 `match[0]` 与 `redactSecret` 输出逐字不变；`-`、空白、标点、串首处的行为与原 `\b` 等价，真正多放行的只有 `_` 前缀位。
- 名字组之后必须整体紧跟 `[:=]`（中间只允许引号与空白），这才是 `API_KEY_ROTATION`、`TOKENIZER` 不命中的实际守卫——名字组总以词字符收尾，该位置的 `\b` 与 `[:=]` 约束等价，保留作双保险。
- 其余语义不动：仍要求「名字 + 引号包住的长字面量」，仍用全大写 lookahead 排除 `YOUR_API_KEY_HERE` 类占位符，固定模式集仍不可配置。
- 回归测试加在 `test/memory-rules.test.ts` 的 `secretLeakReason` 块：五类前缀名（`MY_API_KEY=`、`OPENAI_API_KEY=`、`GITHUB_TOKEN=`、`DB_PASSWORD=`、`APP_SECRET=`）必须命中，回退 `\b` 必红；前缀占位符、`API_KEY_ROTATION = "…"`、`TOKENIZER = "…"` 与散文必须放行。`X-API-KEY:` 在旧实现下已命中，属既有能力，回归放入原真实凭据用例。

## Alternatives considered

- **保留 `\b`，前面加可选前缀组 `(?:\b[A-Za-z0-9]+[_-])?`**：能覆盖 env 风格，但匹配起点会退到前缀本身，命中文本与脱敏摘要会多带前缀（`MY_API_KEY="…"` 而非 `API_KEY="…"`），且 `X-API-KEY` 这类无前缀混合形态要另写分支。后顾是零宽精确解，落败。
- **去掉左边界直接搜名字后缀**：会连 `myApiKey`、`notapi_key` 这类词内串一起拦，误报面扩大，语义上把「赋值形态」扩成「任意包含」；超出 #904 范围，另立提案再议。落败。
- **顺带支持无引号赋值 `MY_API_KEY=abcdef…`**：`.env` 常见形态，但会引入 16 位数字、路径串等误报，违背 v1 守卫「引号长字面量、低误报」的既定取舍；需单独评估，本笔不做。落败（本次不做）。

## Consequences

- 已知绕过（带前缀名）关闭，`MY_API_KEY`、`X-API-KEY`、`FOO_SECRET` 等命名空间全部 fail-closed；用户需改写措辞或把凭据移出 store，这是故意的。
- **升级后果**：守卫不只拦新增。`src/data/patrol.ts:98-119` 的 `quarantineSecrets` 会对全部 active 记忆、技能与 prompt 重判并隔离命中行，而 `src/services/extraction-propose.ts:222` 表明 applied 抽取后会立即触发巡检——升级后首次巡检即会把库中已有的 `MY_API_KEY="…"` 类行隔离；若被隔离的是技能条目，`src/data/patrol.ts:69-72` 还会删除其托管文件。发版 notes 必须向用户明示这一点。
- 多处命中时首个 reason 点名的对象会变（旧实现跳过后报较晚的裸名 `TOKEN`，新实现先报更早的 `API_KEY`）；单次命中的 `match[0]` 与脱敏格式不变，这是修复的预期目标。
- 仍不覆盖（既有名字枚举边界，本笔不扩面）：无引号赋值；camelCase 前缀（`myApiKey`，词内串）；`_` 后缀名（`SECRET_KEY="…"`、`PASSWORD_HASH="…"`、`API_KEY_ID="…"` 仍 `undefined`）；值含 `${}` 插值的形态。与「凭据类字段名 = 引号长字面量即拦」的承诺不完全对齐，后续按实际误漏提案。
- `secretLeakReason` 的调用方（`memory-rules`、`skill-rules`、`prompt-rules`、`patrol`）零改动；`snapshot/api.json` 只收导出面，本次未改导出，无需更新。
- 新增两个测试；全量 950 测试（77 文件）通过。

## Testing

`test/memory-rules.test.ts` 新增两例：`MY_API_KEY=`、`OPENAI_API_KEY=`、`GITHUB_TOKEN=`、`DB_PASSWORD=`、`APP_SECRET=` 均命中；`MY_API_KEY="YOUR_API_KEY_HERE"`、`API_KEY_ROTATION = "0123456789abcdefghij"`、`TOKENIZER = "0123456789abcdefghij"`、`rotate the api key every 90 days` 均放行。`./node_modules/.bin/vitest run test/memory-rules.test.ts` 24/24 绿；全量套件 950/950 绿。

## Related

- [secret-leak-guard](../feature/2026-08-28-secret-leak-guard.md)：原始固定模式集与三个汇入口接线；本笔只修正该模式集的左边界。
- dsh-bounty #904（外部报告，已受理结算）：缺陷复现来源。
