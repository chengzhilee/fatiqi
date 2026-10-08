# -*- coding: utf-8 -*-
"""罚题器 API 冒烟测试：自带启动 server.py 子进程，跑完即关。"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
PORT = 8765
API = "http://127.0.0.1:%d" % PORT
os.environ["NO_BROWSER"] = "1"

FAILS = []


def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name + (" | " + str(extra) if extra and not cond else ""))
    if not cond:
        FAILS.append(name)


def req(method, path, body=None, raw=False, ctype=None):
    r = urllib.request.Request(API + path, method=method)
    data = None
    if body is not None:
        if isinstance(body, bytes):
            data = body
            if ctype:
                r.add_header("Content-Type", ctype)
        else:
            data = json.dumps(body).encode("utf-8")
            r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r, data=data, timeout=10) as resp:
            b = resp.read()
            return resp.status, dict(resp.headers), (b if raw else json.loads(b.decode("utf-8")))
    except urllib.error.HTTPError as e:
        b = e.read()
        try:
            return e.code, dict(e.headers), json.loads(b.decode("utf-8"))
        except Exception:
            return e.code, dict(e.headers), b


def multipart(fields):
    boundary = "----SmokeBoundary7f3a9"
    out = b""
    for name, (filename, payload) in fields.items():
        out += ("--%s\r\n" % boundary).encode()
        out += ('Content-Disposition: form-data; name="%s"; filename="%s"\r\n'
                % (name, filename)).encode("utf-8")
        out += b"Content-Type: application/octet-stream\r\n\r\n"
        out += payload + b"\r\n"
    out += ("--%s--\r\n" % boundary).encode()
    return out, "multipart/form-data; boundary=%s" % boundary


def main():
    proc = subprocess.Popen(
        [sys.executable, str(BASE / "server.py"), "--port", str(PORT)],
        env={**os.environ}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        # 等服务起来
        ok = False
        for _ in range(40):
            time.sleep(0.25)
            try:
                st, _, j = req("GET", "/api/ping")
                if st == 200 and j.get("app") == "罚题器":
                    ok = True
                    break
            except Exception:
                continue
        check("ping", ok)

        st, _, cats = req("GET", "/api/categories")
        check("categories 默认类别", st == 200 and any(c["name"] == "大学生数学竞赛" for c in cats), cats)
        math_cat = next(c for c in cats if c["name"] == "大学生数学竞赛")
        eng_cat = next(c for c in cats if c["name"] == "四级英语")

        # 上传 PDF
        pdf_bytes = (BASE / "test" / "第16届CMC非数学A类测试卷.pdf").read_bytes()
        body, ctype = multipart({"file": ("第16届CMC非数学A类测试卷.pdf", pdf_bytes)})
        st, _, up = req("POST", "/api/upload", body, ctype=ctype)
        check("upload pdf", st == 200 and up.get("kind") == "pdf" and up.get("size") == len(pdf_bytes), up)
        check("upload pdf 有 uploadId", bool(up.get("uploadId")))

        # 建套卷
        st, _, s = req("POST", "/api/sets", {
            "categoryId": math_cat["id"], "name": "第16届CMC非数学A类",
            "uploadId": up["uploadId"],
            "questions": [{"stem": "设函数 f(x)=x²+2x，则 f′(1)=？", "answer": "4"}]})
        check("create set", st == 200 and s.get("name") == "第16届CMC非数学A类", s)
        check("create set 带附件", s.get("attachment", {}).get("kind") == "pdf", s.get("attachment"))
        check("create set 题目", len(s.get("questions", [])) == 1)

        # 附件可访问且是 PDF 类型
        st, hd, raw = req("GET", "/files/" + s["attachment"]["stored"], raw=True)
        ct = hd.get("Content-Type", "")
        check("file serve pdf", st == 200 and "application/pdf" in ct and len(raw) == len(pdf_bytes), ct)

        # 列表
        st, _, ls = req("GET", "/api/sets?categoryId=" + math_cat["id"])
        check("list sets", st == 200 and len(ls) == 1 and ls[0]["questionCount"] == 1, ls)

        # 编辑套卷
        st, _, s2 = req("PUT", "/api/sets/" + s["id"], {
            "questions": [{"stem": "Q1", "answer": "A1"}, {"stem": "Q2", "answer": "A2"}]})
        check("update set questions", st == 200 and len(s2["questions"]) == 2)

        # docx 上传
        docx_bytes = (BASE / "test" / "四级英语模拟卷1.docx").read_bytes()
        body, ctype = multipart({"file": ("四级英语模拟卷1.docx", docx_bytes)})
        st, _, up2 = req("POST", "/api/upload", body, ctype=ctype)
        check("upload docx", st == 200 and up2.get("kind") == "docx", up2)
        st, _, s3 = req("POST", "/api/sets", {
            "categoryId": eng_cat["id"], "name": "四级英语模拟卷1",
            "uploadId": up2["uploadId"], "questions": []})
        check("create docx set", st == 200 and s3["attachment"]["kind"] == "docx")

        # 新建/删除类别
        st, _, c4 = req("POST", "/api/categories", {"name": "冒烟测试类别"})
        check("create category", st == 200 and c4.get("name") == "冒烟测试类别")
        st, _, _d = req("DELETE", "/api/categories/" + c4["id"])
        check("delete category", st == 200)

        # 校验错误分支
        st, _, e1 = req("POST", "/api/upload", b"...", )  # 非 multipart
        check("upload 非 multipart 报 400", st == 400)
        body, ctype = multipart({"file": ("a.exe", b"MZ...")})
        st, _, e2 = req("POST", "/api/upload", body, ctype=ctype)
        check("upload 非法扩展名报 400", st == 400, e2)
        st, _, e3 = req("GET", "/api/sets/deadbeefdead")
        check("set 404", st == 404)
        st, _, raw, = req("GET", "/files/../server.py", raw=True)
        check("路径穿越被拒", st in (403, 404), st)

        # 删除套卷（附件文件也应被删）
        stored_rel = s["attachment"]["stored"]
        st, _, _d = req("DELETE", "/api/sets/" + s["id"])
        check("delete set", st == 200)
        st, _, _d = req("DELETE", "/api/sets/" + s3["id"])
        check("delete docx set", st == 200)
        check("附件文件已删", not (BASE / "uploads" / stored_rel).exists())

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print("=" * 40)
    if FAILS:
        print("FAILED:", FAILS)
        sys.exit(1)
    print("ALL PASS")


if __name__ == "__main__":
    main()
