# 四臂对照 eval-2026-10-19

- date: 2026-10-19
- commit: 88c346f9d4a9765ea90ebcace488323d5df047ad
- tasks: 22
- arms: base/current/candidate/reflect
- 说明: candidate/reflect 尚无候选机制，恒等于 current（如实记录、不伪造对照差），只解读 base vs current 的 lift
- 结论: base 27.3% / current 50.0%（lift +22.7pp）/ candidate 54.5%（lift +27.3pp）/ reflect 54.5%（lift +27.3pp）

| arm | acc | rounds | tool_calls | cost | recall_hit |
|---|---|---|---|---|---|
| base | 27.3% | 1.00 | 0.00 | 22743 | 6/18 |
| current | 50.0% | 1.00 | 0.00 | 64193 | 6/18 |
| candidate | 54.5% | 1.00 | 0.00 | 64726 | 6/18 |
| reflect | 54.5% | 1.00 | 0.00 | 65102 | 6/18 |

flaky: base/task-003, base/task-016, base/task-019, current/task-002, current/task-010, current/task-019, candidate/task-005, candidate/task-010, candidate/task-017, reflect/task-007, reflect/task-015

预算: 实测 216764 tokens（已记为下次基线）

caseRows: 176
