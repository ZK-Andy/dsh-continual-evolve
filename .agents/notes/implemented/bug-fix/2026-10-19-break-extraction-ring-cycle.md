# Agent Note: 拆 extraction-ring 与 extraction-propose 的值导入环

Status: implemented

## Problem

G2 门禁（verify-dep-cycles.ts）落地首跑即在真实树上报红：

```
FAIL: cycle services/extraction-ring.ts -> services/extraction-propose.ts -> services/extraction-ring.ts
```

两条边都是值导入：ring 用 `proposeLink` 组装 chain，propose 用 `errorText` / `runIdOf` 记账。ESM 靠函数提升今天没炸（跨模块用的都是调用时才求值的函数），但分层方向是撒谎的——将来任何一方在模块求值期使用对方绑定就是 TDZ 崩溃。门禁断言“值导入图无环”，树本身必须先变绿，门禁才不是自欺。

## Decision

新建零值导入叶模块 `services/extraction-item.ts`，下沉三样东西：`ExtractionItem` 接口、`runIdOf`、`errorText`（及私有没有导出过的 `UNEXPECTED_ERROR_RAW_MAX`）。三处调用点改从叶模块导入：

- `extraction-ring.ts`：删定义、删不再用的三个 type 导入（ClassifyResult、SubagentLoader、LedgerEntry），留 `ERROR_REASON_MAX` / `runExtractionInner` / `errorHead` 在原处；
- `extraction-propose.ts`：导入源从 ring 换成叶模块；
- `extraction.ts`：`errorText` 改从叶模块来，`ERROR_REASON_MAX` 与 `runExtractionInner` 仍从 ring 来。

`verify-layering.ts` 的 EDGES 同步：新增叶模块条目（五个 type-only 边照 R1 登记），ring 掉 `store` 边、 gain 叶边，propose 的 ring 边换成叶边，entry gain 叶边。`snapshot/budget-baseline.json` 重定基线（含新文件）。

纯搬移，零行为变化：所有被搬符号的签名与语义逐字保留，现有 extraction 回归测试一行不改。

## Consequences

值导入图 73 模块无环（G2 绿），分层门禁绿，751 基线测试不受影响（实跑见提交）。叶模块行数约 90、出度 5（全 type-only），预算充足。以后 ring/propose 之间再出现值边，G2 直接红，不需要人肉发现。

## Alternatives considered

- **把这条已知环写进 allowlist，门禁只拦新增环**。落败：门禁断言的是“无环”，第一天就带例外等于承认断言为假；且被搬的只是三个无依赖纯函数，为这点量 permanently 背一个例外文件不值。
- **把 proposeLink 搬进 ring，反向断环**。落败：proposeLink 拖着 proposal 全套依赖（screen、prompt、retention、subagent-defs），搬进 ring 会让 292 行的 ring 直奔 400 行预算，且职责倒挂（ring 是组装者，不拥有 proposal 调用）。
