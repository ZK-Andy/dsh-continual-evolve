# Agent Note: 撞 id 创建走版本行，软门不再前置丢弃

Status: implemented

Review: FULL/2026-10-20/R1=ok R2=ok R3=ok

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

2026-10-20 未发版功能盘查（P4-b vs P2 软门）时，新增的软硬门 parity 测试抓到真分叉：同一个撞 id 的实质变化 create，软门（`identityRejectReason` → `id-collision` 丢弃）与硬门（`applyOne` → `planMerge` M1 版本行落盘）给出相反决定。P2 落 `id-collision` 时硬门还是"已存在即失败"，P4-b M1 把硬门改成"同 id 实质变化一律版本行、不分动词"，软门没跟上。后果：提取轨撞 id 的 create 在 screen 就被丢弃，M1-create 分支在提取入口恒不可达——入口相关的双语义，正是 D9 宣称关掉的东西。

## Decision

`identityRejectReason` 的 create 分支不再查允许集，直接放行。撞 id 的去向收敛到下游既有两条路：内容门 body 完全重复判 `duplicate` 丢弃；实质变化进 `applyOne`，M1 版本行落盘，非实质变化 `createMemory` "already exists" 闭环失败。`IdentityRejectReason` 与 `ScreenReason` 同步删 `id-collision` 枚举值（G5 快照同变更重定）。静默重复不可能发生：三条路都不产生"同 id 同内容双 active 行"。

## Alternatives considered

- **软门保留丢弃、M1 收窄到 update**：改动面同样大，且 M1"不分动词"是 P4-b ADR 已拍板语义，回退等于推翻已发决定。落败。
- **硬门复用 `identityRejectReason` 判词（全文案统一）**：判词是账本可读性的一部分，"already exists — update it instead" 比 `id-collision` 对查账人更友好；且版本分支本来就没有判词（成功落盘）。保持"定义同家、判词各表"，parity 测试钉死决定一致即可。落败（暂不做全字面统一）。
- **screen 层自己调 `planMerge`**：screen 是纯函数、无 store 访问，调版本判定要破纯性。落败。

## Consequences

提取轨撞 id 的实质 create 从"记 `droppedWarnings: id-collision`"变成版本行落盘加账本对——`droppedWarnings` 里该原因消失是预期内的分布变化。显式写入入口（无 screen）行为不变，它本来就走 M1。代价：P2 ADR（`2026-10-19-p2-extraction-track.md:44/51`）对应两行已过时，以本 note 为准。

## Testing

`test/memory-rules.test.ts` 新增 "hard-gate parity" 节：软硬门决定一致（伪造 update 双双拒绝），撞 id create 双双放行走 M1 版本行（断言版本行 id 与旧行归档），exact-duplicate 撞 id 钉住有意分叉（软放行、硬 fail-closed，提取轨由 duplicate 门先行）；P2 旧断言改为放行语义；`test/pre-screen.test.ts` 撞 id 改为 kept。G5 导出快照同变更 `--update`。
