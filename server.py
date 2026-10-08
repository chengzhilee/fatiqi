# -*- coding: utf-8 -*-
"""罚题器 - 本地服务（纯 Python 标准库，零第三方依赖）

架构说明（与作业管家同思路）：
- 用户电脑安全软件会拦截浏览器打开 http://127.0.0.1 的网页，因此界面统一用
  file:// 方式打开（罚题器.html），页面内通过 fetch 访问本服务（服务端已开 CORS）。
- 数据全部存在本机：data/（题库 JSON）+ uploads/（上传的 PDF/Word 原件）。
  备份 = 复制这两个文件夹。
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote, unquote
from urllib.request import urlopen

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
SETS_DIR = DATA_DIR / "sets"
UPLOADS_DIR = BASE_DIR / "uploads"
TMP_DIR = UPLOADS_DIR / "tmp"
OCR_DIR = DATA_DIR / "ocr_tmp"
PORT_RANGE = range(8765, 8776)
APP_NAME = "罚题器"
DEFAULT_CATEGORIES = ["大学生数学竞赛", "四级英语"]

MUTEX = threading.Lock()

ACCEPT_EXT = {".pdf": "pdf", ".docx": "docx", ".doc": "doc"}
CONTENT_TYPES = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
}
# 允许直接提供的扩展名（上传仅限 ACCEPT_EXT，图片由切图功能写入）
SERVABLE_EXT = {"pdf", "docx", "doc", "png", "jpg", "jpeg"}


# ---------------------------------------------------------------- utilities

def now_str():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def new_id():
    return uuid.uuid4().hex[:12]


def safe_name(name, fallback="file"):
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", name or "").strip().strip(".")
    return name[:120] or fallback


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def write_json_atomic(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def load_categories():
    cats = read_json(DATA_DIR / "categories.json", None)
    if cats is None:
        cats = [{"id": new_id(), "name": n, "createdAt": now_str()}
                for n in DEFAULT_CATEGORIES]
        write_json_atomic(DATA_DIR / "categories.json", cats)
    return cats


def set_path(set_id):
    return SETS_DIR / (set_id + ".json")


def find_first_running_instance():
    """探测已在本机运行的罚题器服务，避免重复起多个。"""
    for port in PORT_RANGE:
        try:
            with urlopen("http://127.0.0.1:%d/api/ping" % port, timeout=0.35) as r:
                data = json.loads(r.read().decode("utf-8"))
                if data.get("app") == APP_NAME:
                    return port
        except Exception:
            continue
    return None


def pick_free_port():
    import socket
    for port in PORT_RANGE:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return None


def _save_question_images(set_id, qid, item, q):
    """题目里的 dataURL 图片（切图功能的题干/答案截图）落盘。"""
    for field, tag in (("stemImgData", "stemImg"), ("ansImgData", "ansImg")):
        data = q.get(field)
        if not data:
            continue
        m = re.match(r"^data:image/(png|jpeg);base64,(.+)$", data, re.S)
        if not m:
            continue
        ext = "png" if m.group(1) == "png" else "jpg"
        name = "q_%s_%s.%s" % (qid, "s" if tag == "stemImg" else "a", ext)
        rel = set_id + "/" + name
        try:
            p = UPLOADS_DIR / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(base64.b64decode(m.group(2)))
            item[tag] = name
        except Exception:
            pass


def _cleanup_orphan_images(set_id, questions):
    """编辑后不再被任何题目引用的切图文件删掉。"""
    d = UPLOADS_DIR / set_id
    if not d.is_dir():
        return
    used = set()
    for q in questions:
        for f in ("stemImg", "ansImg"):
            if q.get(f):
                used.add(q[f])
    for p in d.iterdir():
        if p.name.startswith("q_") and p.name not in used:
            try:
                p.unlink()
            except OSError:
                pass


def parse_multipart(body, content_type):
    """极简 multipart/form-data 解析，返回 {name: (filename, bytes)}。"""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        return {}
    boundary = ("--" + m.group(1)).encode("utf-8")
    parts = {}
    for chunk in body.split(boundary):
        if chunk in (b"", b"--", b"--\r\n"):
            continue
        if chunk.startswith(b"--"):  # 结束边界
            break
        # 每段形如 "\r\n<headers>\r\n\r\n<content>\r\n"，
        # 只剥分段的边界换行，不能动文件内容本身
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if b"\r\n\r\n" not in chunk:
            continue
        head, _, payload = chunk.partition(b"\r\n\r\n")
        head_text = head.decode("utf-8", "replace")
        name_m = re.search(r'name="([^"]*)"', head_text)
        file_m = re.search(r'filename="([^"]*)"', head_text)
        if not name_m:
            continue
        parts[name_m.group(1)] = (
            file_m.group(1) if file_m else None,
            payload,
        )
    return parts


def cleanup_tmp(older_than_hours=24):
    for d in (TMP_DIR, OCR_DIR):
        if not d.exists():
            continue
        cutoff = time.time() - older_than_hours * 3600
        for p in d.iterdir():
            try:
                if p.is_file() and p.stat().st_mtime < cutoff:
                    p.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    server_version = "FaTiQi/1.0"
    protocol_version = "HTTP/1.1"

    # ---- 基础输出 ----
    def _send(self, status, body_bytes, ctype="application/json; charset=utf-8",
              extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body_bytes)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status, obj):
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _error(self, status, msg):
        self._json(status, {"error": msg})

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 200 * 1024 * 1024:
            raise ValueError("文件太大（上限 200MB）")
        return self.rfile.read(length) if length else b""

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # 安静运行

    # ---- 路由 ----
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path == "/api/ping":
            return self._json(200, {"ok": True, "app": APP_NAME, "time": now_str()})
        if path == "/api/categories":
            return self.handle_categories_get()
        if path.startswith("/api/sets"):
            return self.handle_sets_get(url)
        if path.startswith("/files/"):
            return self.handle_file(unquote(path[len("/files/"):]))
        return self.handle_static(path)

    def do_POST(self):
        url = urlparse(self.path)
        try:
            if url.path == "/api/categories":
                return self.handle_categories_post()
            if url.path == "/api/upload":
                return self.handle_upload()
            if url.path == "/api/ocr":
                return self.handle_ocr()
            if url.path == "/api/sets":
                return self.handle_sets_post()
        except ValueError as e:
            return self._error(400, str(e))
        except Exception as e:
            return self._error(500, "服务器内部错误：%s" % e)
        return self._error(404, "未知接口")

    def do_PUT(self):
        url = urlparse(self.path)
        m = re.match(r"^/api/sets/([0-9a-f]+)$", url.path)
        if m:
            return self.handle_sets_put(m.group(1))
        return self._error(404, "未知接口")

    def do_DELETE(self):
        url = urlparse(self.path)
        m = re.match(r"^/api/categories/([0-9a-f]+)$", url.path)
        if m:
            return self.handle_category_delete(m.group(1))
        m = re.match(r"^/api/sets/([0-9a-f]+)$", url.path)
        if m:
            return self.handle_set_delete(m.group(1))
        return self._error(404, "未知接口")

    # ---- 分类 ----
    def handle_categories_get(self):
        cats = load_categories()
        sets = [read_json(set_path(p.stem), None)
                for p in SETS_DIR.glob("*.json")]
        sets = [s for s in sets if s]
        out = []
        for c in cats:
            mine = [s for s in sets if s.get("categoryId") == c["id"]]
            out.append({**c, "setCount": len(mine),
                        "questionCount": sum(len(s.get("questions", [])) for s in mine)})
        return self._json(200, out)

    def handle_categories_post(self):
        body = json.loads(self._body().decode("utf-8") or "{}")
        name = (body.get("name") or "").strip()
        if not name:
            return self._error(400, "类别名称不能为空")
        if len(name) > 30:
            return self._error(400, "类别名称太长（≤30字）")
        with MUTEX:
            cats = load_categories()
            if any(c["name"] == name for c in cats):
                return self._error(400, "已有同名类别")
            cat = {"id": new_id(), "name": name, "createdAt": now_str()}
            cats.append(cat)
            write_json_atomic(DATA_DIR / "categories.json", cats)
        return self._json(200, cat)

    def handle_category_delete(self, cat_id):
        with MUTEX:
            cats = load_categories()
            if not any(c["id"] == cat_id for c in cats):
                return self._error(404, "类别不存在")
            cats = [c for c in cats if c["id"] != cat_id]
            write_json_atomic(DATA_DIR / "categories.json", cats)
            removed_sets = []
            for p in SETS_DIR.glob("*.json"):
                s = read_json(p, None)
                if s and s.get("categoryId") == cat_id:
                    removed_sets.append(p)
            for p in removed_sets:
                s = read_json(p, {})
                att = (s.get("attachment") or {}).get("stored")
                if att:
                    try:
                        (UPLOADS_DIR / att).unlink(missing_ok=True)
                    except OSError:
                        pass
                p.unlink(missing_ok=True)
        return self._json(200, {"ok": True})

    # ---- 上传 ----
    def handle_upload(self):
        ctype = self.headers.get("Content-Type") or ""
        body = self._body()
        if "multipart/form-data" not in ctype:
            return self._error(400, "请用文件上传方式")
        parts = parse_multipart(body, ctype)
        if "file" not in parts:
            return self._error(400, "没有收到文件")
        filename, payload = parts["file"]
        filename = filename or "未命名"
        ext = Path(filename).suffix.lower()
        if ext not in ACCEPT_EXT:
            return self._error(400,
                               "暂不支持 %s 文件，请上传 PDF（.pdf）或 Word（.docx/.doc）" % (ext or "未知类型"))
        kind = ACCEPT_EXT[ext]
        upload_id = new_id()
        stored_name = upload_id + ext
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        (TMP_DIR / stored_name).write_bytes(payload)
        meta = {"uploadId": upload_id, "filename": filename, "kind": kind,
                "size": len(payload), "stored": "tmp/" + stored_name,
                "uploadedAt": now_str()}
        write_json_atomic(DATA_DIR / "uploads_tmp" / (upload_id + ".json"), meta)
        return self._json(200, meta)

    # ---- OCR（Windows 自带离线识别，用于扫描件/文字层损坏的 PDF）----
    def handle_ocr(self):
        ctype = self.headers.get("Content-Type") or ""
        body = self._body()
        if "multipart/form-data" not in ctype:
            return self._error(400, "请用文件上传方式")
        parts = parse_multipart(body, ctype)
        if "image" not in parts or not parts["image"][1]:
            return self._error(400, "没有收到图片")
        payload = parts["image"][1]
        ps = shutil.which("powershell") or shutil.which("pwsh")
        if not ps:
            return self._error(500, "系统里没有 PowerShell，无法 OCR")
        script = BASE_DIR / "ocr.ps1"
        if not script.exists():
            return self._error(500, "缺少 ocr.ps1")
        job = new_id()
        OCR_DIR.mkdir(parents=True, exist_ok=True)
        img = OCR_DIR / (job + ".png")
        out = OCR_DIR / (job + ".txt")
        img.write_bytes(payload)
        try:
            subprocess.run(
                [ps, "-NoProfile", "-ExecutionPolicy", "Bypass",
                 "-File", str(script), "-Path", str(img), "-OutFile", str(out)],
                timeout=90, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            return self._error(504, "OCR 超时，请重试")
        text = out.read_text(encoding="utf-8", errors="replace") if out.exists() else ""
        img.unlink(missing_ok=True)
        out.unlink(missing_ok=True)
        if text.startswith("__ERR__"):
            return self._error(500, "OCR 失败：" + text.strip())
        try:
            lines = json.loads(text)
        except Exception:
            lines = [{"t": l.strip()} for l in text.splitlines() if l.strip()]
        if not isinstance(lines, list):
            lines = []
        lines = [l for l in lines if isinstance(l, dict) and (l.get("t") or "").strip()]
        return self._json(200, {"lines": lines})

    # ---- 套卷 ----
    def handle_sets_get(self, url):
        qs = parse_qs(url.query or "")
        cat_id = (qs.get("categoryId") or [None])[0]
        if url.path == "/api/sets/" or (url.path == "/api/sets" and not cat_id):
            return self._error(400, "缺少 categoryId")
        if url.path.startswith("/api/sets/"):
            set_id = url.path[len("/api/sets/"):]
            s = read_json(set_path(set_id), None)
            if not s:
                return self._error(404, "套卷不存在")
            return self._json(200, s)
        sets = []
        for p in SETS_DIR.glob("*.json"):
            s = read_json(p, None)
            if s and s.get("categoryId") == cat_id:
                sets.append({"id": s["id"], "categoryId": s["categoryId"],
                             "name": s["name"], "createdAt": s.get("createdAt"),
                             "attachment": s.get("attachment"),
                             "questionCount": len(s.get("questions", []))})
        sets.sort(key=lambda x: x.get("createdAt") or "")
        return self._json(200, sets)

    def handle_sets_post(self):
        body = json.loads(self._body().decode("utf-8") or "{}")
        cat_id = body.get("categoryId")
        name = (body.get("name") or "").strip()
        questions = body.get("questions") or []
        upload_id = body.get("uploadId")
        if not cat_id or not name:
            return self._error(400, "缺少类别或套卷名称")
        if not questions and not upload_id:
            return self._error(400, "没有题目也没有附件，无法保存")
        cats = load_categories()
        if not any(c["id"] == cat_id for c in cats):
            return self._error(404, "类别不存在")
        att = None
        if upload_id:
            meta = read_json(DATA_DIR / "uploads_tmp" / (upload_id + ".json"), None)
            if not meta:
                return self._error(404, "上传记录已过期，请重新上传文件")
            att = {"filename": meta["filename"], "kind": meta["kind"],
                   "size": meta["size"]}
        set_id = new_id()
        cleaned = []
        for q in questions:
            stem = (q.get("stem") or "").strip()
            if not stem and not q.get("stemImgData"):
                continue
            qid = new_id()
            item = {"id": qid, "stem": stem,
                    "answer": (q.get("answer") or "").strip(),
                    "source": q.get("source") or "manual"}
            for key in ("stemPage", "ansPage"):
                if isinstance(q.get(key), int):
                    item[key] = q[key]
            _save_question_images(set_id, qid, item, q)
            cleaned.append(item)
        with MUTEX:
            if att:
                src = UPLOADS_DIR / meta["stored"]
                dst_name = set_id + Path(meta["filename"]).suffix.lower()
                dst_rel = set_id + "/" + dst_name  # 统一用 /，避免 URL 里出现 %5C
                dst = UPLOADS_DIR / set_id / dst_name
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
                att["stored"] = dst_rel
            s = {"id": set_id, "categoryId": cat_id, "name": name.strip()[:80],
                 "attachment": att, "questions": cleaned, "createdAt": now_str()}
            write_json_atomic(set_path(set_id), s)
            if upload_id:
                (DATA_DIR / "uploads_tmp" / (upload_id + ".json")).unlink(missing_ok=True)
        return self._json(200, s)

    def handle_sets_put(self, set_id):
        body = json.loads(self._body().decode("utf-8") or "{}")
        with MUTEX:
            s = read_json(set_path(set_id), None)
            if not s:
                return self._error(404, "套卷不存在")
            if "name" in body:
                name = (body.get("name") or "").strip()
                if not name:
                    return self._error(400, "套卷名称不能为空")
                s["name"] = name[:80]
            if "questions" in body:
                cleaned = []
                for q in body["questions"]:
                    stem = (q.get("stem") or "").strip()
                    if not stem and not q.get("stemImgData") and not q.get("stemImg"):
                        continue
                    qid = q.get("id") or new_id()
                    item = {"id": qid, "stem": stem,
                            "answer": (q.get("answer") or "").strip(),
                            "source": q.get("source") or "manual"}
                    # 保留原切图引用（没传新 dataURL 时沿用旧图）
                    if q.get("stemImg"):
                        item["stemImg"] = q["stemImg"]
                    if q.get("ansImg"):
                        item["ansImg"] = q["ansImg"]
                    for key in ("stemPage", "ansPage"):
                        if isinstance(q.get(key), int):
                            item[key] = q[key]
                    _save_question_images(set_id, qid, item, q)
                    cleaned.append(item)
                s["questions"] = cleaned
                _cleanup_orphan_images(set_id, s["questions"])
            write_json_atomic(set_path(set_id), s)
        return self._json(200, s)

    def handle_set_delete(self, set_id):
        with MUTEX:
            s = read_json(set_path(set_id), None)
            if not s:
                return self._error(404, "套卷不存在")
            shutil.rmtree(UPLOADS_DIR / set_id, ignore_errors=True)  # 切图目录
            att = (s.get("attachment") or {}).get("stored")
            if att:
                try:
                    (UPLOADS_DIR / att).unlink(missing_ok=True)
                except OSError:
                    pass
            set_path(set_id).unlink(missing_ok=True)
        return self._json(200, {"ok": True})

    # ---- 附件 ----
    def handle_file(self, rel):
        rel = rel.strip("/")
        target = (UPLOADS_DIR / rel).resolve()
        try:
            target.relative_to(UPLOADS_DIR.resolve())
        except ValueError:
            return self._error(403, "禁止访问")
        if not target.is_file():
            return self._error(404, "文件不存在")
        ext = target.suffix.lower().lstrip(".")
        kind = ext if ext in SERVABLE_EXT else None
        if not kind:
            return self._error(403, "不支持预览该类型")
        data = target.read_bytes()
        disp = "inline" if kind in ("pdf", "png", "jpg", "jpeg") else "attachment"
        fname = quote(target.name)
        return self._send(200, data, CONTENT_TYPES[kind], extra={
            "Content-Disposition": "%s; filename*=UTF-8''%s" % (disp, fname)})

    # ---- 静态资源（http 模式调试用；正式使用走 file://）----
    def handle_static(self, path):
        allow = {
            "/": "罚题器.html", "/index.html": "罚题器.html",
            "/app.js": "app.js", "/style.css": "style.css",
        }
        ctype = {"html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
                 "css": "text/css; charset=utf-8"}
        rel = allow.get(path)
        if rel:
            p = BASE_DIR / rel
            if p.is_file():
                return self._send(200, p.read_bytes(), ctype[Path(rel).suffix[1:]])
            return self._error(404, "not found")
        m = re.match(r"^/libs/([A-Za-z0-9._-]+)$", path)
        if m:
            p = BASE_DIR / "libs" / m.group(1)
            if p.is_file():
                ct = "text/javascript; charset=utf-8" if p.suffix == ".js" else "application/octet-stream"
                return self._send(200, p.read_bytes(), ct)
        m = re.match(r"^/test/(.+)$", path)
        if m and (BASE_DIR / "test").is_dir():
            p = BASE_DIR / "test" / unquote(m.group(1))
            if p.is_file():
                ct = {"pdf": "application/pdf", "docx": CONTENT_TYPES["docx"],
                      "doc": CONTENT_TYPES["doc"], "html": "text/html; charset=utf-8",
                      "py": "text/plain; charset=utf-8"}.get(p.suffix[1:], "application/octet-stream")
                return self._send(200, p.read_bytes(), ct)
        return self._error(404, "not found")


def main():
    if "--port" in sys.argv:
        port = int(sys.argv[sys.argv.index("--port") + 1])
    else:
        existing = find_first_running_instance()
        if existing:
            print("罚题器已在运行（端口 %d），直接打开页面。" % existing)
            open_page(existing)
            return
        port = pick_free_port()
        if port is None:
            print("错误：端口 8765-8775 都被占用了，无法启动。")
            input("按回车键退出...")
            return
    for d in (DATA_DIR, SETS_DIR, UPLOADS_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)
    cleanup_tmp()
    load_categories()

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("%s 服务已启动: http://127.0.0.1:%d  （数据在 data/ 和 uploads/）" % (APP_NAME, port))
    if os.environ.get("NO_BROWSER") != "1" and "--no-browser" not in sys.argv:
        open_page(port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出。")


def open_page(port):
    page = BASE_DIR / "罚题器.html"
    try:
        webbrowser.open(page.as_uri())
    except Exception:
        try:
            webbrowser.open("http://127.0.0.1:%d/" % port)
        except Exception:
            pass


if __name__ == "__main__":
    main()
