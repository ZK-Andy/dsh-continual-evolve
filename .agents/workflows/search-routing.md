# 检索通道路由表

> 由根 AGENTS.md「检索通道路由」引用。本环境双通道并存：内置 `web_search` 走 Exa provider（web profile patch，2026-08-16 切换）；anysearch 工具面独立提供纵向与富参数检索。本表只区分工具面，按意图选通道。

## 路由规则

| 意图 | 通道 | 要点 |
|---|---|---|
| GitHub 项目/仓库/代码 | gh CLI | 见 [github-research.md](github-research.md)，不再重复搜索 |
| 库/框架官方文档与用法 | anysearch `code.doc` | params.library 必填；npm/PyPI/Cargo 文档定点摘要 |
| 真实代码实现示例 | anysearch `code.snippet` 或 `gh search code` | params.repo/lang/path 过滤 |
| 一般 web 检索（中文） | anysearch `general.general`，zone `"cn"` | 资讯、社区讨论、实测文 |
| 一般 web 检索（英文） | anysearch `general.general`，zone `"intl"` | 新闻、官方博客、发布说明 |
| 无区域/纵向诉求的快查 | 内置 `web_search`（Exa 后端） | 仅 query 数组，字段最简 |

## 输出纪律

- 先 `anysearch_capabilities` 发现纵向标签与参数，再按确切 tag 调用
- 多个独立查询合并单次 batch 调用（anysearch 最多五路并发）
- 单步输出超约 50 行先截断再进上下文
