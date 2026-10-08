# -*- coding: utf-8 -*-
"""生成 启动罚题器.bat —— 必须用 GBK + CRLF，避免 cmd 解析出错（作业管家的教训）。"""
from pathlib import Path

BAT = Path(__file__).resolve().parent.parent / "启动罚题器.bat"

content = "\r\n".join([
    '@echo off',
    'cd /d "%~dp0"',
    'if not exist "runtime\\python.exe" (',
    '  echo [ERROR] runtime\python.exe not found. Please keep the runtime folder.',
    '  pause',
    '  exit /b 1',
    ')',
    '"runtime\\python.exe" server.py',
    'if errorlevel 1 pause',
    '',
])
BAT.write_bytes(content.encode("gbk"))
print("OK", BAT, BAT.stat().st_size, "bytes")
