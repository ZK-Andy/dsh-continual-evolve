# Agent Note: 记忆检索改关键词 AND 匹配 + LIKE 兜底

Status: implemented

## Problem

v0.15.0 的 `search`（[../../../../src/store.ts](../../../../src/store.ts)）把整条查询当一个单位：`trim()` 后整串不足 3 字符才走 LIKE 子串匹配，否则整串作为**一个 FTS5 短语**交给 trigram 索引。两个口径叠加出一个洞——trigram 只索引 ≥3 字符的连续段，短语又要求各分词位置相邻，于是**整串 ≥3、却由短词或非连续词组成**的查询恒返回空：

- `中文 交接`（2+2 字符）：整串 5 ≥3 → 走短语 `"中文 交接"`，而目标记忆的正文里两个词都在、只是不相邻 → 0 命中。
- `openSUSE fedora`（两个 ≥3 字符的词、各自出现）：短语要求相邻 → 0 命中。

2026-10-06 在 dotnet-desktop 的 0.15.0 验收里实测 `memory_read` 查 `中文 交接` 返回"没有匹配"，而目标记忆正文同时含「中文」与「交接」。既有测试没拦住：`test/store.test.ts` 的检索用例只覆盖单 token（`中文标题`、`中文`、`with "quotes"`）——单 token 时"短语"与"关键词"等价，洞只在多词查询上出现。

## Decision

`search` 改为「分词 + 双路 AND」：

- **分词**（`queryTokens`）：按 ASCII 空白与全角空格切分，去空 token；为空即返回空结果。
- **全 token ≥3 字符**：FTS5 查询由短语改为 `"tok1" AND "tok2" …`（trigram 各自匹配 ≥3 字符连续段，token 之间 AND）。
- **FTS 命中为空**：回退 LIKE。
- **任一 token <3 字符**：直接走 LIKE——每个 token 在 `title`/`description`/`body` 任一列命中即为该 token 命中，token 之间 AND。
- **转义与缓存**：LIKE 模式 `%token%` 中的 `\ % _` 按 ESCAPE 转义（关键词按字面匹配）；LIKE 的动态语句按 token 数缓存在 `Map<number, Statement>`，不每次 prepare。
- **不变项**：工作区过滤、`status='active'` 过滤、`limit`（默认 20）、返回顺序（feedback > user > reference，再 `updated_at DESC`）全部保持原样。

## Alternatives considered

- **只在 FTS 返回空时用 LIKE 匹配整条查询**：最小改动。落败原因：`中文 交接` 的连续子串在正文里根本不存在，LIKE 整串同为 0 命中，实测场景修不掉。
- **全量走 LIKE、放弃 FTS**：记忆量小的时候够用，实现最简。落败原因：丢掉 trigram 索引，提取轨每轮对既有记忆做相似候选要走全表扫，且改动面比 AND 更大。
- **<3 的 token 走 LIKE、≥3 的走 FTS，两路求交集**：理论上能同时利用索引与短词。落败原因：两路结果集求交需要额外排序与截断语义，实现复杂度远超收益；实测瓶颈是多词的连接方式，不是短词本身。
- **换分词器（`unicode61`）或另建 bigram 索引**：能从根上支持 2 字词。落败原因：改 DDL + 索引重建，且 trigram 本就是为中文选定的分词方案；本次只需修查询构造。
- **对 CJK 无空格查询也自动切 bigram**：召回更宽。落败原因：会改变既有单 token 语义（`中文标题` 现在精确命中，切 bigram 后引入噪声），且用户输入习惯是空格分词。
- **多 token 时按 `bm25()` 排序相关度**：更接近"搜索"直觉。落败原因：会改既有排序契约（类型优先 + 更新时间），留作后续观察项。

## Consequences

- 多关键词查询恢复直觉语义：空格分隔的每个词都必须出现，词序与相邻性不再影响命中。
- 单 token 行为完全不变（原有 5 条检索断言原样通过），新增 2 个用例（多词 AND / LIKE 元字符字面匹配）覆盖新分支，测试 168 → 170 例。
- FTS 未命中时的 LIKE 回退是防御层：它保证 trigram 的切分边界（含标点、特殊字符的查询）不会变成静默零结果。
- **未发版**（用户拍板）：修复只进 main；dotnet-desktop 上已装的是 0.15.0 npm 实体拷贝，仍带旧的单短语检索，更新到下一版本才生效。
