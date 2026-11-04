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
// --- 生日限定小遊戲：幼兒園照顧大作戰 (11/3~11/4 由生日彩蛋開啟) ---
(function ($) {

    const GAME_SECONDS = 60;
    const MAX_HEARTS = 3;
    const BEST_KEY = 'tcte-birthday-game-best';
    const NAME_KEY = 'tcte-birthday-game-name';
    const TOKEN_KEY = 'tcte-birthday-game-token';

    // --- 線上排行榜 (自架於 OCI A1，見 leaderboard-server/) ---
    // 留空時排行榜會自動隱藏；GitHub Pages 是 HTTPS，所以 API 也必須是 HTTPS
    const LEADERBOARD_URL = 'https://tcte-lb.kevinjja.dpdns.org';
    const LEADERBOARD_SIZE = 100; // 排行榜顯示全部玩家 (伺服器最多回傳 100 位)

    // emoji 沒有尿布，自己畫一個 (大小跟 emoji 一樣是 1em)
    const DIAPER_ICON =
        '<svg class="bday-icon" viewBox="0 0 64 64" aria-hidden="true">' +
        '<path d="M5 12 H59 V22 C59 30 52 33 46 38 C41 42 40 52 32 52 C24 52 23 42 18 38 C12 33 5 30 5 22 Z"' +
        ' fill="#ffffff" stroke="#1e88e5" stroke-width="3.5" stroke-linejoin="round"/>' +
        '<path d="M5 12 H59 V20 H5 Z" fill="#90caf9" stroke="#1e88e5" stroke-width="3.5" stroke-linejoin="round"/>' +
        '<path d="M2 14 H12 V22 H2 Z M52 14 H62 V22 H52 Z" fill="#ffca28" stroke="#f57f17" stroke-width="2" stroke-linejoin="round"/>' +
        '<path d="M32 27 C29 24 25 26 26.5 29.5 L32 35 L37.5 29.5 C39 26 35 24 32 27 Z" fill="#ec407a"/>' +
        '</svg>';

    // 小朋友的需求與對應的照顧工具 (tool 可以是 emoji 或 SVG)
    const needs = [
        { face: '🤤', text: '肚子餓', tool: '🍼', label: '奶瓶' },
        { face: '😭', text: '哭哭了', tool: '🧸', label: '抱抱熊' },
        { face: '🥱', text: '想睡覺', tool: '📖', label: '說故事' },
        { face: '💩', text: '換尿布', tool: DIAPER_ICON, label: '尿布' },
        { face: '🤕', text: '跌倒了', tool: '🩹', label: 'OK 繃' }
    ];
    const kids = [
        { name: '小明', face: '👦' },
        { name: '小美', face: '👧' },
        { name: '阿寶', face: '👶' },
        { name: '妞妞', face: '👧' },
        { name: '小胖', face: '👦' },
        { name: '樂樂', face: '👶' }
    ];

    let state = null;
    let tickTimer = null;
    let playerName = '';

    function readBest() {
        try {
            return parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
        } catch (e) {
            return 0;
        }
    }

    function saveBest(score) {
        try {
            localStorage.setItem(BEST_KEY, String(score));
        } catch (e) {
            // 無法儲存時就不記錄最高分
        }
    }

    // 本裝置填過的暱稱，下次開啟就不用再填
    function readName() {
        try {
            return localStorage.getItem(NAME_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    function saveName(name) {
        try {
            localStorage.setItem(NAME_KEY, name);
        } catch (e) {
            // 無法儲存時下次就重新輸入暱稱
        }
    }

    // 本裝置的隨機識別碼：暱稱屬於第一個登記它的裝置，其他裝置不能再用
    let deviceToken = '';
    function getDeviceToken() {
        if (deviceToken) {
            return deviceToken;
        }
        try {
            deviceToken = localStorage.getItem(TOKEN_KEY) || '';
        } catch (e) {
            deviceToken = '';
        }
        if (!/^[0-9a-f]{32}$/.test(deviceToken)) {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            deviceToken = Array.prototype.map.call(bytes, function (b) {
                return ('0' + b.toString(16)).slice(-2);
            }).join('');
            try {
                localStorage.setItem(TOKEN_KEY, deviceToken);
            } catch (e) {
                // 無法儲存時只在這次開啟頁面有效
            }
        }
        return deviceToken;
    }

    function leaderboardEnabled() {
        return LEADERBOARD_URL !== '';
    }

    function leaderboardRequest(path, options) {
        return fetch(LEADERBOARD_URL.replace(/\/$/, '') + path, options).then(function (res) {
            if (res.ok) {
                return res.json();
            }
            // 伺服器會在 error 欄位回傳中文錯誤訊息 (例如：今天不是生日、上傳太頻繁)
            return res.json().catch(function () {
                return {};
            }).then(function (body) {
                throw new Error(body.error || '上傳失敗，請再試一次');
            });
        });
    }

    // --- 伺服器上的開放狀態 (開放日期由管理後台設定) ---
    const STATUS_REFRESH_MS = 60000;
    let serverOpen = null; // null：還沒查到，main.js 會改用預設日期
    let surveyOpen = false; // 遊戲結束後的小問卷 (後台可以關閉)

    function refreshStatus() {
        if (!leaderboardEnabled()) {
            return;
        }
        leaderboardRequest('/status').then(function (status) {
            serverOpen = status.open === true;
            surveyOpen = status.survey === true;
            updateSurveyButton();
        }).catch(function () {
            // 查不到就維持上一次的結果
        });
    }

    window.isBirthdayGameOpen = function () {
        return serverOpen;
    };
    refreshStatus();
    setInterval(refreshStatus, STATUS_REFRESH_MS);

    function fetchTopScores() {
        return leaderboardRequest('/scores?limit=' + LEADERBOARD_SIZE);
    }

    // 登記暱稱；已被其他裝置使用時會失敗並回傳錯誤訊息
    function claimName(name) {
        return leaderboardRequest('/names', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, token: getDeviceToken() })
        });
    }

    // 同一個暱稱只保留最高分，回傳 { rank: 名次, best: 最高分 }
    function submitScore(name, score) {
        return leaderboardRequest('/scores', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, score: score, token: getDeviceToken() })
        });
    }

    // 以伺服器上的最高分為準 (管理後台可能改過或刪除)，同步回本機並更新畫面上的「最高分」
    function syncBest() {
        if (!leaderboardEnabled() || !playerName) {
            return;
        }
        const name = playerName;
        leaderboardRequest('/best?name=' + encodeURIComponent(name)).then(function (result) {
            if (name !== playerName) {
                return;
            }
            const best = result.best || 0;
            saveBest(best);
            // 遊戲結果畫面由上傳結果更新，這裡只更新開場畫面
            $('#bday-overlay .bday-best.intro').text(best > 0 ? '🏆 最高分：' + best : '').toggle(best > 0);
        }).catch(function () {
            // 連不上時沿用本機紀錄
        });
    }

    function renderLeaderboard(container, highlight) {
        // 定時刷新時保留舊的名單，避免閃爍
        if (container.is(':empty')) {
            container.html('<p class="bday-lb-status">讀取排行榜中…</p>');
        }
        fetchTopScores().then(function (rows) {
            if (rows.length === 0) {
                container.html('<p class="bday-lb-status">' +
                    (serverOpen === false ? '還沒有人上榜' : '還沒有人上榜，快來搶第一！') + '</p>');
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

    function showLeaderboard(highlight, message) {
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">🏆 排行榜</p>' +
            '<p class="bday-lb-message"></p>' +
            '<div class="bday-lb"></div>' +
            '<button type="button" class="bday-start">' + (state ? '再玩一次 ↻' : '開始上課 ▶') + '</button>' +
            '</div>'
        ).css('display', 'flex');
        $('#bday-overlay .bday-lb-message').text(message || '').toggle(!!message);
        renderLeaderboard($('#bday-overlay .bday-lb'), highlight);
    }

    // 開場畫面的暱稱區：已記住暱稱時只顯示名字與「更改」，否則顯示輸入框
    function renderNameRow(editing) {
        const row = $('#bday-overlay .bday-name-row');
        if (!editing && playerName) {
            row.html('<span class="bday-name-current">👩‍🏫 <b></b> 老師</span>' +
                '<button type="button" class="bday-name-edit">更改暱稱</button>');
            row.find('b').text(playerName);
            return;
        }
        row.html('<input type="text" class="bday-name" maxlength="12" placeholder="輸入你的暱稱">');
        row.find('.bday-name').val(playerName);
        if (editing) {
            row.find('.bday-name').trigger('focus').trigger('select');
        }
    }

    // 開始按鈕：沒記住暱稱時要先填並檢查是否重複，之後「再玩一次」沿用同一個暱稱
    let checkingName = false;
    function handleStart() {
        const input = $('#bday-overlay .bday-name');
        if (!input.length) {
            if (playerName) {
                startGame();
            } else {
                showIntro();
            }
            return;
        }

        const msg = $('#bday-overlay .bday-submit-msg');
        const name = $.trim(input.val());
        if (!name) {
            msg.text('先輸入暱稱才能開始喔！');
            input.focus();
            return;
        }
        if (!leaderboardEnabled()) {
            playerName = name;
            saveName(name);
            startGame();
            return;
        }
        if (checkingName) {
            return;
        }
        checkingName = true;
        $('#bday-overlay .bday-start').prop('disabled', true);
        msg.removeClass('ok').text('檢查暱稱中…');
        claimName(name).then(function () {
            playerName = name;
            saveName(name);
            syncBest();
            startGame();
        }).catch(function (err) {
            msg.text(err instanceof TypeError ? '連不上排行榜，請稍後再試' : err.message);
            input.trigger('focus').trigger('select');
        }).then(function () {
            checkingName = false;
            $('#bday-overlay .bday-start').prop('disabled', false);
        });
    }

    // 遊戲結束時自動上傳分數，失敗時顯示「重新上傳」
    function uploadScore() {
        const button = $('#bday-overlay .bday-submit-btn');
        const msg = $('#bday-overlay .bday-submit-msg');
        if (state.submitted) {
            return;
        }
        state.submitted = true;
        button.hide();
        msg.removeClass('ok').text('上傳分數中…');

        const name = playerName;
        const score = state.score;
        submitScore(name, score).then(function (result) {
            state.lastSubmitted = { name: name, score: result.best };
            panelHighlight = state.lastSubmitted;
            refreshPanel();
            saveBest(result.best);
            let bestText = '🏆 最高分：' + result.best;
            if (result.best === score && score > state.previousBest) {
                bestText = '🏆 新紀錄！';
            }
            $('#bday-overlay .bday-best').text(bestText);
            msg.addClass('ok').text(result.best > score ?
                '上傳成功！最佳成績 ' + result.best + ' 分，第 ' + result.rank + ' 名' :
                '上傳成功！你是第 ' + result.rank + ' 名 🎉');
        }).catch(function (err) {
            state.submitted = false;
            button.show();
            msg.text(err instanceof TypeError ? '連不上排行榜，請稍後再試' : err.message);
        });
    }

    // 依遊戲進度 (0~1) 在兩個數值間取值，越後面越快
    function lerp(from, to, progress) {
        return from + (to - from) * progress;
    }

    function buildModal() {
        if ($('#bday-game').length) {
            return;
        }

        let kidsHtml = '';
        kids.forEach(function (kid, i) {
            kidsHtml +=
                '<button type="button" class="bday-kid" data-index="' + i + '">' +
                '<span class="bday-kid-bubble"></span>' +
                '<span class="bday-kid-face">' + kid.face + '</span>' +
                '<span class="bday-kid-name">' + kid.name + '</span>' +
                '<span class="bday-kid-timer"><i></i></span>' +
                '</button>';
        });

        let toolsHtml = '';
        needs.forEach(function (need, i) {
            toolsHtml +=
                '<button type="button" class="bday-tool" data-index="' + i + '">' +
                '<span class="bday-tool-icon">' + need.tool + '</span>' +
                '<span class="bday-tool-label">' + need.label + '</span>' +
                '</button>';
        });

        $('body').append(
            '<div id="bday-game" class="bday-game">' +
            '<div class="bday-game-panel">' +
            '<button type="button" class="bday-game-close" title="關閉">✕</button>' +
            '<h2 class="bday-game-title">🎂 幼兒園照顧大作戰</h2>' +
            '<div class="bday-game-hud">' +
            '<span>⏱ <b id="bday-time">' + GAME_SECONDS + '</b></span>' +
            '<span>⭐ <b id="bday-score">0</b></span>' +
            '<span id="bday-hearts"></span>' +
            '<span id="bday-combo" class="bday-combo"></span>' +
            '</div>' +
            '<div class="bday-game-stage">' +
            '<div class="bday-kids">' + kidsHtml + '</div>' +
            '</div>' +
            '<div class="bday-tools">' + toolsHtml + '</div>' +
            '<p class="bday-hint">先選照顧工具，再點需要幫忙的小朋友（鍵盤 1~5 也能選工具）</p>' +
            '<div id="bday-overlay" class="bday-overlay"></div>' +
            '</div>' +
            '</div>'
        );

        const game = $('#bday-game');
        game.on('click', '.bday-game-close', closeGame);
        game.on('click', '.bday-tool', function () {
            selectTool(parseInt($(this).data('index'), 10));
        });
        game.on('click', '.bday-kid', function () {
            careKid(parseInt($(this).data('index'), 10));
        });
        game.on('click', '.bday-start', handleStart);
        game.on('click', '.bday-lb-btn', function () {
            showLeaderboard(state ? state.lastSubmitted : null);
        });
        game.on('click', '.bday-submit-btn', uploadScore);
        game.on('click', '.bday-name-edit', function () {
            renderNameRow(true);
        });
        game.on('keydown', '.bday-name', function (e) {
            if (e.key === 'Enter') {
                handleStart();
            }
        });
        // 點背景關閉
        game.on('click', function (e) {
            if (e.target === this) {
                closeGame();
            }
        });

        $(document).on('keydown.bdayGame', function (e) {
            if (!$('#bday-game').hasClass('open')) {
                return;
            }
            if (e.key === 'Escape') {
                closeGame();
            } else if ($(e.target).is('input')) {
                // 輸入名字時不切換工具
            } else if (e.key >= '1' && e.key <= String(needs.length)) {
                selectTool(parseInt(e.key, 10) - 1);
            }
        });
    }

    function showIntro() {
        const best = readBest();
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">🎉 11/4 是避雷針的生日！</p>' +
            '<p>身為未來的幼保老師，今天要獨自照顧整班小朋友！</p>' +
            '<ul class="bday-rules">' +
            needs.map(function (need) {
                return '<li>' + need.face + ' ' + need.text + ' → ' + need.tool + ' ' + need.label + '</li>';
            }).join('') +
            '</ul>' +
            '<p>沒有及時照顧，家長滿意度 ❤️ 就會下降，連續照顧對了還有加分！</p>' +
            '<p class="bday-best intro"' + (best > 0 ? '>🏆 最高分：' + best : ' style="display:none">') + '</p>' +
            '<div class="bday-submit bday-name-row"></div>' +
            '<p class="bday-submit-msg"></p>' +
            '<button type="button" class="bday-start">開始上課 ▶</button>' +
            (leaderboardEnabled() ? '<button type="button" class="bday-lb-btn">🏆 排行榜</button>' : '') +
            '</div>'
        ).css('display', 'flex');
        renderNameRow(false);
        syncBest();
    }

    function startGame() {
        const now = performance.now();
        state = {
            running: true,
            score: 0,
            combo: 0,
            hearts: MAX_HEARTS,
            startAt: now,
            endAt: now + GAME_SECONDS * 1000,
            nextSpawnAt: now + 400,
            selectedTool: state ? state.selectedTool : 0,
            kids: kids.map(function () {
                return { need: null, since: 0, deadline: 0, moodUntil: 0, moodFace: '' };
            })
        };
        $('#bday-overlay').hide().empty();
        selectTool(state.selectedTool);
        renderHud();
        kids.forEach(function (kid, i) {
            renderKid(i, now);
        });
        clearInterval(tickTimer);
        tickTimer = setInterval(tick, 100);
    }

    function tick() {
        const now = performance.now();
        if (now >= state.endAt) {
            endGame();
            return;
        }
        const progress = (now - state.startAt) / (GAME_SECONDS * 1000);

        state.kids.forEach(function (kid, i) {
            if (state.running && kid.need !== null && now >= kid.deadline) {
                missKid(i, now);
            }
        });
        if (!state.running) {
            return;
        }

        // 產生新的需求：時間越後面越頻繁、等待時間越短
        if (now >= state.nextSpawnAt) {
            const free = [];
            state.kids.forEach(function (kid, i) {
                if (kid.need === null && now >= kid.moodUntil) {
                    free.push(i);
                }
            });
            if (free.length > 0) {
                const kid = state.kids[free[Math.floor(Math.random() * free.length)]];
                kid.need = Math.floor(Math.random() * needs.length);
                kid.since = now;
                kid.deadline = now + lerp(6000, 3500, progress);
            }
            state.nextSpawnAt = now + lerp(1700, 750, progress);
        }

        state.kids.forEach(function (kid, i) {
            renderKid(i, now);
        });
        $('#bday-time').text(Math.ceil((state.endAt - now) / 1000));
    }

    function selectTool(index) {
        if (state) {
            state.selectedTool = index;
        }
        $('.bday-tool').removeClass('selected').eq(index).addClass('selected');
    }

    function careKid(index) {
        if (!state || !state.running) {
            return;
        }
        const now = performance.now();
        const kid = state.kids[index];
        if (kid.need === null) {
            return;
        }

        if (kid.need === state.selectedTool) {
            state.combo++;
            const gain = 10 + Math.min(state.combo - 1, 5) * 2;
            state.score += gain;
            kid.need = null;
            kid.moodFace = '🥰';
            kid.moodUntil = now + 900;
            floatText(index, '+' + gain, 'good');
        } else {
            state.combo = 0;
            floatText(index, '不是這個！', 'bad');
            const el = $('.bday-kid').eq(index);
            el.removeClass('shake');
            el[0].offsetWidth; // 強制重繪以重新啟動動畫
            el.addClass('shake');
        }
        renderKid(index, now);
        renderHud();
    }

    function missKid(index, now) {
        const kid = state.kids[index];
        kid.need = null;
        kid.moodFace = '😤';
        kid.moodUntil = now + 1200;
        state.combo = 0;
        state.hearts--;
        floatText(index, '💔', 'bad');
        renderKid(index, now);
        renderHud();
        if (state.hearts <= 0) {
            endGame();
        }
    }

    function renderKid(index, now) {
        const kid = state.kids[index];
        const el = $('.bday-kid').eq(index);
        const bubble = el.find('.bday-kid-bubble');
        const face = el.find('.bday-kid-face');
        const bar = el.find('.bday-kid-timer i');

        if (kid.need !== null) {
            const need = needs[kid.need];
            const left = Math.max(0, (kid.deadline - now) / (kid.deadline - kid.since));
            el.addClass('needy');
            face.text(need.face);
            bubble.text(need.text).show();
            bar.css('width', (left * 100) + '%').toggleClass('urgent', left < 0.35);
        } else {
            el.removeClass('needy');
            face.text(now < kid.moodUntil ? kid.moodFace : kids[index].face);
            bubble.hide();
            bar.css('width', '0');
        }
    }

    function renderHud() {
        $('#bday-score').text(state.score);
        $('#bday-hearts').text('❤️'.repeat(state.hearts) + '🤍'.repeat(MAX_HEARTS - state.hearts));
        $('#bday-combo').text(state.combo >= 2 ? '連擊 x' + state.combo : '');
    }

    function floatText(index, text, kind) {
        const el = $('.bday-kid').eq(index);
        const tip = $('<span class="bday-float ' + kind + '"></span>').text(text).appendTo(el);
        setTimeout(function () {
            tip.remove();
        }, 900);
    }

    function getRating(score) {
        if (score >= 450) return '👑 傳說中的園長';
        if (score >= 300) return '🥇 金牌幼保老師';
        if (score >= 150) return '🌟 幼保新星';
        return '🌱 實習小老師';
    }

    function endGame() {
        state.running = false;
        clearInterval(tickTimer);

        const best = readBest();
        const isNewBest = state.score > best;
        state.previousBest = best;
        if (isNewBest) {
            saveBest(state.score);
        }

        const reason = state.hearts <= 0 ? '家長滿意度用完了…' : '放學囉！';
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-player"></p>' +
            '<p class="bday-overlay-big">⭐ ' + state.score + ' 分</p>' +
            '<p class="bday-rating">' + getRating(state.score) + '</p>' +
            '<p class="bday-best">' + (isNewBest ? '🏆 新紀錄！' : '🏆 最高分：' + best) + '</p>' +
            '<p>🎂 祝避雷針生日快樂！ 💖</p>' +
            (leaderboardEnabled() && state.score > 0 ?
                '<div class="bday-submit">' +
                '<span class="bday-submit-msg"></span>' +
                '<button type="button" class="bday-submit-btn">重新上傳</button>' +
                '</div>' : '') +
            '<button type="button" class="bday-start">再玩一次 ↻</button>' +
            (leaderboardEnabled() ? '<button type="button" class="bday-lb-btn">🏆 排行榜</button>' : '') +
            '</div>'
        ).css('display', 'flex');
        // 暱稱是玩家輸入的，用 text() 避免被當成 HTML
        $('#bday-overlay .bday-player').text(playerName + ' 老師，' + reason);

        if (leaderboardEnabled() && state.score > 0) {
            uploadScore();
        }
    }

    function closeGame() {
        clearInterval(tickTimer);
        if (state) {
            state.running = false;
        }
        $('#bday-game').removeClass('open');
    }

    // --- 頁面旁固定的排行榜 (開放期間由 main.js 開啟) ---
    const PANEL_REFRESH_MS = 5000;
    const PANEL_CLOSED_REFRESH_MS = 60000; // 遊戲沒開放時，分數只有後台會改
    let panelTimer = null;
    let panelHighlight = null;

    const PANEL_SIDE_GAP = 20; // 固定在頁面旁時，面板與倒數卡片之間至少要留的空間
    let placeTimer = null;

    function refreshPanel() {
        placePanel();
        updateSurveyButton();
        const list = $('#bday-lb-panel .bday-lb');
        // 分頁在背景時不更新，切回來時馬上更新
        if (list.length && !document.hidden) {
            renderLeaderboard(list, panelHighlight);
        }
    }

    // 旁邊放得下就固定在左側，放不下就移進倒數卡片裡 (生日橫幅下面)，避免擋住按鈕
    function placePanel() {
        const panel = $('#bday-lb-panel');
        const content = $('.content');
        if (!panel.length || !content.length) {
            return;
        }
        // 面板固定在左側時右邊緣的位置 (left 20px + 寬度 230px + 左右內距 28px)
        const sideRight = 20 + 230 + 28;
        const side = content[0].getBoundingClientRect().left >= sideRight + PANEL_SIDE_GAP;
        if (side && panel.hasClass('inline')) {
            panel.removeClass('inline').appendTo('body');
        } else if (!side && !panel.hasClass('inline')) {
            panel.addClass('inline').appendTo(content);
        }
    }

    // open：小遊戲是否開放中。沒開放時排行榜照樣顯示 (標上已結束)，只是不用那麼常更新
    window.showBirthdayLeaderboard = function (open) {
        if (!leaderboardEnabled()) {
            return;
        }
        let panel = $('#bday-lb-panel');
        if (!panel.length) {
            panel = $(
                '<aside id="bday-lb-panel" class="bday-lb-panel">' +
                '<button type="button" class="bday-lb-panel-toggle"></button>' +
                '<div class="bday-lb"></div>' +
                '</aside>'
            );
            panel.on('click', '.bday-lb-panel-toggle', function () {
                panel.toggleClass('collapsed');
            });
            panel.on('click', '.bday-survey-btn', openSurvey);
            $('body').append(panel);
            placePanel();
            refreshPanel();
            $(document).on('visibilitychange.bdayPanel', refreshPanel);
            // 視窗大小改變時，等版面穩定後再決定位置
            $(window).on('resize.bdayPanel', function () {
                clearTimeout(placeTimer);
                placeTimer = setTimeout(placePanel, 150);
            });
        }
        panel.find('.bday-lb-panel-toggle').text(open ? '🏆 生日排行榜' : '🏆 生日排行榜 (已結束)');
        clearInterval(panelTimer);
        panelTimer = setInterval(refreshPanel, open ? PANEL_REFRESH_MS : PANEL_CLOSED_REFRESH_MS);
    };

    window.hideBirthdayLeaderboard = function () {
        clearInterval(panelTimer);
        $(document).off('visibilitychange.bdayPanel');
        $(window).off('resize.bdayPanel');
        clearTimeout(placeTimer);
        $('#bday-lb-panel').remove();
    };

    // --- 遊戲結束後的小問卷 (選項要和伺服器 server.py 的 SURVEY_* 一致) ---
    const SURVEY_AGAIN = ['想', '看心情', '不想'];
    const SURVEY_GIFTS = ['零食', '福利社兌換券', '文具', '電子獎狀', '都可以'];
    const SURVEY_TEXT_LENGTH = 200;
    const SURVEY_OTHER_LENGTH = 30;
    const SURVEY_CLASSMATE = ['是', '不是'];
    const SURVEY_SEAT_MIN = 1;
    const SURVEY_SEAT_MAX = 99;

    // 只有這台裝置玩過 (有暱稱) 才顯示按鈕；有沒有上傳過分數由伺服器檢查
    function updateSurveyButton() {
        const panel = $('#bday-lb-panel');
        if (!panel.length) {
            return;
        }
        const show = surveyOpen && serverOpen === false && readName() !== '';
        let button = panel.find('.bday-survey-btn');
        if (show && !button.length) {
            button = $('<button type="button" class="bday-survey-btn">📝 填小問卷</button>').appendTo(panel);
        } else if (!show) {
            button.remove();
        }
    }

    function choiceList(name, type, options) {
        return '<div class="bday-survey-choices">' + options.map(function (option) {
            return '<label><input type="' + type + '" name="' + name + '" value="' + option.value + '">' +
                '<span>' + option.label + '</span></label>';
        }).join('') + '</div>';
    }

    function buildSurvey() {
        if ($('#bday-survey').length) {
            return;
        }
        const stars = [1, 2, 3, 4, 5].map(function (n) {
            return { value: n, label: '★'.repeat(n) };
        });
        const hardest = needs.map(function (need) {
            return { value: need.text, label: need.face + ' ' + need.text };
        });
        const plain = function (list) {
            return list.map(function (text) {
                return { value: text, label: text };
            });
        };
        $('body').append(
            '<div id="bday-survey" class="bday-game bday-survey">' +
            '<div class="bday-game-panel">' +
            '<button type="button" class="bday-game-close" title="關閉">✕</button>' +
            '<h2 class="bday-game-title">📝 生日小遊戲問卷</h2>' +
            '<p class="bday-survey-who"></p>' +
            '<form class="bday-survey-form" novalidate>' +
            '<fieldset><legend>1. 你是幼三甲的嗎？</legend>' +
            choiceList('classmate', 'radio', plain(SURVEY_CLASSMATE)) +
            '<div class="bday-survey-seat-row" style="display:none">' +
            '<label class="bday-survey-sub" for="bday-survey-seat">你的座號</label>' +
            '<input type="number" id="bday-survey-seat" name="seat" class="bday-survey-input bday-survey-seat" inputmode="numeric" min="' +
            SURVEY_SEAT_MIN + '" max="' + SURVEY_SEAT_MAX + '" step="1" placeholder="例如 7"></div></fieldset>' +
            '<fieldset><legend>2. 遊戲好玩嗎？</legend>' + choiceList('fun', 'radio', stars) + '</fieldset>' +
            '<fieldset><legend>3. 最讓你手忙腳亂的是哪一種？</legend>' + choiceList('hardest', 'radio', hardest) + '</fieldset>' +
            '<fieldset><legend>4. 明年還想玩嗎？</legend>' + choiceList('again', 'radio', plain(SURVEY_AGAIN)) + '</fieldset>' +
            '<fieldset><legend>5. 如果有小禮物，你想要什麼？（可複選）</legend>' +
            choiceList('gifts', 'checkbox', plain(SURVEY_GIFTS)) +
            '<input type="text" name="gift_other" class="bday-survey-input" maxlength="' + SURVEY_OTHER_LENGTH +
            '" placeholder="其他想要的（選填）"></fieldset>' +
            '<fieldset><legend>6. 想對避雷針說的生日祝福（選填）</legend>' +
            '<textarea name="wish" class="bday-survey-input" rows="3" maxlength="' + SURVEY_TEXT_LENGTH + '"></textarea></fieldset>' +
            '<fieldset><legend>7. 給站長的建議（選填）</legend>' +
            '<textarea name="advice" class="bday-survey-input" rows="2" maxlength="' + SURVEY_TEXT_LENGTH + '"></textarea></fieldset>' +
            '<p class="bday-submit-msg"></p>' +
            '<button type="submit" class="bday-start">送出 ✉️</button>' +
            '</form>' +
            '<div class="bday-survey-done" style="display:none">' +
            '<p class="bday-overlay-big">🎁 謝謝你填問卷！</p>' +
            '<p>小禮物決定好之後，站長會再公布喔。</p>' +
            '<button type="button" class="bday-lb-btn bday-survey-edit">修改答案</button>' +
            '</div>' +
            '</div>' +
            '</div>'
        );
        const survey = $('#bday-survey');
        survey.on('click', '.bday-game-close', closeSurvey);
        survey.on('click', function (e) {
            if (e.target === this) {
                closeSurvey();
            }
        });
        survey.on('click', '.bday-survey-edit', function () {
            survey.find('.bday-survey-done').hide();
            survey.find('.bday-survey-form').show();
        });
        survey.on('change', '[name="classmate"]', updateSeatRow);
        survey.on('submit', '.bday-survey-form', function (e) {
            e.preventDefault();
            submitSurvey();
        });
        $(document).on('keydown.bdaySurvey', function (e) {
            if (e.key === 'Escape' && survey.hasClass('open')) {
                closeSurvey();
            }
        });
    }

    function surveyMessage(text, ok) {
        $('#bday-survey .bday-submit-msg').text(text).toggleClass('ok', !!ok);
    }

    // 選「是幼三甲的」才顯示座號欄
    function updateSeatRow() {
        const form = $('#bday-survey .bday-survey-form');
        form.find('.bday-survey-seat-row').toggle(form.find('[name="classmate"]:checked').val() === '是');
    }

    function fillSurvey(answers) {
        const form = $('#bday-survey .bday-survey-form');
        form[0].reset();
        updateSeatRow();
        if (!answers) {
            return;
        }
        form.find('[name="seat"]').val(answers.seat || '');
        form.find('[name="fun"][value="' + answers.fun + '"]').prop('checked', true);
        ['classmate', 'hardest', 'again'].forEach(function (key) {
            form.find('[name="' + key + '"]').filter(function () {
                return this.value === answers[key];
            }).prop('checked', true);
        });
        form.find('[name="gifts"]').each(function () {
            this.checked = (answers.gifts || []).indexOf(this.value) !== -1;
        });
        updateSeatRow();
        ['gift_other', 'wish', 'advice'].forEach(function (key) {
            form.find('[name="' + key + '"]').val(answers[key] || '');
        });
    }

    function openSurvey() {
        buildSurvey();
        const survey = $('#bday-survey');
        const name = readName();
        survey.find('.bday-survey-who').html('以「<b class="bday-player"></b>」的身分填寫')
            .find('b').text(name);
        survey.find('.bday-survey-done').hide();
        const form = survey.find('.bday-survey-form').show();
        form.find('input, textarea, button').prop('disabled', true);
        fillSurvey(null);
        surveyMessage('讀取中…', true);
        survey.addClass('open');
        leaderboardRequest('/survey/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, token: getDeviceToken() })
        }).then(function (result) {
            form.find('input, textarea, button').prop('disabled', false);
            fillSurvey(result.answers);
            surveyMessage(result.answers ? '你填過了，可以修改後再送出一次' : '', true);
        }).catch(function (err) {
            surveyMessage(err.message);
        });
    }

    function submitSurvey() {
        const form = $('#bday-survey .bday-survey-form');
        const classmate = form.find('[name="classmate"]:checked').val();
        const seatText = form.find('[name="seat"]').val().trim();
        const seat = classmate === '是' && /^\d{1,2}$/.test(seatText) ? parseInt(seatText, 10) : 0;
        const fun = parseInt(form.find('[name="fun"]:checked').val(), 10);
        const answers = {
            classmate: classmate,
            seat: classmate === '是' ? seat : null,
            fun: fun,
            hardest: form.find('[name="hardest"]:checked').val(),
            again: form.find('[name="again"]:checked').val(),
            gifts: form.find('[name="gifts"]:checked').map(function () {
                return this.value;
            }).get(),
            gift_other: form.find('[name="gift_other"]').val().trim(),
            wish: form.find('[name="wish"]').val().trim(),
            advice: form.find('[name="advice"]').val().trim()
        };
        if (!classmate) {
            surveyMessage('第 1 題還沒選喔');
            return;
        }
        if (classmate === '是' && (seat < SURVEY_SEAT_MIN || seat > SURVEY_SEAT_MAX)) {
            surveyMessage('請填座號（' + SURVEY_SEAT_MIN + '~' + SURVEY_SEAT_MAX + '）');
            form.find('[name="seat"]').trigger('focus');
            return;
        }
        if (!fun) {
            surveyMessage('請選擇遊戲好不好玩');
            return;
        }
        if (!answers.hardest || !answers.again) {
            surveyMessage('第 3、4 題還沒選喔');
            return;
        }
        if (!answers.gifts.length) {
            surveyMessage('第 5 題至少選一個');
            return;
        }
        const button = form.find('button[type="submit"]').prop('disabled', true);
        surveyMessage('送出中…', true);
        leaderboardRequest('/survey', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: readName(), token: getDeviceToken(), answers: answers })
        }).then(function () {
            surveyMessage('');
            form.hide();
            $('#bday-survey .bday-survey-done').show();
        }).catch(function (err) {
            surveyMessage(err.message);
        }).then(function () {
            button.prop('disabled', false);
        });
    }

    function closeSurvey() {
        $('#bday-survey').removeClass('open');
    }

    window.openBirthdayGame = function () {
        buildModal();
        clearInterval(tickTimer);
        state = null;
        playerName = readName();
        $('.bday-kid').removeClass('needy shake').each(function (i) {
            $(this).find('.bday-kid-face').text(kids[i].face);
        }).find('.bday-kid-bubble').hide();
        $('.bday-kid-timer i').css('width', '0');
        selectTool(0);
        showIntro();
        $('#bday-game').addClass('open');
    };

})(jQuery);
