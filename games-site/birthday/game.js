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
// --- 小遊戲：幼兒園照顧大作戰 (開放與否由管理後台設定) ---
(function ($) {

    const G = window.TcteGames;
    const GAME_SECONDS = 60;
    const LEVEL_KEY = 'tcte-game-level';

    // 難度 (key 與 weight 要和 server.py 的 LEVELS 一致)：排行榜分數 = 遊戲分數 × weight
    // wait：小朋友等多久會生氣 (開局 → 最後，毫秒)；spawn：多久冒出一個新需求
    const LEVELS = {
        easy: { label: '簡單', kids: 4, hearts: 5, wait: [8000, 5000], spawn: [2000, 1100], weight: 0.6 },
        normal: { label: '普通', kids: 6, hearts: 3, wait: [6000, 3500], spawn: [1700, 750], weight: 1 },
        hard: { label: '困難', kids: 9, hearts: 3, wait: [5000, 2800], spawn: [1300, 550], weight: 1.5 }
    };
    const LEVEL_ORDER = ['easy', 'normal', 'hard'];

    // emoji 沒有尿布，自己畫一個 (大小跟 emoji 一樣是 1em)
    const DIAPER_ICON =
        '<svg class="bday-icon" viewBox="0 0 64 64" aria-hidden="true">' +
        '<path d="M5 12 H59 V22 C59 30 52 33 46 38 C41 42 40 52 32 52 C24 52 23 42 18 38 C12 33 5 30 5 22 Z"' +
        ' fill="#ffffff" stroke="#1e88e5" stroke-width="3.5" stroke-linejoin="round"/>' +
        '<path d="M5 12 H59 V20 H5 Z" fill="#90caf9" stroke="#1e88e5" stroke-width="3.5" stroke-linejoin="round"/>' +
        '<path d="M2 14 H12 V22 H2 Z M52 14 H62 V22 H52 Z" fill="#ffca28" stroke="#f57f17" stroke-width="2" stroke-linejoin="round"/>' +
        '<path d="M32 27 C29 24 25 26 26.5 29.5 L32 35 L37.5 29.5 C39 26 35 24 32 27 Z" fill="#ec407a"/>' +
        '</svg>';

    // 小朋友的需求與對應的照顧工具 (tool 可以是 emoji 或 SVG；text 要和 server.py 的 SURVEY_HARDEST 一致)
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
        { name: '樂樂', face: '👶' },
        { name: '小芳', face: '👧' },
        { name: '豆豆', face: '👦' },
        { name: '圓圓', face: '👶' }
    ];

    function readLevel() {
        let level = '';
        try {
            level = localStorage.getItem(LEVEL_KEY) || '';
        } catch (e) {
            level = '';
        }
        return LEVELS[level] ? level : 'normal';
    }

    function saveLevel(level) {
        try {
            localStorage.setItem(LEVEL_KEY, level);
        } catch (e) {
            // 無法儲存時下次用普通
        }
    }

    let level = readLevel();

    let state = null;
    let tickTimer = null;
    let playerName = G.readName();

    // --- 伺服器上的開放狀態 (開放日期由管理後台設定) ---
    const STATUS_REFRESH_MS = 60000;
    let serverOpen = null; // null：還沒查到

    function refreshStatus() {
        return G.request('/status').then(function (status) {
            const wasOpen = serverOpen;
            serverOpen = status.open === true;
            // 開放狀態變了，而且沒有在玩時，重新顯示開場畫面
            if (wasOpen !== serverOpen && !(state && state.running)) {
                showIntro();
            }
        }).catch(function () {
            if (serverOpen === null) {
                $('#bday-overlay').html(
                    '<div class="bday-overlay-box">' +
                    '<p class="bday-overlay-big">😵 連不上伺服器</p>' +
                    '<p>等一下再重新整理看看</p>' +
                    '</div>'
                ).css('display', 'flex');
            }
        });
    }

    // 以伺服器上的最高分為準 (管理後台可能改過或刪除)，同步回本機並更新畫面上的「最高分」
    function syncBest() {
        if (!playerName) {
            return;
        }
        const name = playerName;
        G.request('/best?name=' + encodeURIComponent(name)).then(function (result) {
            if (name !== playerName) {
                return;
            }
            const best = result.best || 0;
            G.saveBest(best);
            // 遊戲結果畫面由上傳結果更新，這裡只更新開場畫面
            $('#bday-overlay .bday-best.intro').text(best > 0 ? '🏆 最高分：' + best : '').toggle(best > 0);
        }).catch(function () {
            // 連不上時沿用本機紀錄
        });
    }

    function showLeaderboard(highlight, message) {
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">🏆 排行榜</p>' +
            '<p class="bday-lb-message"></p>' +
            '<div class="bday-lb"></div>' +
            (serverOpen ?
                '<button type="button" class="bday-start">' + (state ? '再玩一次 ↻' : '開始上課 ▶') + '</button>' :
                '<button type="button" class="bday-start">← 返回</button>') +
            '</div>'
        ).css('display', 'flex');
        $('#bday-overlay .bday-lb-message').text(message || '').toggle(!!message);
        G.renderLeaderboard($('#bday-overlay .bday-lb'), highlight, !serverOpen);
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
        if (!serverOpen) {
            showIntro();
            return;
        }
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
        if (checkingName) {
            return;
        }
        checkingName = true;
        $('#bday-overlay .bday-start').prop('disabled', true);
        msg.removeClass('ok').text('檢查暱稱中…');
        // 登記暱稱；已被其他裝置使用時會失敗並回傳錯誤訊息
        G.postJson('/names', { name: name, token: G.getToken() }).then(function () {
            playerName = name;
            G.saveName(name);
            syncBest();
            refreshSideBoard();
            startGame();
        }).catch(function (err) {
            msg.text(err instanceof TypeError ? '連不上排行榜，請稍後再試' : err.message);
            input.trigger('focus').trigger('select');
        }).then(function () {
            checkingName = false;
            $('#bday-overlay .bday-start').prop('disabled', false);
        });
    }

    // 遊戲結束時自動上傳分數 (同一個暱稱只保留最高分)，失敗時顯示「重新上傳」
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
        const score = state.boardScore;
        G.postJson('/scores', { name: name, score: state.score, level: state.level, token: G.getToken() }).then(function (result) {
            state.lastSubmitted = { name: name, score: result.best };
            G.saveBest(result.best);
            refreshSideBoard();
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

    // 依難度畫出這一局的小朋友
    function renderKids() {
        let kidsHtml = '';
        kids.slice(0, LEVELS[level].kids).forEach(function (kid, i) {
            kidsHtml +=
                '<button type="button" class="bday-kid" data-index="' + i + '">' +
                '<span class="bday-kid-bubble"></span>' +
                '<span class="bday-kid-face">' + kid.face + '</span>' +
                '<span class="bday-kid-name">' + kid.name + '</span>' +
                '<span class="bday-kid-timer"><i></i></span>' +
                '</button>';
        });
        $('#bday-game .bday-kids').attr('data-count', LEVELS[level].kids).html(kidsHtml);
    }

    function buildGame() {

        let toolsHtml = '';
        needs.forEach(function (need, i) {
            toolsHtml +=
                '<button type="button" class="bday-tool" data-index="' + i + '">' +
                '<span class="bday-tool-icon">' + need.tool + '</span>' +
                '<span class="bday-tool-label">' + need.label + '</span>' +
                '</button>';
        });

        $('#bday-game').html(
            '<div class="bday-game-panel">' +
            '<h2 class="bday-game-title">🧸 幼兒園照顧大作戰</h2>' +
            '<div class="bday-game-hud">' +
            '<span>⏱ <b id="bday-time">' + GAME_SECONDS + '</b></span>' +
            '<span>⭐ <b id="bday-score">0</b></span>' +
            '<span id="bday-hearts"></span>' +
            '<span id="bday-combo" class="bday-combo"></span>' +
            '</div>' +
            '<div class="bday-game-stage">' +
            '<div class="bday-kids"></div>' +
            '</div>' +
            '<div class="bday-tools">' + toolsHtml + '</div>' +
            '<p class="bday-hint">先選照顧工具，再點需要幫忙的小朋友（鍵盤 1~5 也能選工具）</p>' +
            '<div id="bday-overlay" class="bday-overlay"><div class="bday-overlay-box"><p>讀取中…</p></div></div>' +
            '</div>'
        );

        renderKids();
        const game = $('#bday-game');
        game.on('click', '.bday-tool', function () {
            selectTool(parseInt($(this).data('index'), 10));
        });
        game.on('click', '.bday-kid', function () {
            careKid(parseInt($(this).data('index'), 10));
        });
        game.on('click', '.bday-start', handleStart);
        game.on('click', '.bday-lb-btn', function () {
            showLeaderboard(state ? state.lastSubmitted : (playerName ? { name: playerName } : null));
        });
        game.on('click', '.bday-submit-btn', uploadScore);
        game.on('click', '.bday-name-edit', function () {
            renderNameRow(true);
        });
        game.on('click', '.bday-level', function () {
            level = $(this).data('level');
            saveLevel(level);
            renderLevelRow();
            renderKids();
        });
        game.on('keydown', '.bday-name', function (e) {
            if (e.key === 'Enter') {
                handleStart();
            }
        });

        $(document).on('keydown', function (e) {
            if ($(e.target).is('input')) {
                // 輸入名字時不切換工具
            } else if (e.key >= '1' && e.key <= String(needs.length)) {
                selectTool(parseInt(e.key, 10) - 1);
            }
        });
    }

    function showIntro() {
        if (state && state.running) {
            return;
        }
        state = null;
        const best = G.readBest();
        if (!serverOpen) {
            $('#bday-overlay').html(
                '<div class="bday-overlay-box">' +
                '<p class="bday-overlay-big">⏸️ 遊戲目前沒有開放</p>' +
                '<p>謝謝大家來玩！下次開放再見 👋</p>' +
                (best > 0 && playerName ? '<p class="bday-best">🏆 你的最高分：' + best + '</p>' : '') +
                '<button type="button" class="bday-lb-btn">🏆 看排行榜</button>' +
                '</div>'
            ).css('display', 'flex');
            return;
        }
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">🧸 幼兒園照顧大作戰</p>' +
            '<p>身為未來的幼保老師，今天要獨自照顧整班小朋友！</p>' +
            '<ul class="bday-rules">' +
            needs.map(function (need) {
                return '<li>' + need.face + ' ' + need.text + ' → ' + need.tool + ' ' + need.label + '</li>';
            }).join('') +
            '</ul>' +
            '<p>沒有及時照顧，家長滿意度 ❤️ 就會下降，連續照顧對了還有加分！</p>' +
            '<div class="bday-level-row"></div>' +
            '<p class="bday-level-info"></p>' +
            '<p class="bday-best intro"' + (best > 0 ? '>🏆 最高分：' + best : ' style="display:none">') + '</p>' +
            '<div class="bday-submit bday-name-row"></div>' +
            '<p class="bday-submit-msg"></p>' +
            '<button type="button" class="bday-start">開始上課 ▶</button>' +
            '<button type="button" class="bday-lb-btn">🏆 排行榜</button>' +
            '</div>'
        ).css('display', 'flex');
        renderNameRow(false);
        renderLevelRow();
        syncBest();
    }

    function renderLevelRow() {
        const row = $('#bday-overlay .bday-level-row');
        row.html(LEVEL_ORDER.map(function (key) {
            return '<button type="button" class="bday-level' + (key === level ? ' selected' : '') +
                '" data-level="' + key + '">' + LEVELS[key].label + '</button>';
        }).join(''));
        const info = LEVELS[level];
        $('#bday-overlay .bday-level-info').text(
            info.kids + ' 位小朋友、' + info.hearts + ' 顆愛心，排行榜分數 ×' + info.weight);
    }

    function startGame() {
        const now = performance.now();
        const info = LEVELS[level];
        renderKids();
        state = {
            running: true,
            level: level,
            info: info,
            score: 0,
            combo: 0,
            hearts: info.hearts,
            startAt: now,
            endAt: now + GAME_SECONDS * 1000,
            nextSpawnAt: now + 400,
            selectedTool: state ? state.selectedTool : 0,
            kids: kids.slice(0, info.kids).map(function () {
                return { need: null, since: 0, deadline: 0, moodUntil: 0, moodFace: '' };
            })
        };
        $('#bday-overlay').hide().empty();
        selectTool(state.selectedTool);
        renderHud();
        state.kids.forEach(function (kid, i) {
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
                kid.deadline = now + lerp(state.info.wait[0], state.info.wait[1], progress);
            }
            state.nextSpawnAt = now + lerp(state.info.spawn[0], state.info.spawn[1], progress);
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
        $('#bday-hearts').text('❤️'.repeat(state.hearts) + '🤍'.repeat(state.info.hearts - state.hearts));
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

        // 排行榜分數 = 遊戲分數 × 難度加權 (伺服器也用同樣的方式計算)
        state.boardScore = Math.round(state.score * state.info.weight);
        const best = G.readBest();
        const isNewBest = state.boardScore > best;
        state.previousBest = best;
        if (isNewBest) {
            G.saveBest(state.boardScore);
        }

        const reason = state.hearts <= 0 ? '家長滿意度用完了…' : '放學囉！';
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-player"></p>' +
            '<p class="bday-overlay-big">⭐ ' + state.score + ' 分</p>' +
            '<p class="bday-level-info">' + state.info.label + '：' + state.score + ' × ' + state.info.weight +
            ' = 排行榜 <b>' + state.boardScore + '</b> 分</p>' +
            '<p class="bday-rating">' + getRating(state.boardScore) + '</p>' +
            '<p class="bday-best">' + (isNewBest ? '🏆 新紀錄！' : '🏆 最高分：' + best) + '</p>' +
            (state.boardScore > 0 ?
                '<div class="bday-submit">' +
                '<span class="bday-submit-msg"></span>' +
                '<button type="button" class="bday-submit-btn">重新上傳</button>' +
                '</div>' : '') +
            '<button type="button" class="bday-start">再玩一次 ↻</button>' +
            '<button type="button" class="bday-lb-btn">🏆 排行榜</button>' +
            '</div>'
        ).css('display', 'flex');
        // 暱稱是玩家輸入的，用 text() 避免被當成 HTML
        $('#bday-overlay .bday-player').text(playerName + ' 老師，' + reason);

        if (state.boardScore > 0) {
            uploadScore();
        }
    }

    // --- 遊戲旁邊常駐的排行榜 ---
    const SIDE_REFRESH_MS = 10000;
    function refreshSideBoard() {
        // 分頁在背景時不更新，切回來時馬上更新
        if (document.hidden) {
            return;
        }
        G.renderLeaderboard($('.bday-side-lb .bday-lb'), playerName ? { name: playerName } : null, serverOpen === false);
    }

    $(function () {
        refreshSideBoard();
        setInterval(refreshSideBoard, SIDE_REFRESH_MS);
        $(document).on('visibilitychange', refreshSideBoard);
        buildGame();
        selectTool(0);
        // 回統測倒數的連結帶上身分，倒數網頁的排行榜才能標出自己、填問卷
        $('.games-countdown-link').on('click', function () {
            this.href = G.linkWithIdentity(G.COUNTDOWN_URL);
        });
        refreshStatus();
        setInterval(refreshStatus, STATUS_REFRESH_MS);
    });

})(jQuery);
