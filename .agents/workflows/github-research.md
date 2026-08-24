# GitHub 调研流程（六步配方）

> 由根 AGENTS.md「GitHub 调研纪律」引用。原则：源头过滤省 token，批量并行省轮次。

## 1. 发现

```sh
gh search repos "<关键词>" --sort stars --json fullName,description,stargazersCount,pushedAt
```

找 dsh 插件子场景：关键词换 `topic:dsh-plugin`。

## 2. 验真（健康度核验）

```sh
gh api repos/<owner>/<repo>
```

核对四项：创建日期 vs 星标增速（短期暴涨需警惕刷星）、贡献者数（≥5 为健康）、fork 比（5–15%）、最近 push 日期。npm 分发的再查 npm 月下载量交叉验证真实采用。

## 3. 读内容

```sh
# README（截断防灌水）
gh api repos/<owner>/<repo>/readme --jq '.content' | base64 -d | head -c 2000

# 目录结构
gh api 'repos/<owner>/<repo>/git/trees/HEAD?recursive=1' --jq '.tree[].path'
```

## 4. 取单文件

```sh
gh api repos/<owner>/<repo>/contents/<path>
```

## 5. 克隆兜底（仅当需跨文件 grep / 运行代码）

```sh
git clone --depth 1 --filter=blob:none --sparse <url>
cd <repo> && git sparse-checkout set <目标目录>
```

## 6. 输出纪律

任何单步输出超约 50 行先 `head` 截断再进上下文；多个独立查询合并到同一次 bash 并行执行。
