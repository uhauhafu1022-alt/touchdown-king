/* =========================================================================
 * タッチダウン王 対人対戦（オフェンス vs ディフェンス）
 *  方式：一人プレーのゲームループをそのまま再利用。
 *   - オフェンス側 = 通常の1Pプレー（スクロール／カット・ショルダー・ジャンプ・
 *     ブロッカー／当たり判定／演出すべて同一）。ただし守備の自動湧きは停止。
 *   - ディフェンス側 = 自陣（画面上半分）をタップすると、選んだ種類の守備が
 *     その場に出現。守備は1Pと同じランダムAIで動く（ホーミング/ふらつき/飛び込み）。
 *   - 通信：Supabase Realtime。オフェンス側が権威、状態を配信。守備側は同期表示。
 *   - 攻守交代 → 進んだヤードで勝敗。レベル（速さ）= top
 *  既存コード無改造。</body>直前に <script src="./td-versus.js"></script>
 * ========================================================================= */
(function () {
  'use strict';
  if (window.TDVersus) return;

  var LEVEL_KEY = 'top';           // 対人の速さ
  var ROUND_MAX_SEC = 75;

  /* ===== 接続・ロビー ===== */
  var client = null, channel = null;
  var myId = 'p_' + Math.random().toString(36).slice(2, 9);
  var role = null, roomCode = null, ready = false;

  function getName() { try { if (typeof user !== 'undefined' && user && user.name) return String(user.name).slice(0, 12); } catch (e) {} return 'プレイヤー'; }
  function getClient() { if (client) return client; try { if (window.supabase && typeof SUPA_URL !== 'undefined' && typeof SUPA_ANON !== 'undefined') client = window.supabase.createClient(SUPA_URL, SUPA_ANON); } catch (e) {} return client; }
  function genCode() { var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = ''; for (var i = 0; i < 5; i++) s += a.charAt(Math.floor(Math.random() * a.length)); return s; }
  function peers() { if (!channel || !channel.presenceState) return []; var st = channel.presenceState(), o = []; for (var k in st) for (var i = 0; i < st[k].length; i++) o.push(st[k][i]); return o; }
  function meTracked() { if (channel) { try { channel.track({ id: myId, role: role, name: getName(), ready: ready }); } catch (e) {} } }
  function joinRoom(code, asRole) {
    var c = getClient(); if (!c) { renderError('オンライン接続が必要です。'); return; }
    leave(); roomCode = code; role = asRole; ready = false; render();
    channel = c.channel('versus:' + code, { config: { presence: { key: myId } } });
    channel.on('presence', { event: 'sync' }, function () { render(); maybeStart(); })
      .on('presence', { event: 'join' }, function () { render(); maybeStart(); })
      .on('presence', { event: 'leave' }, function () { if (V.active) peerLeft(); render(); })
      .on('broadcast', { event: 'msg' }, function (m) { onMsg(m && m.payload); })
      .subscribe(function (s) { if (s === 'SUBSCRIBED') { meTracked(); render(); } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') renderError('接続に失敗しました。'); });
  }
  function setReady(v) { ready = v; meTracked(); render(); maybeStart(); }
  function leave() { endMatchAll(); if (channel) { try { channel.untrack(); } catch (e) {} try { channel.unsubscribe(); } catch (e) {} channel = null; } roomCode = null; role = null; ready = false; }
  function send(p) { if (channel) { try { channel.send({ type: 'broadcast', event: 'msg', payload: p }); } catch (e) {} } }
  function maybeStart() { if (role !== 'host' || V.active || !ready) return; var o = peers().filter(function (p) { return p.id !== myId; }); if (o.length < 1) return; if (o.every(function (p) { return p.ready; })) { send({ k: 'start' }); enterRound(1); } }

  /* ===== 守備の種類 ===== */
  var DEFTYPES = [
    { id: 'normal', name: '普通', rMin: 15, rMax: 20, spd: 1.00, cd: 0 },
    { id: 'fast', name: '俊足', rMin: 11, rMax: 12, spd: 1.50, cd: 2600 },
    { id: 'big', name: '大型', rMin: 21, rMax: 23, spd: 0.72, cd: 5200 },
  ];

  var MAXDEF = 12;          // 同時に出せる守備の上限（重くならないように）
  var SPAWN_MIN = 220;      // 連打の最小間隔(ms)
  var SEND_MS = 60;         // 状態送信の間隔(ms)
  var _vid = 0;
  var V = {
    active: false, round: 0, amOffense: false, phase: 'idle',
    rbCos: null, result: { 1: null, 2: null }, finalYard: 0,
    selType: 0, cdUntil: [0, 0, 0], lastSend: 0, latest: null, t0: 0, cdEnd: 0, _cv: null, _ctrl: null,
    lastSpawn: 0, pl: null, dmap: {}, darr: [], barr: [], sc: 0, sp: 0, fy: 0, fyc: 0, hb: 1
  };
  function roundOffenseIsHost(n) { return n === 1; }

  /* ===== エンジンのフック（1度だけ） ===== */
  var patched = false, oUpdate, oRender, oSpawn, oGameOver, oWin, oCos;
  function patchEngine() {
    if (patched) return; patched = true;
    oUpdate = window.update; oRender = window.render; oSpawn = window.spawnDefender;
    oGameOver = window.gameOver; oWin = window.win; oCos = window.playerCos;
    if (typeof oUpdate === 'function') window.update = function (dt) {
      if (!V.active) return oUpdate.apply(this, arguments);
      if (V.amOffense) { oUpdate.apply(this, arguments); offBroadcast(); return; }
      defApply(); return;
    };
    if (typeof oRender === 'function') window.render = function () {
      if (!V.active) return oRender.apply(this, arguments);
      selfHeal();
      if (V.amOffense) { oRender.apply(this, arguments); drawVsHud(); return; }
      defRender(); return;
    };
    if (typeof oSpawn === 'function') window.spawnDefender = function () { if (V.active) return; return oSpawn.apply(this, arguments); };
    if (typeof oGameOver === 'function') window.gameOver = function (byNum) { if (V.active && V.amOffense) { vsEnd('tackled'); return; } return oGameOver.apply(this, arguments); };
    if (typeof oWin === 'function') window.win = function () { if (V.active && V.amOffense) { vsEnd('touchdown'); return; } return oWin.apply(this, arguments); };
    if (typeof oCos === 'function') window.playerCos = function () { if (V.active && !V.amOffense && V.rbCos) return V.rbCos; return oCos.apply(this, arguments); };
  }

  /* ===== ラウンド開始 ===== */
  function enterRound(n) {
    patchEngine();
    V.active = true; V.round = n; V.phase = 'play';
    V.amOffense = roundOffenseIsHost(n) ? (role === 'host') : (role === 'guest');
    V.selType = 0; V.cdUntil = [0, 0, 0]; V.latest = null; V.finalYard = 0;
    V.pl = null; V.dmap = {}; V.darr = []; V.barr = []; V.fyc = 0; V.lastSpawn = 0; V.lastSend = 0;
    V.t0 = performance.now();
    closeLobby();
    try { if (typeof challengeMode !== 'undefined') challengeMode = false; } catch (e) {}
    try { if (typeof LEVELS !== 'undefined' && LEVELS[LEVEL_KEY]) curLevel = LEVELS[LEVEL_KEY]; } catch (e) {}
    if (V.amOffense) {
      try { send({ k: 'cos', c: (typeof oCos === 'function' ? oCos() : null) }); } catch (e) {}
      try { startRun(); } catch (e) {}                    // ← 1Pのプレー開始をそのまま使う
    } else {
      try { if (typeof showScreen === 'function') showScreen(null); } catch (e) {}
      try { reset(); } catch (e) {}
      try { state = STATE.PAUSE; } catch (e) {}          // ゲーム側の入力を無効化しつつ描画は可能に
    }
    buildControls(); bindCanvas(); hideCoinHud(true);
  }
  function selfHeal() {
    var ov = document.getElementById('tdv-ov'); if (ov && ov.style.display !== 'none') ov.style.display = 'none';
    if (V.phase === 'play' && !document.getElementById('tdv-ctrl')) { try { buildControls(); } catch (e) {} }
    if (!V._cv) { try { bindCanvas(); } catch (e) {} }
  }
  function endMatchAll() { V.active = false; V.phase = 'idle'; unbindCanvas(); removeControls(); hideCoinHud(false); }
  function peerLeft() { if (V.active) { endMatchAll(); showResult(null, null, '相手が退出しました'); } }

  /* ===== オフェンス：配信 ===== */
  function offBroadcast() {
    var now = performance.now();
    if (V.phase !== 'play') return;
    if (now - V.t0 > ROUND_MAX_SEC * 1000) { vsEnd('timeup'); return; }
    if (now - V.lastSend < SEND_MS) return; V.lastSend = now;
    try {
      var d = [], i;
      for (i = 0; i < defenders.length; i++) { var x = defenders[i]; d.push([x.vid | 0, x.x | 0, x.y | 0, x.r | 0, (x.leg * 10) | 0, x.downed ? 1 : 0, x.num]); }
      var b = []; for (i = 0; i < blockers.length; i++) { var y = blockers[i]; b.push([y.x | 0, y.y | 0, y.r | 0, (y.leg * 10) | 0, y.num]); }
      send({
        k: 'st',
        p: [player.x | 0, player.y | 0, (player.leg * 10) | 0, player.jump | 0, player.jumpMax | 0, player.shoulderT | 0, player.num],
        d: d, b: b, s: Math.floor(score), sp: Math.round(speed * 100) / 100, fy: fieldY | 0, hb: hasBall ? 1 : 0
      });
    } catch (e) {}
  }
  /* ===== ディフェンス：受信状態をゲームのグローバルへ流し込む ===== */
  // 受信時だけ「目標値」を更新（毎フレームの作り直しをやめて軽量化）
  function defIngest(L) {
    try {
      if (!V.pl) V.pl = { x: L.p[0], y: L.p[1], tx: L.p[0], ty: L.p[1], r: 15, vx: 0, leg: 0, cutT: 99, cutDur: 7, cutFrom: 0, cutTarget: 0, lock: 0, jump: 0, jumpMax: 46, shoulderT: 0, num: '22' };
      var p = V.pl; p.tx = L.p[0]; p.ty = L.p[1]; p.leg = L.p[2] / 10; p.jump = L.p[3]; p.jumpMax = L.p[4] || 46; p.shoulderT = L.p[5]; p.num = L.p[6] || '22';
      var seen = {}, i, a, id, o;
      for (i = 0; i < L.d.length; i++) {
        a = L.d[i]; id = a[0]; seen[id] = 1; o = V.dmap[id];
        if (!o) o = V.dmap[id] = { x: a[1], y: a[2], tx: a[1], ty: a[2], r: a[3], leg: 0, downed: false, num: a[6], kb: 0, vx: 0, speedMul: 1, surgeAmp: 0, homing: false, tackler: false, lungeT: 0, lungeCool: 99, t: 0, kbVx: 0, kbVy: 0 };
        o.tx = a[1]; o.ty = a[2]; o.r = a[3]; o.leg = a[4] / 10; o.downed = a[5] === 1; o.num = a[6];
      }
      for (id in V.dmap) { if (!seen[id]) delete V.dmap[id]; }
      V.barr.length = 0;
      for (i = 0; i < (L.b || []).length; i++) { var c = L.b[i]; V.barr.push({ x: c[0], y: c[1], r: c[2], leg: c[3] / 10, num: c[4], blocks: 0, life: 900, off: 0 }); }
      V.sc = L.s; V.sp = L.sp; V.fy = L.fy; V.hb = L.hb;
      if (!V.fyc) V.fyc = L.fy;
    } catch (e) {}
  }
  // 毎フレームは軽い補間だけ（なめらかに見せる）
  function defApply() {
    if (!V.pl) return;
    try {
      var k = 0.35, p = V.pl, id, o;
      p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k;
      V.darr.length = 0;
      for (id in V.dmap) { o = V.dmap[id]; o.x += (o.tx - o.x) * k; o.y += (o.ty - o.y) * k; V.darr.push(o); }
      V.fyc += (V.fy - V.fyc) * k;
      player = p; defenders = V.darr; blockers = V.barr;
      score = V.sc; speed = V.sp; fieldY = V.fyc; hasBall = V.hb === 1; qb = null;
    } catch (e) {}
  }
  function defRender() {
    try { drawScene(); } catch (e) { try { drawField(); } catch (e2) {} }
    drawVsHud();
  }
  function drawVsHud() {
    try {
      var w = W, sc = (typeof score !== 'undefined' ? Math.floor(score) : 0);
      ctx.textAlign = 'right'; ctx.font = '800 13px -apple-system,sans-serif';
      ctx.fillStyle = V.amOffense ? '#7fd4ff' : '#ff9d8a';
      ctx.fillText(V.amOffense ? '🏈 攻撃（あなた）' : '🛡 守備（あなた）', w - 14, 78);
      if (!V.amOffense) {
        ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = '900 30px -apple-system,sans-serif';
        ctx.fillText(sc + ' / 100 yd', 14, 40);
        ctx.strokeStyle = 'rgba(255,255,255,.45)'; ctx.setLineDash([8, 8]); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, H * 0.5); ctx.lineTo(w, H * 0.5); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '700 12px -apple-system,sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('▲ ここから上をタップで守備を出す', w / 2, H * 0.5 - 8);
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([8, 8]); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, H * 0.5); ctx.lineTo(w, H * 0.5); ctx.stroke(); ctx.setLineDash([]);
      }
      if (V.phase === 'over') {
        ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '900 30px -apple-system,sans-serif';
        ctx.fillText(V.round === 1 ? 'まもなく攻守交代…' : '結果を集計中…', W / 2, H / 2);
        ctx.font = '800 20px -apple-system,sans-serif'; ctx.fillText('記録 ' + V.finalYard + ' yd', W / 2, H / 2 + 32);
      }
    } catch (e) {}
  }

  /* ===== 守備の出現（1PのAIをそのまま付与） ===== */
  function netSpawn(x, y, ti) {
    try {
      if (defenders.length >= MAXDEF) return;           // 出しすぎ防止（重さ対策）
      var t = DEFTYPES[ti] || DEFTYPES[0];
      var r = t.rMin + Math.random() * (t.rMax - t.rMin);
      var lv = curLevel || { homing: .5, tackler: .35, lunge: .012 };
      var homing = Math.random() < lv.homing;
      var tackler = Math.random() < lv.tackler;
      var vx = homing ? 0 : ((Math.random() < 0.6) ? (Math.random() - 0.5) * 3.4 : 0);
      var speedMul = t.spd * (0.9 + Math.random() * 1.05);
      var surgeAmp = (Math.random() < 0.5) ? 1.3 + Math.random() * 1.9 : 0;
      var num = '99'; try { num = '' + rollDefNum(Math.floor(score)); } catch (e) {}
      defenders.push({ vid: ++_vid, x: x, y: y, r: r, vx: vx, speedMul: speedMul, surgeAmp: surgeAmp, homing: homing, tackler: tackler, lungeT: 0, lungeCool: 50 + Math.random() * 90, t: Math.random() * 6, leg: Math.random() * 6, downed: false, kb: 0, kbVx: 0, kbVy: 0, num: num });
      try { burst(x, y, C.def, 8, 3); } catch (e) {}
    } catch (e) {}
  }

  /* ===== 入力（守備＝上半分タップで出現／攻撃＝1Pの操作をそのまま） ===== */
  function ptXY(e) { var p = (e.touches && e.touches[0]) ? e.touches[0] : e; return { x: pX(p.clientX), y: pY(p.clientY) }; }
  function onDown(e) {
    if (!V.active || V.amOffense || V.phase !== 'play') return;
    var p = ptXY(e);
    if (p.y > H * 0.5) { flash('自陣（上半分）にだけ出せます'); return; }
    var ti = V.selType, t = DEFTYPES[ti], now = performance.now();
    if (now - V.lastSpawn < SPAWN_MIN) return;           // 連打の下限間隔
    if (t.cd > 0 && now < V.cdUntil[ti]) return;
    V.lastSpawn = now;
    if (t.cd > 0) V.cdUntil[ti] = now + t.cd;
    send({ k: 'spawn', x: Math.round(p.x), y: Math.round(p.y), t: ti });
    try { sHelmet(); } catch (e2) {}
    updateTypeButtons();
  }
  function bindCanvas() { var cv = (typeof canvas !== 'undefined') ? canvas : document.getElementById('game'); if (!cv || V._cv) return; V._cv = cv; cv.addEventListener('mousedown', onDown); cv.addEventListener('touchstart', onDown, { passive: true }); }
  function unbindCanvas() { var cv = V._cv; if (!cv) return; cv.removeEventListener('mousedown', onDown); cv.removeEventListener('touchstart', onDown); V._cv = null; }

  /* ===== 守備の種類ボタン ===== */
  function buildControls() {
    removeControls();
    if (V.amOffense) return;                       // 攻撃は1Pのボタンをそのまま使う
    var wrap = document.createElement('div'); wrap.id = 'tdv-ctrl';
    wrap.style.cssText = 'position:fixed;left:0;right:0;bottom:10px;z-index:99996;display:flex;justify-content:center;gap:8px;padding:0 8px;pointer-events:none;font-family:-apple-system,sans-serif';
    DEFTYPES.forEach(function (t, i) {
      var b = document.createElement('button'); b.dataset.i = i;
      b.style.cssText = 'pointer-events:auto;border:none;border-radius:12px;padding:12px 10px;font-size:14px;font-weight:800;color:#fff;background:#c8362d;box-shadow:0 4px 0 rgba(0,0,0,.35);font-family:inherit;min-width:88px';
      b.onclick = function () { V.selType = i; updateTypeButtons(); };
      wrap.appendChild(b);
    });
    document.body.appendChild(wrap); V._ctrl = wrap; updateTypeButtons();
  }
  function updateTypeButtons() {
    if (!V._ctrl) return; var now = performance.now();
    Array.prototype.forEach.call(V._ctrl.children, function (b) {
      var i = +b.dataset.i, t = DEFTYPES[i];
      var left = t.cd > 0 ? Math.max(0, Math.ceil((V.cdUntil[i] - now) / 1000)) : 0;
      b.textContent = t.name + (t.cd > 0 ? (left > 0 ? ' ' + left + 's' : ' ✓') : ' ∞');
      b.style.outline = (i === V.selType) ? '3px solid #ffd23f' : 'none';
      b.style.opacity = left > 0 ? '0.5' : '1';
      b.style.background = i === 1 ? '#e08a2d' : i === 2 ? '#9b3bd1' : '#c8362d';
    });
  }
  function removeControls() { if (V._ctrl && V._ctrl.parentNode) V._ctrl.parentNode.removeChild(V._ctrl); V._ctrl = null; }
  function hideCoinHud(h) { try { var e = document.getElementById('coinHud'); if (e) e.style.visibility = h ? 'hidden' : ''; } catch (e2) {} }
  var _f = '', _ft = 0; function flash(m) { _f = m; _ft = performance.now() + 1200; }

  /* ===== ラウンド終了・結果 ===== */
  function vsEnd(status) {
    if (V.phase !== 'play') return;
    V.phase = 'over';
    var yd = 0; try { yd = Math.min(100, Math.floor(score)); } catch (e) {}
    if (status === 'touchdown') yd = 100;
    V.finalYard = yd;
    V.result[V.round] = { yard: yd, status: status };
    try { if (status === 'touchdown') { confetti(); sTouchdown(); sHorn(); } else { sApplause(); } } catch (e) {}
    offBroadcastFinal(status, yd);
    send({ k: 'rend', n: V.round, yd: yd, s: status });
    removeControls();
    if (role === 'host') setTimeout(hostAdvance, 2800);
  }
  function offBroadcastFinal(status, yd) { try { send({ k: 'end', s: status, yd: yd, n: V.round }); } catch (e) {} }
  function hostAdvance() {
    if (V.round === 1) { send({ k: 'round', n: 2 }); enterRound(2); }
    else { var h = (V.result[1] && V.result[1].yard) || 0, g = (V.result[2] && V.result[2].yard) || 0; send({ k: 'result', h: h, g: g }); showResult(h, g, null); }
  }
  function onMsg(p) {
    if (!p) return;
    if (p.k === 'start') { if (role !== 'host') enterRound(1); return; }
    if (p.k === 'round') { enterRound(p.n); return; }
    if (p.k === 'cos') { V.rbCos = p.c; return; }
    if (p.k === 'spawn') { if (V.active && V.amOffense && V.phase === 'play') netSpawn(p.x, p.y, p.t); return; }
    if (p.k === 'st') { if (V.active && !V.amOffense) { V.latest = p; defIngest(p); } return; }
    if (p.k === 'end') { if (V.active && !V.amOffense) { V.phase = 'over'; V.finalYard = p.yd; removeControls(); } return; }
    if (p.k === 'rend') { V.result[p.n] = { yard: p.yd, status: p.s }; if (role === 'host') setTimeout(hostAdvance, 2800); return; }
    if (p.k === 'result') { showResult(p.h, p.g, null); return; }
    if (p.k === 'rematch') { backToLobby(); return; }
  }
  function showResult(hostYard, guestYard, note) {
    endMatchAll(); V.phase = 'result';
    try { state = STATE.MENU; if (typeof showScreen === 'function') showScreen(null); } catch (e) {}
    build(); var ov = document.getElementById('tdv-ov'), m = document.getElementById('tdv-modal'); if (!m) return;
    var h;
    if (note) h = '<h2>対戦終了</h2><p>' + note + '</p><div class="tdv-act"><button class="tdv-pri" onclick="TDVersus.close()">ホームへ</button></div>';
    else {
      var my = (role === 'host') ? hostYard : guestYard, op = (role === 'host') ? guestYard : hostYard;
      var v = my > op ? '🏆 あなたの勝ち！' : my < op ? '😢 あなたの負け…' : '🤝 引き分け';
      var col = my > op ? '#ffd23f' : my < op ? '#ff8a7a' : '#9fe0ff';
      h = '<h2 style="color:' + col + '">' + v + '</h2><div class="tdv-players">' +
        '<div class="tdv-pl"><div class="nm">あなた</div><div class="rl">到達</div><div class="rd tdv-ok">' + my + ' yd</div></div>' +
        '<div class="tdv-pl"><div class="nm">相手</div><div class="rl">到達</div><div class="rd tdv-wait">' + op + ' yd</div></div></div>' +
        '<div class="tdv-act"><button class="tdv-pri" onclick="TDVersus._rematch()">もう一度（同じ相手と）</button><button class="tdv-ghost" onclick="TDVersus.close()">ホームへ</button></div>';
    }
    m.innerHTML = h; ov.style.display = 'flex';
  }
  function backToLobby() { endMatchAll(); V.result = { 1: null, 2: null }; ready = false; meTracked(); try { if (typeof goHome === 'function') goHome(); } catch (e) {} var ov = document.getElementById('tdv-ov'); if (ov) ov.style.display = 'flex'; render(); }
  function closeLobby() { var o = document.getElementById('tdv-ov'); if (o) o.style.display = 'none'; }

  /* ===== ロビーUI ===== */
  var CSS = '#tdv-btn{margin-top:8px;width:min(360px,92vw);padding:12px 6px;border:none;border-radius:10px;font-weight:800;font-size:15px;letter-spacing:1px;color:#3a0d0d;background:linear-gradient(180deg,#ff9d8a,#f0573b);box-shadow:0 5px 0 #a32c1a,0 8px 18px rgba(0,0,0,.4);cursor:pointer;font-family:inherit}#tdv-btn:active{transform:translateY(3px);box-shadow:0 2px 0 #a32c1a}' +
  '#tdv-ov{position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,.66);display:none;align-items:center;justify-content:center;padding:14px;font-family:-apple-system,"Segoe UI",sans-serif}' +
  '#tdv-modal{background:#0a0f1e;color:#eef3ff;width:min(440px,94vw);max-height:90vh;overflow:auto;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.6);padding:20px;text-align:center}' +
  '#tdv-modal h2{margin:0 0 6px;font-size:22px}#tdv-modal p{font-size:13px;opacity:.9;line-height:1.7;margin:4px 0}' +
  '.tdv-act{display:flex;flex-direction:column;gap:9px;margin-top:14px;align-items:center}.tdv-act button{width:min(300px,80vw);border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}' +
  '.tdv-pri{background:linear-gradient(180deg,#9fe0ff,#3bb4f5);color:#03263a;box-shadow:0 4px 0 #1a78ad}.tdv-red{background:linear-gradient(180deg,#ff9d8a,#f0573b);color:#3a0d0d;box-shadow:0 4px 0 #a32c1a}.tdv-ghost{background:rgba(255,255,255,.12);color:#fff;border:2px solid rgba(255,255,255,.45)}' +
  '.tdv-code{font-size:40px;font-weight:900;letter-spacing:10px;color:#ffd23f;margin:10px 0;background:#0c1530;border-radius:12px;padding:14px}' +
  '.tdv-input{font-size:26px;font-weight:800;letter-spacing:8px;text-align:center;text-transform:uppercase;width:min(260px,76vw);padding:12px;border-radius:10px;border:2px solid #3bb4f5;background:#0c1530;color:#fff;font-family:inherit}' +
  '.tdv-players{display:flex;gap:10px;justify-content:center;margin:14px 0}.tdv-pl{flex:1;max-width:160px;background:#0c1530;border-radius:12px;padding:12px 8px}.tdv-pl .nm{font-weight:800;font-size:14px;margin-bottom:4px}.tdv-pl .rl{font-size:11px;opacity:.8}.tdv-pl .rd{margin-top:6px;font-size:13px;font-weight:800}.tdv-wait{color:#7fd4ff}.tdv-ok{color:#37c46a}.tdv-err{color:#ff8a7a;font-weight:700;margin-top:8px}';
  function el(t, a, h) { var e = document.createElement(t); if (a) for (var k in a) e[k] = a[k]; if (h != null) e.innerHTML = h; return e; }
  var built = false, view2 = 'menu', errMsg = '';
  function build() { if (built || !document.body) return; built = true; document.head.appendChild(el('style', null, CSS)); var ov = el('div', { id: 'tdv-ov' }); ov.appendChild(el('div', { id: 'tdv-modal' })); document.body.appendChild(ov); }
  function openMenu() { build(); view2 = 'menu'; errMsg = ''; render(); document.getElementById('tdv-ov').style.display = 'flex'; }
  function close() { leave(); var o = document.getElementById('tdv-ov'); if (o) o.style.display = 'none'; try { if (typeof goHome === 'function') goHome(); } catch (e) {} }
  function renderError(m) { errMsg = m; render(); }
  function roleLabel(r) { return r === 'host' ? '🏈 オフェンス（第1試合）' : r === 'guest' ? '🛡 ディフェンス（第1試合）' : '—'; }
  function render() {
    if (V.active) return; build(); var m = document.getElementById('tdv-modal'); if (!m) return; var h = '';
    if (!channel) {
      if (view2 === 'join') h += '<h2>⚔ 部屋に入る</h2><p>友達から聞いた合言葉を入力してね。</p><div class="tdv-act"><input id="tdv-codein" class="tdv-input" maxlength="5" placeholder="○○○○○"><button class="tdv-red" onclick="TDVersus._join()">この合言葉で入る</button><button class="tdv-ghost" onclick="TDVersus._menu()">← もどる</button></div>';
      else h += '<h2>⚔ 対人対戦</h2><p>オフェンス（走る）対 ディフェンス（止める）の1対1。<br>攻撃は一人プレーと同じ操作。守備は上半分をタップして守備を出そう。</p><div class="tdv-act"><button class="tdv-pri" onclick="TDVersus._create()">部屋を作る（合言葉を発行）</button><button class="tdv-red" onclick="TDVersus._joinView()">部屋に入る（合言葉を入力）</button><button class="tdv-ghost" onclick="TDVersus.close()">とじる</button></div>';
      if (errMsg) h += '<p class="tdv-err">' + errMsg + '</p>'; m.innerHTML = h; return;
    }
    var pl = peers(), me = null, other = null; for (var i = 0; i < pl.length; i++) { if (pl[i].id === myId) me = pl[i]; else other = pl[i]; }
    h += '<h2>⚔ 対戦ロビー</h2><p>合言葉</p><div class="tdv-code">' + (roomCode || '') + '</div>';
    h += other ? '<p class="tdv-ok">相手が参加しました！</p>' : '<p class="tdv-wait">相手の参加を待っています…<br>合言葉「<b>' + roomCode + '</b>」を伝えてね。</p>';
    h += '<div class="tdv-players"><div class="tdv-pl"><div class="nm">' + (me ? me.name : getName()) + '（あなた）</div><div class="rl">' + roleLabel(role) + '</div><div class="rd ' + (ready ? 'tdv-ok' : 'tdv-wait') + '">' + (ready ? '準備OK ✓' : '準備中…') + '</div></div>';
    if (other) h += '<div class="tdv-pl"><div class="nm">' + other.name + '</div><div class="rl">' + roleLabel(other.role) + '</div><div class="rd ' + (other.ready ? 'tdv-ok' : 'tdv-wait') + '">' + (other.ready ? '準備OK ✓' : '準備中…') + '</div></div>';
    h += '</div><div class="tdv-act">';
    if (other && me && me.ready && other.ready) { if (role === 'host') h += '<button class="tdv-pri" onclick="TDVersus._startMatch()">▶ 対戦スタート</button>'; else h += '<button class="tdv-pri" disabled>ホストの開始を待っています…</button>'; }
    else h += '<button class="' + (ready ? 'tdv-ghost' : 'tdv-red') + '" onclick="TDVersus._toggleReady()">' + (ready ? '準備をやめる' : '準備OK') + '</button>';
    h += '<button class="tdv-ghost" onclick="TDVersus._leave()">← 退出する</button></div>';
    if (errMsg) h += '<p class="tdv-err">' + errMsg + '</p>'; m.innerHTML = h;
  }
  window.TDVersus = {
    open: openMenu, close: close,
    _menu: function () { view2 = 'menu'; errMsg = ''; render(); },
    _create: function () { errMsg = ''; joinRoom(genCode(), 'host'); },
    _joinView: function () { view2 = 'join'; errMsg = ''; render(); },
    _join: function () { var i = document.getElementById('tdv-codein'); var v = ((i && i.value) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); if (v.length < 4) { renderError('合言葉を正しく入力してください。'); return; } joinRoom(v, 'guest'); },
    _toggleReady: function () { setReady(!ready); },
    _startMatch: function () { if (role === 'host' && !V.active) { send({ k: 'start' }); enterRound(1); } },
    _leave: function () { leave(); view2 = 'menu'; render(); },
    _rematch: function () { send({ k: 'rematch' }); backToLobby(); },
  };
  function injectButton() { var home = document.getElementById('homeScreen'); if (!home || document.getElementById('tdv-btn')) return; var b = el('button', { id: 'tdv-btn' }, '⚔ 対人対戦'); b.addEventListener('click', openMenu); var g = home.querySelector('.homeGrid'); if (g && g.parentNode) g.parentNode.insertBefore(b, g.nextSibling); else home.appendChild(b); }
  function startUp() { build(); injectButton(); setInterval(injectButton, 1000); setInterval(function () { if (V.active && !V.amOffense) updateTypeButtons(); }, 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startUp); else startUp();
})();
