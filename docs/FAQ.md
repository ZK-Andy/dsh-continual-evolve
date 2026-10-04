# FAQ

踩坑记录与解决方案。这些条目都来自真实开发过程——每一条都对应一次实际的故障与修复。2026-10-04 终极收敛后仅保留宿主（DSH/cordis）侧事实；已拆除机制的历史踩坑见 git 历史与本文件旧版本。

## 1. `dsh web` 启动失败：`1 entry did not activate` / `waiting for service: workflowEngine`

**症状**：插件树加载失败，报插件 `pending (waiting for service: workflowEngine)`。

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

**例外（`ctx.tools.register` 裸注册路径）**：插件绕过 `defineTool` 直接 `ctx.tools.register()` 时，`parameters` 会被 dsh-llm **原样**发给 API，不再经过 `compilePropertyMap`——此时 `required` 必须写成**根级数组**（属性内 `required: true` 会让 DeepSeek API 报 `Invalid schema for function ...: true is not of type "array"`，每轮请求都失败）：

```ts
// ✅ 裸注册的 parameters（原样发 API，必须是标准 JSON Schema）
parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] }
```

## 3. 验证 system-prompt 注入：子代理摘录法 + 会话日志归属

**症状**：改了 system-prompt section 的渲染，不知道会话里实际注入的内容对不对。

**原因**：`request/header` 事件的 `system` 字段经常为空（该字段非必填），从会话 JSONL 拿不到渲染后的系统提示词；且会话日志按工作区与 session id 分目录，GUI 会话 id 与直觉可能不符，看错目录就会误判"注入没生效"。

**修复**（两个可靠方法）：

- **子代理逐字摘录法**（最可靠）：委派一个子代理，让它把系统提示词里的目标 section **逐字摘录**回来——子代理 assembly 实时发生（父链继承也一起验证），可与本地直跑渲染函数的模拟输出逐字对比
- 会话归属确认：`zstd -dc ~/.dsh/sessions/<工作区目录>/<id>/session.v4.jsonl.zstd` 看最近动作属于哪个会话；子代理会话的 header 有 `parentSession` 字段
- 重启 dsh web 用 setsid 延迟脚本（避免 kill 父进程连坐）：先 `sleep` 再 `kill` 旧 PID 再 `nohup node ~/.local/bin/dsh web`，日志 `~/.dsh/web-restart.log`

## 4. cordis logger 不输出任何日志（`ctx.logger` 静默）

**症状**：插件里 `ctx.logger(...)` 的 info/warn/error 全都不出现，调试只能看源码猜或临时埋点。

**原因**（源码实证，`vendor/cordis/src/logger.ts`）：cordis 4.x 的 logger 是 exporter 架构，**默认只有一个内存 buffer exporter**（1000 条，无处输出）——必须有人注册 exporter 才有输出。dsh web 没有接任何 exporter（无 logLevel 配置、无日志文件、无 /api/logs、GUI 无面板）。

**修复**：前台终端想要实时输出时，在 profile 的 `cordis.patch.yml` 加官方插件 `@deepseek-ai/cordis-plugin-logger-console`（仓库 `vendor/logger-console`，npm `1.0.1`）：

```yaml
- insert:
    - id: logger-console
      name: '@deepseek-ai/cordis-plugin-logger-console'
      config:
        colors: false
        levels:
          default: 3
```

输出到 stdout（终端或重定向文件，`tail -f`/`grep` 可查）；浏览器版 exporter 输出到 F12 devtools console。**级别语义（cordis 源码实证）：级别数字 error=0 / info=1 / warn=2 / debug=3，exporter 导出"消息级别 ≤ 配置值"的前缀集**——`default: 3` = 全开，`default: 2` = error+info+warn（只挡 debug），`default: 1` = error+info，`default: 0` = 只 error。"warn 及以上但不含 info"的中间集**无法表达**（info 卡在中间，线性前缀集）；想安静就 `default: 0`。

## 5. 加系统提示词 section 时踩到的上游事实（顺序槽位 / 重名 / 并列）

**症状**：新 section 插错位置（掉到工具指导后面），或启动直接抛 `prompt section "xxx" is already registered`。

**上游事实**（`@deepseek-ai/dsh-system-prompt`，2026-10-01 核对）：

- `SECTION_ORDERS` 的命名槽位只有 `HARNESS_IDENTITY: -1000`、`DEPLOYMENT_PERSONA_PREFIX: 0`，然后直接跳到 `PLAN_POLICY: 500` —— **1–499 是空档**。本插件的 400（记忆索引）住在里面，不会挤占上游命名槽位。
- 排序是 `a.order - b.order || compareNames(name)`：**同 order 不报错**，按名字字典序并列。
- **同名 section 直接 fail-loud 抛错**（`NamedEntries` 的报错信息形如 `prompt section "x" is already registered`），所以加新 section 前先查现有注册名（本插件现有：`evolve:memory-index`）。
- 多个 `complete: true` 的 section 也会抛错（`multiple complete prompt sections are active`）。

**要点**：想让内容排在行为策略之前（身份/记忆类信息宜早），取 0–499 内的值即可；名字带命名空间前缀避免撞车。顺序值进 schemastery 配置（如 `memoryIndex.order`），别硬编码。

## 6. DSH 文件沙箱的读写边界（读不设防、写围工作区）

**症状**：插件把 store 放在 `~/.dsh/` 下，然后假设"模型的读工具打不开沙箱外路径"——这个假设是错的（本插件 2026-10-04 复盘时实证）。

**上游事实**（`@deepseek-ai/dsh-fs-sandbox` / `dsh-tool-fs` / `dsh-sandbox`，安装包源码核对）：

- **读路径从不设防**：`SandboxedFileSystem` 明言 "Reads pass through untouched: every mode permits reading"；读目标只做 realpath，磁盘上任何绝对路径都解析，无包含检查、无点文件过滤。
- **写路径在 `workspace-write` 模式下有围栏**：可写根硬编码为 `workspaceRoot + /tmp + os.tmpdir()`（`dsh-sandbox` `writableRoots()`），**没有配置键**可以追加根；要加根必须改 `dsh-sandbox-policy` 的 Config + `writableRoots()`（代码改动）。
- 围栏生效时，写工具会带 `sandbox_permissions: danger-full-access` + 理由走内置提权确认（`ctx.approval`），批准后重跑不围栏；会话级可用 `sandbox/mode` 事件临时切 `danger-full-access`。
- **工作区内点目录读写全通**：`dsh-tool-fs` 无 ignore/hidden 过滤（连搜索都 `--no-ignore --hidden`，只排 VCS 目录）——`<workspace>/.evolve/` 这类点目录今天就能被模型原生读写。

**要点**：想让模型"直接读写文件"，把文件放进工作区即可，零配置零改动；放 home 目录则读没问题、写会逐次弹提权。
