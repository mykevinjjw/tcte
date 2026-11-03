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
$(document).ready(function () {

    // --- 測試用變數 ---
    // 若要測試特定日期與時間，請填寫下列欄位。
    // 若所有值皆為 null，則使用目前即時時間。
    const debugYear = null;    // 例如：2025
    const debugMonth = null;      // 注意：月份為 1-12
    const debugDay = null;       // 例如：28
    const debugHour = null;      // 0-23
    const debugMinute = null;    // 0-59
    const debugSecond = null;    // 0-59

    // 計算測試時間與目前實際時間的差值 (offset)
    let timeOffset = 0;
    if (debugYear !== null && debugMonth !== null && debugDay !== null) {
        const debugTime = new Date(debugYear, debugMonth - 1, debugDay, debugHour || 0, debugMinute || 0, debugSecond || 0);
        timeOffset = debugTime.getTime() - new Date().getTime();
    }

    // --- 日期狀態設定 ---
    // 用於標示統測日期是否為官方公告的正式日期
    // key 為「學年度」, 1: 正式, 0: 暫定
    const examDateStatus = {
        2025: 1, // 2025學年度 (對應2026年的考試) 為暫定日期
        2026: 0  // 2026學年度 (對應2027年的考試) 為正式日期
    };

    // --- 自動計算統測日期 ---
    function getTcteDate(year) {
        // 4月是第3個月 (0-indexed), 從4月30日開始往前找
        const date = new Date(year, 3, 30);
        // 迴圈直到找到星期六 (getDay() === 6)
        while (date.getDay() !== 6) {
            date.setDate(date.getDate() - 1);
        }
        return date;
    }

    // --- 新增日期狀態提示訊息的 HTML 元素 ---
    $('#exam-date').after('<div id="date-status-message" style="font-size: 0.8rem; color: #ffc107; text-align: center; margin-top: 10px; font-weight: bold;"></div>');

    // --- 彩蛋：管理者生日 (11/4) ---
    const adminBirthday = { month: 11, day: 4 };
    const birthdayOpenFrom = { month: 11, day: 3 }; // 提前開放小遊戲與排行榜的日期 (同月)
    let birthdayMode = '';
    function updateBirthdayEgg(now) {
        const month = now.getMonth() + 1;
        const day = now.getDate();
        let mode = '';
        if (month === adminBirthday.month && day === adminBirthday.day) {
            mode = 'birthday';
        } else if (month === birthdayOpenFrom.month && day >= birthdayOpenFrom.day && day < adminBirthday.day) {
            mode = 'early';
        }
        if (mode === birthdayMode) {
            return;
        }
        birthdayMode = mode;

        $('#birthday-egg, #birthday-confetti').remove();
        if (!mode) {
            if (typeof window.hideBirthdayLeaderboard === 'function') {
                window.hideBirthdayLeaderboard();
            }
            return;
        }

        // 頁面旁固定的排行榜 (birthday-game.js)
        if (typeof window.showBirthdayLeaderboard === 'function') {
            window.showBirthdayLeaderboard();
        }

        $('#date-status-message').after(
            '<div id="birthday-egg" class="birthday-egg" title="點我放彩帶！">' +
            (mode === 'birthday' ? '🎂 今天是避雷針的生日，祝生日快樂！ 🎉' : '🎂 11/4 是避雷針的生日，小遊戲搶先開放！ 🎉') +
            '<button type="button" class="birthday-game-btn">🎮 生日限定小遊戲</button></div>'
        );

        // 開啟生日限定小遊戲 (birthday-game.js)
        $('#birthday-egg .birthday-game-btn').on('click', function (e) {
            e.stopPropagation();
            if (typeof window.openBirthdayGame === 'function') {
                window.openBirthdayGame();
            }
        });

        const confetti = $('<div id="birthday-confetti" class="birthday-confetti"></div>');
        const pieces = ['🎉', '🎊', '🎈', '🎂', '✨', '🎁'];
        for (let i = 0; i < 24; i++) {
            $('<span></span>')
                .text(pieces[i % pieces.length])
                .css({
                    'left': Math.random() * 100 + '%',
                    'animation-delay': (Math.random() * 8) + 's',
                    'animation-duration': (6 + Math.random() * 6) + 's',
                    'font-size': (1 + Math.random() * 1.2) + 'rem'
                })
                .appendTo(confetti);
        }
        $('body').append(confetti);

        // 點擊祝福文字再噴一次彩帶
        $('#birthday-egg').on('click', function () {
            confetti.find('span').each(function () {
                const piece = $(this);
                piece.css('animation', 'none');
                piece[0].offsetHeight; // 強制重繪以重新啟動動畫
                piece.css({
                    'animation': '',
                    'animation-delay': (Math.random() * 1.5) + 's'
                });
            });
        });
    }

    // --- 倒數計時器邏輯 ---
    let countdownInterval;
    function updateCountdown() {
        let now = new Date();
        if (timeOffset !== 0) {
            now = new Date(now.getTime() + timeOffset);
        }

        updateBirthdayEgg(now);

        const currentCalendarYear = now.getFullYear();

        // 1. 用五月(考試月)作為學年度分界，決定當前應顯示的學年度
        const boundaryDateForAcademicYear = getTcteDate(currentCalendarYear);
        boundaryDateForAcademicYear.setHours(0, 0, 0, 0);
        const academicYear = (now < boundaryDateForAcademicYear) ? currentCalendarYear - 1 : currentCalendarYear;

        // 2. 判斷實際要倒數的目標日期 (永遠是下一次的考試日)
        const thisYearExamSaturday = getTcteDate(currentCalendarYear);
        thisYearExamSaturday.setHours(0, 0, 0, 0);

        const thisYearExamSunday = new Date(thisYearExamSaturday);
        thisYearExamSunday.setDate(thisYearExamSunday.getDate() + 1);

        // 新邏輯：換期日為考試週日隔天
        const rolloverDate = new Date(thisYearExamSunday);
        rolloverDate.setDate(rolloverDate.getDate() + 1);
        rolloverDate.setHours(0, 0, 0, 0);

        let targetDate;
        if (now >= rolloverDate) {
            targetDate = getTcteDate(currentCalendarYear + 1);
        } else {
            targetDate = thisYearExamSaturday;
        }
        targetDate.setHours(0, 0, 0, 0);

        // 3. 更新標題 (使用學年度)
        $('#title').text('統測倒數');

        // 4. 檢查並顯示日期狀態 (狀態是跟著「學年度」)
        const status = examDateStatus[academicYear] || 0;
        const statusMessage = $('#date-status-message');
        if (status === 0) {
            statusMessage.text('【系統暫定日期，僅供參考，請以官方公告為準】').show();
        } else {
            statusMessage.hide();
        }

        // 5. 更新倒數或結束訊息
        const tcteSunday = new Date(targetDate);
        tcteSunday.setDate(tcteSunday.getDate() + 1);
        $('#exam-date').text('統測日 : ' + (targetDate.getMonth() + 1) + '/' + targetDate.getDate() + ' ~ ' + (tcteSunday.getMonth() + 1) + '/' + tcteSunday.getDate());

        const diffTime = targetDate - now;

        if (diffTime <= 0) {
            // 此區塊現在只會在考試的週六和週日觸發
            statusMessage.hide();
            $('#exam-date').hide();

            $('#title').text('就是今天！');
            $('#countdown').html('<span>沉著應戰</span><span>祝你考試順利</span>').addClass('final-text')
                .css({ // 新增置中樣式
                    'display': 'flex',
                    'flex-direction': 'column',
                    'justify-content': 'center',
                    'align-items': 'center',
                    'height': '100%'
                });
            return;
        }

        // --- 正常倒數顯示 ---

        // 如果是從結束訊息切換回來，需要重建倒數計時的HTML結構
        if ($('#countdown').hasClass('final-text')) {
            $('#countdown').removeClass('final-text').html(
                '<span id="countdown-days"></span> 天 ' +
                '<span id="countdown-hours"></span> 時 ' +
                '<span id="countdown-minutes"></span> 分 ' +
                '<span id="countdown-seconds"></span> 秒'
            );
        }
        
        // 確保考試日期可見
        $('#exam-date').show();

        const days = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        const hours = Math.floor((diffTime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
        const minutes = Math.floor((diffTime % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diffTime % (1000 * 60)) / 1000);

        $('#countdown-days').text(days);
        $('#countdown-hours').text(hours.toString().padStart(2, '0'));
        $('#countdown-minutes').text(minutes.toString().padStart(2, '0'));
        $('#countdown-seconds').text(seconds.toString().padStart(2, '0'));
    }
    // 立即執行一次
    updateCountdown();
    // 設定每秒更新
    countdownInterval = setInterval(updateCountdown, 1000);
    // --- 公告欄邏輯 ---
    const announcementBoard = $('#announcement-board');
    setTimeout(function () {
        announcementBoard.addClass('hidden');
    }, 30000);
});
