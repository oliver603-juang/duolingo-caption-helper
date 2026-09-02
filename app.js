/* =====================================================================
 * 常駐音訊背景串流 — Live Caption Keep-Alive
 * Web Audio 永不休眠管線 (AudioContext Keep-Alive)
 * ===================================================================== */
'use strict';

/* ---------- 小工具 ---------- */
const $ = (s) => document.querySelector(s);
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => (g > 1e-9 ? 20 * Math.log10(g) : -Infinity);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const LOOP_SECONDS = 20;      // 迴圈緩衝長度：夠長，接縫事件率 0.05Hz，不構成節奏
const XFADE_SECONDS = 0.5;    // 等功率交叉淡接長度
const VOICE_FADE = 0.008;     // 語音節點 8ms 淡入淡出，消除爆音
const SCHEDULE_LEAD = 0.02;   // 排程提前量

/* ---------- 全域狀態 ---------- */
const S = {
  ctx: null,
  noiseNode: null,     // BufferSource 或 AudioWorkletNode
  filterNode: null,
  amGain: null, amOsc: null, amOffset: null,
  noiseGain: null,     // 底噪音量
  voiceBus: null,      // 語音匯流排 (Gain = 1.0)
  busIn: null,         // 匯總點
  analyser: null,
  streamDest: null,
  buffers: {},         // color -> {buffer, rms}
  norm: {},            // color -> 1/rms
  workletReady: false,
  running: false,
  startedAt: 0,
  resumeCount: 0,
  activeVoices: new Set(),
  uploaded: null,
  wakeLock: null,
  suspendedByUser: false,
  deferredInstall: null,
  meterRaf: 0,
  cfg: {
    db: -40, color: 'pink', filter: 'none', am: 0, mode: 'buffer',
    route: 'direct', autoGuard: true
  }
};

/* ---------- 事件記錄 ---------- */
const logEl = $('#log');
function log(msg, kind = 'info') {
  const d = new Date();
  const t = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${t}</span> <span class="${kind}"></span>`;
  line.lastChild.textContent = msg;
  logEl.appendChild(line);
  while (logEl.children.length > 300) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

/* =====================================================================
 * 噪音產生
 * ===================================================================== */

/* Paul Kellet 精緻化粉紅噪音濾波器 */
function makeGenerator(color) {
  if (color === 'white') {
    return () => Math.random() * 2 - 1;
  }
  // pink（speech 也以 pink 為基底，之後再離線濾波成 LTASS）
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    const out = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
    return out;
  };
}

function rmsOf(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
  return Math.sqrt(s / arr.length);
}

function makeRawNoise(n, color) {
  const gen = makeGenerator(color);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = gen();
  return out;
}

/* 等功率交叉淡接成無縫迴圈：
 * data 長度為 L+X，把尾端 X 個樣本淡接回開頭 X 個樣本。
 * 若不做這件事，迴圈接縫的振幅不連續會產生 1/LOOP_SECONDS Hz 的週期性喀噠聲 ——
 * 那正是規格書明令禁止的「節奏」，也是被誤判為音樂的主要風險來源。
 * 用 sqrt() 而非線性，因為兩段是不相關的噪音，等功率才能維持 RMS 恆定。 */
function crossfadeLoop(data, L, X) {
  for (let i = 0; i < X; i++) {
    const t = i / X;
    data[i] = data[i] * Math.sqrt(t) + data[L + i] * Math.sqrt(1 - t);
  }
  return data.subarray(0, L);
}

/* 語音長期平均頻譜 (LTASS) 塑形：離線把粉紅噪音過濾成語音形狀 */
async function shapeToSpeech(ctx, data) {
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OC(1, data.length, ctx.sampleRate);
  const buf = off.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  const src = off.createBufferSource();
  src.buffer = buf;

  const hp = off.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 150; hp.Q.value = 0.7;
  const peak = off.createBiquadFilter();
  peak.type = 'peaking'; peak.frequency.value = 500; peak.Q.value = 1.0; peak.gain.value = 6;
  const peak2 = off.createBiquadFilter();
  peak2.type = 'peaking'; peak2.frequency.value = 1800; peak2.Q.value = 1.2; peak2.gain.value = 3;
  const lp = off.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 4200; lp.Q.value = 0.7;

  src.connect(hp).connect(peak).connect(peak2).connect(lp).connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}

/* 取得（並快取）某種顏色的迴圈緩衝與正規化係數
 * 順序很重要：先離線濾波（並丟棄濾波器暖機暫態），最後才交叉淡接。
 * 若先淡接再濾波，濾波器的零初始狀態會在開頭留下暫態，破壞迴圈連續性。 */
async function getNoiseBuffer(color) {
  if (S.buffers[color]) return S.buffers[color];
  const t0 = performance.now();
  const sr = S.ctx.sampleRate;
  const L = Math.floor(sr * LOOP_SECONDS);
  const X = Math.floor(sr * XFADE_SECONDS);
  const W = Math.floor(sr * 0.25);        // 濾波器暖機長度

  let data;
  if (color === 'speech') {
    const raw = makeRawNoise(W + L + X, 'pink');
    const filtered = await shapeToSpeech(S.ctx, raw);
    data = filtered.slice(W);             // 丟棄暖機段 → 長度 L+X 的穩態訊號
  } else {
    data = makeRawNoise(L + X, color);
  }
  const loopData = crossfadeLoop(data, L, X);

  const rms = rmsOf(loopData) || 1;
  const buffer = S.ctx.createBuffer(1, loopData.length, sr);
  buffer.copyToChannel(loopData, 0);
  const entry = { buffer, rms };
  S.buffers[color] = entry;
  S.norm[color] = 1 / rms;
  log(`已生成 ${color} 迴圈緩衝 ${LOOP_SECONDS}s，原始 RMS=${rms.toFixed(5)}，` +
      `正規化係數=${(1 / rms).toFixed(2)}（耗時 ${(performance.now() - t0).toFixed(0)}ms）`, 'ok');
  return entry;
}

/* ---------- AudioWorklet 版產生器（備選實作） ---------- */
const WORKLET_SRC = `
class NoiseGen extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    var o = (opt && opt.processorOptions) || {};
    this.white = o.color === 'white';
    this.b0=0;this.b1=0;this.b2=0;this.b3=0;this.b4=0;this.b5=0;this.b6=0;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
  process(inputs, outputs) {
    var out = outputs[0][0];
    if (!out) return this.alive;
    if (this.white) {
      for (var i = 0; i < out.length; i++) out[i] = Math.random() * 2 - 1;
    } else {
      for (var j = 0; j < out.length; j++) {
        var w = Math.random() * 2 - 1;
        this.b0 = 0.99886*this.b0 + w*0.0555179;
        this.b1 = 0.99332*this.b1 + w*0.0750759;
        this.b2 = 0.96900*this.b2 + w*0.1538520;
        this.b3 = 0.86650*this.b3 + w*0.3104856;
        this.b4 = 0.55000*this.b4 + w*0.5329522;
        this.b5 = -0.7616*this.b5 - w*0.0168980;
        out[j] = (this.b0+this.b1+this.b2+this.b3+this.b4+this.b5+this.b6 + w*0.5362) * 0.11;
        this.b6 = w * 0.115926;
      }
    }
    return this.alive;
  }
}
registerProcessor('noise-gen', NoiseGen);
`;

async function initWorklet() {
  if (S.workletReady || !S.ctx.audioWorklet) return S.workletReady;
  try {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await S.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    S.workletReady = true;
    log('AudioWorklet 模組載入成功', 'ok');
  } catch (e) {
    S.workletReady = false;
    log('AudioWorklet 載入失敗，改用迴圈緩衝：' + e.message, 'warn');
  }
  return S.workletReady;
}

/* =====================================================================
 * 音訊圖建立 / 拆除
 * ===================================================================== */

async function ensureContext() {
  if (S.ctx && S.ctx.state !== 'closed') return S.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('此瀏覽器不支援 Web Audio API');
  // latencyHint 'playback'：較大緩衝 → 較低喚醒頻率與耗電。
  // 首字延遲由常駐底噪解決，不需要 'interactive' 的低延遲。
  S.ctx = new AC({ latencyHint: 'playback' });
  const ctx = S.ctx;                       // 捕捉區域參考：close() 後 S.ctx 會被設為 null，
  ctx.onstatechange = () => {              // 而 statechange 回呼可能晚一步才觸發
    if (S.ctx !== ctx) return;
    log('AudioContext 狀態變更 → ' + ctx.state, ctx.state === 'running' ? 'ok' : 'warn');
    renderStatus();
    if (S.cfg.autoGuard && S.running && ctx.state === 'suspended') guardResume('statechange');
  };
  log(`AudioContext 建立：sampleRate=${S.ctx.sampleRate}Hz, baseLatency=${(S.ctx.baseLatency * 1000).toFixed(1)}ms`, 'ok');
  return S.ctx;
}

async function buildNoiseChain() {
  const ctx = S.ctx;

  // 產生器
  if (S.cfg.mode === 'worklet' && await initWorklet()) {
    S.noiseNode = new AudioWorkletNode(ctx, 'noise-gen', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { color: S.cfg.color === 'white' ? 'white' : 'pink' }
    });
    // worklet 沒有 speech 塑形，仍需要正規化係數 → 借用同色緩衝的 RMS
    await getNoiseBuffer(S.cfg.color === 'white' ? 'white' : 'pink');
    if (S.cfg.color === 'speech') log('AudioWorklet 模式不支援 LTASS 塑形，已退回粉紅噪音頻譜', 'warn');
  } else {
    const { buffer } = await getNoiseBuffer(S.cfg.color);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    src.start();
    S.noiseNode = src;
  }

  // 限頻濾波
  let tail = S.noiseNode;
  if (S.cfg.filter !== 'none') {
    const f = ctx.createBiquadFilter();
    if (S.cfg.filter === 'lp300') { f.type = 'lowpass'; f.frequency.value = 300; }
    else { f.type = 'highpass'; f.frequency.value = 6000; }
    f.Q.value = 0.707;
    tail.connect(f);
    S.filterNode = f;
    tail = f;
  }

  // 音節包絡調變（LFO 跑在音訊執行緒，不受主執行緒節流影響）
  S.amGain = ctx.createGain();
  if (S.cfg.am > 0) {
    const depth = 0.6;
    S.amGain.gain.value = 1 - depth / 2;
    S.amOsc = ctx.createOscillator();
    S.amOsc.type = 'sine';
    S.amOsc.frequency.value = S.cfg.am;
    S.amOffset = ctx.createGain();
    S.amOffset.gain.value = depth / 2;
    S.amOsc.connect(S.amOffset).connect(S.amGain.gain);
    S.amOsc.start();
  } else {
    S.amGain.gain.value = 1;
  }
  tail.connect(S.amGain);

  // 音量
  S.noiseGain = ctx.createGain();
  S.noiseGain.gain.value = currentNoiseGainValue();
  S.amGain.connect(S.noiseGain).connect(S.busIn);
}

function currentNoiseGainValue() {
  const key = S.cfg.color;
  const norm = S.norm[key] || S.norm.pink || 1;
  return norm * dbToGain(S.cfg.db);
}

function teardownNoiseChain() {
  try { if (S.noiseNode && S.noiseNode.stop) S.noiseNode.stop(); } catch (e) { /* already stopped */ }
  try { if (S.noiseNode && S.noiseNode.port) S.noiseNode.port.postMessage('stop'); } catch (e) { /* no port */ }
  [S.noiseNode, S.filterNode, S.amGain, S.amOsc, S.amOffset, S.noiseGain].forEach(n => {
    try { if (n) n.disconnect(); } catch (e) { /* ignore */ }
  });
  try { if (S.amOsc) S.amOsc.stop(); } catch (e) { /* ignore */ }
  S.noiseNode = S.filterNode = S.amGain = S.amOsc = S.amOffset = S.noiseGain = null;
}

async function start() {
  try {
    await ensureContext();
    const ctx = S.ctx;

    if (!S.busIn) {
      S.busIn = ctx.createGain();
      S.busIn.gain.value = 1.0;
      S.voiceBus = ctx.createGain();
      S.voiceBus.gain.value = 1.0;      // 語音維持原始音量，確保高 SNR
      S.voiceBus.connect(S.busIn);
      S.analyser = ctx.createAnalyser();
      S.analyser.fftSize = 2048;
      S.analyser.smoothingTimeConstant = 0.3;
      S.busIn.connect(S.analyser);
      applyRouting();
    }

    if (!S.noiseNode) await buildNoiseChain();

    S.suspendedByUser = false;
    await ctx.resume();
    S.running = true;
    S.startedAt = performance.now();
    log(`管線啟動：${S.cfg.color} / ${S.cfg.db.toFixed(1)}dB / 濾波=${S.cfg.filter} / AM=${S.cfg.am || '關'}Hz / ${S.cfg.mode}`, 'ok');
    if (S.cfg.autoGuard) startGuard();
    startMeter();
    renderStatus();
  } catch (e) {
    log('啟動失敗：' + e.message, 'err');
  }
}

async function stopAll() {
  stopMeter();
  stopGuard();
  teardownNoiseChain();
  S.activeVoices.forEach(v => { try { v.src.stop(); } catch (e) { /* ignore */ } });
  S.activeVoices.clear();
  try { if (S.analyser) S.analyser.disconnect(); } catch (e) { /* ignore */ }
  try { if (S.busIn) S.busIn.disconnect(); } catch (e) { /* ignore */ }
  try { if (S.voiceBus) S.voiceBus.disconnect(); } catch (e) { /* ignore */ }
  S.busIn = S.voiceBus = S.analyser = null;
  S.streamDest = null;
  const sink = $('#sinkEl');
  sink.pause(); sink.srcObject = null;
  if (S.ctx && S.ctx.state !== 'closed') { try { await S.ctx.close(); } catch (e) { /* ignore */ } }
  S.ctx = null;
  S.buffers = {}; S.norm = {}; S.workletReady = false;
  S.running = false;
  log('已停止並釋放所有音訊資源', 'warn');
  renderStatus();
}

/* 熱重建底噪鏈（切換顏色 / 濾波 / AM / 實作時） */
async function rebuildNoise() {
  if (!S.running || !S.ctx) return;
  teardownNoiseChain();
  await buildNoiseChain();
  log('底噪鏈已重建（主 AudioContext 未中斷）', 'ok');
  renderStatus();
}

/* =====================================================================
 * 輸出路由
 * ===================================================================== */
function applyRouting() {
  if (!S.analyser) return;
  try { S.analyser.disconnect(); } catch (e) { /* ignore */ }
  const sink = $('#sinkEl');
  if (S.cfg.route === 'stream') {
    if (!S.streamDest) S.streamDest = S.ctx.createMediaStreamDestination();
    S.analyser.connect(S.streamDest);
    sink.srcObject = S.streamDest.stream;
    sink.play().then(() => log('已切換至 MediaStream → <audio> 路由', 'ok'))
               .catch(e => log('<audio> 播放被拒：' + e.message, 'err'));
  } else {
    sink.pause(); sink.srcObject = null;
    S.analyser.connect(S.ctx.destination);
    log('已切換至 AudioContext.destination 直接輸出', 'ok');
  }
}

/* =====================================================================
 * 語音注入 —— 每次播放建立獨立節點，播完只銷毀該節點
 * ===================================================================== */
function injectBuffer(buffer, label) {
  if (!S.ctx || S.ctx.state === 'closed') { log('管線未啟動，無法注入語音', 'err'); return; }
  const ctx = S.ctx;
  const dur = buffer.duration;
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  // 獨立 envelope gain：避免直連 destination 造成的起停爆音
  const g = ctx.createGain();
  const t0 = ctx.currentTime + SCHEDULE_LEAD;
  const fade = Math.min(VOICE_FADE, dur / 4);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(1, t0 + fade);
  g.gain.setValueAtTime(1, t0 + dur - fade);
  g.gain.linearRampToValueAtTime(0, t0 + dur);

  src.connect(g).connect(S.voiceBus);
  const rec = { src, g };
  S.activeVoices.add(rec);
  src.onended = () => {
    try { src.disconnect(); g.disconnect(); } catch (e) { /* ignore */ }
    S.activeVoices.delete(rec);
    log(`語音節點已銷毀（${label}）｜底噪與主 Context 持續運行`, 'info');
    renderStatus();
  };
  src.start(t0);

  const outLat = (S.ctx.outputLatency || 0) * 1000;
  log(`注入「${label}」長度 ${dur.toFixed(2)}s，排程提前 ${(SCHEDULE_LEAD * 1000).toFixed(0)}ms，` +
      `輸出延遲 ${outLat.toFixed(1)}ms，SNR ≈ ${(-S.cfg.db).toFixed(1)}dB`, 'ok');
  renderStatus();
}

/* 合成 2 秒「語音狀」測試音：脈衝源 + 三共振峰帶通 + 音節包絡 */
async function makeSynthVoice() {
  const sr = S.ctx.sampleRate;
  const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const off = new OC(1, Math.floor(sr * 2), sr);
  const VOWELS = [[800, 1200, 2500], [300, 2300, 3000], [350, 1200, 2200], [500, 1900, 2500], [500, 1000, 2400]];
  const master = off.createGain();
  master.gain.value = 0.5;
  master.connect(off.destination);

  for (let i = 0; i < 5; i++) {
    const t = i * 0.38 + 0.05;
    const len = 0.28;
    const v = VOWELS[Math.floor(Math.random() * VOWELS.length)];
    const osc = off.createOscillator();
    osc.type = 'sawtooth';
    const f0 = 130 + Math.random() * 60;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.linearRampToValueAtTime(f0 * (0.85 + Math.random() * 0.3), t + len);

    const env = off.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.03);
    env.gain.setValueAtTime(1, t + len - 0.06);
    env.gain.linearRampToValueAtTime(0, t + len);

    osc.connect(env);
    v.forEach((f, k) => {
      const bp = off.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 6 + k * 2;
      const bg = off.createGain();
      bg.gain.value = [1, 0.5, 0.25][k];
      env.connect(bp).connect(bg).connect(master);
    });
    osc.start(t); osc.stop(t + len + 0.02);

    // 子音爆破（30ms 高頻噪音）
    const nb = off.createBuffer(1, Math.floor(sr * 0.03), sr);
    const nd = nb.getChannelData(0);
    for (let j = 0; j < nd.length; j++) nd[j] = (Math.random() * 2 - 1) * (1 - j / nd.length);
    const ns = off.createBufferSource(); ns.buffer = nb;
    const hp = off.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2500;
    const ng = off.createGain(); ng.gain.value = 0.25;
    ns.connect(hp).connect(ng).connect(master);
    ns.start(t);
  }
  const rendered = await off.startRendering();
  // 峰值正規化到 0.8：共振峰帶通後的實際振幅無法預測，
  // 不正規化的話語音會偏小聲，SNR 不具代表性
  const d = rendered.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  if (peak > 0) { const k = 0.8 / peak; for (let i = 0; i < d.length; i++) d[i] *= k; }
  return rendered;
}

async function makeTone() {
  const sr = S.ctx.sampleRate;
  const n = Math.floor(sr * 0.3);
  const buf = S.ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 1000 * i / sr) * 0.5;
  return buf;
}

/* =====================================================================
 * 守護 / 自動恢復
 * ===================================================================== */
let guardTimer = 0;
function startGuard() {
  stopGuard();
  guardTimer = setInterval(() => {
    if (!S.running || !S.ctx) return;
    if (S.ctx.state === 'suspended') guardResume('timer');
  }, 3000);
}
function stopGuard() { if (guardTimer) { clearInterval(guardTimer); guardTimer = 0; } }

function guardResume(reason) {
  if (!S.ctx || S.ctx.state !== 'suspended') return;
  // 使用者主動按下的暫停不該被守護程式覆寫，否則暫停鈕與冷啟動對照組都會失效
  if (S.suspendedByUser) return;
  S.ctx.resume().then(() => {
    S.resumeCount++;
    log(`自動恢復成功（觸發來源：${reason}）`, 'ok');
    renderStatus();
  }).catch(e => log(`自動恢復失敗（${reason}）：${e.message}｜可能需要使用者手勢`, 'warn'));
}

['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
  document.addEventListener(ev, () => { if (S.cfg.autoGuard) guardResume('user-gesture'); }, { passive: true, capture: true })
);
document.addEventListener('visibilitychange', () => {
  log('可見性變更 → ' + document.visibilityState, 'info');
  if (document.visibilityState === 'visible') {
    if (S.cfg.autoGuard) guardResume('visibilitychange');
    if ($('#chkWake').checked) requestWakeLock();
  }
});

/* =====================================================================
 * 背景鎖 (silent <audio> + MediaSession)
 * ===================================================================== */
function makeSilentWavUrl(seconds = 5, sr = 8000, amp = 1e-4) {
  const n = seconds * sr;
  const bytes = 44 + n * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, n * 2, true);
  // 極微弱噪音而非純數位靜音：純 0 可能被系統的靜音最佳化路徑丟棄
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * amp * 32767), true);
  return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }));
}

let bgLockUrl = null;
async function setBgLock(on) {
  const el = $('#bgLockEl');
  if (on) {
    if (!bgLockUrl) { bgLockUrl = makeSilentWavUrl(); el.src = bgLockUrl; }
    el.volume = 1;
    try {
      await el.play();
      log('背景鎖啟用：靜音 <audio> 迴圈播放中', 'ok');
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '音訊保持喚醒', artist: 'Live Caption Keep-Alive', album: 'PWA'
        });
        navigator.mediaSession.playbackState = 'playing';
        navigator.mediaSession.setActionHandler('play', () => { el.play(); guardResume('mediasession'); });
        navigator.mediaSession.setActionHandler('pause', () => { /* 刻意忽略，避免被系統暫停 */ });
        log('MediaSession metadata 已設定', 'ok');
      }
    } catch (e) { log('背景鎖啟用失敗：' + e.message, 'err'); }
  } else {
    el.pause();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    log('背景鎖已關閉', 'warn');
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) { log('此瀏覽器不支援 Wake Lock API', 'warn'); return; }
  try {
    if (S.wakeLock) return;
    S.wakeLock = await navigator.wakeLock.request('screen');
    S.wakeLock.addEventListener('release', () => { S.wakeLock = null; log('Wake Lock 已被系統釋放', 'warn'); });
    log('螢幕 Wake Lock 已取得', 'ok');
  } catch (e) { log('Wake Lock 取得失敗：' + e.message, 'err'); }
}
function releaseWakeLock() {
  if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; log('Wake Lock 已釋放', 'warn'); }
}

/* =====================================================================
 * 電平表 / 狀態顯示
 * ===================================================================== */
let meterBuf = null;
function startMeter() {
  stopMeter();
  const tick = () => {
    if (S.analyser) {
      if (!meterBuf || meterBuf.length !== S.analyser.fftSize) meterBuf = new Float32Array(S.analyser.fftSize);
      S.analyser.getFloatTimeDomainData(meterBuf);
      const db = gainToDb(rmsOf(meterBuf));
      $('#stLvl').textContent = (db === -Infinity ? '−∞' : db.toFixed(1)) + ' dBFS';
      $('#meterBar').style.width = clamp((db + 80) / 80 * 100, 0, 100) + '%';
    }
    const up = S.running ? (performance.now() - S.startedAt) / 1000 : 0;
    $('#stUp').textContent =
      String(Math.floor(up / 60)).padStart(2, '0') + ':' + String(Math.floor(up % 60)).padStart(2, '0');
    S.meterRaf = requestAnimationFrame(tick);
  };
  S.meterRaf = requestAnimationFrame(tick);
}
function stopMeter() { if (S.meterRaf) cancelAnimationFrame(S.meterRaf); S.meterRaf = 0; }

function renderStatus() {
  const st = S.ctx ? S.ctx.state : 'none';
  const badge = $('#stState');
  badge.className = 'badge ' + st;
  $('#stStateT').textContent = st.toUpperCase();
  $('#stNoise').textContent = S.noiseNode
    ? `運行中 · ${S.activeVoices.size} 個語音節點`
    : '停止';
  $('#stSr').textContent = S.ctx ? S.ctx.sampleRate + ' Hz' : '—';
  $('#stLat').textContent = S.ctx
    ? `${(S.ctx.baseLatency * 1000).toFixed(1)} / ${((S.ctx.outputLatency || 0) * 1000).toFixed(1)} ms`
    : '—';
  $('#stRes').textContent = S.resumeCount;
  $('#btnStart').disabled = S.running && S.ctx && S.ctx.state === 'running';
}

/* =====================================================================
 * UI 綁定
 * ===================================================================== */
function syncDbLabel() {
  $('#dbVal').textContent = S.cfg.db.toFixed(1);
  $('#gainVal').textContent = dbToGain(S.cfg.db).toFixed(4);
}

$('#dbSlider').addEventListener('input', (e) => {
  S.cfg.db = parseFloat(e.target.value);
  syncDbLabel();
  if (S.noiseGain && S.ctx) {
    // setTargetAtTime 平滑過渡，避免調整時產生階梯雜訊
    S.noiseGain.gain.setTargetAtTime(currentNoiseGainValue(), S.ctx.currentTime, 0.05);
  }
});
$('#dbSlider').addEventListener('change', () => log(`底噪音量設為 ${S.cfg.db.toFixed(1)} dBFS RMS`, 'info'));

$('#chkWideRange').addEventListener('change', (e) => {
  const sl = $('#dbSlider');
  sl.min = e.target.checked ? -90 : -60;
  sl.max = e.target.checked ? -12 : -30;
  $('#tickMin').textContent = sl.min + ' dB';
  $('#tickMax').textContent = sl.max + ' dB';
  S.cfg.db = clamp(S.cfg.db, +sl.min, +sl.max);
  sl.value = S.cfg.db;
  syncDbLabel();
});

$('#selColor').addEventListener('change', e => { S.cfg.color = e.target.value; rebuildNoise(); });
$('#selFilter').addEventListener('change', e => { S.cfg.filter = e.target.value; rebuildNoise(); });
$('#selAm').addEventListener('change', e => { S.cfg.am = parseFloat(e.target.value); rebuildNoise(); });
$('#selMode').addEventListener('change', e => { S.cfg.mode = e.target.value; rebuildNoise(); });
$('#selRoute').addEventListener('change', e => {
  S.cfg.route = e.target.value;
  if (S.ctx && S.analyser) applyRouting();
});

$('#btnStart').addEventListener('click', start);
$('#btnResume').addEventListener('click', async () => {
  if (!S.ctx) return start();
  S.suspendedByUser = false;
  try { await S.ctx.resume(); S.resumeCount++; log('手動 resume() 成功', 'ok'); }
  catch (e) { log('手動 resume() 失敗：' + e.message, 'err'); }
  renderStatus();
});
$('#btnSuspend').addEventListener('click', async () => {
  if (!S.ctx) return;
  S.suspendedByUser = true;
  try { await S.ctx.suspend(); log('已手動掛起 AudioContext（自動守護暫時讓路）', 'warn'); }
  catch (e) { log(e.message, 'err'); }
  renderStatus();
});
$('#btnStop').addEventListener('click', stopAll);

$('#btnSynth').addEventListener('click', async () => {
  if (!S.ctx) await start();
  injectBuffer(await makeSynthVoice(), '合成語音 2s');
});
$('#btnTone').addEventListener('click', async () => {
  if (!S.ctx) await start();
  injectBuffer(await makeTone(), '1kHz 嗶聲');
});

$('#fileIn').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    await ensureContext();
    const ab = await f.arrayBuffer();
    // 注意：不使用 MediaElementAudioSourceNode —— 同一個 <audio> 只能建立一次
    // MediaElementSource，重複建立會拋 InvalidStateError。decodeAudioData 沒有此限制。
    S.uploaded = await S.ctx.decodeAudioData(ab);
    $('#btnFile').disabled = false;
    log(`音檔已解碼：${f.name}，長度 ${S.uploaded.duration.toFixed(2)}s，${S.uploaded.numberOfChannels}ch`, 'ok');
  } catch (err) { log('解碼失敗：' + err.message, 'err'); }
});
$('#btnFile').addEventListener('click', async () => {
  if (!S.uploaded) return;
  if (!S.running) await start();
  injectBuffer(S.uploaded, '上傳音檔');
});

$('#btnTts').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) { log('此瀏覽器不支援 SpeechSynthesis', 'err'); return; }
  const u = new SpeechSynthesisUtterance($('#ttsText').value);
  u.lang = 'ja-JP';
  u.onstart = () => log('TTS 開始播放（走系統音訊，不經本頁 AudioContext）', 'ok');
  u.onend = () => log('TTS 播放結束', 'info');
  u.onerror = (ev) => log('TTS 錯誤：' + ev.error, 'err');
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
});

$('#btnCold').addEventListener('click', async () => {
  if (!S.ctx || !S.running) { log('請先啟動管線再做對照測試', 'warn'); return; }
  log('=== 冷啟動對照組開始 ===', 'warn');
  const buf = await makeSynthVoice();
  S.suspendedByUser = true;                // 讓守護程式在對照期間讓路
  await S.ctx.suspend();
  log('已掛起管線，等待 2 秒讓系統音訊通道休眠…', 'warn');
  setTimeout(async () => {
    const t0 = performance.now();
    S.suspendedByUser = false;
    await S.ctx.resume();
    log(`resume() 耗時 ${(performance.now() - t0).toFixed(1)}ms，立即注入語音`, 'warn');
    injectBuffer(buf, '冷啟動對照組');
    log('=== 對照組結束：請比對字幕是否吃掉開頭 ===', 'warn');
  }, 2000);
});

$('#chkBgLock').addEventListener('change', e => setBgLock(e.target.checked));
$('#chkWake').addEventListener('change', e => e.target.checked ? requestWakeLock() : releaseWakeLock());
$('#chkAuto').addEventListener('change', e => {
  S.cfg.autoGuard = e.target.checked;
  if (e.target.checked && S.running) startGuard(); else stopGuard();
});

$('#btnClearLog').addEventListener('click', () => { logEl.innerHTML = ''; });
$('#btnCopyLog').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(logEl.innerText); log('記錄已複製到剪貼簿', 'ok'); }
  catch (e) { log('複製失敗：' + e.message, 'err'); }
});

/* PWA 安裝 */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  S.deferredInstall = e;
  $('#btnInstall').style.display = 'block';
});
$('#btnInstall').addEventListener('click', async () => {
  if (!S.deferredInstall) return;
  S.deferredInstall.prompt();
  const { outcome } = await S.deferredInstall.userChoice;
  log('安裝提示結果：' + outcome, 'info');
  S.deferredInstall = null;
  $('#btnInstall').style.display = 'none';
});

/* Service Worker（僅在有 https / localhost 時） */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => log('Service Worker 已註冊（離線可用）', 'ok'))
      .catch(e => log('Service Worker 註冊略過：' + e.message, 'warn'));
  });
}

/* 初始化 */
syncDbLabel();
renderStatus();
log('就緒。請按「啟動管線」（需使用者手勢才能開啟音訊）。', 'info');
if (!(window.AudioContext || window.webkitAudioContext)) log('此瀏覽器不支援 Web Audio API', 'err');
