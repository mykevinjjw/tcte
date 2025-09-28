// 當整個網頁文件都載入完成後，執行此匿名函式
$(document).ready(function () {

    // --- 倒數計時器邏輯 ---
    const targetDate = new Date('2026-04-25T00:00:00');
    const now = new Date();
    const targetDateMidnight = new Date(targetDate).setHours(0, 0, 0, 0);
    const nowDateMidnight = new Date(now).setHours(0, 0, 0, 0);
    const diffTime = targetDateMidnight - nowDateMidnight;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > 0) {
        $('#countdown').text(diffDays + ' 天');
    } else if (diffDays === 0) {
        $('#title').text('就是今天！');
        $('#countdown').text('沉著應戰，祝你考試順利').addClass('final-text');
        $('#exam-date').hide();
    } else {
        $('#title').text('倒數結束');
        $('#countdown').text('感謝您的使用').addClass('final-text');
        $('#exam-date').hide();
    }

    // --- 公告欄邏輯 ---
    const announcementBoard = $('#announcement-board');
    setTimeout(function() {
        announcementBoard.addClass('hidden');
    }, 30000);
});