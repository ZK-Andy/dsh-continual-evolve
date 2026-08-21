# Agent Notes 规则（ADR 系统）

本目录是项目的决策记录系统（Agent Notes / ADR）。规则如下，`scripts/verify-adr-format.py` 机器强制。

## 何时写

- **非平凡变更必须携带至少一个 Agent Note**：改行为、架构、跨文件/包契约、流程、测试策略、磁盘/wire/配置格式者皆属非平凡。纯机械、局部编辑豁免。
- 已拥有该决定的旧笔记更新即可，**禁止重复创建**；笔记要超车就写新的并交叉链接，被完全取代后保留理由可合并删除。

## 路径与状态

- 路径：`.agents/notes/<lifecycle>/<class>/yyyy-mm-dd-<topic-title>.md`
- lifecycle（状态即目录，随状态迁移）：`proposed/` → `implemented/` → `archived/`；另有 `rejected/`。
- class（封闭集合）：`feature` / `bug-fix` / `simplification` / `architecture`（交付源码）/ `process`（工具流程）/ `testing`。刻意无 `refactor`（与 `simplification` 重叠：判别词"可观察行为是否变化"）。
- 日期 = 首次提出日，迁移不改。

## 格式（模板骨架见 `templates/adr-*.md`）

- 头三行：`# Agent Note: <标题>` + `Status: <proposed|implemented|rejected — 理由>` + 空行；状态必须与所在目录一致。
- 骨架：`## Problem` → `## Decision`（implemented，现在时）/ `## Proposal`（proposed）→ **`## Alternatives considered`（强制**）→ `## Consequences`。
- implemented 笔记**禁止** `## Proposal` / `## Plan` / `## Migration plan` / `## Acceptance criteria` 等 spec 用语。

## 维护纪律

- implemented 笔记与上线现实同步：代码移动/改名/改默认值时同变更改写（只改事实，不改决定）。
- `rejected/`：仅当理由能防止重蹈覆辙才保留，否则连档删除。
- `archived/`：归档时只允许在 Status 下插一行 `Archived: YYYY-MM-DD`，之后永久冻结（禁改/禁译/禁删）。

## 门禁

```sh
python3 scripts/verify-adr-format.py   # 在仓库根运行，校验头/骨架/状态-目录一致性
```

双语暂不启用：当前正文中文单语。启用双语时恢复 `.zh.md` 镜像 + `.i18n.yaml` 配对机制（见体系方法论）。
