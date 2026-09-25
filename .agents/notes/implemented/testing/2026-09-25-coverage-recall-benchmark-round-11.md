# Agent Note: 覆盖率第十一轮（recall + benchmark 双文件过分支 85）

Status: implemented

> 放置路径：`.agents/notes/implemented/testing/2026-09-25-coverage-recall-benchmark-round-11.md`

## Problem

第十轮后分支 85 线下 7 文件。按用户拍板本轮取 `recall`（81.0，6 语句+15 分支）与 `benchmark`（83.5，16 语句+13 分支）——缺口多为真机可造的防御臂。

## Decision

- `recall` +4 例（冲突印章/来源 seq/空信号三态、双内容孪生 relevance 平局走 recency、三条目无查询排序、空结果/归档/note 渲染）：语句 94.9→97.4、分支 81.0→96.8。
- `benchmark` +6 例（腐败 definition/addCase 双错/空洞与坏 rubric 的扫尾+问题+默认态迁移/scoreboard 缺失·部分·腐败三态/坏 meta/文件冒充 cases 目录）：语句 92.4→100、分支 83.5→98.8。
- decline（有证明）：recall 读 catch（`loadHarnessState` S6 永不抛契约，腐败文件实测降级为空）＋两排序比较器微臂（同毫秒平局/平局内逆序，行为由孪生/三元测试钉死）；benchmark 回滚 `String(cause)` 臂（engine.rollback 恒抛 Error，ghost/错会话已覆 Error 臂）。
- 附带发现（真 bug 行为，非本次改动）：同标题重复 create 幂等（id 哈希标题，`applied:false`）；local 域永不冲突拦截。测试已按此改写（孪生改异标题同内容）。
- 水位线不动（分支最低线仍 memory-agent 80.68）；双语 README 测试数 995→1005，徽章语句/分支/函数 98/91/99（分支首次过 91）。

## Alternatives considered

- **为读 catch / String 臂造 mock**：load 永不抛、rollback 恒抛 Error——mock 测的是 mock。落败。
- **为比较器 `: 0` 臂造同毫秒时间戳**：时序非确定，属 flaky 测试；排序行为已有孪生/三元钉死。落败。
- **把 tool 一起收了**：18 缺口与本组无关，分轮次保持 diff 最小。落败。

## Consequences

- 收益：1005 测试（+10）；85 线下 7→5 文件；分支首次过 91。
- 代价：四处 decline 均为已裁定不可达项。
- 后续：第十二轮主战场 `tool`（83.8）/`skillquality`（82.8）/`wrapup`（82.9）/`auto`（82.5）/`memory-agent`（80.68 地板）中选 ROI 高者；`../` 前缀口径仍待产品拍板；函数 99.51 两处已裁定项不变。

## Testing

- `pnpm test` 1005 全绿（54 文件）；per-file 水位线 `pnpm test:coverage` 全绿；tsc/oxlint/TS 四门禁全绿。
