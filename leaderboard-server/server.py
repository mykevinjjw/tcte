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

GET  /scores?limit=10               -> [{"name": "...", "score": 123}, ...]
POST /names  {name, token}          -> {"ok": true}；暱稱已被其他裝置使用時回 409
POST /scores {name, token, score}   -> {"rank": 3, "best": 123}；同一個暱稱只保留最高分
GET  /status                        -> {"open": true, "dates": ["11-03", "11-04"]}；網站用來決定要不要開放小遊戲
GET  /health                        -> {"ok": true}

token 是每台裝置隨機產生的識別碼，暱稱屬於第一個登記它的裝置。
開放日期存在 settings 表 (管理後台 admin.py 可以修改)，登記暱稱與上傳分數會記在 events 表。
"""
import json
import os
import re
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
BIRTHDAY_ONLY = os.environ.get('LB_BIRTHDAY_ONLY', '1') == '1'  # 1：只有開放日期 (台灣時間) 能上傳分數
# 開放上傳的日期 (月-日，逗號分隔)；管理後台設定過就以後台為準，這裡只是預設值
DEFAULT_OPEN_DATES = os.environ.get('LB_OPEN_DATES', '11-03,11-04')
MAX_EVENTS = 20000  # events 表最多保留的筆數

TAIPEI = timezone(timedelta(hours=8))
MAX_NAME_LENGTH = 12
MAX_SCORE = 1500  # 60 秒內正常玩不可能超過的分數
MAX_LIMIT = 50
MAX_BODY_BYTES = 1024
RATE_LIMIT_COUNT = 10  # 每個 IP 每分鐘最多登記暱稱 + 上傳分數的次數
RATE_LIMIT_WINDOW = 60
TOKEN_PATTERN = re.compile(r'^[0-9a-f]{16,64}$')

db_lock = threading.Lock()
rate_lock = threading.Lock()
recent_posts = {}


def now_text():
    return datetime.now(TAIPEI).isoformat(timespec='seconds')


def parse_dates(text):
    """把 '11-03,11-04' 轉成 [(11, 3), (11, 4)]，格式不對就回傳 None"""
    dates = []
    for part in text.split(','):
        part = part.strip()
        if not part:
            continue
        match = re.match(r'^(\d{1,2})-(\d{1,2})$', part)
        if not match:
            return None
        month, day = int(match.group(1)), int(match.group(2))
        try:
            datetime(2024, month, day)  # 2024 是閏年，2/29 也算合法
        except ValueError:
            return None
        if (month, day) not in dates:
            dates.append((month, day))
    return sorted(dates)


def get_open_dates(conn):
    row = conn.execute("SELECT value FROM settings WHERE key = 'open_dates'").fetchone()
    dates = parse_dates(row[0]) if row else None
    return dates if dates is not None else (parse_dates(DEFAULT_OPEN_DATES) or [])


def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        conn.execute(
            'CREATE TABLE IF NOT EXISTS events ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' at TEXT NOT NULL,'
            ' ip TEXT NOT NULL,'
            ' action TEXT NOT NULL,'  # claim：登記暱稱、score：上傳分數
            ' name TEXT NOT NULL,'
            ' score INTEGER,'
            ' status INTEGER NOT NULL,'
            ' note TEXT)'
        )
        # 一個暱稱一列；score 為 NULL 表示已登記暱稱但還沒上傳過分數
        conn.execute(
            'CREATE TABLE IF NOT EXISTS players ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' name TEXT NOT NULL UNIQUE COLLATE NOCASE,'
            ' token TEXT,'
            ' score INTEGER,'
            ' created_at TEXT NOT NULL,'
            ' updated_at TEXT NOT NULL)'
        )
        conn.execute('CREATE INDEX IF NOT EXISTS idx_players_rank ON players (score DESC, updated_at, id)')

        # 舊版每次上傳一列的 scores 表：每個暱稱取最高分搬過來，原表改名保留備份
        # (SQLite 搭配單一 MAX() 時，name 與 created_at 會取自最高分的那一列)
        legacy = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scores'").fetchone()
        if legacy:
            conn.execute(
                'INSERT OR IGNORE INTO players (name, token, score, created_at, updated_at)'
                ' SELECT name, NULL, MAX(score), created_at, created_at'
                ' FROM scores GROUP BY name COLLATE NOCASE'
            )
            conn.execute('ALTER TABLE scores RENAME TO scores_legacy')


def is_open_date(conn):
    if not BIRTHDAY_ONLY:
        return True
    now = datetime.now(TAIPEI)
    return (now.month, now.day) in get_open_dates(conn)


def log_event(conn, ip, action, name, score, status, note=None):
    conn.execute(
        'INSERT INTO events (at, ip, action, name, score, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        (now_text(), ip, action, name, score, status, note)
    )
    conn.execute('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?', (MAX_EVENTS,))


def clean_name(value):
    if not isinstance(value, str):
        return None
    # 去掉換行等控制字元，避免奇怪的名字
    name = ''.join(ch for ch in value if not unicodedata.category(ch).startswith('C')).strip()
    if not 1 <= len(name) <= MAX_NAME_LENGTH:
        return None
    return name


def clean_token(value):
    if isinstance(value, str) and TOKEN_PATTERN.match(value):
        return value
    return None


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
        if url.path == '/status':
            with sqlite3.connect(DB_PATH) as conn:
                dates = get_open_dates(conn)
                is_open = is_open_date(conn)
            self.send_json(200, {'open': is_open, 'dates': ['%02d-%02d' % d for d in dates]})
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
                'SELECT name, score FROM players WHERE score IS NOT NULL'
                ' ORDER BY score DESC, updated_at ASC, id ASC LIMIT ?', (limit,)
            ).fetchall()
        self.send_json(200, [{'name': name, 'score': score} for name, score in rows])

    def read_json(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= MAX_BODY_BYTES:
            return None
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ('/names', '/scores'):
            self.send_json(404, {'error': '找不到這個網址'})
            return
        with sqlite3.connect(DB_PATH) as conn:
            is_open = is_open_date(conn)
        if not is_open:
            self.send_json(403, {'error': '現在不是開放上傳的時間喔'})
            return

        data = self.read_json()
        if data is None:
            self.send_json(400, {'error': '資料格式不正確'})
            return
        name = clean_name(data.get('name'))
        token = clean_token(data.get('token'))
        if name is None:
            self.send_json(400, {'error': '暱稱要 1~%d 個字' % MAX_NAME_LENGTH})
            return
        if token is None:
            self.send_json(400, {'error': '請重新整理頁面後再試一次'})
            return

        score = None
        if path == '/scores':
            score = data.get('score')
            if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= MAX_SCORE:
                self.send_json(400, {'error': '分數不正確'})
                return
        ip = self.client_ip()
        action = 'claim' if path == '/names' else 'score'
        if not allow_post(ip):
            self.send_json(429, {'error': '太頻繁了，休息一下再試'})
            return

        with db_lock, sqlite3.connect(DB_PATH) as conn:
            row = conn.execute('SELECT id, token, score FROM players WHERE name = ?', (name,)).fetchone()
            if row is None:
                conn.execute(
                    'INSERT INTO players (name, token, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                    (name, token, score, now_text(), now_text())
                )
                best = score
            else:
                player_id, owner, best = row
                if owner is not None and owner != token:
                    log_event(conn, ip, action, name, score, 409, '暱稱屬於其他裝置')
                    self.send_json(409, {'error': '這個暱稱已經有人用了，換一個吧'})
                    return
                if owner is None:
                    # 舊資料還沒有裝置識別碼，由第一個使用的裝置認領
                    conn.execute('UPDATE players SET token = ? WHERE id = ?', (token, player_id))
                if score is not None and (best is None or score > best):
                    # 同一個暱稱只更新成更高的分數
                    conn.execute('UPDATE players SET score = ?, updated_at = ? WHERE id = ?',
                                 (score, now_text(), player_id))
                    best = score

            if path == '/names':
                log_event(conn, ip, action, name, None, 200)
                self.send_json(200, {'ok': True})
                return
            higher = conn.execute('SELECT COUNT(*) FROM players WHERE score > ?', (best,)).fetchone()[0]
            log_event(conn, ip, action, name, score, 201, '最高分 %d，第 %d 名' % (best, higher + 1))
        self.send_json(201, {'rank': higher + 1, 'best': best})

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.client_ip(), fmt % args), flush=True)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('Leaderboard API listening on http://%s:%d (db: %s)' % (HOST, PORT, DB_PATH), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
