# -*- coding: utf-8 -*-
"""在 app.js 里定位某个函数，打印上下文（调试用）"""
import sys
import pathlib

needle = sys.argv[1] if len(sys.argv) > 1 else "gapRun"
before = int(sys.argv[2]) if len(sys.argv) > 2 else 200
after = int(sys.argv[3]) if len(sys.argv) > 3 else 400

t = pathlib.Path(__file__).resolve().parent.parent.joinpath("app.js").read_text(encoding="utf-8")
i = t.find(needle)
if i < 0:
    print("NOT FOUND:", needle)
else:
    print(t[max(0, i - before):i + after])
