# dsh-continual-evolve 差距分析：对照 prime-agent /refine 与 penguin-harness

> （2026-08-17 作为本项目交接文档采纳；配套源码级报告在工作区 `research/prime-agent/REPORT.md` 与 `research/penguin-harness-capability-report.md`）
>
> 综合 2026-08-17 两份源码级报告：
> - `research/prime-agent/REPORT.md`（/refine 9 类 33 项能力 + 17 项借鉴候选 + 11 项缺失）
> - `research/penguin-harness-capability-report.md`（4 大自进化 Skill 全解 + 10 项候选）
> 对照基准：dsh-continual-evolve 已实现能力（design.md 全勾选 + 维护期增强：rubric ACL / 技能热挂载 / goal 轮次 / 轨迹接地 / 归档 / 日志）与实测源码（`evaluate.ts` / `score.ts` / `benchmark.ts` / `inject.ts`）。
> 结论先行：**治理层（版本/回滚/门禁/审计/benchmark 闭环）已全面领先两个参照物**（prime-agent 无审批/无 benchmark/无遗忘；penguin 纯软契约零硬校验）。真正欠缺集中在**验证闭环的评分者分离、记忆生命周期、评估证据链**三类，共 16 项，按价值排序如下。

---

## A. 验证闭环的实质缺口（penguin 方向，价值最高）

### A1 【强烈】评估执行者/评分者分离 —— 修复"自产自审"
- **现状（已实测确认）**：`src/evaluate.ts` L133 把 rubric **明文**注入"执行任务的同一子代理"提示词，指示 "Score your own execution strictly against the rubric"——即"跑任务 + 自评"同一模型，rubric 对被测者可见。这正是 dsh 自己研究报告中批判 penguin 的"自产自审"结构，我们原样继承了。
- **penguin 解法**：Evaluator 用 CLI 启动被测者（**只见 statement**，看不到 rubric），再用私有 rubric 私下评分；workspace 隔离 + 四元组绑定根 Trace 实证。
- **改法建议**：`evaluate.ts` 拆两段——① 被测子代理只收 statement、产出产物与原始证据（无 rubric）；② 评分由**独立 reviewer 子代理**（注入解密 rubric，不见完成过程，只看产物+证据）或**宿主确定性判定**（机械项）执行。rubric 解密点移到 reviewer 分支，被测分支永不接触 rubric。
- **收益**：消除分数虚高与"模型自评不可信"（penguin 研究报告核心教训 + design.md §8 风险表中自己承认的风险）。

### A2 失败格协议：失败≠零分 / 缺数据不作废 / 不因低分重跑
- **现状（实测）**：`evaluate.ts` catch 路径返回 `score: 0, passed: false`；`score.ts` aggregate 用 `mean(all)` 全量平均——**失败格当 0 分拖低均值**，一次子代理启动失败可能翻转 ACCEPT/REJECT。
- **penguin 协议**：4 稳定失败码（invalid_request/benchmark_invalid/version_changed/evaluation_failed）；错误/缺产物照常评分；`cost` 缺失不作废；聚合前显式排除失败格并计数。
- **改法**：CellScore 增加 `status: "ok"|"failed"`；聚合排除 failed 格、report 显式列出失败格数与原因；决策规则 = "失败格 > 阈值即拒绝该轮"（而非当零分）。

### A3 评估运行时实证校验（防版本/材料漂移）
- **现状**：评估运行时（provider/model）是**配置层冻结**，但单元格无实际运行时的实证回写；候选被改动/材料被改动无法检出。
- **penguin**：evaluator 从根 Trace session_meta 读**实际** provider/model 与请求比对；statement/rubric 启动前后快照对比检漂移；`version_changed` 失败码。
- **改法**：单元格 schema 增加 `provider/model/thinkingLevel`（宿主从子代理会话元数据实证写入）+ 候选/材料 hash；不匹配该格判 failed（带原因），对应 penguin 的 version_changed 语义。

### A4 每单元格强制 Trace 证据指针（分数→轨迹可回放）
- **现状（实测）**：CellScore 无 session 引用——分数无法下钻回放"这 90 分是哪次会话哪几步跑出来的"。
- **penguin**：scoreboard 每 Run 带 `session_id`，评估中心可下钻 Trace。
- **改法**：单元格记录子代理会话 id（`sessionId`），`/evolve benchmark` 报告与 scoreboard 存盘带该字段；审计时按 id 回放事件（DSH 事件溯源天然支持）。

### A5 校准 Pilot + Formal Baseline 生命周期 + Case 质量门禁
- **现状**：benchmark 有 case/rubric/run 结构，但**无"设计→Pilot 单 Run 校准→冻结 Formal Baseline"流程**，也无 case 质量检查（Capability Contract、捷径区分声明、leak check）。
- **penguin benchmark-design (v7)**：Capability Contract 先行 → 逐 Case 私下记录"预期行为/捷径/区分点" → Pilot 每 Case 单 Run 迭代校准（修复不耗预算）→ 冻结首个达标/最低分有效修订 → Formal Baseline 原样记录不回填；`calibration_failed` 仅当产不出有效修订；全公开文件 leak check。
- **改法**：`/evolve benchmark` 增加 case 状态机（draft→calibrating→frozen）与 `casecheck` 子命令（对照 skillquality.ts 模式做 benchmark case 质检）；doc 沉淀校准语义（分低≠基准坏）。

---

## B. 记忆生命周期的缺失（prime-agent 论文方向，第二价值）

### B1 条目使用率/引用统计（pull-rate 驱动清理）
- **现状**：注入有排序/新鲜度（rankEntries），但**无每条目被注入/引用/使用次数记录**。
- **prime 论文**：LONG-TERM MEMORY OVERVIEW + 实测 pull rate——"多数已写 memory 条目从未被引用"；用使用统计驱动清理。
- **改法**：inject 渲染时对命中条目计数（落盘到 store 或独立 usage.jsonl）；`evolve_list` 展示使用数；门禁/报告中暴露"零使用条目"建议归档。

### B2 自动降权/遗忘/冲突消解
- **现状**：只有**人工** archive/unarchive；无自动衰减（旧条目随版本/时间降权）、无"同名/同主题冲突消解"、无"过期提示"。
- **prime 论文**：Refiner memory pass 显式 demote（"areas the agent has moved past"）；refinement 单调累积是已知问题。
- **改法**：rankEntries 的 recencyScore 已有 30 天半衰期雏形——补"引用计数衰减 + 过期标记"；门禁把"低用旧条目"列为归档候选（复用现有 archive 通道，见待办 #11 候选 c）。

### B3 记忆目录分层：全量目录 + 按需取全文
- **现状**：注入 6 条/类封顶 + 排序——是"精选注入"，无"免费目录（id+title 全量）+ 按需读全文"的分层检索面。
- **prime 论文**：orchestrator 提示词列出全部 memory 的 id+title（目录零成本），模型按需取全文。
- **改法**：`evolve_list`/注入侧加"目录视图"（全量 id+title 一行式，极低 token），与精选 6 条注入并存；模型可按 id 取全文（已有 evole_get/read 语义）。

---

## C. 治理/成本/工程细节（prime-agent 方向，低成本可补）

### C1 reviewer/refiner 模型分离
- **现状**：review 门禁与规划共用会话主模型（ctx.llm）。
- **prime**：无分离（3.8 记为缺失）；但"便宜模型把关、昂贵模型提案"是明确改进方向。
- **改法**：配置 `reviewModel`（可选），review 门禁走独立模型/预算档位。

### C2 编辑影响范围（blast-radius）审计
- **现状**：无。
- **prime**：触发/evidence/outcome 均无 scope 标注校验，"这条规则影响多广"无从推导（第三方点名批评）。
- **改法**：规划提示词强制每条 edit 声明"影响范围（通用战术/单项目/单会话）"；review 校验声明合理性；audit 记录。**我们已领先的天然优势**：local/global scope + sourceSession/sourceSeqs 证据链，补一层"通用化 vs 个案"标注即可。

### C3 cost/duration 进评估矩阵（ROI 护栏）
- **现状（实测）**：CellScore 无 cost/duration；scoreboard 无预算信息。
- **penguin**：scoreboard 每条 Evaluation 带 cost/duration_ms（缺数据不作废）。
- **改法**：宿主从子代理 usage 事件聚合 cost/duration 写入单元格；报告展示"提升 X 分花 Y token"。

### C4 扩展事件面（refine_complete 语义）
- **现状**：dsh 插件无"进化完成"的对外事件。
- **prime**：`refine_complete{id,summary,appliedEdits,scope}` extension 事件，第三方可观察/拦截。
- **改法**：插件在对 DSH 可见的地方（日志/审计/notify）增加结构化"进化完成"记录（已有 notify.ts 雏形），供外部消费。

### C5 种子演示 benchmark
- **现状**：无开箱 benchmark。
- **改法**：`examples/benchmark` 带 1 个真实 case + 数据文件，README 直达（降低上手成本，非核心）。

### C6 跨进程 mtime / 分支失效（按需评估）
- **现状**：乐观并发（baseline 比对）已覆盖多写者；DSH 单进程模型下"跨进程 mtime 同步"必要性低。
- **改法**：暂不实现，记入 FAQ 权衡；若多进程场景出现（多个 dsh web 实例同 baseDir）再做。

---

## D. 论文级/远期（prime 论文方向）

### D1 failure-signature 四遍式 Refiner
- 按失败签名（导航循环/工具失败/目标停滞/漏探）分类驱动 prompt 重写 / subagent CRUD / 技能修复 / 记忆降权——当前我们的门禁是"单回合判定该不该沉淀"，无"按失败类型路由处理策略"。

### D2 bootstrap-updating 变体（harness 继承加速）
- 实证"前一跑 refined harness 加速下一跑"——我们的 parentSession 链继承 + global 注入已有雏形（D 级研究项：把"继承效果"做成可度量 benchmark 指标）。

### D3 goal 轮次与进化耦合（反向）
- 我们已实现 goal 轮次驱动（prime 无对应物），保持领先；D 级研究：goal blocked 连续 N 轮 → 自动触发 wrapup 评估（衔接待办 #11）。

---

## 汇总表

| 优先级 | 项 | 参照物 | 现状 | 建议动作 |
|---|---|---|---|---|
| P0 | A1 评分者分离 | penguin #1 | 自产自审（实测） | 拆被测/评分两段，rubric 只进 reviewer |
| P0 | A2 失败格协议 | penguin #4 | 失败格当 0 分（实测） | status 字段 + 聚合排除 + 失败计数拒绝 |
| P1 | A3 运行时实证校验 | penguin #5 | 仅配置冻结 | 单元格回写实际 provider/hash，不匹配判 failed |
| P1 | A4 Trace 证据指针 | penguin #6 | 无 session 引用 | 单元格带 sessionId + 报告可回放 |
| P1 | B1 使用率统计 | prime #4.17 | 无 | 注入计数落盘 + 展示 |
| P1 | B2 自动降权/过期 | prime #3.4/3.6 | 仅人工 archive | recency+引用衰减，门禁提议归档（衔接 #11） |
| P2 | A5 校准 Pipeline + case 质检 | penguin #2/#3 | 无状态机 | case 状态机 + casecheck 子命令 |
| P2 | B3 记忆目录分层 | prime #4.17 | 精选 6 条注入 | 全量 id+title 目录视图 |
| P2 | C1 review 模型分离 | prime #3.8 | 同模型 | reviewModel 配置 |
| P2 | C2 blast-radius 声明 | prime #3.2 | 无 | edit 强制影响范围声明 + review 校验 |
| P2 | C3 cost/duration 入矩阵 | penguin #8 | 无 | usage 事件聚合 |
| P3 | C4 扩展事件面 | prime #4.13 | 无 | notify 结构化进化完成记录 |
| P3 | C5 种子 benchmark | penguin | 无 | examples 真实 case |
| P3 | C6 跨进程同步 | prime #4.10 | 乐观并发已覆盖 | 暂不实现，记 FAQ |
| R | D1 failure-signature Refiner | prime #4.16 | 无 | 研究项 |
| R | D2/D3 继承度量 / goal-wrapup | prime 论文 | 雏形 | 研究项 |

> P0=强烈建议立即可做（修复结构弱点）；P1=记忆层与证据链关键；P2=低成本治理增强；P3=锦上添花；R=远期研究。