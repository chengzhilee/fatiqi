# -*- coding: utf-8 -*-
"""检查所有套卷状态"""
import json
import pathlib

base = pathlib.Path(__file__).resolve().parent.parent
for p in (base / "data" / "sets").glob("*.json"):
    s = json.loads(p.read_text(encoding="utf-8"))
    qs = s["questions"]
    imgs = sum(1 for q in qs if q.get("stemImg"))
    print("===", s["id"], "|", s["name"], "| 题数", len(qs), "| 切图", imgs, "|", s["createdAt"])
    for i, q in enumerate(qs[:5]):
        print("   ", i + 1, repr((q.get("stem") or "")[:38]))
