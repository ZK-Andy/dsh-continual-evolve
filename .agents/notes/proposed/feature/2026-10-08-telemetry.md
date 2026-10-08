# Agent Note: 提取遥测（默认开的最小上报 + 本地聚合看板）

Status: proposed

中文单语（双语启用时补 `<同名>.zh.md` 镜像，见 notes/README.md）

## Problem

单用户视角下样本攒得慢：个案判定可以每会话人工对账，但"提取成熟度"这类统计判断（落盘率、各类 skip/failed 占比）需要行数，下一轮（技能物化→提示词补充→评审取回）迟迟凑不够开工证据。同时 npm 侧显示外部安装真实存在（近一周 2712、近一月 5643 次下载），但下载含镜像同步/CI 重装水分且延迟 1–2 天——到底多少活人在用、版本升级多快、别人的提取跑成什么样，全未知。本地账本只回答"我"，回答不了"我们"。

## Proposal

分两轨，P0 先行、P1 带前置条件：

- **P0 本地聚合看板（本机，零隐私问题）**：账本上持续计数——`applied` 数、skip 按原因桶、`failed` 按错误桶（`surface-read-failed` / `llm-failed` / `unexpected-error` 三桶，不存原文）、`token-usage` 复活后的 token/轮；卡片多一行近 7 天统计。"够不够开下一轮"变成可读的数，而不是感觉。
- **P1 最小上报（默认开，三开关可停）**：回答"多少活人、升多快、别处失败面"。字段白名单如下，之外任何字段新增必须另起 ADR：

  | 字段 | 说明 |
  |---|---|
  | `install_id` | 匿名随机 UUID，首次生成存 state 表（不用 workspace 哈希，避免跨库关联） |
  | `plugin_version` / `node_version` / `platform` | 版本分布与环境面 |
  | 窗口期计数（7 天） | runs 总数、`applied` 数、skip 按原因**桶**（仅枚举 + `model-skip` 一桶）、failed 按**错误桶**（三桶 + `sqlite-busy`/`json-parse`/`timeout` 等枚举） |
  | `ledger_migration_ok` | 库迁移类操作成功与否（布尔） |

  **永不上报**：记忆正文/标题/描述/钩子、workspace 路径原文、`session_id`、`skip_reason` 原文、error 原文、prompt 与模型回答原文（快照测试锁死）。
- **默认开的配套约束**（缺一不可）：首次注入与卡片内显眼 notice；三处 kill switch（环境变量、卡片开关、配置项），任一关闭即停；每次上报的 payload 同步在本地留一行可查（卡片显形"开/关 + 上次上报时间 + payload 明文"）；README 与 awesome 页披露遥测存在与字段。
- **数据在哪看（P1 前置条件）**：上报没有可查的去处等于黑洞，P1 落地前必须先有答案。推荐极简自建 endpoint（单函数收 JSON → 日聚合 → 静态页公开分母与版本曲线，collector 代码公开）；备选自建/云 PostHog（信任链多一节）；npm 下载统计只作交叉验证（延迟+水分，无维度）。

## Alternatives considered

- **默认关（opt-in）**：隐私最稳。落败原因：首要问题就是"多少活人"，opt-in 率趋近零则分母永远拿不到，白做；在白名单+三开关+notice+披露约束下接受默认开。
- **只做本地聚合不上报**：零隐私风险。落败原因：回答不了版本分布与外部失败面，"用户升多快"继续靠猜；且 P0 本来就要做，两者不是互斥是先后。
- **第三方分析（PostHog/Plausible）当 collector**：免运维、有现成 dashboard。落败为首选的原因：数据经第三方之手，信任链多一节，需另行披露；保留为备选（自建 PostHog 也重，与"极简"初衷相悖）。
- **用 npm 下载统计当主视图**：零成本。落败原因：1–2 天延迟、含镜像水分、无版本/失败维度；只配做交叉验证。
- **上报记忆内容或原因原文以加速"懂我"**：落败原因："懂我"是 per-user 个性化，与跨用户聚合无关；且触碰个人信息红线，绝不做。

## Acceptance criteria

- P0：卡片近 7 天统计行可读；"开下一轮"的成熟度判断有数可依，不再凭感觉。
- P1：payload 快照测试锁定白名单（字段断言 + 记忆内容/路径/`session_id`零出现）；三开关任一可停；公开 dashboard 可查分母与版本曲线；README/awesome 页披露齐全；collector 选型先于上报落地。
- 红线：任何版本上报记忆内容即算事故。

## Risks

- 默认开的信任成本：用户发现未知上报即差评/卸载——靠 notice + 披露 + 可查对冲，无法归零。
- 字段 creep：白名单外"顺手加一个字段"是最可能的腐化路径——以"新增字段另起 ADR"硬约束。
- collector 运维成本与 PIPL 下行为计数的合规：匿名聚合属低风险，但披露必须先行。
- 镜像/CI 污染分母：以 `install_id` 去重 + 版本心跳串清洗，残差接受。

---

<!-- 归档/状态迁移规则：
proposed → implemented：Status 改 implemented、移入 implemented/<class>/，## Proposal 改写为现在时的 ## Decision，Acceptance criteria/Risks 折叠进 ## Consequences（或现在时的 ## Testing/## Verification）。
proposed → rejected：Status 改为 "rejected — <一行理由>"，文件冻结。
归档：移入 archived/<class>/，Status 下插入 "Archived: YYYY-MM-DD"，之后永久冻结。 -->
