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
// --- 小遊戲：貪吃蛇 (隨時都能玩，排行榜和其他遊戲分開) ---
(function ($) {

    const G = window.TcteGames;
    const GAME = 'snake'; // 要和 server.py 的 GAMES 一致
    const BEST_KEY = 'tcte-snake-best';
    const LEVEL_KEY = 'tcte-snake-level';
    const GRID = 17;
    const FOOD_POINTS = 10;
    const BONUS_POINTS = 20;
    const BONUS_EVERY = 5; // 每吃幾個出現一次限時 ⭐
    const BONUS_MS = 6000;
    const FOODS = ['📚', '✏️', '📝', '📐', '🧮', '📖'];

    // 難度 (key 與 weight 要和 server.py 的 LEVELS 一致)：排行榜分數 = 遊戲分數 × weight
    // speed：每走一格的毫秒數 (開局 → 吃了 40 個以後)；wrap：撞牆會從另一邊出來
    const LEVELS = {
        easy: { label: '簡單', speed: [170, 120], wrap: true, weight: 0.6, info: '比較慢，撞牆會從另一邊出來' },
        normal: { label: '普通', speed: [140, 85], wrap: false, weight: 1, info: '撞牆就結束' },
        hard: { label: '困難', speed: [105, 55], wrap: false, weight: 1.5, info: '超快，撞牆就結束' }
    };
    const LEVEL_ORDER = ['easy', 'normal', 'hard'];
    const DIRS = {
        up: { x: 0, y: -1 },
        down: { x: 0, y: 1 },
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 }
    };
    const KEYS = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right'
    };

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

    let level = LEVELS[storageGet(LEVEL_KEY)] ? storageGet(LEVEL_KEY) : 'normal';
    let state = null;
    let playerName = G.readName();
    let canvas = null;
    let ctx = null;
    let frame = 0;

    // --- 排行榜與最高分 ---

    function syncBest() {
        if (!playerName) {
            return;
        }
        const name = playerName;
        G.request('/best?game=' + GAME + '&name=' + encodeURIComponent(name)).then(function (result) {
            if (name !== playerName) {
                return;
            }
            const best = result.best || 0;
            storageSet(BEST_KEY, String(best));
            $('#bday-overlay .bday-best.intro').text(best > 0 ? '🏆 最高分：' + best : '').toggle(best > 0);
        }).catch(function () {
            // 連不上時沿用本機紀錄
        });
    }

    const SIDE_REFRESH_MS = 10000;
    function refreshSideBoard() {
        if (document.hidden) {
            return;
        }
        G.renderLeaderboard($('.bday-side-lb .bday-lb'), playerName ? { name: playerName } : null, false, GAME);
    }

    function showLeaderboard(highlight) {
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">🏆 排行榜</p>' +
            '<div class="bday-lb"></div>' +
            '<button type="button" class="bday-start">' + (state ? '再玩一次 ↻' : '開始 ▶') + '</button>' +
            '</div>'
        ).css('display', 'flex');
        G.renderLeaderboard($('#bday-overlay .bday-lb'), highlight, false, GAME);
    }

    // --- 開場畫面 ---

    function renderNameRow(editing) {
        const row = $('#bday-overlay .bday-name-row');
        if (!editing && playerName) {
            row.html('<span class="bday-name-current">🐍 <b></b></span>' +
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

    function renderLevelRow() {
        $('#bday-overlay .bday-level-row').html(LEVEL_ORDER.map(function (key) {
            return '<button type="button" class="bday-level' + (key === level ? ' selected' : '') +
                '" data-level="' + key + '">' + LEVELS[key].label + '</button>';
        }).join(''));
        $('#bday-overlay .bday-level-info').text(LEVELS[level].info + '，排行榜分數 ×' + LEVELS[level].weight);
    }

    function showIntro() {
        state = null;
        drawBoard();
        const best = readBest();
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">🐍 貪吃蛇</p>' +
            '<p>吃掉 📚 ✏️ 📝 讓蛇變長，每個 +' + FOOD_POINTS + ' 分；<br>偶爾出現的 ⭐ 要快點吃，+' + BONUS_POINTS + ' 分！</p>' +
            '<p>撞到自己就結束。電腦用方向鍵或 WASD，手機在格子上滑動或按下面的按鈕。</p>' +
            '<div class="bday-level-row"></div>' +
            '<p class="bday-level-info"></p>' +
            '<p class="bday-best intro"' + (best > 0 ? '>🏆 最高分：' + best : ' style="display:none">') + '</p>' +
            '<div class="bday-submit bday-name-row"></div>' +
            '<p class="bday-submit-msg"></p>' +
            '<button type="button" class="bday-start">開始 ▶</button>' +
            '<button type="button" class="bday-lb-btn">🏆 排行榜</button>' +
            '</div>'
        ).css('display', 'flex');
        renderNameRow(false);
        renderLevelRow();
        syncBest();
    }

    let checkingName = false;
    function handleStart() {
        if (state && state.paused) {
            resume();
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
        G.postJson('/names', { name: name, token: G.getToken(), game: GAME }).then(function () {
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

    // --- 遊戲 ---

    function randomFreeCell() {
        const taken = {};
        state.snake.forEach(function (p) {
            taken[p.x + ',' + p.y] = true;
        });
        if (state.food) {
            taken[state.food.x + ',' + state.food.y] = true;
        }
        if (state.bonus) {
            taken[state.bonus.x + ',' + state.bonus.y] = true;
        }
        const free = [];
        for (let y = 0; y < GRID; y++) {
            for (let x = 0; x < GRID; x++) {
                if (!taken[x + ',' + y]) {
                    free.push({ x: x, y: y });
                }
            }
        }
        return free.length ? free[Math.floor(Math.random() * free.length)] : null;
    }

    function placeFood() {
        const cell = randomFreeCell();
        state.food = cell ? { x: cell.x, y: cell.y, icon: FOODS[Math.floor(Math.random() * FOODS.length)] } : null;
    }

    function startGame() {
        const mid = Math.floor(GRID / 2);
        state = {
            running: true,
            paused: false,
            level: level,
            info: LEVELS[level],
            score: 0,
            eaten: 0,
            dir: 'right',
            queue: [],
            snake: [{ x: mid, y: mid }, { x: mid - 1, y: mid }, { x: mid - 2, y: mid }],
            food: null,
            bonus: null,
            lastStep: performance.now(),
            submitted: false
        };
        placeFood();
        $('#bday-overlay').hide().empty();
        $('body').addClass('bday-playing');
        renderHud();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(loop);
    }

    function stepInterval() {
        const speed = state.info.speed;
        return speed[0] + (speed[1] - speed[0]) * Math.min(1, state.eaten / 40);
    }

    function loop(now) {
        if (!state || !state.running) {
            return;
        }
        if (!state.paused) {
            if (now - state.lastStep >= stepInterval()) {
                state.lastStep = now;
                step(now);
            }
            if (state.bonus && now >= state.bonus.until) {
                state.bonus = null;
            }
        }
        if (state.running) {
            drawBoard(now);
            frame = requestAnimationFrame(loop);
        }
    }

    function turn(dir) {
        if (!state || !state.running || state.paused) {
            return;
        }
        // 最多先記兩個轉向 (快速連按時不會漏)，不能直接回頭
        const last = state.queue.length ? state.queue[state.queue.length - 1] : state.dir;
        if (dir === last || (DIRS[dir].x + DIRS[last].x === 0 && DIRS[dir].y + DIRS[last].y === 0)) {
            return;
        }
        if (state.queue.length < 2) {
            state.queue.push(dir);
        }
    }

    function step(now) {
        if (state.queue.length) {
            state.dir = state.queue.shift();
        }
        const head = state.snake[0];
        let next = { x: head.x + DIRS[state.dir].x, y: head.y + DIRS[state.dir].y };
        if (next.x < 0 || next.x >= GRID || next.y < 0 || next.y >= GRID) {
            if (!state.info.wrap) {
                endGame('撞到牆了！');
                return;
            }
            next = { x: (next.x + GRID) % GRID, y: (next.y + GRID) % GRID };
        }
        const eating = state.food && next.x === state.food.x && next.y === state.food.y;
        // 沒吃東西時尾巴會移走，所以可以走進尾巴原本的位置
        const body = eating ? state.snake : state.snake.slice(0, -1);
        if (body.some(function (p) { return p.x === next.x && p.y === next.y; })) {
            endGame('咬到自己了！');
            return;
        }
        state.snake.unshift(next);
        if (eating) {
            state.score += FOOD_POINTS;
            state.eaten++;
            if (state.eaten % BONUS_EVERY === 0 && !state.bonus) {
                const cell = randomFreeCell();
                if (cell) {
                    state.bonus = { x: cell.x, y: cell.y, until: now + BONUS_MS };
                }
            }
            placeFood();
            if (!state.food) {
                endGame('整個格子都被你吃滿了！'); // 滿分
                return;
            }
        } else {
            state.snake.pop();
        }
        if (state.bonus && next.x === state.bonus.x && next.y === state.bonus.y) {
            state.score += BONUS_POINTS;
            state.bonus = null;
        }
        renderHud();
    }

    function pause() {
        if (!state || !state.running || state.paused) {
            return;
        }
        state.paused = true;
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">⏸️ 暫停中</p>' +
            '<button type="button" class="bday-start">繼續 ▶</button>' +
            '</div>'
        ).css('display', 'flex');
    }

    function resume() {
        if (!state || !state.paused) {
            return;
        }
        state.paused = false;
        state.lastStep = performance.now();
        $('#bday-overlay').hide().empty();
    }

    function renderHud() {
        $('#snake-score').text(state ? state.score : 0);
        $('#snake-length').text(state ? state.snake.length : 3);
    }

    function getRating(score) {
        if (score >= 600) return '👑 蛇王';
        if (score >= 300) return '🥇 吃書高手';
        if (score >= 120) return '🌟 越吃越長';
        return '🌱 小小蛇';
    }

    function endGame(reason) {
        state.running = false;
        cancelAnimationFrame(frame);
        drawBoard(performance.now());
        $('body').removeClass('bday-playing');
        refreshSideBoard();

        state.boardScore = Math.round(state.score * state.info.weight);
        const best = readBest();
        const isNewBest = state.boardScore > best;
        state.previousBest = best;
        if (isNewBest) {
            storageSet(BEST_KEY, String(state.boardScore));
        }
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
        $('#bday-overlay .bday-player').text(playerName + '，' + reason);
        if (state.boardScore > 0) {
            uploadScore();
        }
    }

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
        G.postJson('/scores', {
            name: name, score: state.score, level: state.level, token: G.getToken(), game: GAME
        }).then(function (result) {
            state.lastSubmitted = { name: name, score: result.best };
            storageSet(BEST_KEY, String(result.best));
            refreshSideBoard();
            $('#bday-overlay .bday-best').text(
                result.best === score && score > state.previousBest ? '🏆 新紀錄！' : '🏆 最高分：' + result.best);
            msg.addClass('ok').text(result.best > score ?
                '上傳成功！最佳成績 ' + result.best + ' 分，第 ' + result.rank + ' 名' :
                '上傳成功！你是第 ' + result.rank + ' 名 🎉');
        }).catch(function (err) {
            state.submitted = false;
            button.show();
            msg.text(err instanceof TypeError ? '連不上排行榜，請稍後再試' : err.message);
        });
    }

    // --- 畫面 ---

    function resizeCanvas() {
        const ratio = window.devicePixelRatio || 1;
        const size = Math.round(canvas.clientWidth * ratio);
        if (size && canvas.width !== size) {
            canvas.width = size;
            canvas.height = size;
        }
        drawBoard(performance.now());
    }

    function roundRect(x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function drawEmoji(icon, cell, x, y, scale) {
        ctx.font = Math.round(cell * 0.8 * scale) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon, (x + 0.5) * cell, (y + 0.55) * cell);
    }

    function drawBoard(now) {
        if (!ctx) {
            return;
        }
        const size = canvas.width;
        const cell = size / GRID;
        ctx.clearRect(0, 0, size, size);
        for (let y = 0; y < GRID; y++) {
            for (let x = 0; x < GRID; x++) {
                ctx.fillStyle = (x + y) % 2 ? '#c5e8b7' : '#d4efc6';
                ctx.fillRect(x * cell, y * cell, cell + 0.5, cell + 0.5);
            }
        }
        if (!state) {
            return;
        }
        if (state.food) {
            drawEmoji(state.food.icon, cell, state.food.x, state.food.y, 1);
        }
        if (state.bonus) {
            // 快消失時閃爍
            const left = state.bonus.until - (now || 0);
            if (left > 1500 || Math.floor(left / 150) % 2 === 0) {
                drawEmoji('⭐', cell, state.bonus.x, state.bonus.y, 1 + 0.08 * Math.sin((now || 0) / 120));
            }
        }
        const pad = cell * 0.08;
        const total = state.snake.length;
        for (let i = total - 1; i >= 0; i--) {
            const p = state.snake[i];
            // 頭比較深，越往尾巴越淺
            const t = total > 1 ? i / (total - 1) : 0;
            ctx.fillStyle = 'rgb(' + Math.round(46 + t * 60) + ',' + Math.round(125 + t * 60) + ',' + Math.round(50 + t * 40) + ')';
            roundRect(p.x * cell + pad, p.y * cell + pad, cell - pad * 2, cell - pad * 2, cell * 0.3);
            ctx.fill();
        }
        // 眼睛
        const head = state.snake[0];
        const d = DIRS[state.dir];
        const cx = (head.x + 0.5) * cell;
        const cy = (head.y + 0.5) * cell;
        [-1, 1].forEach(function (side) {
            const ex = cx + d.x * cell * 0.15 + -d.y * side * cell * 0.2;
            const ey = cy + d.y * cell * 0.15 + d.x * side * cell * 0.2;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(ex, ey, cell * 0.13, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#263238';
            ctx.beginPath();
            ctx.arc(ex + d.x * cell * 0.04, ey + d.y * cell * 0.04, cell * 0.065, 0, Math.PI * 2);
            ctx.fill();
        });
        if (!state.running && !state.paused) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.15)';
            ctx.fillRect(0, 0, size, size);
        }
    }

    function buildGame() {
        $('#bday-game').html(
            '<div class="bday-game-panel">' +
            '<h2 class="bday-game-title">🐍 貪吃蛇</h2>' +
            '<div class="bday-game-hud">' +
            '<span>⭐ <b id="snake-score">0</b></span>' +
            '<span>📏 <b id="snake-length">3</b></span>' +
            '<button type="button" class="snake-pause" aria-label="暫停">⏸️</button>' +
            '</div>' +
            '<div class="bday-game-stage snake-stage"><canvas class="snake-canvas"></canvas></div>' +
            '<div class="snake-pad">' +
            '<button type="button" data-dir="up" aria-label="上">▲</button>' +
            '<button type="button" data-dir="left" aria-label="左">◀</button>' +
            '<button type="button" data-dir="down" aria-label="下">▼</button>' +
            '<button type="button" data-dir="right" aria-label="右">▶</button>' +
            '</div>' +
            '<p class="bday-hint">方向鍵 / WASD 移動，空白鍵暫停；手機可以在格子上滑動</p>' +
            '<div id="bday-overlay" class="bday-overlay"><div class="bday-overlay-box"><p>讀取中…</p></div></div>' +
            '</div>'
        );
        canvas = $('#bday-game .snake-canvas')[0];
        ctx = canvas.getContext('2d');

        const game = $('#bday-game');
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
            storageSet(LEVEL_KEY, level);
            renderLevelRow();
        });
        game.on('keydown', '.bday-name', function (e) {
            if (e.key === 'Enter') {
                handleStart();
            }
        });
        game.on('click', '.snake-pause', pause);
        // 按鈕用 pointerdown，手機上反應比 click 快
        game.on('pointerdown', '.snake-pad button', function (e) {
            e.preventDefault();
            turn($(this).data('dir'));
        });

        $(document).on('keydown', function (e) {
            if ($(e.target).is('input')) {
                return;
            }
            if (KEYS[e.key]) {
                if (state && state.running) {
                    e.preventDefault(); // 不要捲動頁面
                }
                turn(KEYS[e.key]);
            } else if (e.key === ' ' || e.key === 'p' || e.key === 'P') {
                if (state && state.running) {
                    e.preventDefault();
                    if (state.paused) {
                        resume();
                    } else {
                        pause();
                    }
                }
            } else if (e.key === 'Enter' && !(state && state.running && !state.paused)) {
                $('#bday-overlay .bday-start').first().trigger('click');
            }
        });

        // 手機：在格子上滑動轉向 (遊戲中不讓頁面跟著捲動)
        let touchStart = null;
        canvas.addEventListener('touchstart', function (e) {
            const t = e.changedTouches[0];
            touchStart = { x: t.clientX, y: t.clientY };
        }, { passive: true });
        canvas.addEventListener('touchmove', function (e) {
            if (state && state.running) {
                e.preventDefault();
            }
            if (!touchStart) {
                return;
            }
            const t = e.changedTouches[0];
            const dx = t.clientX - touchStart.x;
            const dy = t.clientY - touchStart.y;
            if (Math.max(Math.abs(dx), Math.abs(dy)) >= 24) {
                turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
                touchStart = { x: t.clientX, y: t.clientY }; // 不放開也能連續轉彎
            }
        }, { passive: false });
        canvas.addEventListener('touchend', function () {
            touchStart = null;
        });

        $(window).on('resize', resizeCanvas);
        resizeCanvas();
    }

    $(function () {
        refreshSideBoard();
        setInterval(refreshSideBoard, SIDE_REFRESH_MS);
        $(document).on('visibilitychange', function () {
            if (document.hidden) {
                pause(); // 切到別的分頁自動暫停
            } else {
                refreshSideBoard();
            }
        });
        buildGame();
        showIntro();
        $('.games-countdown-link').on('click', function () {
            this.href = G.linkWithIdentity(G.COUNTDOWN_URL);
        });
    });

})(jQuery);
