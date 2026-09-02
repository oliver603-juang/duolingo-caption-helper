# 常駐音訊保持喚醒 (Live Caption Keep-Alive PWA)

以極微弱、無節奏的底噪維持 Android 音訊輸出通道熱啟動，避免 Pixel 即時字幕
(Live Caption) 因喚醒延遲吃掉 2~3 秒短句的開頭。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | UI 與版面 |
| `app.js` | 音訊引擎（噪音生成、路由、語音注入、守護） |
| `sw.js` | 離線快取 Service Worker（**不負責**背景音訊） |
| `manifest.webmanifest` | PWA 資訊清單 |
| `icon-*.png` | 圖示 |
| `test.js` | Playwright 無頭煙霧測試（25 項） |
| `build_artifact.py` | 打包成單檔 `artifact.html` |

## 部署

必須用 **HTTPS**（或 `localhost`），否則 Service Worker、Wake Lock、安裝提示都不會啟用。

```bash
# 本機測試
python3 -m http.server 8000
# 手機同網段測試建議用 ngrok / Cloudflare Tunnel 取得 https 網址

# 執行測試
npm i playwright && node test.js
```

丟到任何靜態主機（GitHub Pages / Netlify / Cloudflare Pages）即可。

## Pixel 9a 上的設定

1. Chrome 開啟網址 → 選單 → **加到主畫面**（裝成 PWA，背景存活率較高）
2. 設定 → 應用程式 → Chrome → 電池 → **不受限制**
3. 設定 → 無障礙 → **即時字幕** 開啟
4. 開啟 PWA → 按「啟動管線」（必須有使用者手勢）
5. 若要背景使用，勾選「背景鎖」

## 建議的測試順序

1. `-40dB / 粉紅噪音 / 無濾波 / 無調變` — 規格書原案，先看字幕列是否常駐
2. 若出現 🎵 → 把音量降到 `-50 ~ -55dB`，或改用 **語音形狀噪音 (LTASS)**
3. 若字幕列完全不出現 → 音量往上加到 `-35 ~ -30dB`
4. 用「冷啟動對照組」按鈕做 A/B：它會掛起管線 2 秒再立刻播放，
   重現「吃字」；和保持喚醒的結果比對，才知道底噪到底有沒有效
5. 用「系統 TTS 日語測試」產生真正會被辨識的語音來驗證字幕內容

## 實作重點與取捨

- **不使用 `ScriptProcessorNode`**：已廢棄，且回呼在主執行緒 —— PWA 進背景會被節流，
  底噪反而先斷。改用 20 秒迴圈緩衝（`AudioBufferSourceNode`，跑在音訊執行緒），
  另提供 `AudioWorklet` 模式作為備選。
- **等功率交叉淡接**：迴圈接縫的振幅不連續會產生 0.05 Hz 週期性喀噠聲，
  也就是規格書禁止的「節奏」。用 `sqrt()` 權重（不是線性）才能讓不相關噪音的 RMS 恆定。
- **正規化係數**：滑桿標示的 dB 是「RMS dBFS」。程式會實測產生器輸出的 RMS 再反推增益，
  所以粉紅／白／語音形狀三種噪音在同一個 dB 設定下音量一致。
- **不使用 `MediaElementAudioSourceNode`**：同一個 `<audio>` 只能建立一次 MediaElementSource，
  重複建立會拋 `InvalidStateError`。上傳音檔一律走 `decodeAudioData`。
- **語音節點有獨立 envelope**：8 ms 淡入淡出，避免直連 destination 造成的起停爆音。
  播完只銷毀該節點，底噪與主 `AudioContext` 不中斷。
- **手動暫停優先於自動守護**：自動守護會在 `statechange` 時搶救 suspended 狀態，
  若不特別讓路，「暫停」鈕和冷啟動對照組會立刻被覆寫失效。

## 已知限制

- Live Caption 的 ASR 模型是由 AudioSet 聲音分類器 gate 的；底噪只能保住
  **音訊通道** 不休眠，無法保證 **ASR 模型** 不被卸載。詳見對話中的分析。
- MediaStream 路由在部分 Android 會被導向通話音訊串流，Live Caption 可能收不到。
- 持續音訊輸出會讓 CPU 無法進入深度睡眠，耗電明顯增加。
