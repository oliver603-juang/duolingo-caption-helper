/* 無頭瀏覽器煙霧測試：驗證音訊圖能實際建立、電平正確、無 console 錯誤 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(__dirname, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : req.url.slice(1));
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(d);
  });
});

(async () => {
  await new Promise(r => server.listen(8099, r));
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--mute-audio']
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  await page.goto('http://localhost:8099/index.html');
  const results = [];
  const check = (name, ok, detail = '') => { results.push([ok, name, detail]); };

  // 1. 啟動管線
  await page.click('#btnStart');
  await page.waitForTimeout(4000);
  let st = await page.evaluate(() => ({
    state: S.ctx && S.ctx.state, sr: S.ctx && S.ctx.sampleRate,
    hasNoise: !!S.noiseNode, gain: S.noiseGain && S.noiseGain.gain.value,
    norm: S.norm.pink, running: S.running
  }));
  check('AudioContext 進入 running', st.state === 'running', JSON.stringify(st));
  check('底噪節點已建立', st.hasNoise);
  check('正規化後 gain ≈ -40dB', Math.abs(st.gain / st.norm - 0.01) < 1e-6, 'gain=' + st.gain);

  // 2. 量測實際輸出 RMS 是否等於設定的 dB
  const measure = () => page.evaluate(() => new Promise(res => {
    const buf = new Float32Array(S.analyser.fftSize);
    let acc = 0, n = 0;
    const t = setInterval(() => {
      S.analyser.getFloatTimeDomainData(buf);
      let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
      acc += s / buf.length; n++;
      if (n >= 30) { clearInterval(t); res(20 * Math.log10(Math.sqrt(acc / n))); }
    }, 30);
  }));
  let db = await measure();
  check('實測底噪 ≈ -40 dBFS (±2dB)', Math.abs(db + 40) < 2, 'measured=' + db.toFixed(2) + 'dB');

  // 3. 調整滑桿到 -55dB
  await page.evaluate(() => {
    const sl = document.querySelector('#dbSlider');
    sl.value = -55; sl.dispatchEvent(new Event('input'));
  });
  await page.waitForTimeout(600);
  db = await measure();
  check('滑桿調到 -55dB 後實測相符 (±2dB)', Math.abs(db + 55) < 2, 'measured=' + db.toFixed(2) + 'dB');
  await page.evaluate(() => {
    const sl = document.querySelector('#dbSlider');
    sl.value = -40; sl.dispatchEvent(new Event('input'));
  });

  // 4. 迴圈接縫連續性：檢查緩衝首尾樣本差異是否夠小（等功率淡接後應無突變）
  const seam = await page.evaluate(() => {
    const b = S.buffers.pink.buffer.getChannelData(0);
    let maxStep = 0;
    for (let i = 1; i < b.length; i++) maxStep = Math.max(maxStep, Math.abs(b[i] - b[i - 1]));
    const seamStep = Math.abs(b[0] - b[b.length - 1]);
    return { seamStep, maxStep, len: b.length };
  });
  check('迴圈接縫無不連續（接縫跳變 ≤ 內部最大跳變）',
        seam.seamStep <= seam.maxStep,
        `seam=${seam.seamStep.toExponential(2)} max=${seam.maxStep.toExponential(2)}`);

  // 5. 切換噪音類型（含 LTASS 離線塑形）
  for (const c of ['white', 'speech']) {
    await page.selectOption('#selColor', c);
    await page.waitForTimeout(3500);
    const ok = await page.evaluate((cc) => !!S.noiseNode && !!S.buffers[cc], c);
    check(`切換至 ${c} 噪音成功`, ok);
    const d = await measure();
    check(`${c} 正規化後仍為 -40dB (±2.5dB)`, Math.abs(d + 40) < 2.5, 'measured=' + d.toFixed(2));
  }
  await page.selectOption('#selColor', 'pink');
  await page.waitForTimeout(2500);

  // 6. 限頻 + 音節調變（僅驗證不炸掉、電平確實下降）
  await page.selectOption('#selFilter', 'lp300');
  await page.waitForTimeout(2500);
  const dLp = await measure();
  check('低通 300Hz 生效（電平下降）', dLp < -40, 'measured=' + dLp.toFixed(2));
  await page.selectOption('#selFilter', 'none');
  await page.waitForTimeout(2500);

  await page.selectOption('#selAm', '4');
  await page.waitForTimeout(2500);
  const amOk = await page.evaluate(() => !!S.amOsc && S.amOsc.frequency.value === 4);
  check('4Hz 音節包絡調變已掛上 LFO', amOk);
  await page.selectOption('#selAm', '0');
  await page.waitForTimeout(2500);

  // 7. AudioWorklet 模式
  await page.selectOption('#selMode', 'worklet');
  await page.waitForTimeout(2500);
  const wl = await page.evaluate(() => ({ ready: S.workletReady, type: S.noiseNode && S.noiseNode.constructor.name }));
  check('AudioWorklet 模式運作', wl.ready && wl.type === 'AudioWorkletNode', JSON.stringify(wl));
  const dW = await measure();
  check('Worklet 模式電平 ≈ -40dB (±2.5dB)', Math.abs(dW + 40) < 2.5, 'measured=' + dW.toFixed(2));
  await page.selectOption('#selMode', 'buffer');
  await page.waitForTimeout(2000);

  // 8. 語音注入 + 節點回收
  const before = await page.evaluate(() => S.activeVoices.size);
  await page.click('#btnSynth');
  await page.waitForTimeout(400);
  const during = await page.evaluate(() => S.activeVoices.size);
  const dV = await measure();
  check('語音注入時電平大幅上升（高 SNR）', dV > -24, 'measured=' + dV.toFixed(2) + ' SNR=' + (dV + 40).toFixed(1) + 'dB');
  await page.waitForTimeout(2600);
  const after = await page.evaluate(() => ({ n: S.activeVoices.size, noise: !!S.noiseNode, state: S.ctx.state }));
  check('播放中有語音節點', before === 0 && during === 1, `${before}->${during}`);
  check('播放完語音節點已銷毀', after.n === 0);
  check('底噪與主 Context 未受影響', after.noise && after.state === 'running');
  const dAfter = await measure();
  check('語音結束後電平回到 -40dB (±2dB)', Math.abs(dAfter + 40) < 2, 'measured=' + dAfter.toFixed(2));

  // 9a. 非使用者意圖的 suspend（模擬系統掛起）→ 守護程式應自動救回
  const n0 = await page.evaluate(() => S.resumeCount);
  await page.evaluate(() => S.ctx.suspend());
  await page.waitForTimeout(4000);
  const g = await page.evaluate(() => ({ s: S.ctx.state, n: S.resumeCount }));
  check('系統掛起後自動守護救回 running', g.s === 'running' && g.n > n0, JSON.stringify(g));

  // 9b. 使用者按下的暫停 → 守護程式必須讓路，不可被自動覆寫
  await page.click('#btnSuspend');
  await page.waitForTimeout(300);
  check('手動暫停立即生效', (await page.evaluate(() => S.ctx.state)) === 'suspended');
  await page.waitForTimeout(4500);
  check('手動暫停不會被自動守護覆寫',
        (await page.evaluate(() => S.ctx.state)) === 'suspended');
  await page.click('#btnResume');
  await page.waitForTimeout(400);
  check('手動 Resume 恢復 running', (await page.evaluate(() => S.ctx.state)) === 'running');

  // 10. MediaStream 路由
  await page.selectOption('#selRoute', 'stream');
  await page.waitForTimeout(1200);
  check('MediaStream 路由建立', await page.evaluate(() => !!S.streamDest && !!document.querySelector('#sinkEl').srcObject));
  await page.selectOption('#selRoute', 'direct');
  await page.waitForTimeout(800);

  // 11. 停止釋放
  await page.click('#btnStop');
  await page.waitForTimeout(800);
  check('停止後資源已釋放', await page.evaluate(() => S.ctx === null && !S.noiseNode && !S.running));

  console.log('\n================ 測試結果 ================');
  let fail = 0;
  results.forEach(([ok, name, d]) => {
    if (!ok) fail++;
    console.log(`${ok ? '  PASS' : '! FAIL'}  ${name}${d ? '   [' + d + ']' : ''}`);
  });
  console.log('==========================================');
  console.log(`${results.length - fail}/${results.length} 通過`);
  if (errors.length) { console.log('\n頁面錯誤:'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('無 console / page 錯誤');

  await browser.close();
  server.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
