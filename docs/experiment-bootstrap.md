# Bootstrap-Update 对照实验（D2，研究项）

> 假设（prime-agent 论文方向）：**前一跑 refined 的 harness 加速下一跑**——当 harness 状态里沉淀了与 benchmark case 相关的知识（记忆/提示词）时，同一 case 的评估应该花费更少或表现更好。
> 本实验不做工程改动，只用已有 benchmark 闭环与 scoreboard（含 `durationMs`，见 C3）验证假设，为 D2 是否值得工程化提供数据。

## 实验设计

**对照结构**：固定一个 reference 基线，每轮在 harness 中沉淀一条与该 case 直接相关的知识后跑一个 candidate，对比 candidate 与 reference 的 `overall` 与总耗时（`totalDurationMs`）。

**变量控制**：
- 同一 benchmark、同一 case（statement/rubric 不变——A3 会检测材料漂移，材料变了实验直接作废）
- 记录每轮 `provider/model`（cell 已带，A3）——不同模型跑出来的对比无意义
- 每轮之间**只**改变 harness 状态（新增/修改一条该 case 相关的 memory/prompt）

**判定标准**（趋势 > 单点）：
- 连续 ≥3 轮，candidate.overall ≥ reference.overall **且** totalDurationMs 单调下降 → 支持"继承加速"（正信号，值得工程化度量）
- overall 持平但耗时显著下降 → 部分支持（成本面加速）
- 无趋势 → 假设在该 case 上不成立（记录，勿强行解读）

## 步骤（约 3 轮，每轮 1 次两段式评估）

### 第 0 轮：基线

```bash
/evolve benchmark new bootstrap
/evolve benchmark add-case bootstrap "Lint Before Code" \
  "<statement（用 examples/README.md 的 lint_convention 内容）>" \
  "<rubric（同上例子的分级 0-100 rubric）>"
/evolve benchmark run bootstrap                    # 得 reference（基线 overall + totalDurationMs）
/evolve benchmark status bootstrap                 # 记录：overall / durationMs / provider / model
```

### 第 1..N 轮：沉淀知识 → 评估候选

每轮先往 harness 写一条**针对该 case** 的知识（必须与 case 可观测相关，例如：

```
/evolve plan "记住：写代码前必须先运行适用的 lint 检查（ruff/eslint/mypy），并把这条记为跨会话行为策略"
```

或手动 `/evolve goal` + 门禁沉淀。写完后：

```bash
/evolve benchmark run bootstrap candidate <refinementId>   # 或在 /evolve plan 后查 refinement 列表取 id
/evolve benchmark status bootstrap                          # 记录 candidate overall + totalDurationMs
```

每轮结束用下方脚本导出趋势表，确认 `caseHash` 列在轮间不变（材料未漂移）。

## 数据提取（脚本）

```bash
bash scripts/benchmark-trend.sh bootstrap   # # 输出 bid/标签/overall/durationMs/failed/轮间 hash 一致性
```

脚本遍历 `~/.dsh/evolve/benchmarks/*/scoreboard.json`，输出制表符分隔行，可直接贴进 OBSERVATION 的实验记录节。

## 已知限制（记录结论时必须声明）

- `harnessOverview` 注入的是**当前 local store 快照**——沉淀必须落在评估时可见的 store（local 链或 global）
- 两段式评估的子代理数量是 ×2，每轮成本 = runs × cases × 2 子代理；建议 `runs=1` 起步
- 模型随机性 → 单轮分数差 ±10 属正常，只看 ≥3 轮趋势
- reference 在 benchmark-command 里只能跑一次（防覆盖基线）——需要重跑基线时新建 benchmark

## 结论写入

跑完后把表格 + 判定写进 `/mnt/work/work/OBSERVATION.md`（新增观察项：D2 bootstrap 实验），并对照本文件更新状态。