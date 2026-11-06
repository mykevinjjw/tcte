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
GET  /status                        -> {"open": true, "dates": ["11-03", "11-04"], "survey": false}；網站用來決定要不要開放小遊戲與問卷
POST /survey/load {name, token}     -> {"answers": {...} 或 null}；只有上傳過分數的暱稱本人 (同一台裝置) 能填
POST /survey {name, token, answers} -> {"ok": true}；同一個暱稱重填會覆蓋
GET  /health                        -> {"ok": true}

其他遊戲 (例如貪吃蛇) 在 /scores、/best 帶 game=snake (POST 放在 JSON 的 game 欄位)，
分數存在 game_scores 表、各自一個排行榜，暱稱與裝置綁定和生日遊戲共用 players 表；
這些遊戲不受開放日期限制，隨時都能玩。

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
MAX_RAW_SCORE = 2000  # 一場 60 秒內正常玩不可能超過的分數 (加權前)
# 難度：排行榜分數 = 遊戲分數 × 加權 (四捨五入)，所有難度共用一個排行榜；沒帶 level 的舊版網頁算普通
LEVELS = {
    'easy': ('簡單', 0.6),
    'normal': ('普通', 1.0),
    'hard': ('困難', 1.5),
}
MAX_SCORE = round(MAX_RAW_SCORE * max(w for _, w in LEVELS.values()))  # 排行榜上可能的最高分
# 其他遊戲：名稱、遊戲分數上限 (加權前)；難度加權同 LEVELS
GAMES = {
    'snake': ('貪吃蛇', 4000),
}
MAX_GAME_SCORE = max(round(raw * max(w for _, w in LEVELS.values())) for _, raw in GAMES.values())
MAX_LIMIT = 100
MAX_BODY_BYTES = 1024
RATE_LIMIT_COUNT = 10  # 每個 IP 每分鐘最多登記暱稱 + 上傳分數的次數
RATE_LIMIT_WINDOW = 60
TOKEN_PATTERN = re.compile(r'^[0-9a-f]{16,64}$')

# --- 遊戲結束後的小問卷 (選項要和網站 assets/js/birthday-board.js 的 SURVEY 一致) ---
MAX_SURVEY_BODY_BYTES = 8192
SURVEY_TEXT_LENGTH = 200
SURVEY_OTHER_LENGTH = 30
SURVEY_CLASS_NAME = '幼三甲'
SURVEY_CLASSMATE = ['是', '不是']
SURVEY_SEAT_MIN, SURVEY_SEAT_MAX = 1, 99
SURVEY_HARDEST = ['肚子餓', '哭哭了', '想睡覺', '換尿布', '跌倒了']
SURVEY_AGAIN = ['想', '看心情', '不想']
SURVEY_GIFTS = ['零食', '福利社兌換券', '文具', '電子獎狀', '都可以']

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
        # 後來加的欄位：上傳的裝置識別碼，讓後台分辨同一個人用了哪幾台裝置
        if 'token' not in [row[1] for row in conn.execute('PRAGMA table_info(events)')]:
            conn.execute('ALTER TABLE events ADD COLUMN token TEXT')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_events_name ON events (name COLLATE NOCASE, id)')
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
        # 其他遊戲的分數：每個遊戲、每個暱稱一列，只保留最高分
        conn.execute(
            'CREATE TABLE IF NOT EXISTS game_scores ('
            ' game TEXT NOT NULL,'
            ' name TEXT NOT NULL COLLATE NOCASE,'
            ' score INTEGER NOT NULL,'
            ' created_at TEXT NOT NULL,'
            ' updated_at TEXT NOT NULL,'
            ' PRIMARY KEY (game, name))'
        )
        conn.execute('CREATE INDEX IF NOT EXISTS idx_game_scores_rank ON game_scores (game, score DESC, updated_at)')
        # 問卷：一個暱稱一份，answers 是 JSON
        conn.execute(
            'CREATE TABLE IF NOT EXISTS surveys ('
            ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
            ' name TEXT NOT NULL UNIQUE COLLATE NOCASE,'
            ' token TEXT NOT NULL,'
            ' answers TEXT NOT NULL,'
            ' created_at TEXT NOT NULL,'
            ' updated_at TEXT NOT NULL)'
        )

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


def always_open(conn):
    """後台的「無限期開放」：每天都能玩 (預設關)"""
    row = conn.execute("SELECT value FROM settings WHERE key = 'always_open'").fetchone()
    return row is not None and row[0] == '1'


def is_event_date(conn):
    """今天是不是設定的開放日期 (生日活動；倒數網頁的祝福橫幅與問卷用它判斷)"""
    now = datetime.now(TAIPEI)
    return (now.month, now.day) in get_open_dates(conn)


def is_open_date(conn):
    """現在能不能玩、上傳分數"""
    if not BIRTHDAY_ONLY or always_open(conn):
        return True
    return is_event_date(conn)


def survey_enabled(conn):
    """後台的問卷開關 (預設開)"""
    row = conn.execute("SELECT value FROM settings WHERE key = 'survey_open'").fetchone()
    return row is None or row[0] == '1'


def is_survey_open(conn):
    # 活動日 (開放日期) 不收問卷，結束後才開始；無限期開放時其他日子都能填
    return survey_enabled(conn) and not is_event_date(conn)


def clean_text(value, limit):
    if value is None:
        return ''
    if not isinstance(value, str):
        return None
    # 保留換行，去掉其他控制字元
    text = ''.join(ch for ch in value if ch == '\n' or not unicodedata.category(ch).startswith('C')).strip()
    return text if len(text) <= limit else None


def clean_answers(data):
    """檢查問卷答案，格式不對回傳 (None, 錯誤訊息)"""
    if not isinstance(data, dict):
        return None, '問卷格式不正確'
    classmate = data.get('classmate')
    if classmate not in SURVEY_CLASSMATE:
        return None, '請選擇是不是%s的' % SURVEY_CLASS_NAME
    seat = data.get('seat')
    if classmate == '是':
        # 幼三甲的同學才需要填座號
        if isinstance(seat, bool) or not isinstance(seat, int) or not SURVEY_SEAT_MIN <= seat <= SURVEY_SEAT_MAX:
            return None, '請填座號 (%d~%d)' % (SURVEY_SEAT_MIN, SURVEY_SEAT_MAX)
    else:
        seat = None
    fun = data.get('fun')
    if isinstance(fun, bool) or not isinstance(fun, int) or not 1 <= fun <= 5:
        return None, '請選擇遊戲好不好玩 (1~5 顆星)'
    if data.get('hardest') not in SURVEY_HARDEST:
        return None, '請選擇最手忙腳亂的狀況'
    if data.get('again') not in SURVEY_AGAIN:
        return None, '請選擇明年還想不想玩'
    gifts = data.get('gifts')
    if not isinstance(gifts, list) or not gifts or any(g not in SURVEY_GIFTS for g in gifts):
        return None, '前三名的禮物建議至少選一個'
    gift_other = clean_text(data.get('gift_other'), SURVEY_OTHER_LENGTH)
    wish = clean_text(data.get('wish'), SURVEY_TEXT_LENGTH)
    advice = clean_text(data.get('advice'), SURVEY_TEXT_LENGTH)
    if gift_other is None:
        return None, '其他禮物建議最多 %d 個字' % SURVEY_OTHER_LENGTH
    if wish is None or advice is None:
        return None, '文字最多 %d 個字' % SURVEY_TEXT_LENGTH
    return {
        'classmate': classmate,
        'seat': seat,
        'fun': fun,
        'hardest': data['hardest'],
        'again': data['again'],
        'gifts': [g for g in SURVEY_GIFTS if g in gifts],
        'gift_other': gift_other,
        'wish': wish,
        'advice': advice,
    }, None


def log_event(conn, ip, action, name, score, status, note=None, token=None):
    conn.execute(
        'INSERT INTO events (at, ip, action, name, score, status, note, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        (now_text(), ip, action, name, score, status, note, token)
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


def clean_game(value):
    """沒帶或 birthday：生日遊戲 (回傳 '')；其他遊戲回傳 key；不認得回傳 None"""
    if value in (None, '', 'birthday'):
        return ''
    return value if value in GAMES else None


def game_rank(conn, game, best):
    return conn.execute('SELECT COUNT(DISTINCT score) FROM game_scores WHERE game = ? AND score > ?',
                        (game, best)).fetchone()[0] + 1


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
                event = is_event_date(conn)
                always = always_open(conn)
                survey = is_survey_open(conn)
            self.send_json(200, {'open': is_open, 'event': event, 'always': always,
                                 'dates': ['%02d-%02d' % d for d in dates], 'survey': survey})
            return
        if url.path == '/best':
            # 某個暱稱目前在伺服器上的最高分 (管理後台可能改過)，沒有分數時 best 為 null
            name = clean_name(parse_qs(url.query).get('name', [''])[0])
            game = clean_game(parse_qs(url.query).get('game', [''])[0])
            if not name or game is None:
                self.send_json(400, {'error': '暱稱不正確'})
                return
            if game:
                with sqlite3.connect(DB_PATH) as conn:
                    row = conn.execute('SELECT score FROM game_scores WHERE game = ? AND name = ?',
                                       (game, name)).fetchone()
                    best = row[0] if row else None
                    rank = game_rank(conn, game, best) if best is not None else None
                self.send_json(200, {'best': best, 'rank': rank})
                return
            with sqlite3.connect(DB_PATH) as conn:
                row = conn.execute('SELECT score FROM players WHERE name = ?', (name,)).fetchone()
                best = row[0] if row else None
                rank = None
                if best is not None:
                    rank = conn.execute('SELECT COUNT(DISTINCT score) FROM players WHERE score > ?', (best,)).fetchone()[0] + 1
            self.send_json(200, {'best': best, 'rank': rank})
            return
        if url.path != '/scores':
            self.send_json(404, {'error': '找不到這個網址'})
            return

        try:
            limit = int(parse_qs(url.query).get('limit', ['10'])[0])
        except ValueError:
            limit = 10
        limit = max(1, min(limit, MAX_LIMIT))
        game = clean_game(parse_qs(url.query).get('game', [''])[0])
        if game is None:
            self.send_json(400, {'error': '找不到這個遊戲'})
            return

        with sqlite3.connect(DB_PATH) as conn:
            if game:
                rows = conn.execute(
                    'SELECT name, score FROM game_scores WHERE game = ?'
                    ' ORDER BY score DESC, updated_at ASC LIMIT ?', (game, limit)
                ).fetchall()
            else:
                rows = conn.execute(
                    'SELECT name, score FROM players WHERE score IS NOT NULL'
                    ' ORDER BY score DESC, updated_at ASC, id ASC LIMIT ?', (limit,)
                ).fetchall()
        self.send_json(200, [{'name': name, 'score': score} for name, score in rows])

    def read_json(self, max_bytes=MAX_BODY_BYTES):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= max_bytes:
            return None
        try:
            data = json.loads(self.rfile.read(length).decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) else None

    def handle_survey(self, path):
        with sqlite3.connect(DB_PATH) as conn:
            survey_open = is_survey_open(conn)
        if not survey_open:
            self.send_json(403, {'error': '問卷現在沒有開放喔'})
            return
        data = self.read_json(MAX_SURVEY_BODY_BYTES)
        if data is None:
            self.send_json(400, {'error': '資料格式不正確'})
            return
        name = clean_name(data.get('name'))
        token = clean_token(data.get('token'))
        if name is None or token is None:
            self.send_json(400, {'error': '找不到你的暱稱，請用玩遊戲的那台裝置填寫'})
            return
        ip = self.client_ip()
        if not allow_post(ip):
            self.send_json(429, {'error': '太頻繁了，休息一下再試'})
            return

        with db_lock, sqlite3.connect(DB_PATH) as conn:
            # 只有上傳過分數、而且是同一台裝置的玩家本人能填
            row = conn.execute('SELECT name, token, score FROM players WHERE name = ?', (name,)).fetchone()
            if row is None or row[1] != token or row[2] is None:
                self.send_json(403, {'error': '只有玩過遊戲的玩家能填，請用玩遊戲的那台裝置填寫'})
                return
            name = row[0]
            existing = conn.execute('SELECT answers FROM surveys WHERE name = ?', (name,)).fetchone()
            if path == '/survey/load':
                self.send_json(200, {'answers': json.loads(existing[0]) if existing else None})
                return

            answers, error = clean_answers(data.get('answers'))
            if answers is None:
                self.send_json(400, {'error': error})
                return
            text = json.dumps(answers, ensure_ascii=False)
            if existing:
                conn.execute('UPDATE surveys SET token = ?, answers = ?, updated_at = ? WHERE name = ?',
                             (token, text, now_text(), name))
            else:
                conn.execute(
                    'INSERT INTO surveys (name, token, answers, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                    (name, token, text, now_text(), now_text())
                )
            log_event(conn, ip, 'survey', name, None, 200, '修改問卷' if existing else '填寫問卷', token)
        self.send_json(200, {'ok': True})

    def do_POST(self):
        path = urlparse(self.path).path
        if path in ('/survey', '/survey/load'):
            self.handle_survey(path)
            return
        if path not in ('/names', '/scores'):
            self.send_json(404, {'error': '找不到這個網址'})
            return
        data = self.read_json()
        if data is None:
            self.send_json(400, {'error': '資料格式不正確'})
            return
        game = clean_game(data.get('game'))
        if game is None:
            self.send_json(400, {'error': '找不到這個遊戲'})
            return
        if not game:
            # 開放日期只管生日遊戲
            with sqlite3.connect(DB_PATH) as conn:
                is_open = is_open_date(conn)
            if not is_open:
                self.send_json(403, {'error': '現在不是開放上傳的時間喔'})
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
        level_note = ''
        if path == '/scores':
            raw = data.get('score')
            level = data.get('level', 'normal')
            if level not in LEVELS:
                self.send_json(400, {'error': '難度不正確'})
                return
            max_raw = GAMES[game][1] if game else MAX_RAW_SCORE
            if isinstance(raw, bool) or not isinstance(raw, int) or not 0 <= raw <= max_raw:
                self.send_json(400, {'error': '分數不正確'})
                return
            label, weight = LEVELS[level]
            score = int(raw * weight + 0.5)
            level_note = '%s%s %d 分 ×%g，' % (GAMES[game][0] + ' ' if game else '', label, raw, weight)
        ip = self.client_ip()
        action = 'claim' if path == '/names' else (game or 'score')
        if not allow_post(ip):
            self.send_json(429, {'error': '太頻繁了，休息一下再試'})
            return

        with db_lock, sqlite3.connect(DB_PATH) as conn:
            row = conn.execute('SELECT id, token, score FROM players WHERE name = ?', (name,)).fetchone()
            # 其他遊戲的分數不放在 players.score (那是生日遊戲的)
            player_score = None if game else score
            if row is None:
                conn.execute(
                    'INSERT INTO players (name, token, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                    (name, token, player_score, now_text(), now_text())
                )
                best = player_score
            else:
                player_id, owner, best = row
                if owner is not None and owner != token:
                    log_event(conn, ip, action, name, score, 409, '暱稱屬於其他裝置', token)
                    self.send_json(409, {'error': '這個暱稱已經有人用了，換一個吧'})
                    return
                if owner is None:
                    # 舊資料還沒有裝置識別碼，由第一個使用的裝置認領
                    conn.execute('UPDATE players SET token = ? WHERE id = ?', (token, player_id))
                if player_score is not None and (best is None or player_score > best):
                    # 同一個暱稱只更新成更高的分數
                    conn.execute('UPDATE players SET score = ?, updated_at = ? WHERE id = ?',
                                 (score, now_text(), player_id))
                    best = score

            if path == '/names':
                log_event(conn, ip, action, name, None, 200, token=token)
                self.send_json(200, {'ok': True})
                return
            if game:
                name = conn.execute('SELECT name FROM players WHERE name = ?', (name,)).fetchone()[0]
                existing = conn.execute('SELECT score FROM game_scores WHERE game = ? AND name = ?',
                                        (game, name)).fetchone()
                if existing is None:
                    conn.execute(
                        'INSERT INTO game_scores (game, name, score, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
                        (game, name, score, now_text(), now_text())
                    )
                    best = score
                elif score > existing[0]:
                    conn.execute('UPDATE game_scores SET score = ?, updated_at = ? WHERE game = ? AND name = ?',
                                 (score, now_text(), game, name))
                    best = score
                else:
                    best = existing[0]
                rank = game_rank(conn, game, best)
                log_event(conn, ip, action, name, score, 201, '%s最高分 %d，第 %d 名' % (level_note, best, rank), token)
                self.send_json(201, {'rank': rank, 'best': best, 'score': score})
                return
            higher = conn.execute('SELECT COUNT(DISTINCT score) FROM players WHERE score > ?', (best,)).fetchone()[0]
            log_event(conn, ip, action, name, score, 201, '%s最高分 %d，第 %d 名' % (level_note, best, higher + 1), token)
        self.send_json(201, {'rank': higher + 1, 'best': best, 'score': score})

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.client_ip(), fmt % args), flush=True)


def main():
    init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('Leaderboard API listening on http://%s:%d (db: %s)' % (HOST, PORT, DB_PATH), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
