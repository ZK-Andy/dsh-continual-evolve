# Agent Note: 覆盖率第十轮（速赢三文件过分支 85）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-quickwin-round-10.md`

## Problem

第九轮后分支 85 线下 10 个文件。按用户拍板本轮先取速赢组：`autocase`（84.6，2 缺口）、`project`（81.3，1 语句+6 分支）、`promotion`（81.8，2 语句+6 分支）——缺口小、一轮可让三文件过线。

## Decision

- `autocase` +1 例（空 reasons 渲染 `(none captured)`/`(none)`，一例收 L69+L83 两臂）：语句/分支/函数三项 100。
- `project` +5 例（空白 identity 视同缺省、basename 剥空回 `project`、meta.cwd 回退、identity 选项透传、抛错 getter 进 catch）：语句 95.2→100、分支 81.3→93.9。
- `promotion` +3 例（空文本重叠计 0、多候选取最高分、默认策略与全非法模式回退）：语句 96.5→98.3、分支 81.8→97.3。
- decline（有证明）：project win32 臂（Linux CI 平台门控）、`identity.length > 0` 假臂（真值非空串恒真）、promotion 短脱敏臂（11 凭据正则最小匹配均 >10 字符，`<=10` 真臂不可达）。
- 水位线不动（分支最低线仍 memory-agent 80.69）；双语 README 测试数 986→995，徽章语句/分支/函数保持 98/90/99。

## Alternatives considered

- **先啃 memory-agent 地板**：45 缺口一轮未必收完，速赢组 14 缺口一轮三文件过线，ROI 更高。落败（排后轮）。
- **为 win32/短脱敏臂造 mock**：前者是平台门控（换平台即变），后者被调方正则最小长度已锁死——mock 测的是 mock。落败。
- **把 recall 一起收了**：15 缺口与本组无关，分轮次保持 diff 最小。落败。

## Consequences

- 收益：995 测试（+9）；85 线下 10→7 文件；三文件分支全部过 85。
- 代价：三处 decline 均为已裁定不可达项。
- 后续：第十一轮主战场 `recall`（81.01）/`skillquality`/`wrapup`/`benchmark`/`tool`/`auto` 中选 ROI 高者；`../` 前缀口径仍待产品拍板；函数 99.51 两处已裁定项不变。

## Testing

- `pnpm test` 995 全绿（54 文件）；per-file 水位线 `pnpm test:coverage` 全绿；tsc/oxlint/TS 四门禁全绿。
