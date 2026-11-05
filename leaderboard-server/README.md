# 生日小遊戲排行榜 API（OCI A1）

目前部署：`https://tcte-lb.kevinjja.dpdns.org`（OCI A1 `oci-a1`，經 Cloudflare 代理），由既有的 nginx 反向代理到 `127.0.0.1:8787`，設定檔為 [nginx-tcte-lb.conf](nginx-tcte-lb.conf)，HTTPS 憑證用 certbot 申請。

11/4 生日小遊戲「幼兒園照顧大作戰」的線上排行榜後端。只用 Python 標準庫與 SQLite，不需要安裝任何套件，分數存在 `scores.db`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/scores?limit=10` | 取得前幾名 `[{"name", "score"}]` |
| POST | `/names` | 登記暱稱 `{"name", "token"}`；已被其他裝置使用回 409 |
| POST | `/scores` | 上傳 `{"name", "token", "score"}`，同暱稱只保留最高分，回傳 `{"rank", "best"}` |
| GET | `/best?name=` | 某個暱稱目前的最高分 `{"best", "rank"}`（網站用它同步「最高分」） |
| GET | `/status` | `{"open", "event", "always", "dates", "survey"}`：`open` 現在能不能玩、`event` 今天是不是活動日（倒數網頁的橫幅）、`always` 是否無限期開放 |
| POST | `/survey/load` | 讀自己填過的問卷 `{"name", "token"}` → `{"answers"}`；只有上傳過分數的暱稱本人能用 |
| POST | `/survey` | 填問卷 `{"name", "token", "answers"}`，同暱稱重填會覆蓋 |
| GET | `/health` | 健康檢查 |

`token` 是每台裝置隨機產生的識別碼，暱稱（不分大小寫）屬於第一個登記它的裝置。

伺服器的防護：名字 1~12 字、分數 0~1500、每個 IP 每分鐘最多 10 次（登記暱稱 + 上傳）、只有開放日期（台灣時間，在管理後台設定；沒設定過時用 `LB_OPEN_DATES`，預設 `11-03,11-04`）能上傳（`LB_BIRTHDAY_ONLY=0` 可關閉）、只接受 `LB_ALLOWED_ORIGINS` 列出的網站呼叫。

## 部署步驟（Ubuntu / Oracle Linux）

GitHub Pages 是 HTTPS，瀏覽器不允許它呼叫 HTTP 的 API，所以需要一個網域指到 A1 的公開 IP，再用 Caddy 自動申請 HTTPS 憑證。

1. 建立使用者並放好程式：

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin tcte
   sudo mkdir -p /opt/tcte-leaderboard
   sudo cp server.py /opt/tcte-leaderboard/
   sudo chown -R tcte:tcte /opt/tcte-leaderboard
   ```

2. 啟動服務（網站不是 `https://mykevinjjw.github.io` 的話，先改 service 檔裡的 `LB_ALLOWED_ORIGINS`）：

   ```bash
   sudo cp tcte-leaderboard.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now tcte-leaderboard
   curl http://127.0.0.1:8787/health
   ```

3. 已經有 nginx 佔用 80/443 的話：把 [nginx-tcte-lb.conf](nginx-tcte-lb.conf) 的 80 port 區塊放到 `/etc/nginx/conf.d/`，再執行 `sudo certbot --nginx -d 你的網域 --redirect`，然後跳到第 5 步。

   沒有網頁伺服器的話：安裝 [Caddy](https://caddyserver.com/docs/install)，把 `Caddyfile` 裡的 `lb.example.com` 換成你的網域後放到 `/etc/caddy/Caddyfile`，再執行 `sudo systemctl reload caddy`。

4. 開放 80 / 443 port：
   - OCI 主控台：VCN → Security List（或 NSG）新增 Ingress，TCP 80、443，來源 `0.0.0.0/0`。
   - 主機防火牆（OCI 的 Ubuntu 映像預設用 iptables 擋掉）：

     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```

     Oracle Linux 則用 `sudo firewall-cmd --permanent --add-service=http --add-service=https && sudo firewall-cmd --reload`。

5. 確認 `https://你的網域/health` 回傳 `{"ok": true}` 後，把網域填進 `games-site/common.js` 的 `API_URL`。

## 遊戲網站（games.mykevin.dpdns.org）

遊戲本身放在 `https://games.mykevin.dpdns.org`（repo 的 [games-site/](../games-site/)，靜態檔案放在 A1 的 `/var/www/tcte-games`，nginx 設定 [nginx-games.conf](nginx-games.conf)）：

- `/`：遊戲主頁，列出所有小遊戲（新增遊戲就在 `games-site/` 加一個資料夾，主頁加一張卡片）
- `/birthday/`：生日小遊戲「幼兒園照顧大作戰」，沒開放時只能看排行榜
- `/admin/`：管理後台（見下面）

統測倒數網頁只保留旁邊的排行榜與問卷（`assets/js/birthday-board.js`），開放期間的「生日限定小遊戲」按鈕會連到遊戲網站。倒數網頁的排行榜固定是 11/4 生日活動的最終結果（[assets/data/birthday-leaderboard.json](../assets/data/birthday-leaderboard.json)），不再跟伺服器同步；遊戲網站上的排行榜才是即時的。

遊戲有簡單／普通／困難三種難度（`games-site/birthday/game.js` 的 `LEVELS`），共用一個排行榜：網頁上傳 `{"score": 遊戲分數, "level"}`，伺服器存「遊戲分數 × 加權」（簡單 ×0.6、普通 ×1、困難 ×1.5，`server.py` 的 `LEVELS`）。兩個網站共用 `games-site/common.js`。兩邊的 localStorage 不互通，所以兩個網站之間的連結會在網址 `#player=暱稱,識別碼` 帶上這台裝置的身分，另一邊還沒有暱稱時才會採用。

更新遊戲網站：

```bash
tar czf /tmp/games-site.tgz -C games-site . && scp /tmp/games-site.tgz oci-a1:/tmp/
ssh oci-a1 'sudo tar xzf /tmp/games-site.tgz -C /var/www/tcte-games --no-same-owner && sudo restorecon -R /var/www/tcte-games'
```

## 管理後台（admin.py）

目前部署：`https://games.mykevin.dpdns.org/admin/`（`tcte-admin.service`，`127.0.0.1:8788`，`ADMIN_BASE_PATH=/admin`，nginx 設定 [nginx-games.conf](nginx-games.conf)）。舊網址 `https://tcteback.kevinjja.dpdns.org` 會轉址過去（[nginx-tcteback.conf](nginx-tcteback.conf)）。和 API 共用同一個 `scores.db`，功能：

- 排行榜：看全部玩家、改分數（留空 = 從排行榜移除但保留暱稱）、解除綁定裝置（換手機時用）、刪除
- 設定開放日期（活動日）與「無限期開放」：勾選後每天都能玩、上傳，問卷在活動日以外都能填；存檔後立即生效
- 玩家頁：點暱稱看這個人的每一次上傳、分數歷程圖、用過的裝置與 IP
- 時間軸：每小時上傳次數、全場最高分演進與第一名換人紀錄、依日期的逐筆時間軸
- 排行榜與上傳紀錄每 5 秒自動更新（正在輸入的欄位不會被蓋掉）
- 問卷：遊戲開放日以外才收（後台可整個關閉）；統計好玩程度、最手忙腳亂的狀況、明年想不想玩、給前三名的禮物建議，生日祝福集中成留言牆，可匯出 CSV
- 上傳紀錄：登記暱稱、上傳分數、填問卷、後台操作（最多保留 20000 筆）
- 備份下載：`scores.db`、玩家 CSV、紀錄 CSV、問卷 CSV

部署：

```bash
sudo cp admin.py /opt/tcte-leaderboard/ && sudo chown tcte:tcte /opt/tcte-leaderboard/admin.py
# 設定帳號密碼 (只有 root 能讀)
read -rs PW && H=$(printf '%s
' "$PW" | python3 admin.py hash-password) && unset PW
printf 'ADMIN_USER=admin
ADMIN_PASSWORD_HASH=%s
' "$H" | sudo tee /etc/tcte-admin.env >/dev/null && sudo chmod 600 /etc/tcte-admin.env
sudo cp tcte-admin.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now tcte-admin
sudo cp nginx-games.conf /etc/nginx/conf.d/games.conf && sudo systemctl reload nginx
sudo certbot --nginx -d games.mykevin.dpdns.org --redirect
```

後台要用帳號密碼登入（`ADMIN_NO_LOGIN=0`）。設成 `1` 會變成免登入，任何知道網址的人都能查看與操作後台。

A1 上第一次部署時產生的密碼存在 `/root/tcte-admin-password.txt`；改密碼就重新產生 `/etc/tcte-admin.env` 再 `sudo systemctl restart tcte-admin`。登入失敗 10 分鐘內 5 次會暫時鎖定該 IP，登入 12 小時後失效。

## 常用操作

```bash
# 看紀錄
journalctl -u tcte-leaderboard -u tcte-admin -f
# 刪掉不當名字 (先停服務或直接用 sqlite3 操作皆可)
sudo -u tcte sqlite3 /opt/tcte-leaderboard/scores.db "DELETE FROM players WHERE name = '不當名字';"
# 備份
sudo -u tcte sqlite3 /opt/tcte-leaderboard/scores.db ".backup /tmp/scores-backup.db"
```
