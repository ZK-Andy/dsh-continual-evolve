# Agent Note: skillquality 覆盖率第三轮与 guidance 物化崩溃修复

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-skillquality-round-3.md`

## Problem

第二轮（`2026-09-25-coverage-low-files-round-2.md`）后 `skillquality.ts`（语句 82.81 / 分支 ~75）是全仓最低线持有者，未覆盖集中在 YAML 子集解析器（引号 scalar、块 scalar、嵌套对象、注释）与 frontmatter 名称分支。补测过程中 guidance 形状的回归用例抓出一个真实崩溃：`renderSkillMarkdown` 对缺失 `arguments` 的条目直接 `Object.keys`，而 `validate.ts` 明确允许 guidance 条目无 reference/arguments——任何无合约 guidance 条目的物化都会抛 `TypeError`。

## Decision

- 补 22 例（`test/skillquality.test.ts` +21、`test/skill-render.test.ts` +1）：EISDIR 读失败回退、缺闭合 `---`、单/双引号 scalar（含转义与未闭合）、注释与空行、`|`/`>` 块、嵌套 metadata（含非法行）、顶层非法行、缺 name/非法 name、大小写布尔拼写、合法 whenToUse、string 起始与 `./` 前缀 prose 引用、带 title 链接、executable/guidance 双形状端到端校验。
- 修复 guidance 物化崩溃（`src/skill-render.ts`）：`arguments` 沿用 `reference` 同构守卫（`args && typeof args === "object" && Object.keys…`），缺失时省略 `## Arguments` 节而非抛错。
- 死分支合并（`src/skillquality.ts`，行为不变的简化重构，第一轮 `??` 合并先例）：`validateSkillEntryContent` 的转义判断从四判式收敛为单个 `includes("/../")`——正则已把 `match[0]` 锚定在 `references|scripts` 前缀，`../` 前缀、绝对路径、盘符三判式永假。
- 水位线棘轮上移：statements/lines 82→86（新最低线 `review-scheduler` 86.58），branches 75 与 functions 90 保持（最低线仍是 `wrapup-command` 75.6 与 `fate` 90）。
- 双语 README 测试数徽章与计数 870→894；覆盖率整数徽章不变（96/85/98）。

## Alternatives considered

- **只测 executable 形状、放过 guidance 崩溃**：崩溃在 validate-合法输入上可达（guidance 无合约是正常形状），属于生产物化路径缺陷而非测试形状问题。落败。
- **在 validate 层强制 guidance 携带 arguments**：与既有契约（guidance 无输入合约）及平台语义直接冲突。落败。
- **保留四判式转义判断**：三判式经正则锚定证明不可达，保留只压低分支水位且误导读者以为存在三种逃逸形态。落败。
- **追逐剩余 ~22 个分支到 100**：全部是 `noUncheckedIndexedAccess` 要求的 `?? ""` 回退（循环界内索引恒有定义）、非 Error throw -cause、string 解析器产出 boolean、cursor 微边——与第二轮裁定的"不可达防御"同类，凑数测试只会写出脆弱断言。落败。
- **顺手收紧前置 `../` 逃逸（`../references/x.md` 当前被接受）**：这是策略变更（validator 接受而 `skillResourceRefs` 按跨 skill 互链跳过，两者口径不一致），需产品拍板，不在本轮覆盖率范围内。落败，记为后续项。

## Consequences

- 收益：894 测试（+24）；`skillquality` 语句/行/函数 100、分支 ~82.7，不再是最低线持有者；`skill-render` 回到三项 100；全仓 96.44 / 85.76 / 98.53。
- 代价：`skillquality` 分支距 100 仍有 ~22 个已裁定不可达的防御槽位；分支水位线 75 的下一最低线是 `wrapup-command` 75.6。
- 后续：`review-scheduler`（86.58）是 statements 下一轮主战场；`../` 前缀口径不一致待产品拍板。
- 观测：v8 分支数在连续两次全量跑之间有 ±0.2 抖动（82.67/82.81），整数水位线不受影响。

## Testing

- `pnpm test` 894 全绿；per-file 水位线 `pnpm test:coverage` 全绿（含新 86 线）；tsc（含 scripts）/oxlint/TS 四门禁全绿。
- guidance 回归用例在修复前复现 `TypeError`（`Object.keys(undefined)`），修复后通过。
