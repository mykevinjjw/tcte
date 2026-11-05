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

// --- 統測倒數網頁上的生日小遊戲排行榜與問卷 (遊戲本身在 games.mykevin.dpdns.org) ---
(function ($) {

    const G = window.TcteGames;

    // 問卷第 3 題的選項 (要和遊戲的需求、server.py 的 SURVEY_HARDEST 一致)
    const needs = [
        { face: '🤤', text: '肚子餓' },
        { face: '😭', text: '哭哭了' },
        { face: '🥱', text: '想睡覺' },
        { face: '💩', text: '換尿布' },
        { face: '🤕', text: '跌倒了' }
    ];

    // --- 伺服器上的開放狀態 (開放日期由管理後台設定) ---
    const STATUS_REFRESH_MS = 60000;
    let serverOpen = null; // 現在能不能玩 (無限期開放時每天都是 true)
    let serverEvent = null; // 今天是不是活動日 (生日橫幅)；null：還沒查到，main.js 會改用預設日期
    let surveyOpen = false; // 遊戲結束後的小問卷 (後台可以關閉)
    // 剛開頁面時先等伺服器回覆一下，避免用預設日期先顯示遊戲按鈕、查到後又消失
    const STATUS_WAIT_MS = 3000;
    let statusPending = true;
    setTimeout(function () {
        statusPending = false;
    }, STATUS_WAIT_MS);

    function refreshStatus() {
        G.request('/status').then(function (status) {
            serverOpen = status.open === true;
            serverEvent = status.event === true;
            surveyOpen = status.survey === true;
            updateSurveyButton();
            updatePanelTitle();
        }).catch(function () {
            // 查不到就維持上一次的結果
        }).then(function () {
            statusPending = false;
        });
    }

    // undefined：還在等伺服器 (先不顯示)；null：查不到，main.js 改用預設日期
    window.isBirthdayGameOpen = function () {
        return statusPending && serverEvent === null ? undefined : serverEvent;
    };
    refreshStatus();
    setInterval(refreshStatus, STATUS_REFRESH_MS);

    // 遊戲網站的網址，帶上這台裝置的暱稱，到那邊不用重新登記
    window.birthdayGameUrl = function () {
        return G.linkWithIdentity(G.GAMES_URL + 'birthday/');
    };

    function readName() {
        return G.readName();
    }

    function renderLeaderboard(container, highlight) {
        G.renderLeaderboard(container, highlight, serverOpen === false);
    }

    // --- 頁面旁固定的排行榜 (開放期間由 main.js 開啟) ---
    const PANEL_REFRESH_MS = 5000;
    const PANEL_CLOSED_REFRESH_MS = 60000; // 遊戲沒開放時，分數只有後台會改
    let panelTimer = null;
    let panelHighlight = readName() ? { name: readName() } : null;

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
            panel.on('click', '.bday-play-btn', function () {
                this.href = window.birthdayGameUrl();
            });
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
        updatePanelTitle();
    };

    // 標題、「去玩」按鈕與更新頻率看現在能不能玩 (無限期開放時每天都能玩)
    let panelOpen = null;
    function updatePanelTitle() {
        const panel = $('#bday-lb-panel');
        const open = serverOpen === true;
        if (!panel.length || open === panelOpen) {
            return;
        }
        panelOpen = open;
        panel.find('.bday-lb-panel-toggle').text(open ? '🏆 小遊戲排行榜' : '🏆 小遊戲排行榜 (暫停中)');
        panel.find('.bday-play-btn').remove();
        if (open) {
            $('<a class="bday-survey-btn bday-play-btn">🎮 去玩小遊戲</a>')
                .attr('href', G.GAMES_URL + 'birthday/')
                .insertAfter(panel.find('.bday-lb'));
        }
        clearInterval(panelTimer);
        panelTimer = setInterval(refreshPanel, open ? PANEL_REFRESH_MS : PANEL_CLOSED_REFRESH_MS);
    }

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
        // 伺服器已經排除活動日 (遊戲進行中不收問卷)
        const show = surveyOpen && readName() !== '';
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
            SURVEY_SEAT_MIN + '" max="' + SURVEY_SEAT_MAX + '" step="1"></div></fieldset>' +
            '<fieldset><legend>2. 遊戲好玩嗎？</legend>' + choiceList('fun', 'radio', stars) + '</fieldset>' +
            '<fieldset><legend>3. 最讓你手忙腳亂的是哪一種？</legend>' + choiceList('hardest', 'radio', hardest) + '</fieldset>' +
            '<fieldset><legend>4. 明年還想玩嗎？</legend>' + choiceList('again', 'radio', plain(SURVEY_AGAIN)) + '</fieldset>' +
            '<fieldset><legend>5. 要送給排行榜前三名的小禮物，你建議送什麼？（可複選）</legend>' +
            choiceList('gifts', 'checkbox', plain(SURVEY_GIFTS)) +
            '<input type="text" name="gift_other" class="bday-survey-input" maxlength="' + SURVEY_OTHER_LENGTH +
            '" placeholder="其他建議（選填）"></fieldset>' +
            '<fieldset><legend>6. 想對避雷針說的生日祝福（選填）</legend>' +
            '<textarea name="wish" class="bday-survey-input" rows="3" maxlength="' + SURVEY_TEXT_LENGTH + '"></textarea></fieldset>' +
            '<fieldset><legend>7. 給站長的建議（選填）</legend>' +
            '<textarea name="advice" class="bday-survey-input" rows="2" maxlength="' + SURVEY_TEXT_LENGTH + '"></textarea></fieldset>' +
            '<p class="bday-submit-msg"></p>' +
            '<button type="submit" class="bday-start">送出 ✉️</button>' +
            '</form>' +
            '<div class="bday-survey-done" style="display:none">' +
            '<p class="bday-overlay-big">🎁 謝謝你填問卷！</p>' +
            '<p>前三名的小禮物決定好之後，站長會再公布喔。</p>' +
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
        G.postJson('/survey/load', { name: name, token: G.getToken() }).then(function (result) {
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
        G.postJson('/survey', { name: readName(), token: G.getToken(), answers: answers }).then(function () {
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

})(jQuery);
