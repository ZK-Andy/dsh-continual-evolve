#!/usr/bin/env python3
"""本地 governance 自检（与 CI governance.yml 同逻辑的快检）"""
import pathlib, re, sys
root = pathlib.Path(__file__).resolve().parents[1]
ok = True
# 检查 Issue 模板含 Owner/priority/class。
# 豁免：config.yml（表单配置非模板）；test_feedback.yml（30 秒轻量反馈表，
# 治理字段由分诊时补——上游 dotnet-deepseek-harness-desktop 同场景长期红着没人修）。
for p in (root / ".github/ISSUE_TEMPLATE").glob("*.yml"):
    if p.name in ("config.yml", "test_feedback.yml"):
        continue
    t = p.read_text()
    for kw in ["owner", "priority", "class"]:
        if kw not in t.lower():
            print(f"FAIL {p}: 缺 {kw}")
            ok = False
# 检查 PR 模板含 checklist
pr = root / ".github/pull_request_template.md"
if pr.exists():
    t = pr.read_text()
    if "Reviewer Checklist" not in t:
        print("FAIL PR template 缺 Reviewer Checklist")
        ok = False
    if "change-scope" not in t:
        print("FAIL PR template 缺 change-scope")
        ok = False
else:
    print("FAIL 缺 .github/pull_request_template.md")
    ok = False
print("OK" if ok else "FAIL")
sys.exit(0 if ok else 1)
