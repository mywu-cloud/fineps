# fineps — 台股每股盈餘 EPS 排行

Taiwan Stock Quarterly EPS Ranking System

## 系統架構

**前端**：純 HTML/CSS/Vanilla JavaScript 單頁應用（index.html），無框架、無建置流程。開啟頁面只讀取快取 JSON（`data/eps-*.json`、`data/prices.json`），全市場表格約 1–2 秒內完成；上市 / 上櫃 / 搶先報分頁都從同一份資料篩選，切換分頁不再發送新的網路請求。

**季度自動判斷**：最新季度＝快取中已有半數以上公司公布的最新一季，搶先報＝下一季（例如 26Q2 → 搶先報 26Q3），不再寫死於程式碼。

**EPS 快取**：`scripts/fetch-eps.js` 由 GitHub Actions（update-eps.yml）平日 08:17、15:17–22:17 每小時執行：
1. **官方批次端點**（每次數個請求）：TWSE `t187ap06_L_*`、`t187ap14_L`，TPEx `mopsfin_t187ap06_O_*`。端點提供的是年初至今累計 EPS，單季值以「本季累計 − 前幾季單季合計」推算，標記為暫估（表格 EPS 旁的橘色 `*`）。
2. **FinMind 補正**（每次上限 400 檔）：只查詢「暫估值」與「缺最新季」的股票取得正式單季 EPS，每檔 20 小時內不重複查詢。

**股價快取**：`scripts/fetch-prices.js`（update-prices.yml，平日 19:00、20:00）以 TWSE `STOCK_DAY_ALL` 與 TPEx `tpex_mainboard_quotes` 兩個批次請求寫入 `data/prices.json`；前端開啟後另以同樣的兩個端點各補抓一次較新的股價。

**CORS 代理**：functions/api/proxy.js（Cloudflare Pages Function），非 pages.dev 網域時改用 corsproxy.io 備援。

## 功能特色

- 📊 **每股盈餘 EPS 排行**：最新一季上市 / 上櫃全覽（季度自動判斷）
- 📈 **季增率（QoQ）**：與前一季比較
- 📅 **年增率（YoY）**：與去年同季比較
- 🔢 **累季年增率**：年初至今累積 EPS 年增率
- ⚡ **每股盈餘搶先報**：下一季已公布公司即時列出
- 🔍 **產業篩選**：按產業類別過濾
- ⭐ **自選股**：追蹤個人關注股票
- 📉 **歷史圖表**：點擊個股查看最近 12 季 EPS 走勢（SVG 長條圖）
- 💰 **本益比（P/E）**：單季及近 4 季 P/E 顯示於個股詳情
- 🗓️ **年度篩選**：個股詳情可依年度篩選歷史 EPS
- 💾 **CSV / XLS 匯出**

## 資料來源

- **TWSE / TPEx OpenAPI** — 全市場最新一季累計 EPS、收盤價
- **FinMind API** — 季度 EPS 歷史與正式單季值（TaiwanStockFinancialStatements）、股票清單（TaiwanStockInfo，僅 Actions 使用）

## 使用方式

https://fineps.pages.dev/

## 色彩規範（台股慣例）

- 🔴 上漲 / 正值：`#d9363e`
- 🟢 下跌 / 負值：`#389d59`

## 相關專案

- [finrev](https://github.com/mywu-cloud/finrev) — 台股月營收排行
