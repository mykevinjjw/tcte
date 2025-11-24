$(document).ready(function () {

    // --- 測試用變數 ---
    // 若要測試特定年份，請填寫年份數字，例如 2025。倒數將從該年1月1日開始計算。
    // 若要使用目前時間，請將其設為 null。
    const debugYear = null;
    // --- 自動計算統測日期 ---
    function getTcteDate(year) 
    {
        // 4月是第3個月 (0-indexed), 從4月30日開始往前找
        const date = new Date(year, 3, 30);
        // 迴圈直到找到星期六 (getDay() === 6)
        while (date.getDay() !== 6) {
            date.setDate(date.getDate() - 1);
        }
        return date;
    }
    // --- 倒數計時器邏輯 ---
    let countdownInterval;
    function updateCountdown() {
        const now = debugYear ? new Date(debugYear, 0, 1) : new Date();
        const currentYear = now.getFullYear();
        let targetDate = getTcteDate(currentYear);
        targetDate.setHours(0, 0, 0, 0); // 設定為當天凌晨
        // 如果今年的考試日期已過，目標設為明年
        if (now > targetDate) {
            targetDate = getTcteDate(currentYear + 1);
            targetDate.setHours(0, 0, 0, 0);
        }
        const targetYear = targetDate.getFullYear();       
        const tcteSunday = new Date(targetDate);
        console.log(tcteSunday);
        tcteSunday.setDate(tcteSunday.getDate() + 1);
        // 更新標題與考試日期
        $('#title').text(targetYear + ' 統測倒數');
        $('#exam-date').text('統測日 : ' + (targetDate.getMonth() + 1) + '/' + targetDate.getDate() + ' ~ ' + (tcteSunday.getMonth() + 1) + '/' + tcteSunday.getDate());
        const diffTime = targetDate - now;
        if (diffTime <= 0) {
            // 檢查是否在考試週末
            const today = new Date(now);
            today.setHours(0,0,0,0);
            if (today.getTime() === targetDate.getTime() || today.getTime() === tcteSunday.getTime()) {
                 $('#title').text('就是今天！');
                 $('#countdown').html('<span>沉著應戰</span><span>祝你考試順利</span>').addClass('final-text');
                 $('#exam-date').hide();
            } else {
                $('#title').text('倒數結束');
                $('#countdown').html('<span>感謝您的使用</span><span>期待明年再見</span>').addClass('final-text');
                $('#exam-date').hide();
            }
            // 如果倒數結束，且我們在一個 interval 中，就清除它
            if (countdownInterval) {
                clearInterval(countdownInterval);
            }
            return;
        }
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
    // 如果不是測試模式，則設定每秒更新
    if (!debugYear) {
        countdownInterval = setInterval(updateCountdown, 1000);
    }
    // --- 公告欄邏輯 ---
    const announcementBoard = $('#announcement-board');
    setTimeout(function() {
        announcementBoard.addClass('hidden');
    }, 30000);
});
