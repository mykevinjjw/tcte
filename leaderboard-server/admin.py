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
"""生日小遊戲排行榜管理後台：只用 Python 標準庫，跟 server.py 共用同一個 SQLite 資料庫。

功能：管理排行榜 (改分數、解除裝置綁定、刪除)、玩家完整紀錄與分數歷程、時間軸、設定開放日期、
查看上傳紀錄、下載備份。

產生密碼雜湊 (放到 ADMIN_PASSWORD_HASH)：
    python3 admin.py hash-password      # 從標準輸入讀密碼
"""
import csv
import hashlib
import hmac
import html
import io
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlencode, urlparse

import server as lb  # 共用資料庫位置、資料表與開放日期的處理

# --- 設定 (都可以用環境變數覆蓋) ---
HOST = os.environ.get('ADMIN_HOST', '127.0.0.1')  # 只聽本機，由 nginx 反向代理並提供 HTTPS
PORT = int(os.environ.get('ADMIN_PORT', '8788'))
ADMIN_USER = os.environ.get('ADMIN_USER', 'admin')
ADMIN_PASSWORD_HASH = os.environ.get('ADMIN_PASSWORD_HASH', '')
COOKIE_SECURE = os.environ.get('ADMIN_COOKIE_SECURE', '1') == '1'
# 1：不需要帳號密碼，任何能連到後台網址的人都能查看與操作 (站長自行決定的設定)
NO_LOGIN = os.environ.get('ADMIN_NO_LOGIN', '0') == '1'

COOKIE_NAME = 'tcte_admin'
SESSION_SECONDS = 12 * 60 * 60
LOGIN_FAIL_LIMIT = 5  # 每個 IP 在 LOGIN_FAIL_WINDOW 秒內最多輸錯幾次
LOGIN_FAIL_WINDOW = 10 * 60
PBKDF2_ITERATIONS = 240000
EVENTS_PAGE_SIZE = 200
MAX_FORM_BYTES = 4096

sessions = {}
sessions_lock = threading.Lock()
login_fails = {}
login_lock = threading.Lock()

# 操作完成後顯示的訊息 (網址只帶代號，避免把任意文字顯示在頁面上)
FLASH_MESSAGES = {
    'score': '已修改分數',
    'unbind': '已解除裝置綁定，下一個使用這個暱稱的裝置會綁定它',
    'deleted': '已刪除玩家',
    'dates': '已更新開放日期',
    'bad-dates': '日期格式不正確，請用「月-日」並以逗號分隔，例如 11-03,11-04',
    'bad-score': '分數要是 0~%d 的整數，留空代表清除分數' % lb.MAX_SCORE,
    'missing': '找不到這位玩家，可能已經被刪除',
}
STATUS_TEXT = {
    200: '登記成功',
    201: '上傳成功',
    409: '暱稱重複',
}
ACTION_TEXT = {
    'claim': '登記暱稱',
    'score': '上傳分數',
    'admin': '後台操作',
}


# --- 密碼與登入 ---

def hash_password(password, salt=None):
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, PBKDF2_ITERATIONS)
    return 'pbkdf2_sha256$%d$%s$%s' % (PBKDF2_ITERATIONS, salt.hex(), digest.hex())


def check_password(password, stored):
    try:
        algorithm, iterations, salt, digest = stored.split('$')
        if algorithm != 'pbkdf2_sha256':
            return False
        actual = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), bytes.fromhex(salt), int(iterations))
    except ValueError:
        return False
    return hmac.compare_digest(actual.hex(), digest)


def too_many_fails(ip):
    now = time.time()
    with login_lock:
        fails = [t for t in login_fails.get(ip, []) if now - t < LOGIN_FAIL_WINDOW]
        login_fails[ip] = fails
        return len(fails) >= LOGIN_FAIL_LIMIT


def record_fail(ip):
    with login_lock:
        login_fails.setdefault(ip, []).append(time.time())


def new_session():
    sid = secrets.token_urlsafe(32)
    with sessions_lock:
        now = time.time()
        for key in [k for k, v in sessions.items() if v['expires'] < now]:
            del sessions[key]
        sessions[sid] = {'csrf': secrets.token_urlsafe(24), 'expires': now + SESSION_SECONDS}
    return sid


# 免登入模式時所有人共用的工作階段，表單仍然帶 CSRF 碼，擋掉其他網站偷偷送出的表單
OPEN_SESSION = {'csrf': secrets.token_urlsafe(32), 'expires': float('inf')}


def get_session(sid):
    if NO_LOGIN:
        return OPEN_SESSION
    if not sid:
        return None
    with sessions_lock:
        session = sessions.get(sid)
        if session and session['expires'] >= time.time():
            return session
        sessions.pop(sid, None)
    return None


# --- 資料庫 ---

def db():
    conn = sqlite3.connect(lb.DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def log_admin(conn, ip, name, note):
    lb.log_event(conn, ip, 'admin', name, None, 200, note)


def fmt_time(text):
    # 2026-11-03T19:22:17+08:00 -> 11/03 19:22:17
    try:
        value = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return text or ''
    return value.strftime('%m/%d %H:%M:%S')


def csv_time(text):
    # 2026-11-03T19:22:17+08:00 -> 2026/11/03 19:22:17 (台灣時間，Excel 會當成日期時間)
    try:
        value = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return text or ''
    return value.astimezone(lb.TAIPEI).strftime('%Y/%m/%d %H:%M:%S')


def e(value):
    return html.escape('' if value is None else str(value), quote=True)


# --- 頁面 ---

STYLE = '''
:root { --bg: #f6f7fb; --card: #fff; --text: #263238; --muted: #78909c; --line: #e3e7ee;
        --accent: #e91e63; --ok: #2e7d32; --warn: #c62828; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
       font-family: "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif; font-size: 15px; }
header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding: 12px 16px;
         background: #263238; color: #fff; }
header h1 { margin: 0; font-size: 1.1rem; }
header nav { display: flex; flex-wrap: wrap; gap: 4px 14px; flex: 1; }
header a { color: #cfd8dc; text-decoration: none; }
header a.on { color: #fff; font-weight: 700; }
header form { margin: 0; }
main { max-width: 1100px; margin: 0 auto; padding: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
.card h2 { margin: 0 0 12px; font-size: 1.05rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; }
.stat b { display: block; font-size: 1.6rem; }
.stat span { color: var(--muted); font-size: 0.85rem; }
.flash { padding: 10px 14px; border-radius: 10px; margin-bottom: 16px; background: #e8f5e9; color: var(--ok); }
.flash.bad { background: #ffebee; color: var(--warn); }
.muted { color: var(--muted); font-size: 0.85rem; }
.open { color: var(--ok); font-weight: 700; }
.closed { color: var(--warn); font-weight: 700; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { padding: 8px 6px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
td.actions { display: flex; gap: 6px; align-items: center; }
td.actions form { display: flex; gap: 4px; margin: 0; }
input[type=text], input[type=password], input[type=number] {
    padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; font: inherit; }
input[type=number] { width: 80px; }
button, .button { padding: 6px 12px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent);
                  color: #fff; font: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
button.ghost, .button.ghost { background: #fff; color: var(--accent); }
button.danger { background: var(--warn); border-color: var(--warn); }
header button { background: none; border-color: #90a4ae; color: #cfd8dc; padding: 3px 10px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.card h3 { margin: 16px 0 8px; font-size: 0.95rem; }
code { font-size: 0.85em; color: var(--muted); }
tr.hl td { background: #fce4ec; }
.chart { width: 100%; height: auto; display: block; }
.chart .grid { stroke: var(--line); stroke-width: 1; }
.chart .tick { stroke: #b0bec5; }
.chart .axis { fill: var(--muted); font-size: 11px; }
.chart .step { fill: none; stroke-width: 2; stroke-linejoin: round; }
.chart .dot { stroke: #fff; stroke-width: 2; }
.chart .dot:hover, .chart .bar:hover { opacity: 0.75; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-bottom: 8px; font-size: 0.85rem; color: var(--muted); }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.chip { padding: 3px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--text); text-decoration: none; }
.chip.on { background: var(--text); border-color: var(--text); color: #fff; }
.feed { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line); }
.feed li { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; padding: 5px 0; position: relative; }
.feed li::before { content: ''; position: absolute; left: -21px; top: 11px; width: 10px; height: 10px;
                   border-radius: 50%; background: #b0bec5; border: 2px solid var(--card); }
.feed li.best::before { background: #3f6fd8; }
.feed li.top::before { background: var(--accent); }
.feed li.admin, .feed li.claim { color: var(--muted); }
.feed li.hour { font-weight: 700; padding-top: 12px; }
.feed li.hour::before { background: var(--text); }
.feed time { color: var(--muted); font-variant-numeric: tabular-nums; min-width: 64px; }
.badge { font-size: 0.78rem; padding: 1px 8px; border-radius: 999px; background: #e8eefc; color: #2c4fa0; }
.badge.top { background: #fce4ec; color: #ad1457; }
.login { max-width: 360px; margin: 12vh auto; }
.login label { display: block; margin: 10px 0 4px; }
.login input { width: 100%; }
.login button { width: 100%; margin-top: 16px; padding: 10px; }
'''


# 每 5 秒在背景重新抓目前的頁面，替換有 data-live 的區塊；正在輸入或改了還沒儲存的區塊先不更新
LIVE_JS = '''(function () {
    var REFRESH_MS = 5000;
    function editing(el) {
        var active = document.activeElement;
        if (active && el.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) {
            return true;
        }
        var inputs = el.querySelectorAll('input');
        for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].value !== inputs[i].defaultValue) {
                return true;
            }
        }
        return false;
    }
    function refresh() {
        var parts = document.querySelectorAll('[data-live]');
        if (!parts.length || document.hidden) {
            return;
        }
        fetch(location.href, { credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
            if (!res.ok || res.redirected) {
                throw new Error('not available');
            }
            return res.text();
        }).then(function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            Array.prototype.forEach.call(parts, function (el) {
                var fresh = doc.querySelector('[data-live="' + el.getAttribute('data-live') + '"]');
                if (fresh && fresh.innerHTML !== el.innerHTML && !editing(el)) {
                    el.innerHTML = fresh.innerHTML;
                }
            });
        }).catch(function () {
            // 登入過期或連不上時先不更新
        });
    }
    setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
})();
'''


def layout(title, body, session=None, active=''):
    nav = ''
    if session:
        links = [('/', '排行榜', 'players'), ('/timeline', '時間軸', 'timeline'), ('/events', '上傳紀錄', 'events'),
                 ('/backup', '備份下載', 'backup')]
        nav = '<nav>' + ''.join(
            '<a href="%s"%s>%s</a>' % (href, ' class="on"' if key == active else '', label)
            for href, label, key in links
        ) + '</nav>' + ('' if NO_LOGIN else (
            '<form method="post" action="/logout"><input type="hidden" name="csrf" value="%s">'
            '<button type="submit">登出</button></form>' % e(session['csrf'])
        ))
    return (
        '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        '<meta name="robots" content="noindex, nofollow">'
        '<title>%s｜TCTE 管理後台</title><style>%s</style>%s</head><body>'
        '<header><h1>🎂 TCTE 管理後台</h1>%s</header><main>%s</main></body></html>'
    ) % (e(title), STYLE, '<script src="/live.js" defer></script>' if session else '', nav, body)


def flash_html(query):
    key = query.get('msg', [''])[0]
    if key not in FLASH_MESSAGES:
        return ''
    bad = key.startswith('bad') or key == 'missing'
    return '<div class="flash%s">%s</div>' % (' bad' if bad else '', e(FLASH_MESSAGES[key]))


def csrf_input(session):
    return '<input type="hidden" name="csrf" value="%s">' % e(session['csrf'])


def login_page(error=''):
    body = (
        '<div class="card login"><h2>登入</h2>%s'
        '<form method="post" action="/login">'
        '<label for="user">帳號</label><input id="user" type="text" name="user" autocomplete="username" required>'
        '<label for="password">密碼</label>'
        '<input id="password" type="password" name="password" autocomplete="current-password" required>'
        '<button type="submit">登入</button></form></div>'
    ) % ('<div class="flash bad">%s</div>' % e(error) if error else '')
    return layout('登入', body)


def players_page(session, query):
    with db() as conn:
        dates = lb.get_open_dates(conn)
        is_open = lb.is_open_date(conn)
        players = conn.execute(
            'SELECT id, name, token, score, created_at, updated_at FROM players'
            ' ORDER BY score IS NULL, score DESC, updated_at, id'
        ).fetchall()
        plays = {
            name.lower(): (count, last)
            for name, count, last in conn.execute(
                "SELECT name, COUNT(*), MAX(at) FROM events WHERE action = 'score' AND status = 201"
                ' GROUP BY name COLLATE NOCASE'
            )
        }
        today = datetime.now(lb.TAIPEI).strftime('%Y-%m-%d')
        uploads_today = conn.execute(
            "SELECT COUNT(*) FROM events WHERE action = 'score' AND status = 201 AND at LIKE ?", (today + '%',)
        ).fetchone()[0]

    scored = sum(1 for p in players if p['score'] is not None)
    date_text = ','.join('%02d-%02d' % d for d in dates)
    stats = (
        '<div class="stats" style="margin-bottom:16px" data-live="stats">'
        '<div class="stat"><b>%d</b><span>登記的暱稱</span></div>'
        '<div class="stat"><b>%d</b><span>有分數的玩家</span></div>'
        '<div class="stat"><b>%d</b><span>今天的上傳次數</span></div>'
        '<div class="stat"><b class="%s">%s</b><span>現在 (台灣時間)</span></div>'
        '</div>'
    ) % (len(players), scored, uploads_today, 'open' if is_open else 'closed', '開放中' if is_open else '未開放')

    dates_form = (
        '<div class="card"><h2>開放日期</h2>'
        '<form method="post" action="/settings/open-dates" class="row">%s'
        '<input type="text" name="dates" value="%s" placeholder="11-03,11-04" size="30">'
        '<button type="submit">儲存</button></form>'
        '<p class="muted">格式「月-日」，多個日期用逗號分隔，以台灣時間判斷。網站只在這些日期顯示小遊戲並接受上傳；'
        '留空代表完全不開放。生日當天 (11/4) 的祝福橫幅不受影響。</p></div>'
    ) % (csrf_input(session), e(date_text))

    rows = []
    rank = 0
    for p in players:
        if p['score'] is not None:
            rank += 1
        token = p['token']
        count, last_play = plays.get(p['name'].lower(), (0, None))
        rows.append(
            '<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td class="actions">'
            '<form method="post" action="/players/score">%s<input type="hidden" name="id" value="%d">'
            '<input type="number" name="score" min="0" max="%d" value="%s" aria-label="分數">'
            '<button type="submit" class="ghost">改分數</button></form>'
            '%s'
            '<a class="button ghost" href="/players/delete?id=%d">刪除</a>'
            '</td></tr>' % (
                rank if p['score'] is not None else '—',
                name_link(p['name']),
                e(p['score']) if p['score'] is not None else '<span class="muted">未上傳</span>',
                '<a href="/player?%s">%d 次</a>' % (e(urlencode({'name': p['name']})), count) if count else
                '<span class="muted">0</span>',
                '<code>%s…</code>' % e(token[:8]) if token else '<span class="muted">未綁定</span>',
                e(fmt_time(p['created_at'])),
                e(fmt_time(last_play)) if last_play else '<span class="muted">—</span>',
                csrf_input(session), p['id'], lb.MAX_SCORE, e(p['score']) if p['score'] is not None else '',
                (
                    '<form method="post" action="/players/unbind">%s<input type="hidden" name="id" value="%d">'
                    '<button type="submit" class="ghost">解除綁定</button></form>' % (csrf_input(session), p['id'])
                ) if token else '',
                p['id'],
            )
        )
    table = (
        '<div class="card" data-live="players"><h2>排行榜 (共 %d 位，每 5 秒自動更新)</h2><div class="table-wrap"><table>'
        '<tr><th>名次</th><th>暱稱</th><th>最高分</th><th>上傳次數</th><th>綁定裝置</th><th>登記時間</th><th>最近遊玩</th>'
        '<th>操作</th></tr>'
        '%s</table></div>'
        '<p class="muted">點暱稱或上傳次數可以看這個人的每一次上傳與分數歷程。「解除綁定」後，下一台使用這個暱稱的裝置會綁定它 (玩家換手機或清除瀏覽器資料時使用)。'
        '分數留空儲存會讓玩家從排行榜上消失，但保留暱稱。</p></div>'
    ) % (len(players), ''.join(rows) or '<tr><td colspan="8" class="muted">還沒有玩家</td></tr>')

    return layout('排行榜', flash_html(query) + stats + dates_form + table, session, 'players')


# --- 圖表 (伺服器直接產生 SVG，滑鼠移到點或長條上會顯示詳細資料) ---

CHART_W, CHART_H = 860, 240
CHART_PAD = (48, 16, 14, 34)  # 左、右、上、下
COLOR_UPLOAD = '#3f6fd8'
COLOR_BEST = '#e91e63'
WEEKDAYS = '一二三四五六日'
RANK_PATTERN = re.compile(r'第 (\d+) 名')


def parse_time(text):
    try:
        return datetime.fromisoformat(text).astimezone(lb.TAIPEI)
    except (TypeError, ValueError):
        return None


def nice_step(value, ticks=4):
    # 讓 y 軸刻度落在 1、2、5 的倍數
    raw = max(value, 1) / ticks
    magnitude = 10 ** (len(str(int(raw))) - 1)
    for factor in (1, 2, 5, 10):
        if raw <= factor * magnitude:
            return factor * magnitude
    return 10 * magnitude


class Chart:
    def __init__(self, t0, t1, y_max):
        if t1 <= t0:
            t1 = t0 + timedelta(minutes=30)
        self.t0, self.t1 = t0, t1
        self.step = nice_step(y_max)
        self.y_max = self.step * max(1, -(-y_max // self.step))
        left, right, top, bottom = CHART_PAD
        self.left, self.top = left, top
        self.width = CHART_W - left - right
        self.height = CHART_H - top - bottom
        self.parts = []

    def x(self, dt):
        return self.left + (dt - self.t0).total_seconds() / (self.t1 - self.t0).total_seconds() * self.width

    def y(self, value):
        return self.top + self.height - value / self.y_max * self.height

    def grid(self):
        out = []
        value = 0
        while value <= self.y_max:
            y = self.y(value)
            out.append('<line x1="%d" x2="%d" y1="%.1f" y2="%.1f" class="grid"/>'
                       '<text x="%d" y="%.1f" class="axis" text-anchor="end">%d</text>'
                       % (self.left, self.left + self.width, y, y, self.left - 6, y + 4, value))
            value += self.step
        # x 軸：依時間長度選刻度間隔，跨日時標日期
        span_minutes = (self.t1 - self.t0).total_seconds() / 60
        minutes = next((m for m in (5, 10, 15, 30, 60, 120, 180, 360, 720) if span_minutes / m <= 8), 1440)
        tick = self.t0.replace(minute=0, second=0, microsecond=0)
        while (tick.hour * 60 + tick.minute) % minutes:
            tick += timedelta(minutes=5)
        last_day = None
        while tick <= self.t1:
            if tick >= self.t0:
                label = tick.strftime('%H:%M')
                if tick.date() != last_day:
                    label = tick.strftime('%m/%d ') + label
                    last_day = tick.date()
                x = self.x(tick)
                out.append('<line x1="%.1f" x2="%.1f" y1="%d" y2="%d" class="tick"/>'
                           '<text x="%.1f" y="%d" class="axis" text-anchor="middle">%s</text>'
                           % (x, x, self.top + self.height, self.top + self.height + 4,
                              x, CHART_H - 12, label))
            tick += timedelta(minutes=minutes)
        return ''.join(out)

    def render(self, label):
        return ('<svg class="chart" viewBox="0 0 %d %d" role="img" aria-label="%s">%s%s</svg>'
                % (CHART_W, CHART_H, e(label), self.grid(), ''.join(self.parts)))


def step_path(chart, points, end):
    # 階梯線：數值維持到下一次改變為止
    d = []
    for i, (dt, value) in enumerate(points):
        x, y = chart.x(dt), chart.y(value)
        d.append(('H%.1f V%.1f' if i else 'M%.1f %.1f') % (x, y))
    d.append('H%.1f' % chart.x(end))
    return '<path d="%s" class="step" stroke="%s"/>' % (' '.join(d), COLOR_BEST)


def dot(chart, dt, value, color, title, big=False):
    # 外圈用底色描邊，點重疊時還分得出來；<title> 是滑鼠移上去的說明
    return ('<circle cx="%.1f" cy="%.1f" r="%s" fill="%s" class="dot"><title>%s</title></circle>'
            % (chart.x(dt), chart.y(value), 6 if big else 4.5, color, e(title)))


def legend(items):
    return '<div class="legend">%s</div>' % ''.join(
        '<span><i style="background:%s"></i>%s</span>' % (color, e(label)) for color, label in items)


def name_link(name):
    return '<a href="/player?%s">%s</a>' % (e(urlencode({'name': name})), e(name))


def score_text(score):
    return '未上傳' if score is None else score


def status_text(action, status):
    if action == 'admin':
        return '完成'
    return STATUS_TEXT.get(status, status)


def player_page(session, name):
    with db() as conn:
        player = conn.execute('SELECT id, name, token, score, created_at, updated_at FROM players'
                              ' WHERE name = ?', (name,)).fetchone()
        events = conn.execute(
            'SELECT id, at, ip, action, name, score, status, note, token FROM events'
            ' WHERE name = ? COLLATE NOCASE ORDER BY id', (name,)
        ).fetchall()
        rank = None
        if player and player['score'] is not None:
            rank = conn.execute('SELECT COUNT(*) FROM players WHERE score > ?', (player['score'],)).fetchone()[0] + 1
    if not player and not events:
        return None
    title = player['name'] if player else name

    uploads = [ev for ev in events if ev['action'] == 'score' and ev['status'] == 201]
    scores = [ev['score'] for ev in uploads]
    played = [parse_time(ev['at']) for ev in uploads]
    devices = {ev['token'] for ev in events if ev['token']}
    ips = {ev['ip'] for ev in events if ev['action'] != 'admin'}

    stats = '<div class="stats" style="margin-bottom:16px" data-live="player-stats">%s</div>' % ''.join(
        '<div class="stat"><b>%s</b><span>%s</span></div>' % item for item in [
            (e(player['score']) if player and player['score'] is not None else '—', '目前最高分'),
            ('第 %d 名' % rank if rank else '—', '目前名次'),
            (len(uploads), '上傳次數'),
            (round(sum(scores) / len(scores)) if scores else '—', '平均分數'),
            (e(played[0].strftime('%m/%d %H:%M')) if played else '—', '第一次上傳'),
            (e(played[-1].strftime('%m/%d %H:%M')) if played else '—', '最近一次上傳'),
            (len(devices) or '—', '用過的裝置'),
            (len(ips), '用過的 IP'),
        ])

    # 分數歷程：每次上傳一個點，個人最高分畫成階梯線
    personal_best, record_ids = {}, set()
    chart_html = '<p class="muted">還沒有逐筆上傳紀錄 (11/3 20:00 以前的上傳只留下最高分)</p>'
    if uploads:
        chart = Chart(played[0], played[-1], max(scores))
        best, line = -1, []
        for ev, dt in zip(uploads, played):
            if ev['score'] > best:
                best = ev['score']
                line.append((dt, best))
                record_ids.add(ev['id'])
            personal_best[ev['id']] = best
        chart.parts.append(step_path(chart, line, played[-1]))
        for ev, dt in zip(uploads, played):
            record = ev['id'] in record_ids
            chart.parts.append(dot(chart, dt, ev['score'], COLOR_BEST if record else COLOR_UPLOAD, '%s　%d 分%s' % (
                dt.strftime('%m/%d %H:%M:%S'), ev['score'], '　個人新紀錄' if record else ''), record))
        chart_html = legend([(COLOR_UPLOAD, '每次上傳的分數'), (COLOR_BEST, '個人最高分 (大點是刷新紀錄的那次)')]) + \
            chart.render('%s 的分數歷程' % title)

    rows = []
    for ev in reversed(events):
        dt = parse_time(ev['at'])
        match = RANK_PATTERN.search(ev['note'] or '')
        rows.append(
            '<tr%s><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (
                ' class="hl"' if ev['id'] in record_ids else '',
                e(dt.strftime('%Y/%m/%d %H:%M:%S') if dt else ev['at']),
                e(ACTION_TEXT.get(ev['action'], ev['action'])),
                e(ev['score']) if ev['score'] is not None else '',
                e(personal_best.get(ev['id'], '')),
                '第 %s 名' % match.group(1) if match else '',
                '<code>%s</code>' % e(ev['token'][:8]) if ev['token'] else '',
                e(ev['ip']),
                e(ev['note'] if ev['action'] == 'admin' else status_text(ev['action'], ev['status'])),
            ))
    table = (
        '<div class="card" data-live="player-events"><h2>完整紀錄 (共 %d 筆，最新在上)</h2>'
        '<div class="table-wrap"><table>'
        '<tr><th>時間</th><th>動作</th><th>分數</th><th>當時個人最高</th><th>當時名次</th><th>裝置</th><th>IP</th>'
        '<th>結果</th></tr>%s</table></div>'
        '<p class="muted">粉紅底色是刷新個人紀錄的那一次。「裝置」是遊戲在每台裝置隨機產生的識別碼前 8 碼'
        ' (11/4 改版前的紀錄沒有)。</p></div>'
    ) % (len(events), ''.join(rows) or '<tr><td colspan="8" class="muted">沒有紀錄</td></tr>')

    if player:
        info = '<p class="muted">登記於 %s・%s</p>' % (
            e(fmt_time(player['created_at'])),
            '綁定裝置 <code>%s</code>' % e(player['token'][:8]) if player['token'] else '未綁定裝置')
    else:
        info = '<p class="muted">這個暱稱已經不在排行榜上 (可能被刪除)，以下是留下來的紀錄。</p>'
    body = (
        '<p><a href="/">← 回排行榜</a></p><div class="card"><h2>👩‍🏫 %s</h2>%s</div>%s'
        '<div class="card" data-live="player-chart"><h2>分數歷程</h2>%s</div>%s'
    ) % (e(title), info, stats, chart_html, table)
    return layout(title, body, session, 'players')


def timeline_page(session, query):
    with db() as conn:
        rows = conn.execute('SELECT id, at, ip, action, name, score, status, note FROM events ORDER BY id').fetchall()
    events = [(ev, parse_time(ev['at'])) for ev in rows]
    events = [(ev, dt) for ev, dt in events if dt]
    if not events:
        return layout('時間軸', '<div class="card">還沒有任何紀錄</div>', session, 'timeline')

    # 依時間順序重播一次：每個人的最高分、全場最高分與第一名換人的時間點
    best_by_name, top, top_line, top_changes, marks = {}, None, [], [], {}
    uploads = []
    for ev, dt in events:
        if ev['action'] != 'score' or ev['status'] != 201:
            continue
        uploads.append((ev, dt))
        key = ev['name'].lower()
        if ev['score'] > best_by_name.get(key, -1):
            best_by_name[key] = ev['score']
            marks[ev['id']] = 'best'
        if top is None or ev['score'] > top[1]:
            if top is None or top[0].lower() != key:
                top_changes.append((dt, ev['name'], ev['score']))
            top = (ev['name'], ev['score'])
            top_line.append((dt, ev['score']))
            marks[ev['id']] = 'top'
    first, last = events[0][1], events[-1][1]

    # 每小時上傳次數
    activity = '<p class="muted">還沒有上傳</p>'
    if uploads:
        buckets = {}
        for ev, dt in uploads:
            bucket = buckets.setdefault(dt.replace(minute=0, second=0, microsecond=0), {'count': 0, 'names': set()})
            bucket['count'] += 1
            bucket['names'].add(ev['name'].lower())
        start = min(buckets)
        chart = Chart(start, max(buckets) + timedelta(hours=1), max(b['count'] for b in buckets.values()))
        bar_width = max(chart.x(start + timedelta(hours=1)) - chart.x(start) - 2, 1)
        for hour, bucket in sorted(buckets.items()):
            x, y = chart.x(hour) + 1, chart.y(bucket['count'])
            chart.parts.append(
                '<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" fill="%s" class="bar">'
                '<title>%s　上傳 %d 次・%d 位玩家</title></rect>' % (
                    x, y, bar_width, chart.top + chart.height - y, min(4, bar_width / 2), COLOR_UPLOAD,
                    e(hour.strftime('%m/%d %H:00～%H:59')), bucket['count'], len(bucket['names'])))
        busiest_hour, busiest = max(buckets.items(), key=lambda item: item[1]['count'])
        activity = chart.render('每小時上傳次數') + '<p class="muted">最熱鬧的時段：%s，上傳 %d 次、%d 位玩家。</p>' % (
            e(busiest_hour.strftime('%m/%d %H:00～%H:59')), busiest['count'], len(busiest['names']))

    # 全場最高分演進：第一名換人的點放大，滑鼠移上去看是誰
    top_html = '<p class="muted">還沒有上傳</p>'
    if top_line:
        chart = Chart(top_line[0][0], last, top_line[-1][1])
        chart.parts.append(step_path(chart, top_line, last))
        for dt, name, score in top_changes:
            chart.parts.append(dot(chart, dt, score, COLOR_BEST, '%s　%s 拿下第一名 (%d 分)' % (
                dt.strftime('%m/%d %H:%M:%S'), name, score), True))
        change_rows = ''.join(
            '<tr><td>%s</td><td>%s</td><td>%d</td></tr>' % (e(dt.strftime('%m/%d %H:%M:%S')), name_link(name), score)
            for dt, name, score in reversed(top_changes))
        top_html = chart.render('全場最高分演進') + (
            '<h3>第一名換人紀錄</h3><div class="table-wrap"><table><tr><th>時間</th><th>新的第一名</th><th>分數</th></tr>'
            '%s</table></div>' % change_rows)

    # 逐筆時間軸：一次看一天，預設最新的一天
    days = sorted({dt.date() for _, dt in events}, reverse=True)
    picked = query.get('date', [''])[0]
    day = next((d for d in days if d.isoformat() == picked), days[0])
    chips = ''.join('<a class="chip%s" href="/timeline?date=%s">%s (%s)</a>' % (
        ' on' if d == day else '', d.isoformat(), d.strftime('%m/%d'), WEEKDAYS[d.weekday()]) for d in days)
    items, current_hour, count = [], None, 0
    for ev, dt in reversed(events):
        if dt.date() != day:
            continue
        count += 1
        if dt.hour != current_hour:
            current_hour = dt.hour
            items.append('<li class="hour">%02d:00</li>' % dt.hour)
        mark = marks.get(ev['id'], '')
        if ev['action'] == 'score' and ev['status'] == 201:
            what = '上傳 <b>%d</b> 分' % ev['score']
        elif ev['action'] == 'claim':
            what = '登記暱稱' if ev['status'] == 200 else '想用這個暱稱，但已經有人用了'
        else:
            what = '後台：' + e(ev['note'])
        items.append('<li class="%s"><time>%s</time>%s<span>%s</span>%s</li>' % (
            mark or ev['action'], dt.strftime('%H:%M:%S'), name_link(ev['name']) if ev['name'] != '-' else '<span></span>',
            what, {'top': ' <span class="badge top">🏆 全場最高分</span>',
                   'best': ' <span class="badge">⭐ 個人新紀錄</span>'}.get(mark, '')))

    stats = ''.join('<div class="stat"><b>%s</b><span>%s</span></div>' % item for item in [
        (len(uploads), '總上傳次數'),
        (len(best_by_name), '有上傳的玩家'),
        ('%s 分' % top[1] if top else '—', '全場最高分' + ('（%s）' % e(top[0]) if top else '')),
        (e(first.strftime('%m/%d %H:%M')), '第一筆紀錄'),
        (e(last.strftime('%m/%d %H:%M')), '最新一筆紀錄'),
    ])
    body = (
        '<div class="stats" style="margin-bottom:16px" data-live="timeline-stats">%s</div>'
        '<div class="card" data-live="timeline-activity"><h2>每小時上傳次數</h2>%s</div>'
        '<div class="card" data-live="timeline-top"><h2>全場最高分演進</h2>%s</div>'
        '<div class="card" data-live="timeline-feed"><h2>逐筆時間軸</h2><div class="chips">%s</div>'
        '<p class="muted">這天共 %d 筆紀錄，最新在上。點暱稱可以看這個人的完整紀錄。</p><ul class="feed">%s</ul></div>'
    ) % (stats, activity, top_html, chips, count, ''.join(items))
    return layout('時間軸', body, session, 'timeline')


def delete_page(session, player_id):
    with db() as conn:
        p = conn.execute('SELECT id, name, score FROM players WHERE id = ?', (player_id,)).fetchone()
    if not p:
        return None
    body = (
        '<div class="card"><h2>確定要刪除「%s」嗎？</h2>'
        '<p>分數：%s。刪除後這個暱稱會從排行榜消失，其他人也可以重新登記。</p>'
        '<form method="post" action="/players/delete" class="row">%s<input type="hidden" name="id" value="%d">'
        '<button type="submit" class="danger">確定刪除</button><a class="button ghost" href="/">取消</a></form></div>'
    ) % (e(p['name']), e(p['score']) if p['score'] is not None else '未上傳', csrf_input(session), p['id'])
    return layout('刪除玩家', body, session, 'players')


def events_page(session, query):
    action = query.get('action', [''])[0]
    name = query.get('name', [''])[0].strip()
    try:
        before = int(query.get('before', ['0'])[0])
    except ValueError:
        before = 0

    where, params = [], []
    if action in ACTION_TEXT:
        where.append('action = ?')
        params.append(action)
    if name:
        where.append('name LIKE ?')
        params.append('%' + name + '%')
    if before > 0:
        where.append('id < ?')
        params.append(before)
    sql = 'SELECT id, at, ip, action, name, score, status, note, token FROM events'
    if where:
        sql += ' WHERE ' + ' AND '.join(where)
    sql += ' ORDER BY id DESC LIMIT ?'
    params.append(EVENTS_PAGE_SIZE)
    with db() as conn:
        events = conn.execute(sql, params).fetchall()

    options = '<option value="">全部動作</option>' + ''.join(
        '<option value="%s"%s>%s</option>' % (key, ' selected' if key == action else '', label)
        for key, label in ACTION_TEXT.items()
    )
    filters = (
        '<div class="card"><form method="get" action="/events" class="row">'
        '<select name="action">%s</select>'
        '<input type="text" name="name" value="%s" placeholder="搜尋暱稱">'
        '<button type="submit">篩選</button><a class="button ghost" href="/events">清除</a></form></div>'
    ) % (options, e(name))

    rows = ''.join(
        '<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>' % (
            e(fmt_time(ev['at'])), e(ev['ip']), '<code>%s</code>' % e(ev['token'][:8]) if ev['token'] else '',
            e(ACTION_TEXT.get(ev['action'], ev['action'])), name_link(ev['name']) if ev['name'] != '-' else '-',
            e(ev['score']) if ev['score'] is not None else '', e(status_text(ev['action'], ev['status'])),
            e(ev['note']),
        )
        for ev in events
    )
    more = ''
    if len(events) == EVENTS_PAGE_SIZE:
        next_query = {'before': events[-1]['id']}
        if action:
            next_query['action'] = action
        if name:
            next_query['name'] = name
        more = '<p><a class="button ghost" href="/events?%s">更早的紀錄 →</a></p>' % e(urlencode(next_query))
    table = (
        '<div class="card" data-live="events"><h2>上傳紀錄 (最新在上，最多保留 %d 筆，每 5 秒自動更新)</h2>'
        '<div class="table-wrap"><table>'
        '<tr><th>時間</th><th>IP</th><th>裝置</th><th>動作</th><th>暱稱</th><th>分數</th><th>結果</th><th>備註</th></tr>'
        '%s</table></div>%s</div>'
    ) % (lb.MAX_EVENTS, rows or '<tr><td colspan="8" class="muted">沒有紀錄</td></tr>', more)
    return layout('上傳紀錄', filters + table, session, 'events')


def backup_page(session):
    body = (
        '<div class="card"><h2>備份下載</h2><div class="row">'
        '<a class="button" href="/backup/scores.db">下載完整資料庫 (.db)</a>'
        '<a class="button ghost" href="/backup/players.csv">匯出排行榜 (CSV)</a>'
        '<a class="button ghost" href="/backup/events.csv">匯出上傳紀錄 (CSV)</a></div>'
        '<p class="muted">.db 是 SQLite 檔案，包含排行榜、上傳紀錄與設定，可以用 DB Browser for SQLite 開啟，'
        '也可以直接放回伺服器還原。CSV 可以用 Excel 開啟。</p></div>'
    )
    return layout('備份下載', body, session, 'backup')


def csv_bytes(header, rows):
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(header)
    writer.writerows(rows)
    return out.getvalue().encode('utf-8-sig')  # 加 BOM，Excel 才會用 UTF-8 開啟


# --- HTTP ---

class Handler(BaseHTTPRequestHandler):
    server_version = 'TcteAdmin/1.0'

    def client_ip(self):
        forwarded = self.headers.get('X-Forwarded-For')
        if forwarded and self.client_address[0] in ('127.0.0.1', '::1'):
            return forwarded.split(',')[-1].strip()
        return self.client_address[0]

    def session_id(self):
        for part in (self.headers.get('Cookie') or '').split(';'):
            key, _, value = part.strip().partition('=')
            if key == COOKIE_NAME:
                return value
        return ''

    def send_body(self, status, body, content_type='text/html; charset=utf-8', headers=None):
        data = body.encode('utf-8') if isinstance(body, str) else body
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy',
                         "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; "
                         "frame-ancestors 'none'; base-uri 'none'")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, location, cookie=None):
        self.send_response(303)
        self.send_header('Location', location)
        self.send_header('Content-Length', '0')
        self.send_header('Cache-Control', 'no-store')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()

    def cookie(self, value, max_age):
        return '%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Strict%s' % (
            COOKIE_NAME, value, max_age, '; Secure' if COOKIE_SECURE else '')

    def read_form(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return None
        if not 0 <= length <= MAX_FORM_BYTES:
            return None
        raw = self.rfile.read(length).decode('utf-8', errors='replace')
        return {k: v[0] for k, v in parse_qs(raw, keep_blank_values=True).items()}

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        session = get_session(self.session_id())

        if url.path == '/live.js':
            self.send_body(200, LIVE_JS, 'text/javascript; charset=utf-8')
            return
        if url.path == '/login':
            if session:
                self.redirect('/')
            else:
                self.send_body(200, login_page())
            return
        if not session:
            self.redirect('/login')
            return

        if url.path == '/':
            self.send_body(200, players_page(session, query))
        elif url.path == '/players/delete':
            try:
                page = delete_page(session, int(query.get('id', ['0'])[0]))
            except ValueError:
                page = None
            if page:
                self.send_body(200, page)
            else:
                self.redirect('/?msg=missing')
        elif url.path == '/player':
            page = player_page(session, query.get('name', [''])[0].strip())
            if page:
                self.send_body(200, page)
            else:
                self.redirect('/?msg=missing')
        elif url.path == '/timeline':
            self.send_body(200, timeline_page(session, query))
        elif url.path == '/events':
            self.send_body(200, events_page(session, query))
        elif url.path == '/backup':
            self.send_body(200, backup_page(session))
        elif url.path.startswith('/backup/'):
            self.send_backup(url.path)
        else:
            self.send_body(404, layout('找不到頁面', '<div class="card">找不到這個頁面</div>', session))

    def send_backup(self, path):
        stamp = datetime.now(lb.TAIPEI).strftime('%Y%m%d-%H%M%S')
        with db() as conn:
            if path == '/backup/scores.db':
                memory = sqlite3.connect(':memory:')
                conn.backup(memory)
                data, name, kind = memory.serialize(), 'tcte-scores-%s.db' % stamp, 'application/vnd.sqlite3'
                memory.close()
            elif path == '/backup/players.csv':
                rows = [
                    (name, score, bound, csv_time(created), csv_time(updated))
                    for name, score, bound, created, updated in conn.execute(
                        "SELECT name, score, CASE WHEN token IS NULL THEN '' ELSE '是' END, created_at, updated_at"
                        ' FROM players ORDER BY score IS NULL, score DESC, updated_at'
                    )
                ]
                data = csv_bytes(['暱稱', '分數', '已綁定裝置', '登記時間', '最後更新'], rows)
                name, kind = 'tcte-players-%s.csv' % stamp, 'text/csv; charset=utf-8'
            elif path == '/backup/events.csv':
                rows = [
                    (csv_time(at), ip, token or '', ACTION_TEXT.get(action, action), name, score,
                     status_text(action, status), note)
                    for at, ip, action, name, score, status, note, token in conn.execute(
                        'SELECT at, ip, action, name, score, status, note, token FROM events ORDER BY id'
                    )
                ]
                data = csv_bytes(['時間', 'IP', '裝置', '動作', '暱稱', '分數', '結果', '備註'], rows)
                name, kind = 'tcte-events-%s.csv' % stamp, 'text/csv; charset=utf-8'
            else:
                self.send_body(404, 'not found', 'text/plain; charset=utf-8')
                return
        self.send_body(200, data, kind, {'Content-Disposition': "attachment; filename*=UTF-8''%s" % quote(name)})

    def do_POST(self):
        path = urlparse(self.path).path
        ip = self.client_ip()
        form = self.read_form()
        if form is None:
            self.send_body(400, '資料格式不正確', 'text/plain; charset=utf-8')
            return

        if path == '/login':
            if too_many_fails(ip):
                self.send_body(429, login_page('輸錯太多次了，請 10 分鐘後再試'))
                return
            user_ok = hmac.compare_digest(form.get('user', ''), ADMIN_USER)
            password_ok = bool(ADMIN_PASSWORD_HASH) and check_password(form.get('password', ''), ADMIN_PASSWORD_HASH)
            if user_ok and password_ok:
                self.redirect('/', self.cookie(new_session(), SESSION_SECONDS))
            else:
                record_fail(ip)
                self.send_body(401, login_page('帳號或密碼錯誤'))
            return

        sid = self.session_id()
        session = get_session(sid)
        if not session or not hmac.compare_digest(form.get('csrf', ''), session['csrf']):
            self.redirect('/login')
            return

        if path == '/logout':
            with sessions_lock:
                sessions.pop(sid, None)
            self.redirect('/login', self.cookie('', 0))
            return

        if path == '/settings/open-dates':
            dates = lb.parse_dates(form.get('dates', ''))
            if dates is None:
                self.redirect('/?msg=bad-dates')
                return
            text = ','.join('%02d-%02d' % d for d in dates)
            with lb.db_lock, db() as conn:
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('open_dates', ?)", (text,))
                log_admin(conn, ip, '-', '開放日期改為 %s' % (text or '(不開放)'))
            self.redirect('/?msg=dates')
            return

        if path not in ('/players/score', '/players/unbind', '/players/delete'):
            self.send_body(404, layout('找不到頁面', '<div class="card">找不到這個頁面</div>', session))
            return
        try:
            player_id = int(form.get('id', ''))
        except ValueError:
            self.redirect('/?msg=missing')
            return

        with lb.db_lock, db() as conn:
            player = conn.execute('SELECT name, score FROM players WHERE id = ?', (player_id,)).fetchone()
            if not player:
                self.redirect('/?msg=missing')
                return
            if path == '/players/score':
                raw = form.get('score', '').strip()
                try:
                    score = int(raw) if raw else None
                except ValueError:
                    score = -1
                if score is not None and not 0 <= score <= lb.MAX_SCORE:
                    self.redirect('/?msg=bad-score')
                    return
                conn.execute('UPDATE players SET score = ?, updated_at = ? WHERE id = ?',
                             (score, lb.now_text(), player_id))
                log_admin(conn, ip, player['name'], '分數 %s → %s' % (score_text(player['score']), score_text(score)))
                msg = 'score'
            elif path == '/players/unbind':
                conn.execute('UPDATE players SET token = NULL WHERE id = ?', (player_id,))
                log_admin(conn, ip, player['name'], '解除裝置綁定')
                msg = 'unbind'
            else:
                conn.execute('DELETE FROM players WHERE id = ?', (player_id,))
                log_admin(conn, ip, player['name'], '刪除玩家 (分數 %s)' % score_text(player['score']))
                msg = 'deleted'
        self.redirect('/?msg=' + msg)

    def log_message(self, fmt, *args):
        print('%s - %s' % (self.client_ip(), fmt % args), flush=True)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'hash-password':
        password = sys.stdin.readline().rstrip('\n')
        if not password:
            sys.exit('請從標準輸入提供密碼')
        print(hash_password(password))
        return
    if not ADMIN_PASSWORD_HASH:
        sys.exit('請先設定 ADMIN_PASSWORD_HASH (用 python3 admin.py hash-password 產生)')
    lb.init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('Admin listening on http://%s:%d (db: %s)' % (HOST, PORT, lb.DB_PATH), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
