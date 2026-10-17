# Agent Note: governance 工作流改为脚本校验，事件负载走环境变量

Status: implemented

> 放置路径：`.agents/notes/implemented/bug-fix/2026-10-18-governance-workflow-shell-injection.md`
> 发现：2026-10-18 01:40 用户带来 issue #3（awesome 列表外联），核查其触发的工作流时发现 `governance` 唯一一次运行是红的。
> 落地：`scripts/governance-check.ts`（校验逻辑 + 单测）替换 `.github/workflows/governance.yml` 里的内联 shell；**未发版**（不影响 npm 产物，随下一次发版自然带上）。

## Problem

`governance` 工作流把事件负载直接插进 shell 源码：

```yaml
BODY="${{ github.event.issue.body }}"
```

issue 正文是不可信 markdown。issue #3 的正文里有 ```` ```markdown ```` 围栏，反引号在双引号内构成命令替换，围栏里的 markdown 链接 `](https://…)` 让 bash 在 `(` 处报语法错误：

```
governance.yml: line 19: markdown: 未找到命令
governance.yml: command substitution: line 20: 未预期的记号 "(" 附近有语法错误
Process completed with exit code 2
```

后果有三层：①这段校验对任何带代码块的 issue 都**从未执行过**——文件注释声称检查 Owner/优先级/分类，实际一行都没跑；②`set -euo pipefail` 让语法错误变成工作流失败，Actions 留红；③那次失败把默认分支当时的 HEAD（`dae56d5`）检查状态染红，`ci` 两项是绿的，看提交历史会困惑。

同时暴露两个小问题：注释宣称的 Issue 标记校验根本没实现；PR 分支的 `grep` 对含反引号的正文同样脆弱。

## Decision

校验逻辑移进 `scripts/governance-check.ts`，工作流只负责把负载送进去：

- **负载走环境变量**：`env: EVENT_NAME / EVENT_JSON: ${{ toJSON(github.event) }}`，脚本读 `process.env`。环境变量的值不参与 shell 解析，反引号、`$`、括号都只是字节。
- **恒退出 0**：缺 marker 只发 `::warning::` 注解，不阻断外部贡献者（沿用原文件「提示级」的定位，但现在是真的——原先的 `set -e` 与 `grep` 会把它变成失败）。
- **校验真的实现**：issue 检查正文是否含 `Owner` / `优先级` / `分类`，PR 检查 `Reviewer Checklist` / `change-scope`；正文为空单独报一条并短路。
- **可测**：`checkGovernance` / `parseEvent` / `renderFindings` 是纯函数，`test/governance-check.test.ts` 九例覆盖假负载、空正文、两侧模板齐全与缺失、非对象负载、`workflow_dispatch` 之类无需校验的事件。CI 侧用 `node scripts/governance-check.ts`（Node 24 默认擦除类型，零依赖、不起 pnpm）。

## Alternatives considered

- **只把 `${{ }}` 换成 env、保留内联 shell**。落败原因：修掉注入但留下「注释宣称的校验不存在」和「不可测」，下次改判据还得重蹈覆辙。
- **`${{ github.event.issue.body }}` 包进 heredoc 或 `<<'EOF'`**。落败原因：`${{ }}` 在 runner 组装脚本**之前**就完成了替换，heredoc 里的反引号依然是正文的一部分、不参与解析，但正文里若出现与分隔符同名的行仍会截断；仍是把不可信文本塞进源码，只是运气窗口变大。
- **用 `github-script` 或官方 action 读 payload**。落败原因：引入第三方 action 只为读一个 JSON；仓库已有「TS 脚本 + vitest」的成熟形状（`draft-release-notes`），照抄成本更低。
- **补 `workflow_dispatch` 便于手动复跑**。落败原因：dispatch 事件的 payload 不含 issue，跑它只能证明脚本能启动，证明不了 issue 路径；真实验证靠编辑一次 issue 触发 `edited`。

## Consequences

- 带代码块的 issue/PR 不再弄红工作流；缺失模板字段时贡献者会看到一条黄色注解而不是失败的红叉。
- 校验逻辑与文档门禁同构（TS 脚本 + vitest），以后改判据是改一个纯函数。
- 未处理：`actions/checkout@v4` 仍报 Node 20 弃用警告，`ubuntu-latest` 自 2026-10-19 起迁移到 Ubuntu 26——两者都不影响本修复，等下一次动 CI 时一并处理（`pnpm check:docs` 的门禁脚本同理）。
- 工作流失败不会再回写提交状态之外的地方；是否要把 governance 纳入「发版前必须全绿」的范围：**不纳入**——它是提示级校验，不是质量门。

## Testing

- `test/governance-check.test.ts`（9 例，vitest 全绿）。
- 本地用真实负载复跑：`EVENT_NAME=issues EVENT_JSON="$(gh issue view 3 --json …)" node scripts/governance-check.ts` → 输出 `::warning::缺少 Owner / 优先级 / 分类…`、`exit 0`；`tsx` 路径同样 `exit 0`。修复前同一份正文在本仓库的插值形态下 `exit 2`（复现脚本见 2026-10-18 会话记录）。
