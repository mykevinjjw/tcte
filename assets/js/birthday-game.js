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

    // --- 線上排行榜 (自架於 OCI A1，見 leaderboard-server/) ---
    // 留空時排行榜會自動隱藏；GitHub Pages 是 HTTPS，所以 API 也必須是 HTTPS
    const LEADERBOARD_URL = 'https://tcte-lb.kevinjja.dpdns.org';
    const LEADERBOARD_SIZE = 10;

    // 小朋友的需求與對應的照顧工具
    const needs = [
        { face: '🤤', text: '肚子餓', tool: '🍼', label: '奶瓶' },
        { face: '😭', text: '哭哭了', tool: '🧸', label: '抱抱熊' },
        { face: '🥱', text: '想睡覺', tool: '📖', label: '說故事' },
        { face: '💩', text: '換尿布', tool: '🧷', label: '尿布' },
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

    function fetchTopScores() {
        return leaderboardRequest('/scores?limit=' + LEADERBOARD_SIZE);
    }

    // 回傳 { rank: 名次 }
    function submitScore(name, score) {
        return leaderboardRequest('/scores', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, score: score })
        });
    }

    function renderLeaderboard(container, highlight) {
        // 定時刷新時保留舊的名單，避免閃爍
        if (container.is(':empty')) {
            container.html('<p class="bday-lb-status">讀取排行榜中…</p>');
        }
        fetchTopScores().then(function (rows) {
            if (rows.length === 0) {
                container.html('<p class="bday-lb-status">還沒有人上榜，快來搶第一！</p>');
                return;
            }
            const list = $('<ol class="bday-lb-list"></ol>');
            let highlighted = false;
            rows.forEach(function (row, i) {
                const item = $('<li></li>');
                $('<span class="bday-lb-rank"></span>').text(['🥇', '🥈', '🥉'][i] || (i + 1)).appendTo(item);
                $('<span class="bday-lb-name"></span>').text(row.name).appendTo(item);
                $('<span class="bday-lb-score"></span>').text(row.score).appendTo(item);
                if (!highlighted && highlight && row.name === highlight.name && row.score === highlight.score) {
                    item.addClass('me');
                    highlighted = true;
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
            '<p class="bday-overlay-big">🏆 排行榜 Top ' + LEADERBOARD_SIZE + '</p>' +
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

    // 開始按鈕：沒記住暱稱時要先填，之後「再玩一次」沿用同一個暱稱
    function handleStart() {
        const input = $('#bday-overlay .bday-name');
        if (input.length) {
            const name = $.trim(input.val());
            if (!name) {
                $('#bday-overlay .bday-submit-msg').text('先輸入暱稱才能開始喔！');
                input.focus();
                return;
            }
            playerName = name;
            saveName(name);
        } else if (!playerName) {
            showIntro();
            return;
        }
        startGame();
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
            state.lastSubmitted = { name: name, score: score };
            panelHighlight = state.lastSubmitted;
            refreshPanel();
            msg.addClass('ok').text('上傳成功！你是第 ' + result.rank + ' 名 🎉');
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
            (best > 0 ? '<p>🏆 最高分：' + best + '</p>' : '') +
            '<div class="bday-submit bday-name-row"></div>' +
            '<p class="bday-submit-msg"></p>' +
            '<button type="button" class="bday-start">開始上課 ▶</button>' +
            (leaderboardEnabled() ? '<button type="button" class="bday-lb-btn">🏆 排行榜</button>' : '') +
            '</div>'
        ).css('display', 'flex');
        renderNameRow(false);
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
        if (isNewBest) {
            saveBest(state.score);
        }

        const reason = state.hearts <= 0 ? '家長滿意度用完了…' : '放學囉！';
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-player"></p>' +
            '<p class="bday-overlay-big">⭐ ' + state.score + ' 分</p>' +
            '<p class="bday-rating">' + getRating(state.score) + '</p>' +
            '<p>' + (isNewBest ? '🏆 新紀錄！' : '🏆 最高分：' + best) + '</p>' +
            '<p>🎂 避雷針生日快樂！未來一定是超棒的幼保老師 💖</p>' +
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
    let panelTimer = null;
    let panelHighlight = null;

    function refreshPanel() {
        const list = $('#bday-lb-panel .bday-lb');
        // 分頁在背景時不更新，切回來時馬上更新
        if (list.length && !document.hidden) {
            renderLeaderboard(list, panelHighlight);
        }
    }

    window.showBirthdayLeaderboard = function () {
        if (!leaderboardEnabled() || $('#bday-lb-panel').length) {
            return;
        }
        const panel = $(
            '<aside id="bday-lb-panel" class="bday-lb-panel">' +
            '<button type="button" class="bday-lb-panel-toggle">🏆 生日排行榜</button>' +
            '<div class="bday-lb"></div>' +
            '</aside>'
        );
        panel.on('click', '.bday-lb-panel-toggle', function () {
            panel.toggleClass('collapsed');
        });
        $('body').append(panel);
        refreshPanel();
        panelTimer = setInterval(refreshPanel, PANEL_REFRESH_MS);
        $(document).on('visibilitychange.bdayPanel', refreshPanel);
    };

    window.hideBirthdayLeaderboard = function () {
        clearInterval(panelTimer);
        $(document).off('visibilitychange.bdayPanel');
        $('#bday-lb-panel').remove();
    };

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
