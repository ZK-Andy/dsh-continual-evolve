# FAQ

踩坑记录与解决方案。这些条目都来自真实开发过程——每一条都对应一次实际的故障与修复。

## 1. `dsh web` 启动失败：`1 entry did not activate` / `waiting for service: workflowEngine`

**症状**：插件树加载失败，报 `dsh-continual-evolve: pending (waiting for service: workflowEngine)`。

**原因**：web profile 的 host 层**故意禁用**了 `workflow-worker-thread` 和 `tool-workflow`（`dsh-web-app/cordis.patch.yml` 里 `disabled: true`）；标准预设里的那份在 `delegation` 组内且配置了 `isolate: { workflowEngine: true }`——引擎在组内隔离域，host 插件永远解析不到。把 `workflowEngine` 声明为必选 `inject` 会让整个插件卡在 pending。

**修复**：不要把 `workflowEngine` 放进 `inject`。需要时用 `ctx.get("workflowEngine")` 惰性读取，拿不到就抛明确错误。评估类工作优先用 **host 平面的 `ctx.subagents`**（任何 profile 都有）。

## 2. `unsupported JSON schema: schema.required is not supported by the value schema DSL`

**症状**：`defineTool` 抛 `JsonSchemaError: schema.required is not supported by the value schema DSL`。

**原因**：`defineTool` 对两类 schema 走不同编译路径：

| 字段 | 编译路径 | 是否支持根级 `required: [...]` |
|---|---|---|
| `parameters` | `compilePropertyMap` | 支持，但写法是**每个属性上写 `required: true`** |
| `output.schema` | `compileValueSchema`（`allowRequired: false`） | **不支持**根级 `required: [...]` |

**修复**：`output.schema` 用 DSL 写法——在属性上标 `required: true`：

```ts
// ❌ 错误
output: { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
// ✅ 正确
output: { schema: { type: "object", properties: { text: { type: "string", required: true } } } }
```

**例外（mount 裸 register 路径）**：`/evolve mount` 生成的插件用 `ctx.tools.register()` 直接注册，`parameters` 会被 dsh-llm **原样**发给 API，不再经过 `compilePropertyMap`——此时 `required` 必须写成**根级数组**（属性内 `required: true` 会让 DeepSeek API 报 `Invalid schema for function ...: true is not of type "array"`，每轮请求都失败）：

```ts
// ✅ mount 插件 parameters（原样发 API，必须是标准 JSON Schema）
parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }
```

## 3. benchmark 评估报 `unit failed: text.trim is not a function`

**症状**：评估单元全部记 0 分，cells 的 notes 是 `unit failed: text.trim is not a function`。

**原因**：`SubagentResult.output` 的类型是 **`ContentBlock[]`**（不是字符串）——对它调 `.trim()` 必然炸。而且 `SubagentRun.result` 用完后**必须 `dispose()`**，否则子代理残留。

**修复**：
- 用 `ctx.subagents.start` 的 **`outputSchema`** 参数请求结构化输出，从 `result.structured` 取 provider 已校验的值——根本不需要解析模型文本
- 回退路径：从 `output`（ContentBlock[]）拼接文本再解析
- `await result` 后记得 `runObj.dispose()`

## 4. 回滚报 `Refinement <id> not found in local history`

**症状**：`/evolve rollback <evolve_xxx>` 找不到记录。

**原因**：帮助文本里 `<id>` 是占位符语法，用户原样复制会把尖括号带进 id（`<evolve_xxx>` ≠ `evolve_xxx`）；行尾 `# 注释` 也会被当成参数。

**修复**：命令解析器内置两类容错（本项目已实现）：
- `stripAngleBrackets()`：容忍 `<id>` 与 `id` 两种写法
- 引号感知分词：`"多 词 参数"` 保持为一个 token 并剥引号，`#` 在外层开始注释

## 5. 自动 review 门禁从不触发（reviews.jsonl 只有 armed）

**症状**：`autoReview: true` 配置正确、`armed` 标记正常，但聊了很多轮 `reviews.jsonl` 里没有任何判断记录。

**原因**（两个层面）：
1. **每 6 回合一次且重启清零**——门禁的内存计数器随进程重启归零，两次重启之间没攒够 6 回合就不会触发。这是"看起来没工作"最常见的原因。
2. `agent/turn-stopping` 事件的 **payload 是否带 `agent` 在不同版本间变过**：最初类型声明写有 `agent` 但发射处（agent-loop）没带上；`agent/status` 的 `running → idle` 转换路径被 host 消费者（dsh-host-apiproxy）验证可用。**最终接线（`src/auto.ts`，2026-08-14 验证）**：计数用 `agent/turn-stopping`（带 agent，20:56 真实触发过一次 approved），`agent/status` idle 只作间隔检查触发点；`advanceGateState`（status 转换计数）保留为测试过的纯函数（`test/auto.test.ts`），未直接接线。

**修复**：见 `src/auto.ts`。每次门禁判断（approved / declined / failed）都会追加到 `<dshHome>/evolve/reviews.jsonl`，是唯一的可靠观察点；armed 标记在插件注册时写入，可区分"没触发"与"没加载"。

## 6. `/evolve benchmark add-case` 的参数被拆烂（statement 变成 `hygiene"`）

**症状**：case 的 statement/rubric 落盘后内容残缺。

**原因**：命令分词器不懂引号，`"Commit hygiene"` 被按空白拆成 `"Commit` 和 `hygiene"`。

**修复**：shell 风格引号分词（见 #4）。注意帮助文本里的 `<任务文本>` 是占位符——真实使用要写实际内容。
## 7. 门禁报 `gate error: review gate produced no text`

**症状**：`reviews.jsonl` 里出现 `failed (turn_interval, 6 turns): gate error: evolve: review gate produced no text`，但 `maxTokens` 预算充足。

**原因**：DeepSeek 推理模型把输出预算烧在**可见思考**上，最终文本块为零——门禁/规划器拿到的是空 text。prime-agent 源码有同款处理："keep the refinement request non-reasoning so the model uses its output budget for the JSON object"。

**修复**：LLM 调用传 `reasoningEffort: ReasoningEffortId("off")`（DeepSeek 适配器支持 `"off"`），并显式处理 `max-tokens` 截断：

```ts
import { BlockAssembler, createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
for await (const chunk of ctx.llm.stream({
  provider, model, system, messages,
  reasoningEffort: ReasoningEffortId("off"),   // ← 关键
  maxTokens: 8000,
})) { assembler.push(chunk); }
```

## 8. 验证 system-prompt 注入：子代理摘录 + 会话日志双法；local store 按会话 id 分目录

**症状**：改了 `src/inject.ts` 的 section 注入，不知道渲染结果对不对；或把验证条目写进了错误的会话 store。

**原因**：`request/header` 事件的 `system` 字段经常为空（该字段非必填），从会话 JSONL 拿不到渲染后的系统提示词；且 `~/.dsh/evolve/local/` 按**会话 id**（`Agent.id`）分目录，GUI 会话 id 与直觉可能不符（本会话是 `session-8ba460f0`，旧会话是 `session-a3e5e3c0`），写错目录 = 注入看不到。

**修复**（两个可靠方法）：
- **子代理逐字摘录法**（最可靠）：委派一个子代理，让它把系统提示词里 `# Continual Harness — Prompt Notes` / `# Continual Harness — Delegation Specs` 段**逐字摘录**回来——子代理 assembly 实时发生（父链继承也一起验证），摘录与 `node` 直跑 `lib/inject.js` 的 `entriesSectionText` 模拟输出逐字对比
- 会话归属确认：`zstd -dc ~/.dsh/sessions/--mnt-work-work--/<id>/session.jsonl.zstd` 看最近动作属于哪个会话；子代理会话的 header 有 `parentSession` 字段
- 重启 dsh web 用 setsid 延迟脚本（避免 kill 父进程连坐）：先 `sleep` 再 `kill` 旧 PID 再 `nohup node ~/.local/bin/dsh web`，日志 `~/.dsh/web-restart.log`

## 9. 启动日志出现 `[W] rubric encryption: ... using the development key`（dev key 是什么）

**症状**：dsh web 启动时（接了 console exporter 后可见）警告 rubric 加密在用 development key。

**原因**：rubric ACL 用 AES-256-GCM 加密评分标准，明文永不着盘。密钥解析优先级（`src/rubric.ts` `resolveRubricKey`）：① 插件配置 `rubricKey` → ② 环境变量 `DSH_EVOLVE_RUBRIC_KEY` → ③ **本地密钥文件** → ④ dev 兜底。老版本没有第 ③ 档，未配置时直接回退到代码里写死的公开 dev key——所有不配置的用户共用同一把全世界公开的钥匙，密文形同虚设（虚假安全感），而且每个新用户都会看到一条需要自己搞懂的警告（2026-08-15 真实教训：方案讨论不能只考虑本机开发者，插件是公开的，要面向所有安装者）。

**修复**（v0.1.x 起）：第 ③ 档自动生成本地密钥文件 `<baseDir>/evolve/rubric.key`（0600，每台安装实例随机独立密钥）——**零配置、无警告、无公开钥匙**；config/env 保留为高级覆盖项，dev key 仅在密钥文件读写失败（病态环境）时兜底。注意：**换密钥（删文件或配置 config/env）后旧密文 rubric 无法解密**，需重新 `/evolve benchmark add-case`。

## 10. cordis logger 不输出任何日志（`ctx.logger` 静默）

**症状**：插件里 `ctx.logger(...)` 的 info/warn/error 全都不出现，调试只能看源码猜或临时埋点。

**原因**（源码实证，`vendor/cordis/src/logger.ts`）：cordis 4.x 的 logger 是 exporter 架构，**默认只有一个内存 buffer exporter**（1000 条，无处输出）——必须有人注册 exporter 才有输出。dsh web 没有接任何 exporter（无 logLevel 配置、无日志文件、无 /api/logs、GUI 无面板）。

**修复**（两层）：
1. **插件自带文件日志（开箱即用，`src/logfile.ts`）**：插件加载时自动注册一个文件 exporter，所有 cordis 日志消息写入 `<baseDir>/evolve/plugin.log`（JSONL、0600、超 `logMaxBytes` 轮转到 `.1`）——与 `dsh web` 启动方式无关，无需安装任何额外组件。查看：`/evolve log [tail N]` 或 `tail -f ~/.dsh/evolve/plugin.log`。配置：`logToFile`（默认 true）、`logLevel`（默认 1=info；3=debug 全开）、`logMaxBytes`（默认 5MiB）。
2. **可选：官方 console exporter 实时看**——前台终端想要实时输出时，在 profile 的 `cordis.patch.yml` 加官方插件 `@deepseek-ai/cordis-plugin-logger-console`（仓库 `vendor/logger-console`，npm `1.0.1`）：
```yaml
- insert:
    - id: logger-console
      name: '@deepseek-ai/cordis-plugin-logger-console'
      config:
        colors: false
        levels:
          default: 3
```
输出到 stdout（终端或重定向文件，`tail -f`/`grep` 可查）；浏览器版 exporter 输出到 F12 devtools console。**级别语义（cordis 源码实证）：级别数字 error=0 / info=1 / warn=2 / debug=3，exporter 导出"消息级别 ≤ 配置值"的前缀集**——`default: 3` = 全开，`default: 2` = error+info+warn（只挡 debug），`default: 1` = error+info，`default: 0` = 只 error。"warn 及以上但不含 info"的中间集**无法表达**（info 卡在中间，线性前缀集）；想安静就 `default: 0`（本机 2026-08-17 已按此配置，info/warn 全进 plugin.log 不受影响）。

## 11. benchmark 候选分数大涨却被拒：`case totalDurationMs regressed`

**症状**：候选 overall 从 0 涨到 100，决策却 `REJECTED`，reasons 是 `case totalDurationMs regressed: 82854 < 85127 - 0`；且 `autoRollbackOnReject`（默认 true）把刚沉淀的知识条目**连坐回滚删除**。

**原因**：`aggregate()` 的返回值把 per-case 均值与元数据键（`overall`/`failed`/`total`/`totalDurationMs`——C3 新增）混在**同一个对象**。`decide()`/`decisionReport()` 遍历 `Object.entries(reference.aggregate)` 做按 case 回归判断时只排除了 overall/failed/total，漏了 `totalDurationMs`——耗时被当成分数参与回归比较，方向还写反了（更短 = 更差），把"这轮跑得更快"判定为"回归"。

**修复**（`00c3b37`）：两函数改为从 `reference.cells` 派生**真实 caseId 集合**再逐 case 比对，元数据键永不进入分级/展示；`87c85cc` 补上回滚 refinement 的 `rollbackOf` 审计链（此前回滚记录只有 summary 文本"Rollback refinement <id>"，字段为空）。

**教训**：任何"超类型对象 + 遍历键当 case"的逻辑都脆弱（聚合对象迟早会加新元数据键）。判定对象、报告对象都从 `entry.cells` 派生的 case 集合出发，只在明确键名上取元数据。


## 12. 门禁批量 failed：`LLM call failed: provider "opencode-go"`

**症状**：`reviews.jsonl` 里出现成串 `gate error: evolve: LLM call failed: provider "opencode-go"`（2026-08-19 前后 14 次）。

**原因**：未配置 `reviewModel` 时门禁走 agent 自身 provider；该 provider 间歇不可用，门禁每次都失败。

**修复与要点**：失败被完全遏制（记录 + 回退 lastReviewAt，不干扰 agent 循环），但会浪费一次调用并污染审计。两个选项：① 在 profile patch 里给 `continual-evolve` 配 `reviewModel: "<稳定provider>/<model>"` 把门禁路由到便宜且稳定的模型；② 接受遏制行为，用 `/evolve failures` 观察频率。判断数据源：`/evolve failures` 的按类计数。
