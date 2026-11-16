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
// --- 小遊戲：讀書彈珠台 (隨時都能玩，排行榜和其他遊戲分開) ---
// 檯面、計分規則都是原創：撞 📚✏️📐 彈簧柱、點亮上方三條「科目」通道升倍率、打滿三張 📝 考卷、⭐ 洞加分。
(function ($) {

    const G = window.TcteGames;
    const GAME = 'pinball'; // 要和 server.py 的 GAMES 一致
    const BEST_KEY = 'tcte-pinball-best';
    const LEVEL_KEY = 'tcte-pinball-level';

    // 檯面座標 (邏輯單位)，畫的時候再縮放到 canvas
    const W = 400;
    const H = 720;
    const R = 9;               // 球半徑
    const MAX_SPEED = 1600;
    const STEP = 1 / 600;      // 物理每一小步的秒數 (小步才不會穿牆)
    const LANE_X = 352;        // 右邊發射通道的內牆
    const GATE_Y = 215;        // 發射通道上方的單向門
    const MAX_MULT = 5;

    // 難度 (key 與 weight 要和 server.py 的 LEVELS 一致)：排行榜分數 = 遊戲分數 × weight
    const LEVELS = {
        easy: { label: '簡單', balls: 5, gravity: 800, save: 15, flipper: 64, weight: 0.6, info: '5 顆球，發射後 15 秒內掉下去會救回來' },
        normal: { label: '普通', balls: 3, gravity: 950, save: 8, flipper: 62, weight: 1, info: '3 顆球，發射後 8 秒內有救球' },
        hard: { label: '困難', balls: 3, gravity: 1100, save: 0, flipper: 56, weight: 1.5, info: '3 顆球，沒有救球，擋板比較短' }
    };
    const LEVEL_ORDER = ['easy', 'normal', 'hard'];

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

    // --- 音效 (WebAudio 即時合成，不用載入音檔) ---

    const SOUND_KEY = 'tcte-pinball-sound';
    let soundOn = storageGet(SOUND_KEY) !== 'off';
    let audio = null;
    let master = null;
    const lastSfx = {};

    function initAudio() {
        if (!audio) {
            try {
                audio = new (window.AudioContext || window.webkitAudioContext)();
                master = audio.createGain();
                master.gain.value = 0.9;
                master.connect(audio.destination);
            } catch (e) {
                audio = null;
            }
        }
        if (audio && audio.state === 'suspended') {
            audio.resume();
        }
    }

    function tone(freq, dur, type, vol, slide, delay) {
        const t0 = audio.currentTime + (delay || 0);
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        if (slide) {
            o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
        }
        g.gain.setValueAtTime(vol, t0);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g);
        g.connect(master);
        o.start(t0);
        o.stop(t0 + dur + 0.02);
    }

    function arp(notes, step, type, vol) {
        notes.forEach(function (f, i) {
            tone(f, step * 1.6, type, vol, 0, i * step);
        });
    }

    const SFX = {
        bumper: function () { tone(720, 0.12, 'square', 0.06, 340); },
        sling: function () { tone(330, 0.08, 'triangle', 0.12, 170); },
        flipper: function () { tone(150, 0.05, 'square', 0.035, 70); },
        lane: function () { tone(1050, 0.12, 'sine', 0.09); },
        target: function () { tone(620, 0.1, 'triangle', 0.1, 940); },
        drop: function () { tone(440, 0.16, 'sawtooth', 0.05, 180); },
        spin: function () { tone(1700, 0.02, 'square', 0.025); },
        saucer: function () { tone(260, 0.35, 'sine', 0.12, 900); },
        launch: function () { tone(180, 0.3, 'sawtooth', 0.045, 640); },
        drain: function () { tone(420, 0.7, 'triangle', 0.12, 70); },
        save: function () { arp([784, 1047, 1319], 0.07, 'sine', 0.09); },
        bank: function () { arp([523, 659, 784, 1047], 0.06, 'square', 0.05); },
        ramp: function () { arp([392, 523, 659, 784, 1047], 0.05, 'sine', 0.1); },
        mult: function () { arp([659, 784, 988, 1319, 1568], 0.07, 'triangle', 0.11); },
        jackpot: function () { arp([523, 659, 784, 1047, 784, 1047, 1319, 1568], 0.08, 'square', 0.06); }
    };

    function sfx(name) {
        if (!soundOn || !audio || audio.state !== 'running') {
            return;
        }
        const now = audio.currentTime;
        if (now - (lastSfx[name] || -1) < 0.035) { // 同一種聲音太密就略過，避免爆音
            return;
        }
        lastSfx[name] = now;
        SFX[name]();
    }

    function vibrate(ms) {
        if (soundOn && navigator.vibrate) {
            try {
                navigator.vibrate(ms);
            } catch (e) {
                // 不支援就算了
            }
        }
    }

    let level = LEVELS[storageGet(LEVEL_KEY)] ? storageGet(LEVEL_KEY) : 'normal';
    let state = null;
    let playerName = G.readName();
    let canvas = null;
    let ctx = null;
    let frame = 0;

    // --- 排行榜與最高分 (跟貪吃蛇同一套) ---

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
            row.html('<span class="bday-name-current">🎯 <b></b></span>' +
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
        drawTable(performance.now());
        const best = readBest();
        $('#bday-overlay').html(
            '<div class="bday-overlay-box">' +
            '<p class="bday-overlay-big">🎯 讀書彈珠台</p>' +
            '<p>撞 📚 ✏️ 📐 彈簧柱得分；點亮上方三條科目通道，倍率最高 ×' + MAX_MULT + '！<br>' +
            '把球打進左邊 🎢 坡道 (連發加倍)，衝 3 次 ⭐ 洞會變 💰 大獎；<br>打倒中間三片落下靶、打滿 📝 考卷、轉旋轉片也有分。</p>' +
            '<p>手機：按住畫面右下發射，點左半邊、右半邊打擋板。<br>電腦：按住空白鍵發射，← → 或 Z / M 打擋板，P 暫停。</p>' +
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

    // --- 檯面 ---

    function seg(x1, y1, x2, y2, opts) {
        return $.extend({ x1: x1, y1: y1, x2: x2, y2: y2, e: 0.45, kick: 0, draw: true }, opts || {});
    }

    // 建一張新檯面 (每局重建，燈號、考卷狀態都歸零)
    function buildTable(info) {
        const t = { segs: [], bumpers: [], lanes: [], targets: [], flippers: [] };
        const s = t.segs;
        // 上方圓頂：從右牆 (380,190) 繞過頂端到左牆 (20,190)
        const cx = 200, cy = 190, rr = 180, n = 28;
        for (let i = 0; i < n; i++) {
            const a1 = Math.PI * i / n, a2 = Math.PI * (i + 1) / n;
            s.push(seg(cx + rr * Math.cos(a1), cy - rr * Math.sin(a1), cx + rr * Math.cos(a2), cy - rr * Math.sin(a2), { arc: true }));
        }
        s.push(seg(20, 190, 20, 720));                 // 左牆 (下面是左邊的出界道)
        s.push(seg(380, 190, 380, 700));               // 右外牆
        s.push(seg(LANE_X, GATE_Y + 10, LANE_X, 700)); // 發射通道內牆
        s.push(seg(LANE_X, 690, 380, 690, { e: 0.1, draw: false })); // 發射台
        s.push(seg(380, GATE_Y - 20, LANE_X, GATE_Y + 10, { gate: true, e: 0.3 })); // 斜的單向門：球只能往上出去，掉回來會滾進檯面
        // 下方導軌：把球送到擋板上
        // 彈弓 (擋板上方的三角形，斜邊會把球彈開)；彈弓外側是出界道，掉進去就沒了
        const slingHit = function (b) {
            addScore(1);
            sfx('sling');
            burst(b.x, b.y, '#ffca28', 5, 150);
            shake(1.5);
        };
        s.push(seg(56, 440, 94, 546, { e: 0.6, kick: 330, sling: true, onHit: slingHit }));
        s.push(seg(56, 440, 56, 520));
        s.push(seg(56, 520, 94, 546));
        s.push(seg(316, 440, 278, 546, { e: 0.6, kick: 330, sling: true, onHit: slingHit }));
        s.push(seg(316, 440, 316, 520));
        s.push(seg(316, 520, 278, 546));
        // 導軌：從彈弓底下接到擋板軸心，跟擋板一樣粗，球才會順順滾上擋板，不會卡在接縫
        s.push(seg(56, 520, 110, 600, { thick: 7 }));
        s.push(seg(316, 520, 262, 600, { thick: 7 }));
        // 上方三條科目通道的隔柱
        s.push(seg(165, 92, 165, 140));
        s.push(seg(235, 92, 235, 140));
        t.lanes = [
            { x: 130, icon: '📚', lit: false, cool: 0 },
            { x: 200, icon: '✏️', lit: false, cool: 0 },
            { x: 270, icon: '📐', lit: false, cool: 0 }
        ];
        // 左上斜板：把沿著圓頂滑下來的球踢進中間 (黏在牆上，球不會卡在縫裡)
        s.push(seg(20, 178, 64, 224, { e: 0.6, kick: 220, sling: true, onHit: slingHit }));
        // 彈簧柱
        t.bumpers = [
            { x: 130, y: 245, r: 24, icon: '📚', flash: 0 },
            { x: 270, y: 245, r: 24, icon: '✏️', flash: 0 },
            { x: 200, y: 325, r: 24, icon: '📐', flash: 0 }
        ];
        // 左側坡道入口：球夠快衝進去就會走架高的坡道，繞一圈從右邊落到右擋板
        t.ramp = { x1: 34, x2: 82, y1: 248, y2: 284, count: 0, combo: 0, last: -99 };
        // 右側旋轉片：球衝過去會一直轉，每轉半圈得分
        t.spinner = { x1: 318, x2: 346, y: 262, a: 0, w: 0, half: 0 };
        // 中間的落下靶：打倒一片少一片，三片都倒有大獎，2 秒後再升起來
        t.drops = [];
        t.dropReset = 0;
        [170, 206, 242].forEach(function (x) {
            const d = { x: x, y: 395, down: false, flash: 0 };
            t.drops.push(d);
            s.push(seg(x - 13, 395, x + 13, 395, { e: 0.5, thick: 4, draw: false, dropT: d, onHit: function () { hitDrop(d); } }));
        });
        // 右側三張考卷 (站立靶)
        [300, 345, 390].forEach(function (y, i) {
            const target = { y: y, hit: false, flash: 0, index: i };
            t.targets.push(target);
            s.push(seg(344, y - 14, 344, y + 14, { e: 0.5, target: target, draw: false, onHit: function () { hitTarget(target); } }));
        });
        // ⭐ 洞
        t.saucer = { x: 62, y: 340, r: 14, flash: 0, jackpot: false };
        // 擋板：左邊往右指、右邊往左指；rest 是放下時的角度，up 是打上去
        t.flippers = [
            { side: 'left', x: 110, y: 600, len: info.flipper, rest: 0.5, up: -0.45, a: 0.5, w: 0 },
            { side: 'right', x: 262, y: 600, len: info.flipper, rest: Math.PI - 0.5, up: Math.PI + 0.45, a: Math.PI - 0.5, w: 0 },
            // 左牆中間的小擋板 (跟左擋板一起動)，可以把球挑回坡道或 ⭐ 洞
            { side: 'left', x: 25, y: 368, len: 34, rest: 0.55, up: -0.55, a: 0.55, w: 0, mini: true }
        ];
        return t;
    }

    function startGame() {
        const info = LEVELS[level];
        state = {
            running: true,
            paused: false,
            level: level,
            info: info,
            score: 0,
            balls: info.balls,
            mult: 1,
            table: buildTable(info),
            ball: null,
            keys: { left: false, right: false },
            charging: false,
            charge: 0,
            saveUntil: 0,
            msg: '',
            msgUntil: 0,
            last: performance.now(),
            acc: 0,
            time: 0,
            submitted: false,
            fx: { parts: [], pops: [], rings: [], trail: [], shake: 0, flashAll: 0, flashColor: '' }
        };
        initAudio();
        newBall();
        $('#bday-overlay').hide().empty();
        $('body').addClass('bday-playing');
        renderHud();
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(loop);
    }

    function newBall() {
        state.ball = { x: 366, y: 690 - R - 1, vx: 0, vy: 0, held: 0, ramp: 0 };
        state.charge = 0;
        state.fx.trail = [];
    }

    // --- 特效：粒子、跳分數字、光圈、震動 ---

    function burst(x, y, color, n, speed) {
        const parts = state.fx.parts;
        for (let i = 0; i < n && parts.length < 260; i++) {
            const a = Math.random() * Math.PI * 2;
            const v = speed * (0.35 + Math.random() * 0.65);
            parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 0.35 + Math.random() * 0.4, max: 0.75, color: color });
        }
    }

    function ring(x, y, color, size) {
        state.fx.rings.push({ x: x, y: y, color: color, size: size || 40, t0: state.time });
    }

    function pop(x, y, text, color) {
        if (state.fx.pops.length > 18) {
            state.fx.pops.shift();
        }
        state.fx.pops.push({ x: x, y: y, text: text, color: color || '#ffffff', t0: state.time });
    }

    function shake(amount) {
        state.fx.shake = Math.max(state.fx.shake, amount);
    }

    function flashAll(color, secs) {
        state.fx.flashAll = state.time + secs;
        state.fx.flashLen = secs;
        state.fx.flashColor = color;
    }

    function stepFx(dt) {
        const fx = state.fx;
        fx.parts = fx.parts.filter(function (p) {
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vy += 500 * dt;
            p.vx *= 0.97;
            return p.life > 0;
        });
        fx.pops = fx.pops.filter(function (p) { return state.time - p.t0 < 0.9; });
        fx.rings = fx.rings.filter(function (r) { return state.time - r.t0 < 0.45; });
        fx.shake = Math.max(0, fx.shake - dt * 30);
        const b = state.ball;
        if (b && !b.held) {
            const p = b.ramp ? rampPoint(b.ramp) : b;
            fx.trail.push({ x: p.x, y: p.y });
            if (fx.trail.length > 9) {
                fx.trail.shift();
            }
        }
    }

    function inLane(b) {
        return b.x > LANE_X && b.y > GATE_Y;
    }

    function readyToLaunch() {
        const b = state.ball;
        return b && inLane(b) && b.y > 640 && Math.abs(b.vy) < 60;
    }

    function launch() {
        if (!readyToLaunch()) {
            state.charging = false;
            state.charge = 0;
            return;
        }
        state.ball.vy = -(820 + 760 * state.charge);
        sfx('launch');
        state.charging = false;
        state.charge = 0;
        if (state.info.save) {
            state.saveUntil = state.time + state.info.save;
        }
    }

    function say(text) {
        state.msg = text;
        state.msgUntil = state.time + 1.4;
    }

    // 加分；有給位置就在那裡跳出分數
    function addScore(points, x, y, color) {
        const got = points * state.mult;
        state.score += got;
        if (x !== undefined) {
            pop(x, y, '+' + got, color);
        }
        return got;
    }

    function hitTarget(target) {
        target.flash = state.time + 0.3;
        addScore(5, 318, target.y - 12);
        sfx('target');
        burst(344, target.y, '#ffffff', 6, 160);
        if (target.hit) {
            return;
        }
        target.hit = true;
        if (state.table.targets.every(function (t) { return t.hit; })) {
            say('📝 考卷全對！+' + addScore(200));
            sfx('bank');
            flashAll('255, 255, 255', 0.35);
            state.table.targets.forEach(function (t) {
                t.hit = false;
                burst(344, t.y, '#ffca28', 12, 260);
            });
        }
    }

    function hitDrop(d) {
        if (d.down) {
            return;
        }
        const t = state.table;
        d.down = true;
        d.flash = state.time + 0.3;
        addScore(20, d.x, d.y - 18, '#ffb3c1');
        sfx('drop');
        burst(d.x, d.y, '#ff6b81', 14, 240);
        shake(3);
        if (t.drops.every(function (x) { return x.down; })) {
            say('🎯 落下靶全倒！+' + addScore(300));
            sfx('bank');
            vibrate(30);
            flashAll('255, 107, 129', 0.45);
            t.dropReset = state.time + 2;
        }
    }

    // 坡道路徑 (三次貝茲曲線)：左邊入口 → 繞上方 → 落到右擋板
    const RAMP_PATH = [[58, 266], [14, 30], [345, 40], [250, 470]];
    const RAMP_SECS = 1.1;

    function bezier(u) {
        const p = RAMP_PATH, v = 1 - u;
        const a = v * v * v, b = 3 * v * v * u, c = 3 * v * u * u, d = u * u * u;
        return {
            x: a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0],
            y: a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]
        };
    }

    function rampPoint(t0) {
        return bezier(Math.min(1, (state.time - t0) / RAMP_SECS));
    }

    function enterRamp(b) {
        const r = state.table.ramp;
        b.ramp = state.time;
        r.combo = state.time - r.last < 8 ? Math.min(5, r.combo + 1) : 1;
        r.last = state.time;
        r.count++;
        const got = addScore(100 * r.combo);
        say(r.combo > 1 ? '🎢 坡道連發 ×' + r.combo + '！+' + got : '🎢 坡道 +' + got);
        sfx('ramp');
        vibrate(20);
        burst(58, 266, '#7fd6ff', 18, 260);
        ring(58, 266, '127, 214, 255', 46);
        if (r.count % 3 === 0 && !state.table.saucer.jackpot) {
            state.table.saucer.jackpot = true;
            setTimeout(function () {
                if (state && state.running) {
                    say('💰 ⭐ 洞亮了：大獎！');
                }
            }, 1300);
        }
    }

    function stepRamp(b) {
        const u = (state.time - b.ramp) / RAMP_SECS;
        if (u < 1) {
            return;
        }
        const p = bezier(1);
        b.ramp = 0;
        b.x = p.x;
        b.y = p.y;
        b.vx = 20;
        b.vy = 160;
        burst(p.x, p.y, '#7fd6ff', 10, 160);
    }

    // 擋板打上去時，點亮的通道跟著換位置 (方便把三條都點滿)
    function rotateLanes(dir) {
        const lanes = state.table.lanes;
        const lit = lanes.map(function (l) { return l.lit; });
        lanes.forEach(function (l, i) {
            l.lit = lit[(i - dir + lanes.length) % lanes.length];
        });
    }

    function setFlipper(side, down) {
        if (!state || !state.running || state.paused) {
            return;
        }
        if (state.keys[side] !== down && down) {
            rotateLanes(side === 'left' ? -1 : 1);
            sfx('flipper');
        }
        state.keys[side] = down;
    }

    // --- 物理 ---

    function clampSpeed(b) {
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > MAX_SPEED) {
            b.vx *= MAX_SPEED / sp;
            b.vy *= MAX_SPEED / sp;
        }
    }

    // 球撞線段 (含擋板)；vpx/vpy 是接觸點本身的速度 (擋板在轉)
    function collideSegment(b, s, rad, vpx, vpy) {
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
        const l2 = dx * dx + dy * dy;
        let t = ((b.x - s.x1) * dx + (b.y - s.y1) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
        const px = s.x1 + t * dx, py = s.y1 + t * dy;
        let nx = b.x - px, ny = b.y - py;
        const d = Math.hypot(nx, ny);
        if (d >= rad || d === 0) {
            return null;
        }
        if (s.gate && b.vy <= 0) {
            return null; // 單向門：往上的球直接穿過
        }
        nx /= d;
        ny /= d;
        b.x = px + nx * rad;
        b.y = py + ny * rad;
        const rvx = b.vx - (vpx || 0), rvy = b.vy - (vpy || 0);
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
            b.vx = (vpx || 0) + rvx - (1 + s.e) * vn * nx;
            b.vy = (vpy || 0) + rvy - (1 + s.e) * vn * ny;
            if (s.kick && -vn > 60) {
                b.vx += nx * s.kick;
                b.vy += ny * s.kick;
                s.flash = state.time + 0.15;
            }
            if (s.onHit && -vn > 40 && state.time > (s.cool || 0)) {
                s.cool = state.time + 0.08;
                s.onHit(b);
            }
        }
        return { px: px, py: py };
    }

    function flipperTip(f) {
        return { x: f.x + f.len * Math.cos(f.a), y: f.y + f.len * Math.sin(f.a) };
    }

    function stepFlippers(dt) {
        state.table.flippers.forEach(function (f) {
            const pressed = state.keys[f.side];
            const target = pressed ? f.up : f.rest;
            const speed = pressed ? 22 : 12; // 弧度/秒
            const diff = target - f.a;
            const move = Math.sign(diff) * Math.min(Math.abs(diff), speed * dt);
            f.w = move / dt;
            f.a += move;
        });
    }

    function physicsStep(dt) {
        const b = state.ball;
        state.time += dt;
        stepFlippers(dt);
        const t = state.table;
        // 落下靶時間到就升起來
        if (t.dropReset && state.time >= t.dropReset) {
            t.dropReset = 0;
            t.drops.forEach(function (d) {
                d.down = false;
                d.flash = state.time + 0.3;
            });
        }
        // 旋轉片慢慢停下來，每轉半圈得分
        const sp = t.spinner;
        if (sp.w > 0) {
            sp.a += sp.w * dt;
            sp.w = Math.max(0, sp.w - (3 + sp.w * 0.7) * dt);
            const half = Math.floor(sp.a / Math.PI);
            if (half !== sp.half) {
                sp.half = half;
                addScore(2);
                sfx('spin');
            }
        }
        if (!b) {
            return;
        }
        // 在坡道上：照路徑走，不算碰撞
        if (b.ramp) {
            stepRamp(b);
            return;
        }
        // 發射蓄力
        if (state.charging) {
            state.charge = Math.min(1, state.charge + dt / 1.1);
        }
        // ⭐ 洞把球吸住一下再吐出來
        if (b.held) {
            if (state.time >= b.held) {
                b.held = 0;
                b.vx = 260 + Math.random() * 120;
                b.vy = -380 - Math.random() * 120;
            }
            return;
        }
        const oldY = b.y;
        b.vy += state.info.gravity * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        // 穿過旋轉片 → 依速度轉起來
        if ((oldY - sp.y) * (b.y - sp.y) <= 0 && oldY !== b.y && b.x > sp.x1 && b.x < sp.x2) {
            sp.w = Math.min(70, sp.w + Math.abs(b.vy) / 22);
            burst(b.x, sp.y, '#b388ff', 4, 120);
        }
        // 往上衝進坡道入口
        const rp = t.ramp;
        if (b.vy < -380 && b.x > rp.x1 && b.x < rp.x2 && b.y > rp.y1 && b.y < rp.y2) {
            enterRamp(b);
            return;
        }
        t.segs.forEach(function (s) {
            if (s.dropT && s.dropT.down) {
                return;
            }
            collideSegment(b, s, R + (s.thick || 2));
        });
        t.flippers.forEach(function (f) {
            const tip = flipperTip(f);
            const fs = { x1: f.x, y1: f.y, x2: tip.x, y2: tip.y, e: 0.3 };
            // 接觸點的速度 = 角速度 × 半徑；擋板往上打時把球打飛
            const dx = tip.x - f.x, dy = tip.y - f.y;
            const u = Math.max(0, Math.min(1, ((b.x - f.x) * dx + (b.y - f.y) * dy) / (dx * dx + dy * dy)));
            const rx = dx * u, ry = dy * u;
            collideSegment(b, fs, R + (f.mini ? 5 : 7), -f.w * ry, f.w * rx);
        });
        t.bumpers.forEach(function (p) {
            const dx = b.x - p.x, dy = b.y - p.y;
            const d = Math.hypot(dx, dy);
            const rad = p.r + R;
            if (d < rad && d > 0) {
                const nx = dx / d, ny = dy / d;
                b.x = p.x + nx * rad;
                b.y = p.y + ny * rad;
                const vn = b.vx * nx + b.vy * ny;
                if (vn < 0) {
                    b.vx -= 1.9 * vn * nx;
                    b.vy -= 1.9 * vn * ny;
                }
                b.vx += nx * 280;
                b.vy += ny * 280;
                if (state.time > (p.cool || 0)) { // 同一顆連續碰到只算一次分
                    addScore(10, p.x, p.y - p.r - 10, '#fff3c4');
                    p.cool = state.time + 0.08;
                    sfx('bumper');
                    burst(p.x + nx * p.r, p.y + ny * p.r, '#ffe082', 10, 220);
                    ring(p.x, p.y, '255, 202, 40', p.r + 22);
                    shake(2.5);
                    vibrate(8);
                }
                p.flash = state.time + 0.18;
            }
        });
        // 上方通道：經過就點亮，三條都亮 → 倍率 +1
        if (b.y > 100 && b.y < 135) {
            t.lanes.forEach(function (l) {
                if (Math.abs(b.x - l.x) < 18 && state.time > l.cool) {
                    l.cool = state.time + 0.5;
                    addScore(3, l.x, 92);
                    if (!l.lit) {
                        sfx('lane');
                        ring(l.x, 118, '255, 202, 40', 30);
                    }
                    l.lit = true;
                }
            });
            if (t.lanes.every(function (l) { return l.lit; })) {
                t.lanes.forEach(function (l) {
                    l.lit = false;
                    burst(l.x, 118, '#ffca28', 14, 240);
                });
                sfx('mult');
                vibrate(25);
                flashAll('255, 202, 40', 0.6);
                if (state.mult < MAX_MULT) {
                    state.mult++;
                    say('🔥 倍率 ×' + state.mult + '！');
                } else {
                    say('🔥 倍率全滿！+' + addScore(150));
                }
            }
        }
        // ⭐ 洞
        const sc = t.saucer;
        if (Math.hypot(b.x - sc.x, b.y - sc.y) < sc.r && state.time > (sc.cool || 0)) {
            b.x = sc.x;
            b.y = sc.y;
            b.vx = 0;
            b.vy = 0;
            b.held = state.time + 0.9;
            sc.cool = state.time + 2;
            sc.flash = state.time + 0.9;
            ring(sc.x, sc.y, '255, 224, 130', 44);
            if (sc.jackpot) {
                sc.jackpot = false;
                say('💰 大獎！+' + addScore(1000));
                sfx('jackpot');
                vibrate([40, 40, 80]);
                shake(6);
                flashAll('255, 224, 130', 0.9);
                burst(sc.x, sc.y, '#ffe082', 40, 360);
            } else {
                say('⭐ 加分洞 +' + addScore(75));
                sfx('saucer');
                burst(sc.x, sc.y, '#ffe082', 14, 200);
            }
        }
        clampSpeed(b);
        // 保險：球卡住不動 (又沒在按擋板接住它) 超過 2.5 秒就輕推一下
        if (Math.hypot(b.vx, b.vy) < 15 && !inLane(b) && !state.keys.left && !state.keys.right) {
            b.still = (b.still || 0) + dt;
            if (b.still > 2.5) {
                b.still = 0;
                b.vx += (Math.random() - 0.5) * 240;
                b.vy -= 260;
            }
        } else {
            b.still = 0;
        }
        // 掉下去了
        if (b.y > H + 20 || b.x < -20 || b.x > W + 20) {
            loseBall();
        }
    }

    function loseBall() {
        if (state.time < state.saveUntil) {
            say('🛟 救回來了！');
            sfx('save');
            state.saveUntil = 0;
            newBall();
            return;
        }
        sfx('drain');
        vibrate(120);
        shake(8);
        flashAll('255, 60, 60', 0.5);
        state.balls--;
        renderHud();
        if (state.balls <= 0) {
            state.ball = null;
            endGame('球都掉光了！');
            return;
        }
        say('還剩 ' + state.balls + ' 顆球');
        newBall();
    }

    function loop(now) {
        if (!state || !state.running) {
            return;
        }
        let dt = Math.min(0.05, (now - state.last) / 1000);
        state.last = now;
        if (!state.paused) {
            state.acc += dt;
            while (state.acc >= STEP) {
                physicsStep(STEP);
                state.acc -= STEP;
                if (!state.running) {
                    break;
                }
            }
            stepFx(dt);
            renderHud();
        }
        drawTable(now);
        if (state.running) {
            frame = requestAnimationFrame(loop);
        }
    }

    function pause() {
        if (!state || !state.running || state.paused) {
            return;
        }
        state.paused = true;
        state.keys.left = state.keys.right = false;
        state.charging = false;
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
        state.last = performance.now();
        $('#bday-overlay').hide().empty();
    }

    let hudCache = '';
    function renderHud() {
        const text = state ? state.score + '|' + state.balls + '|' + state.mult : '';
        if (text === hudCache) {
            return;
        }
        hudCache = text;
        $('#pinball-score').text(state ? state.score : 0);
        $('#pinball-balls').text(state ? Math.max(0, state.balls) : LEVELS[level].balls);
        $('#pinball-mult').text(state ? state.mult : 1);
    }

    function getRating(score) {
        if (score >= 40000) return '👑 彈珠之神';
        if (score >= 15000) return '🥇 彈珠高手';
        if (score >= 4000) return '🌟 越打越順';
        return '🌱 新手上路';
    }

    function endGame(reason) {
        state.running = false;
        cancelAnimationFrame(frame);
        drawTable(performance.now());
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
        const w = Math.round(canvas.clientWidth * ratio);
        if (w && canvas.width !== w) {
            canvas.width = w;
            canvas.height = Math.round(w * H / W);
        }
        drawTable(performance.now());
    }

    function emoji(icon, x, y, size) {
        ctx.font = Math.round(size) + 'px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(icon, x, y + size * 0.06);
    }

    function line(s, color, width) {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
    }

    // 沒開局時也畫一張檯面當背景
    const previewTable = buildTable(LEVELS.normal);

    function drawTable(now) {
        if (!ctx) {
            return;
        }
        const k = canvas.width / W;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(k, 0, 0, k, 0, 0);
        const time = state ? state.time : now / 1000;
        const t = state ? state.table : previewTable;
        const fx = state ? state.fx : null;
        // 畫面震動
        if (fx && fx.shake > 0 && state.running) {
            ctx.translate((Math.random() - 0.5) * fx.shake * 2, (Math.random() - 0.5) * fx.shake * 2);
        }

        // 檯面底色
        const bg = ctx.createLinearGradient(0, 0, 0, H);
        bg.addColorStop(0, '#1f3b63');
        bg.addColorStop(1, '#13263f');
        ctx.fillStyle = bg;
        ctx.fillRect(-10, -10, W + 20, H + 20);
        // 圓頂上的跑馬燈 (全亮時代表剛拿到大獎)
        const allLit = fx && fx.flashAll > time;
        for (let i = 0; i <= 16; i++) {
            const a = Math.PI * i / 16;
            const on = allLit || Math.floor(time * 8 - i) % 6 === 0;
            ctx.fillStyle = on ? '#ffe082' : 'rgba(255, 224, 130, 0.18)';
            ctx.beginPath();
            ctx.arc(200 + 166 * Math.cos(a), 190 - 166 * Math.sin(a), on ? 3.2 : 2.4, 0, Math.PI * 2);
            ctx.fill();
        }
        // 發射通道
        ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        ctx.fillRect(LANE_X, GATE_Y, 380 - LANE_X, 690 - GATE_Y);
        // 中間的大字
        ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.font = '700 46px "Noto Sans TC", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('統測加油', 186, 430);

        // 牆
        t.segs.forEach(function (s) {
            if (!s.draw) {
                return;
            }
            if (s.sling) {
                line(s, (s.flash || 0) > time ? '#ffe082' : '#ffca28', 6);
            } else if (s.gate) {
                line(s, 'rgba(255, 255, 255, 0.35)', 2);
            } else {
                line(s, 'rgba(255, 255, 255, 0.85)', 4);
            }
        });

        // 上方通道
        t.lanes.forEach(function (l) {
            if (l.lit) { // 先畫光暈再畫圖示，圖示才不會被蓋住
                ctx.fillStyle = 'rgba(255, 202, 40, ' + (0.35 + 0.2 * Math.sin(time * 6 + l.x)) + ')';
                ctx.beginPath();
                ctx.arc(l.x, 118, 18, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = l.lit ? 1 : 0.45;
            emoji(l.icon, l.x, 118, 22);
            ctx.globalAlpha = 1;
        });

        // 考卷
        t.targets.forEach(function (tg) {
            ctx.fillStyle = tg.flash > time ? '#ffffff' : (tg.hit ? '#ffca28' : 'rgba(255, 255, 255, 0.25)');
            ctx.fillRect(340, tg.y - 14, 8, 28);
            ctx.globalAlpha = tg.hit ? 1 : 0.55;
            emoji('📝', 322, tg.y, 18);
            ctx.globalAlpha = 1;
        });

        // 落下靶
        t.drops.forEach(function (d) {
            if (d.down) {
                ctx.fillStyle = 'rgba(255, 107, 129, 0.18)';
                ctx.fillRect(d.x - 13, d.y - 2, 26, 4);
                return;
            }
            ctx.fillStyle = d.flash > time ? '#ffffff' : '#ff6b81';
            ctx.fillRect(d.x - 13, d.y - 5, 26, 10);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.fillRect(d.x - 13, d.y - 5, 26, 2);
        });

        // 旋轉片 (轉起來時寬度忽大忽小，看起來像在翻)
        const sp = t.spinner;
        const sw = Math.abs(Math.cos(sp.a));
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fillRect(sp.x1 - 3, sp.y - 2, 3, 4);
        ctx.fillRect(sp.x2, sp.y - 2, 3, 4);
        ctx.fillStyle = sp.w > 2 ? '#d1b3ff' : '#b388ff';
        ctx.fillRect(sp.x1, sp.y - 1 - 5 * sw, sp.x2 - sp.x1, 2 + 10 * sw);

        // 坡道入口的箭頭燈
        const rp = t.ramp;
        for (let i = 0; i < 3; i++) {
            const on = Math.floor(time * 5) % 3 === 2 - i;
            ctx.strokeStyle = on ? '#7fd6ff' : 'rgba(127, 214, 255, 0.25)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            const y = 304 - i * 11;
            ctx.moveTo(48, y + 6);
            ctx.lineTo(58, y - 2);
            ctx.lineTo(68, y + 6);
            ctx.stroke();
        }

        // ⭐ 洞 (亮大獎時閃金光)
        const sc = t.saucer;
        if (sc.jackpot) {
            ctx.fillStyle = 'rgba(255, 202, 40, ' + (0.35 + 0.3 * Math.sin(time * 9)) + ')';
            ctx.beginPath();
            ctx.arc(sc.x, sc.y, sc.r + 12, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillStyle = (sc.flash || 0) > time ? 'rgba(255, 224, 130, 0.6)' : 'rgba(0, 0, 0, 0.45)';
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, sc.r + 4, 0, Math.PI * 2);
        ctx.fill();
        emoji(sc.jackpot ? '💰' : '⭐', sc.x, sc.y, 18);

        // 彈簧柱
        t.bumpers.forEach(function (p) {
            const lit = p.flash > time;
            ctx.fillStyle = lit ? '#fff3c4' : '#3a7bd5';
            ctx.strokeStyle = lit ? '#ffca28' : 'rgba(255, 255, 255, 0.85)';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r + (lit ? 2 : 0), 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            if (p.icon) {
                emoji(p.icon, p.x, p.y, 24);
            }
        });

        // 擋板
        t.flippers.forEach(function (f) {
            const tip = flipperTip(f);
            line({ x1: f.x, y1: f.y, x2: tip.x, y2: tip.y }, '#ffca28', f.mini ? 10 : 14);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(f.x, f.y, 4, 0, Math.PI * 2);
            ctx.fill();
        });

        // 發射彈簧
        const charge = state ? state.charge : 0;
        ctx.fillStyle = '#90a4ae';
        ctx.fillRect(LANE_X + 5, 692 + charge * 18, 380 - LANE_X - 10, 6);
        if (state && state.charging) {
            ctx.fillStyle = '#ffca28';
            ctx.fillRect(LANE_X + 4, 712 - 60 * charge, 4, 60 * charge);
        }

        // 架高的坡道 (畫在檯面上方)
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(RAMP_PATH[0][0], RAMP_PATH[0][1]);
        ctx.bezierCurveTo(RAMP_PATH[1][0], RAMP_PATH[1][1], RAMP_PATH[2][0], RAMP_PATH[2][1], RAMP_PATH[3][0], RAMP_PATH[3][1]);
        const rampLit = state && state.time - rp.last < 1.2;
        ctx.strokeStyle = rampLit ? 'rgba(127, 214, 255, 0.32)' : 'rgba(127, 214, 255, 0.13)';
        ctx.lineWidth = 24;
        ctx.stroke();
        ctx.strokeStyle = rampLit ? 'rgba(200, 240, 255, 0.8)' : 'rgba(200, 240, 255, 0.3)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.lineDashOffset = -time * 40;
        ctx.stroke();
        ctx.setLineDash([]);

        // 光圈
        if (fx) {
            fx.rings.forEach(function (r) {
                const u = (state.time - r.t0) / 0.45;
                ctx.strokeStyle = 'rgba(' + r.color + ', ' + (1 - u) + ')';
                ctx.lineWidth = 3 * (1 - u) + 1;
                ctx.beginPath();
                ctx.arc(r.x, r.y, r.size * (0.6 + 0.6 * u), 0, Math.PI * 2);
                ctx.stroke();
            });
        }

        // 球 (拖尾 → 本體；在坡道上畫大一點，像是被架高)
        const b = state && state.ball;
        if (b) {
            const p = b.ramp ? rampPoint(b.ramp) : b;
            const size = b.ramp ? R * 1.25 : R;
            fx.trail.forEach(function (q, i) {
                ctx.fillStyle = 'rgba(200, 230, 255, ' + (0.05 + 0.3 * i / fx.trail.length) + ')';
                ctx.beginPath();
                ctx.arc(q.x, q.y, size * (0.4 + 0.5 * i / fx.trail.length), 0, Math.PI * 2);
                ctx.fill();
            });
            const g = ctx.createRadialGradient(p.x - 3, p.y - 3, 1, p.x, p.y, size);
            g.addColorStop(0, '#ffffff');
            g.addColorStop(1, '#9fb3c8');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
            ctx.fill();
        }

        if (fx) {
            // 粒子
            fx.parts.forEach(function (q) {
                ctx.globalAlpha = Math.max(0, q.life / q.max);
                ctx.fillStyle = q.color;
                ctx.fillRect(q.x - 1.5, q.y - 1.5, 3, 3);
            });
            ctx.globalAlpha = 1;
            // 跳出來的分數
            ctx.font = '700 13px "Noto Sans TC", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            fx.pops.forEach(function (q) {
                const u = (state.time - q.t0) / 0.9;
                ctx.globalAlpha = 1 - u;
                ctx.fillStyle = q.color;
                ctx.fillText(q.text, q.x, q.y - 26 * u);
            });
            ctx.globalAlpha = 1;
            // 全畫面閃光
            if (fx.flashAll > time) {
                ctx.fillStyle = 'rgba(' + fx.flashColor + ', ' + (0.28 * (fx.flashAll - time) / fx.flashLen) + ')';
                ctx.fillRect(-10, -10, W + 20, H + 20);
            }
        }

        if (state) {
            // 救球中的提示燈
            if (state.time < state.saveUntil) {
                ctx.fillStyle = Math.floor(state.time * 4) % 2 ? '#7cf0a8' : 'rgba(124, 240, 168, 0.4)';
                ctx.font = '700 14px "Noto Sans TC", sans-serif';
                ctx.fillText('🛟 救球中', 186, 680);
            }
            if (readyToLaunch() && !state.charging) {
                ctx.fillStyle = 'rgba(255, 255, 255, ' + (0.55 + 0.35 * Math.sin(time * 5)) + ')';
                ctx.font = '700 13px "Noto Sans TC", sans-serif';
                ctx.fillText('按住發射 ↑', 300, 660);
            }
            if (state.msgUntil > state.time) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.fillRect(56, 448, 260, 44);
                ctx.fillStyle = '#ffffff';
                ctx.font = '700 18px "Noto Sans TC", sans-serif';
                ctx.fillText(state.msg, 186, 471);
            }
            if (!state.running && !state.paused) {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
                ctx.fillRect(0, 0, W, H);
            }
        }
    }

    function buildGame() {
        $('#bday-game').html(
            '<div class="bday-game-panel">' +
            '<h2 class="bday-game-title">🎯 讀書彈珠台</h2>' +
            '<div class="bday-game-hud">' +
            '<span>⭐ <b id="pinball-score">0</b></span>' +
            '<span>⚪ <b id="pinball-balls">3</b></span>' +
            '<span>✖️ <b id="pinball-mult">1</b></span>' +
            '<button type="button" class="snake-pause pinball-sound" aria-label="音效開關">' + (soundOn ? '🔊' : '🔇') + '</button>' +
            '<button type="button" class="snake-pause pinball-pause" aria-label="暫停">⏸️</button>' +
            '</div>' +
            '<div class="bday-game-stage pinball-stage"><canvas class="pinball-canvas"></canvas></div>' +
            '<p class="bday-hint">手機：按住右下發射、點左右兩半打擋板；電腦：空白鍵發射，← → 或 Z / M 打擋板，P 暫停</p>' +
            '<div id="bday-overlay" class="bday-overlay"><div class="bday-overlay-box"><p>讀取中…</p></div></div>' +
            '</div>'
        );
        canvas = $('#bday-game .pinball-canvas')[0];
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
            renderHud();
        });
        game.on('keydown', '.bday-name', function (e) {
            if (e.key === 'Enter') {
                handleStart();
            }
        });
        game.on('click', '.pinball-pause', pause);
        game.on('click', '.pinball-sound', function () {
            soundOn = !soundOn;
            storageSet(SOUND_KEY, soundOn ? 'on' : 'off');
            $(this).text(soundOn ? '🔊' : '🔇');
            if (soundOn) {
                initAudio();
            }
        });

        const LEFT_KEYS = { ArrowLeft: 1, z: 1, Z: 1, a: 1, A: 1, ShiftLeft: 1 };
        const RIGHT_KEYS = { ArrowRight: 1, m: 1, M: 1, '/': 1, l: 1, L: 1, ShiftRight: 1 };
        function playing() {
            return state && state.running && !state.paused;
        }
        $(document).on('keydown keyup', function (e) {
            if ($(e.target).is('input')) {
                return;
            }
            const down = e.type === 'keydown';
            const key = e.key === 'Shift' ? e.code : e.key;
            if (LEFT_KEYS[key] || RIGHT_KEYS[key]) {
                if (playing()) {
                    e.preventDefault();
                    setFlipper(LEFT_KEYS[key] ? 'left' : 'right', down);
                }
            } else if (e.key === ' ' || e.key === 'ArrowDown') {
                if (playing()) {
                    e.preventDefault(); // 不要捲動頁面
                    if (down && !e.originalEvent.repeat && readyToLaunch()) {
                        state.charging = true;
                    } else if (!down && state.charging) {
                        launch();
                    }
                }
            } else if (down && (e.key === 'p' || e.key === 'P' || e.key === 'Escape')) {
                if (state && state.running) {
                    if (state.paused) {
                        resume();
                    } else {
                        pause();
                    }
                }
            } else if (down && e.key === 'Enter' && !playing()) {
                $('#bday-overlay .bday-start').first().trigger('click');
            }
        });

        // 手機：每根手指按在左半邊 = 左擋板、右半邊 = 右擋板；球在發射台時，按住右下角蓄力、放開發射
        const touches = {};
        function syncTouches() {
            let left = false, right = false;
            Object.keys(touches).forEach(function (id) {
                if (touches[id] === 'left') left = true;
                if (touches[id] === 'right') right = true;
            });
            setFlipper('left', left);
            setFlipper('right', right);
        }
        canvas.addEventListener('touchstart', function (e) {
            if (!playing()) {
                return;
            }
            e.preventDefault();
            const rect = canvas.getBoundingClientRect();
            Array.prototype.forEach.call(e.changedTouches, function (t) {
                const x = (t.clientX - rect.left) / rect.width * W;
                const y = (t.clientY - rect.top) / rect.height * H;
                if (readyToLaunch() && x > LANE_X - 60 && y > H * 0.55) {
                    touches[t.identifier] = 'launch';
                    state.charging = true;
                } else {
                    touches[t.identifier] = x < W * 0.465 ? 'left' : 'right';
                }
            });
            syncTouches();
        }, { passive: false });
        function touchEnd(e) {
            Array.prototype.forEach.call(e.changedTouches, function (t) {
                if (touches[t.identifier] === 'launch' && state && state.charging) {
                    launch();
                }
                delete touches[t.identifier];
            });
            if (playing()) {
                e.preventDefault();
                syncTouches();
            }
        }
        canvas.addEventListener('touchend', touchEnd, { passive: false });
        canvas.addEventListener('touchcancel', touchEnd, { passive: false });
        // 滑鼠：左鍵按左半邊 / 右半邊 (方便電腦沒鍵盤時測試)
        canvas.addEventListener('mousedown', function (e) {
            if (!playing()) {
                return;
            }
            const rect = canvas.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width * W;
            const y = (e.clientY - rect.top) / rect.height * H;
            if (readyToLaunch() && x > LANE_X - 60 && y > H * 0.55) {
                state.charging = true;
                touches.mouse = 'launch';
            } else {
                touches.mouse = x < W * 0.465 ? 'left' : 'right';
                syncTouches();
            }
        });
        $(window).on('mouseup', function () {
            if (touches.mouse === 'launch' && state && state.charging) {
                launch();
            }
            delete touches.mouse;
            if (playing()) {
                syncTouches();
            }
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
