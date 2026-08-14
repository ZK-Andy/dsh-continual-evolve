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

