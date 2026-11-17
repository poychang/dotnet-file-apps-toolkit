# 網站部署與擴充套件發布

這份指南區分「已準備好的自動化」與「需要帳號擁有者完成的設定」。提交這些檔案不會自動註冊 Marketplace 發行者，也不會在沒有版本標籤的情況下建立 Release。

## 1. GitHub Pages（首次設定）

1. 將變更合併／推送到 `poychang/dotnet-file-apps-toolkit` 的 `main`。
2. 在儲存庫 **Settings → Pages → Build and deployment → Source** 選擇 **GitHub Actions**，不是 Deploy from a branch。
3. 在 **Actions → Deploy GitHub Pages → Run workflow** 選取 `main` 執行。後續網站相關檔案推送到 `main` 時會自動部署。
4. 確認 `github-pages` environment 允許 `main` 部署，並確認 Actions 沒有被儲存庫／組織政策停用。
5. 確認部署完成後，開啟 <https://project.poychang.net/dotnet-file-apps-toolkit/>。此儲存庫已連結至自訂網域 `project.poychang.net`。

工作流程使用官方 `configure-pages`、`upload-pages-artifact`、`deploy-pages` actions；只在部署 job 授予 `pages: write` 與 `id-token: write`，不需要 PAT。

網站原始碼位於 [docs](./docs/)，圖片沿用 [images](./images/) 的素材；`npm run build:site` 產生 `out/site/` 作為唯一部署內容，不會將原始碼、測試或維護文件公開到 Pages。頁面使用相對資源路徑，可正確放在 `/dotnet-file-apps-toolkit/` 子路徑下。

本機預覽：

```sh
npm run test:publishing
python -m http.server 8000 --bind 127.0.0.1 --directory out/site
```

開啟 <http://127.0.0.1:8000/>。Python 僅為本機預覽選項，CI 不需要 Python 網頁伺服器。

## 2. GitHub Release 與固定下載網址

[release.yml](./.github/workflows/release.yml) 在推送 `v*` 標籤時執行，僅接受正式 `vX.Y.Z` 版本。發布前會檢查：

- 標籤、`package.json` 與 `package-lock.json` 根套件版本完全一致。
- `CHANGELOG.md` 有對應版本的非空白 `## X.Y.Z` 區段，且 `Unreleased` 已清空。
- lint、型別檢查、單元測試、網站／發布測試，以及 Linux 的一般與 Restricted Mode 整合測試全部通過。
- VSIX 經過 `vsce package` 驗證，並產生 SHA-256 校驗檔。

這次已將原有 Unreleased 變更與發布準備整理為 `0.2.1`，並同步 package 與 lockfile 版本。首次自動發行可直接使用 `v0.2.1`；工作流程本身不會偷偷修改版本。

未來發行新版本時（這次 `0.2.1` 已完成這一步，不必重跑），先更新版本：

```sh
# 更新 package.json 與 package-lock.json，不自動提交或加標籤
npm version patch --no-git-tag-version
```

將 changelog 的 Unreleased 內容移至新的 `## X.Y.Z` 區段。以下為本次 `0.2.1` 的驗證與發行指令；後續請改用新版本號：

```sh
node scripts/prepare-release.mjs v0.2.1
npm run lint
npm run check-types
npm run test:unit
npm run test:publishing
npm run test:integration
npm run vsix
```

檢視並提交版本變更到 `main`，等待跨平台 CI 成功，再推送對應標籤：

```sh
git push origin main
git tag v0.2.1
git push origin v0.2.1
```

工作流程建立正式 GitHub Release，包含：

| 資產 | 用途 |
| --- | --- |
| `dotnet-file-apps-toolkit.vsix` | 固定名稱的可安裝套件；版本記錄於套件 manifest 與 Release tag |
| `SHA256SUMS` | VSIX 的 SHA-256 校驗值 |

Release 內文採用該版本的 changelog，附手動安裝方式。VSIX 的 README 圖片與相對連結固定到發行標籤，不會隨 `main` 改變。

網站下載網址固定為：

<https://github.com/poychang/dotnet-file-apps-toolkit/releases/latest/download/dotnet-file-apps-toolkit.vsix>

首次正式 Release 完成前，此網址會回傳 404；頁面與 README 已說明此狀態。後續正式版本沿用同一資產名稱，網站不必因版本升級重新部署，也不依賴 GitHub API 請求或速率限制。依版本遞增順序發行，並在 GitHub 確認目標 Release 標記為 **Latest**；不要把較舊維護版本設為 Latest。

下載後可校驗：

```powershell
Get-FileHash .\dotnet-file-apps-toolkit.vsix -Algorithm SHA256
```

與 Release 的 `SHA256SUMS` 比對，或在 Linux/macOS 執行 `sha256sum --check SHA256SUMS`（macOS 可用 `shasum -a 256 -c SHA256SUMS`）。

### 重試與權限

- 可用 `gh workflow run release.yml --ref v0.2.1` 對**既有標籤**手動執行；選取分支會明確失敗。
- 工作流程不覆寫既有 Release／套件。若某個 job 失敗，優先使用 **Re-run failed jobs**；已成功發布的版本需要修改時，請發行新版本，不要移動標籤或覆寫 VSIX。
- GitHub Release 使用該 job 的 `GITHUB_TOKEN` 與 `contents: write`；不需要另外存 GitHub PAT。
- 保護 `main` 與 `v*` 標籤，限制可推送者；建議加上版本標籤 ruleset。跨平台 CI 不會成為標籤發行的自動依賴，維護者應先確認它通過；Release 本身仍會重跑 Linux 全套檢查。

## 3. Visual Studio Marketplace 上架前置作業

### 已完成的儲存庫準備

- Manifest 使用 `poychang.dotnet-file-apps-toolkit` 作為擴充套件 ID。
- 提供 256 × 256 PNG 圖示、深色 Marketplace banner、分類／搜尋關鍵字、網站、repository、issue 與 Q&A 連結。
- 提供英文／繁體中文 README、安裝教學、功能截圖、相容性說明、changelog 與 MIT LICENSE。
- `.vscodeignore` 採允許清單，VSIX 只包含執行檔、必要素材、在地化、文法與使用文件，不包含網站、測試及工作流程。
- `vsce` 已納入鎖定的開發依賴；`npm run vsix` 會透過 `vscode:prepublish` 執行 production build，保留套件與授權檢查。

原創圖示可在 Windows 執行 `.\scripts\generate-icon.ps1` 重新產生；不使用 Microsoft／VS Code 商標作為套件圖示。

### 必須由發行者完成

1. 使用 Microsoft 帳號登入 [Marketplace 管理頁](https://marketplace.visualstudio.com/manage)。
2. 建立或確認你有權使用的 **publisher ID 為 `poychang`**。GitHub 帳號不會自動建立同名 Marketplace publisher；若 ID 不可用，須同步修改 manifest、網站及 README 的擴充套件 ID。
3. 補齊 publisher 顯示名稱與聯絡資訊，確認授權、使用的套件與素材符合發布要求。不要將帳號憑證或聯絡個資寫入儲存庫。
4. 確認擴充套件名稱可用。首次發布可能需要 Marketplace 驗證；在正式上架成功前，不要宣稱網站的 Marketplace 安裝已可用。
5. 以實際 VSIX 做安裝與基本操作確認。C# Dev Kit 互通、WSL／SSH／Dev Containers 的實機驗證仍需完成，不能以 CI 取代。

### 建議：OIDC Trusted Publishing，不存長效 PAT

依 [VS Code 官方發布指南](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)，本儲存庫使用 `vsce publish --oidc`。目前鎖定的 `vsce` 已支援此選項。

1. 在 GitHub **Settings → Environments** 建立 `marketplace`，建議設必要審核人員，並限制部署來源為版本標籤 `v*`。
2. 在 Marketplace publisher 的 **Trusted Publishing → Create** 建立 policy：

   | 欄位 | 值 |
   | --- | --- |
   | Policy name | 自訂，例如 `GitHub release` |
   | Repository owner | `poychang` |
   | Repository | `dotnet-file-apps-toolkit` |
   | Workflow | `release.yml` |
   | Environment | `marketplace` |

3. 在 GitHub **Settings → Secrets and variables → Actions → Variables** 建立**儲存庫變數** `PUBLISH_MARKETPLACE`，值為 `true`。不要只建在 environment 層級，因為 job 的啟用條件會先求值。
4. 推送新的正式版本標籤。GitHub Release 成功後，`marketplace` job 才會開始；若有 environment 審核，先核准。
5. 該 job 下載同一次建置的 VSIX、驗證 checksum，然後發布到 Marketplace，**不重新封裝**。GitHub 與 Marketplace 使用相同套件內容。

不設定 `PUBLISH_MARKETPLACE`（或設為 `false`）時，仍可正常建立 GitHub Release 與網站，不會嘗試 Marketplace 發布。OIDC policy 不匹配或發布失敗會讓 job 明確失敗，不會略過錯誤或略過重複版本。

若已經先發行到 GitHub，但當時沒有啟用 Marketplace，可直接下載並驗證該 Release 的 VSIX，從 Marketplace 管理頁 **New extension → Visual Studio Code** 上傳首次版本（後續版本使用更新操作）。不必重跑 GitHub Release job。之後的新版本再由 OIDC 自動發布。

官方指出 Azure DevOps 全域 PAT 將於 2026-12-01 退場，因此此流程不新增 `VSCE_PAT` 長效秘密。若暫時不能設定 OIDC，可先使用管理頁手動上傳已驗證的同一份 VSIX。

## 官方參考

- [GitHub Pages 自訂工作流程](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [VS Code 擴充套件發布與 Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension manifest 欄位](https://code.visualstudio.com/api/references/extension-manifest)
