#!/usr/bin/env python3
#
#   TCTE Countdown  Copyright (C) 2025  mykevinjjw
#
#   This program is free software: you can redistribute it and/or modify
#   it under the terms of the GNU General Public License as published by
#   the Free Software Foundation, either version 3 of the License, or
#   (at your option) any later version.
#
#   This program is distributed in the hope that it will be useful,
#   but WITHOUT ANY WARRANTY; without even the implied warranty of
#   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#   GNU General Public License for more details.
#
#   You should have received a copy of the GNU General Public License
#   along with this program.  If not, see <https://www.gnu.org/licenses/>.
#
"""生日小遊戲排行榜 API：只用 Python 標準庫 + SQLite，可直接跑在 OCI A1。

GET  /scores?limit=10        -> [{"name": "...", "score": 123}, ...]
POST /scores {name, score}   -> {"rank": 3}
GET  /health                 -> {"ok": true}
"""
import json
import os
import sqlite3
import threading
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# --- 設定 (都可以用環境變數覆蓋) ---
HOST = os.environ.get('LB_HOST', '127.0.0.1')  # 只聽本機，由 Caddy 反向代理並提供 HTTPS
PORT = int(os.environ.get('LB_PORT', '8787'))
DB_PATH = os.environ.get('LB_DB', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'scores.db'))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get('LB_ALLOWED_ORIGINS', 'https://mykevinjjw.github.io').split(',') if o.strip()]
BIRTHDAY_ONLY = os.environ.get('LB_BIRTHDAY_ONLY', '1') == '1'  # 1：只有 11/4 (台灣時間) 能上傳分數

BIRTHDAY = (11, 4)
TAIPEI = timezone(timedelta(hours=8))
MAX_NAME_LENGTH = 12
MAX_SCORE = 1500  # 60 秒內正常玩不可能超過的分數
MAX_LIMIT = 50
MAX_BODY_BYTES = 1024
RATE_LIMIT_COUNT = 5  # 每個 IP 每分鐘最多上傳次數
RATE_LIMIT_WINDOW = 60

db_lock = threading.Lock()
rate_lock = threading.Lock()
recent_posts = {}


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute(
            'CREATE TABLE IF NOT EXISTS scores ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' name TEXT NOT NULL,'
            ' score INTEGER NOT NULL,'
            ' created_at TEXT NOT NULL)'
        )
        conn.execute('CREATE INDEX IF NOT EXISTS idx_scores_rank ON scores (score DESC, id)')


def is_birthday():
    now = datetime.now(TAIPEI)
    return (now.month, now.day) == BIRTHDAY


def clean_name(value):
    if not isinstance(value, str):
        return None
    # 去掉換行等控制字元，避免奇怪的名字
    name = ''.join(ch for ch in value if not unicodedata.category(ch).startswith('C')).strip()
    if not 1 <= len(name) <= MAX_NAME_LENGTH:
        return None
    return name


def allow_post(ip):
    now = time.time()
    with rate_lock:
        stamps = [t for t in recent_posts.get(ip, []) if now - t < RATE_LIMIT_WINDOW]
        if len(stamps) >= RATE_LIMIT_COUNT:
            recent_posts[ip] = stamps
            return False
        stamps.append(now)
        recent_posts[ip] = stamps
        # 順便清掉很久沒出現的 IP
        if len(recent_posts) > 10000:
            for key in [k for k, v in recent_posts.items() if not v or now - v[-1] >= RATE_LIMIT_WINDOW]:
                del recent_posts[key]
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = 'TcteLeaderboard/1.0'

    def client_ip(self):
        # 經過本機的 Caddy 時，真正的來源 IP 在 X-Forwarded-For 最後一個
        forwarded = self.headers.get('X-Forwarded-For')
        if forwarded and self.client_address[0] in ('127.0.0.1', '::1'):
            return forwarded.split(',')[-1].strip()
        return self.client_address[0]

    def send_cors_headers(self):
        origin = self.headers.get('Origin')
        if origin and ('*' in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_cors_headers()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors_headers()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/health':
            self.send_json(200, {'ok': True})
            return
        if url.path != '/scores':
            self.send_json(404, {'error': '找不到這個網址'})
            return

        try:
            limit = int(parse_qs(url.query).get('limit', ['10'])[0])
        except ValueError:
            limit = 10
        limit = max(1, min(limit, MAX_LIMIT))

        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                'SELECT name, score FROM scores ORDER BY score DESC, id ASC LIMIT ?', (limit,)
            ).fetchall()
        self.send_json(200, [{'name': name, 'score': score} for name, score in rows])

    def do_POST(self):
        if urlparse(self.path).path != '/scores':
            self.send_json(404, {'error': '找不到這個網址'})
            return
        if BIRTHDAY_ONLY and not is_birthday():
            self.send_json(403, {'error': '只有 11/4 生日當天才能上傳分數喔'})
            return

        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BODY_BYTES:
            self.send_json(400, {'error': '資料格式不正確'})
            return
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {'error': '資料格式不正確'})
            return
        if not isinstance(data, dict):
            self.send_json(400, {'error': '資料格式不正確'})
            return

        name = clean_name(data.get('name'))
        score = data.get('score')
        if name is None:
            self.send_json(400, {'error': '名字要 1~%d 個字' % MAX_NAME_LENGTH})
            return
        if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= MAX_SCORE:
            self.send_json(400, {'error': '分數不正確'})
            return
        if not allow_post(self.client_ip()):
            self.send_json(429, {'error': '上傳太頻繁了，休息一下再試'})
            return

        with db_lock, sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                'INSERT INTO scores (name, score, created_at) VALUES (?, ?, ?)',
                (name, score, datetime.now(TAIPEI).isoformat(timespec='seconds'))
            )
            higher = conn.execute('SELECT COUNT(*) FROM scores WHERE score > ?', (score,)).fetchone()[0]
        self.send_json(201, {'rank': higher + 1})

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.client_ip(), fmt % args), flush=True)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('Leaderboard API listening on http://%s:%d (db: %s)' % (HOST, PORT, DB_PATH), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
