# 生日小遊戲排行榜 API（OCI A1）

目前部署：`https://tcte-lb.kevinjja.dpdns.org`（OCI A1 `oci-a1`，經 Cloudflare 代理），由既有的 nginx 反向代理到 `127.0.0.1:8787`，設定檔為 [nginx-tcte-lb.conf](nginx-tcte-lb.conf)，HTTPS 憑證用 certbot 申請。

11/4 生日小遊戲「幼兒園照顧大作戰」的線上排行榜後端。只用 Python 標準庫與 SQLite，不需要安裝任何套件，分數存在 `scores.db`。

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/scores?limit=10` | 取得前幾名 `[{"name", "score"}]` |
| POST | `/names` | 登記暱稱 `{"name", "token"}`；已被其他裝置使用回 409 |
| POST | `/scores` | 上傳 `{"name", "token", "score"}`，同暱稱只保留最高分，回傳 `{"rank", "best"}` |
| GET | `/status` | 現在是否開放 `{"open", "dates"}`（網站用它決定顯示小遊戲） |
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

5. 確認 `https://你的網域/health` 回傳 `{"ok": true}` 後，把網域填進 `assets/js/birthday-game.js` 的 `LEADERBOARD_URL`。

## 管理後台（admin.py）

目前部署：`https://tcteback.kevinjja.dpdns.org`（`tcte-admin.service`，`127.0.0.1:8788`，nginx 設定 [nginx-tcteback.conf](nginx-tcteback.conf)）。和 API 共用同一個 `scores.db`，功能：

- 排行榜：看全部玩家、改分數（留空 = 從排行榜移除但保留暱稱）、解除綁定裝置（換手機時用）、刪除
- 設定開放日期：存檔後網站與上傳限制立即生效
- 上傳紀錄：登記暱稱、上傳分數、後台操作（最多保留 20000 筆）
- 備份下載：`scores.db`、玩家 CSV、紀錄 CSV

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
sudo cp nginx-tcteback.conf /etc/nginx/conf.d/tcteback.conf && sudo systemctl reload nginx
sudo certbot --nginx -d tcteback.kevinjja.dpdns.org --redirect
```

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
