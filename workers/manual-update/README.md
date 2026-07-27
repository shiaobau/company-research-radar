# 手動更新 Worker

此 Worker 僅驗證管理密碼並觸發 GitHub Actions；它不儲存公司資料，也不執行爬取。

## 部署前設定

1. 在 Cloudflare 建立 Workers 專案，部署此資料夾的 `wrangler.jsonc`。
2. 在 Worker 的 **Bindings** 建立一個 KV namespace，綁定名稱為 `UPDATE_ATTEMPTS`。它只保存 10 分鐘內的失敗嘗試次數。
3. 在 Worker 的 **Secrets** 新增：
   - `GITHUB_TOKEN`：GitHub fine-grained personal access token，只授權 `shiaobau/company-research-radar`，並給予觸發 Actions 所需的最小寫入權限。
   - `UPDATE_PASSWORD_HASH`：格式為 `iterations:saltBase64:hashBase64` 的 PBKDF2-SHA-256 雜湊。
4. `DASHBOARD_ORIGINS` 可用逗號列出允許操作 Worker 的網站來源。目前預留 GitHub Pages 與 `https://company-watch-u1-u5.pages.dev`。

## 五個觀察站密碼

未設定其他值時，U1-U5 都會沿用 `UPDATE_PASSWORD_HASH`。日後若要分開密碼，在 Worker Secrets 新增 `UNIVERSE_PASSWORD_HASHES`，值為單行 JSON：

```json
{"u1":"雜湊值1","u2":"雜湊值2","u3":"雜湊值3","u4":"雜湊值4","u5":"雜湊值5"}
```

未列在這個 JSON 的觀察站仍會沿用 `UPDATE_PASSWORD_HASH`。原始密碼與雜湊值都不可提交到 Git。

## 產生密碼雜湊

在本機用 Node.js 執行下列命令，輸入密碼後會輸出要填入 `UPDATE_PASSWORD_HASH` 的值。請勿把輸出值、密碼或 GitHub Token 提交到 Git。

```powershell
$password = Read-Host "更新密碼" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$script = @'
const crypto = require("crypto");
const password = process.argv[1];
const salt = crypto.randomBytes(16);
crypto.pbkdf2(password, salt, 10000, 32, "sha256", (error, hash) => {
  if (error) throw error;
  console.log(`10000:${salt.toString("base64")}:${hash.toString("base64")}`);
});
'@
node -e $script -- $plain
Remove-Variable plain
```

## 連接網站

部署完成後，將 Worker URL 加上 `/manual-update`，填入 `data/app_config.json` 的 `manual_update.endpoint`，並將 `enabled` 改為 `true` 後推送。網址範例：

```json
{
  "manual_update": {
    "enabled": true,
    "endpoint": "https://company-research-radar-update.<你的子網域>.workers.dev/manual-update"
  }
}
```

網站按下「執行完整更新」時會要求輸入密碼。密碼只會透過 HTTPS 傳給 Worker 驗證，不會保存於瀏覽器或 GitHub Pages。
