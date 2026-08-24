# Agent Note: cjk-bigram-bm25-retrieval

Status: implemented

## Problem

注入排序的检索层有两类实测缺陷：①`tokenize` 把连续中文串当**单个** token 做全等比较——条目「用户偏好深色主题」对查询「深色主题偏好」命中数为 0，中文场景措辞稍有不同即完全漏召回；②打分为原始命中计数（无 IDF、无长度归一），常见词与专名同权，排序区分度差。2026-08-24 同类项目调研（openclaw 混合检索 / mem0 写入消解 / graphiti 时序图）确认「关键词精确匹配」已是落后一个世代的检索形态。

## Decision

新建 `src/search.ts`，零新依赖：

1. **tokenize 升级 CJK bigram**：ASCII 词元照旧；CJK 连续段切重叠字符 bigram（单字段落为 unigram）——Elasticsearch/OpenSearch `cjk_bigram` analyzer 同款标准。混合文串由正则交替按脚本边界拆分。
2. **打分升级字段加权 BM25**：title ×2 / body ×1 权重语义沿用旧实现；IDF 用 Lucene 非负变体 `ln(1 + (N - df + 0.5)/(df + 0.5))`——任何命中 token 得分严格 > 0、不命中恰为 0，保住 `rankEntries`「相关条目压过更新但无关条目」的排序不变式。k1=1.5、b=0.75 为模块常量。
3. **rankEntries 预计算**：每次调用构建一次 `RelevanceIndex`（逐字段 tf/df/平均长度），比较器只查表——顺带消除旧实现排序比较器内 O(n log n) 次重复分词。

索引生命周期 = 单次排序调用，**不落盘**：JSON 状态文件是唯一真相源，落盘索引即第二真相源（需自行失效、与原子写和快照对账）；实测几百条量级全量重建+打分为个位数毫秒。

## Alternatives considered

- **better-sqlite3 FTS5**：~27MB unpacked、native build/prebuilt 平台负担（Alpine/Electron 易翻车），违反本仓发布约束，出局。
- **sql.js（WASM）**：官方构建不含 FTS5，无 FTS5 的 wasm 比纯 JS 还重，出局。
- **MiniSearch**（0.8MB 零依赖内置 BM25）：唯一站得住的库选项；但默认分词同样切不开中文仍需自定义 tokenizer，且本仓条目量级下手写 BM25 仅约 40 行，引库收益为负。留作未来需要 fuzzy/组合查询时再评估。
- **FlexSearch**：非标准相关性模型 + 过重抽象，出局。
- **node:sqlite 内置 FTS5**：零安装体积但 v22.x 需 `--experimental-sqlite` flag（当前 engines 下不可用），留作观察项。
- **Intl.Segmenter("zh") 分词**：跨 ICU 结果不定、领域词切分不稳；bigram 确定性更强，符合可预期文化。
- **维持现状**：中文漏召回是分词语义问题而非扫描架构问题，不可接受。

## Consequences

- 中文子串查询从必然漏召回变为稳定命中（回归测试钉死）；英文行为不变（词元精确匹配）。
- 排序分数由整数变浮点，但对外只暴露顺序——`rankEntries` 签名不变；`relevanceHits` 导出移除（仅测试引用过）；`recencyScore` 不动（wrapup staleness 依赖）。
- 未来条目上万或需要 fuzzy 匹配时再评估 MiniSearch/持久化索引。

## Related

- [gap-analysis](../../../../docs/gap-analysis.md)：B3 检索分层与本决策同域；2026-08-24 同类对照报告为调研输入。
