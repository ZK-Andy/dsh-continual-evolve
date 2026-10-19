# R2 评审简报（code-review）

## Scope
- base: abc123  head: def456
- 需深审面：src/services/foo.ts
- 陪跑文件：无
- diff 面相邻件：无

## Directed checks
- [ ] 核对 foo 入参与返回契约，证据在 src/services/foo.ts:1

## Explicitly out of scope
- 不追 diff 面之外的调用方全图

## Report contract
- 返回 `Blocker[]/Suggestion[]`，每条 `文件:行 + 一句证据`；空即"无发现"
