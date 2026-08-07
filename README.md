# fineps — 台股每股盈餘 EPS 排行

Taiwan Stock Quarterly EPS Ranking System

## 系統架構

**前端**：純 HTML/CSS/Vanilla JavaScript 單頁應用（index.html），無框架、無建置流程。

**資料快取**：scripts/fetch-eps.js 由 GitHub Actions（update-eps.yml）平日排程執行，向 FinMind 抓取 EPS 並寫入 data/eps-twse.json、data/eps-tpex.json（可續傳設計，已有當季數值會跳過）。

**即時股價代理**：functions/api/proxy.js（Cloudflare Pages Function）作 CORS 代理；部署於非 pages.dev 網域（如目前的 GitHub Pages）時，改用公開的 corsproxy.io 備援。

**載入行為**：主表與搶先報分頁皆採用相同機制，以每批 15 檔、批次間隔約 300ms 的方式逐檔比對快取並視需要補抓資料。股票數量多時（上市約 1200 多檔），完整表格填滿實測需數分鐘；切換到搶先報分頁會針對下一季再跑一次同樣的全市場迴圈，因此同樣需要數分鐘才能完整載入，並非讀取既有資料就能即時顯示。

## 功能特色

- 📊 **每股盈餘 EPS 排行**：最新一季（26Q1）上市 / 上櫃全覽
- 📈 **季增率（QoQ）**：與前一季比較
- 📅 **年增率（YoY）**：與去年同季比較
- 🔢 **累季年增率**：Q1 累積 EPS 年增率
- 🔍 **產業篩選**：按產業類別過濾
- ⭐ **自選股**：追蹤個人關注股票
- 📉 **歷史圖表**：點擊個股查看最近 12 季 EPS 走勢（SVG 長條圖）
- 💰 **本益比（P/E）**：單季及近 4 季 P/E 顯示於個股詳情
- 🗓️ **年度篩選**：個股詳情可依年度篩選歷史 EPS
- 💾 **CSV / XLS 匯出**

## 資料來源

- **FinMind API** — 季度 EPS（TaiwanStockFinancialStatements）
- **TWSE OpenAPI** — 收盤價
- **FinMind API** — 股票清單（TaiwanStockInfo）

## 使用方式

直接訪問 GitHub Pages：  
https://mywu-cloud.github.io/fineps/

## 色彩規範（台股慣例）

- 🔴 上漲 / 正值：`#d9363e`
- 🟢 下跌 / 負值：`#389d59`

## 相關專案

- [finrev](https://github.com/mywu-cloud/finrev) — 台股月營收排行
