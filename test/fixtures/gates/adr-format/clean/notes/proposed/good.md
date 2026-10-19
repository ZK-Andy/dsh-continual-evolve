# Agent Note: 好样本（G3 绿样本）

Status: proposed

## Problem

某个门禁没有红绿样本，假门禁永远绿。

## Alternatives considered

- 不做：保持现状，假门禁风险自担。
- 全量接入现成框架：引入第二套规则语言，成本高于自写。

## Proposal

给每条门禁配违规与干净样本，先红后绿。
