/*
    TCTE Countdown  Copyright (C) 2025  mykevinjjw

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/
// --- 遊戲網站 (games.mykevin.dpdns.org) 與統測倒數網頁共用：排行榜 API、玩家暱稱與裝置識別碼 ---
(function ($) {

    // 排行榜 API (自架於 OCI A1，見 leaderboard-server/)
    // 本機測試時可以在載入前設定 window.TCTE_API_URL 改用測試伺服器
    const API_URL = (window.TCTE_API_URL || 'https://tcte-lb.kevinjja.dpdns.org').replace(/\/$/, '');
    const BEST_KEY = 'tcte-birthday-game-best';
    const NAME_KEY = 'tcte-birthday-game-name';
    const TOKEN_KEY = 'tcte-birthday-game-token';
    // 兩個網站的 localStorage 不互通，連結之間用網址 # 後面帶暱稱與識別碼 (# 後面不會送到伺服器)
    const HASH_KEY = 'player';

    function storageGet(key) {
        try {
            return localStorage.getItem(key) || '';
        } catch (e) {
            return '';
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {
            // 無法儲存時只在這次開啟頁面有效
        }
    }

    function readBest() {
        return parseInt(storageGet(BEST_KEY), 10) || 0;
    }

    function saveBest(score) {
        storageSet(BEST_KEY, String(score));
    }

    // 本裝置填過的暱稱，下次開啟就不用再填
    function readName() {
        return storageGet(NAME_KEY);
    }

    function saveName(name) {
        storageSet(NAME_KEY, name);
    }

    function validToken(token) {
        return /^[0-9a-f]{32}$/.test(token);
    }

    // 本裝置的隨機識別碼：暱稱屬於第一個登記它的裝置，其他裝置不能再用
    let deviceToken = '';
    function getToken() {
        if (deviceToken) {
            return deviceToken;
        }
        deviceToken = storageGet(TOKEN_KEY);
        if (!validToken(deviceToken)) {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            deviceToken = Array.prototype.map.call(bytes, function (b) {
                return ('0' + b.toString(16)).slice(-2);
            }).join('');
            storageSet(TOKEN_KEY, deviceToken);
        }
        return deviceToken;
    }

    // 把這台裝置的身分加在連結後面，帶到另一個網站
    function linkWithIdentity(url) {
        const name = readName();
        if (!name) {
            return url;
        }
        return url.split('#')[0] + '#' + HASH_KEY + '=' + encodeURIComponent(name) + ',' + getToken();
    }

    // 從網址帶過來的身分：這個網站還沒有暱稱時才採用，然後把網址上的 # 拿掉
    function importIdentity() {
        const match = location.hash.match(new RegExp('^#' + HASH_KEY + '=([^,]+),([0-9a-f]{32})$'));
        if (!match) {
            return;
        }
        if (!readName()) {
            let name = '';
            try {
                name = decodeURIComponent(match[1]);
            } catch (e) {
                name = '';
            }
            if (name) {
                saveName(name);
                storageSet(TOKEN_KEY, match[2]);
                deviceToken = '';
            }
        }
        try {
            history.replaceState(null, '', location.pathname + location.search);
        } catch (e) {
            location.hash = '';
        }
    }
    importIdentity();

    function request(path, options) {
        return fetch(API_URL + path, options).then(function (res) {
            if (res.ok) {
                return res.json();
            }
            // 伺服器會在 error 欄位回傳中文錯誤訊息 (例如：遊戲沒開放、上傳太頻繁)
            return res.json().catch(function () {
                return {};
            }).then(function (body) {
                throw new Error(body.error || '上傳失敗，請再試一次');
            });
        });
    }

    function postJson(path, data) {
        return request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
    }

    const LEADERBOARD_SIZE = 100; // 伺服器最多回傳 100 位

    // closed：遊戲沒開放時不用叫大家來搶第一
    function renderLeaderboard(container, highlight, closed) {
        // 定時刷新時保留舊的名單，避免閃爍
        if (container.is(':empty')) {
            container.html('<p class="bday-lb-status">讀取排行榜中…</p>');
        }
        return request('/scores?limit=' + LEADERBOARD_SIZE).then(function (rows) {
            if (rows.length === 0) {
                container.html('<p class="bday-lb-status">' +
                    (closed ? '還沒有人上榜' : '還沒有人上榜，快來搶第一！') + '</p>');
                return;
            }
            const list = $('<ol class="bday-lb-list"></ol>');
            let rank = 0;
            rows.forEach(function (row, i) {
                // 同分同名次，下一個分數接著排不跳號 (例如 1、2、2、2、3)
                if (i === 0 || row.score !== rows[i - 1].score) {
                    rank += 1;
                }
                const item = $('<li></li>');
                $('<span class="bday-lb-rank"></span>').text(['🥇', '🥈', '🥉'][rank - 1] || rank).appendTo(item);
                $('<span class="bday-lb-name"></span>').text(row.name).appendTo(item);
                $('<span class="bday-lb-score"></span>').text(row.score).appendTo(item);
                // 暱稱不分大小寫不會重複，用暱稱找自己那一列
                if (highlight && row.name.toLowerCase() === highlight.name.toLowerCase()) {
                    item.addClass('me');
                }
                list.append(item);
            });
            container.empty().append(list);
        }).catch(function () {
            if (container.find('.bday-lb-list').length) {
                return;
            }
            container.html('<p class="bday-lb-status">排行榜暫時連不上，等等再試試</p>');
        });
    }

    window.TcteGames = {
        GAMES_URL: 'https://games.mykevin.dpdns.org/',
        COUNTDOWN_URL: 'https://mykevinjjw.github.io/tcte/',
        request: request,
        postJson: postJson,
        readBest: readBest,
        saveBest: saveBest,
        readName: readName,
        saveName: saveName,
        getToken: getToken,
        linkWithIdentity: linkWithIdentity,
        renderLeaderboard: renderLeaderboard
    };

})(jQuery);
