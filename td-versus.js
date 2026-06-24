/* =========================================================================
 * タッチダウン王 対人対戦 — フェーズ1（ロビー）＋フェーズ2（対戦本体・第一版）
 * -------------------------------------------------------------------------
 * オフェンス vs ディフェンスの1対1。Supabase Realtime（Presence+Broadcast）。
 * - 合言葉で同じ部屋(channel "versus:<code>")に2人入る → 準備OK → 対戦開始
 * - 縦フィールド：オフェンスは上のゴールへ走る／ディフェンスはタップ地点へ守備を動かす
 * - タックル or 完走でラウンド終了 → 攻守交代 → 進んだヤード比較で勝敗
 * - 同期は「そのラウンドのオフェンス側が審判（権威）」方式
 * 既存コードは無改造。グローバル(window.supabase/SUPA_URL/SUPA_ANON/user/
 * SPV/CHARS/selChar/canvas)を読むだけ。</body>直前に
 *   <script src="./td-versus.js"></script>
 * ========================================================================= */
(function () {
  'use strict';
  if (window.TDVersus) return;

  /* ============ 接続・ロビー ============ */
  var client = null, channel = null;
  var myId = 'p_' + Math.random().toString(36).slice(2, 9);
  var role = null, roomCode = null, ready = false;

  function getName() { try { if (typeof user !== 'undefined' && user && user.name) return String(user.name).slice(0, 12); } catch (e) {} return 'プレイヤー'; }
  function getClient() {
    if (client) return client;
    try { if (window.supabase && typeof SUPA_URL !== 'undefined' && typeof SUPA_ANON !== 'undefined') client = window.supabase.createClient(SUPA_URL, SUPA_ANON); } catch (e) {}
    return client;
  }
  function genCode() { var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = ''; for (var i = 0; i < 5; i++) s += a.charAt(Math.floor(Math.random() * a.length)); return s; }
  function peers() { if (!channel || !channel.presenceState) return []; var st = channel.presenceState(), out = []; for (var k in st) for (var i = 0; i < st[k].length; i++) out.push(st[k][i]); return out; }
  function meTracked() { if (channel) { try { channel.track({ id: myId, role: role, name: getName(), ready: ready }); } catch (e) {} } }
  function joinRoom(code, asRole) {
    var c = getClient(); if (!c) { renderError('オンライン接続が必要です（少し待ってからもう一度）。'); return; }
    leave(); roomCode = code; role = asRole; ready = false; render();
    channel = c.channel('versus:' + code, { config: { presence: { key: myId } } });
    channel.on('presence', { event: 'sync' }, function () { render(); maybeStart(); })
      .on('presence', { event: 'join' }, function () { render(); maybeStart(); })
      .on('presence', { event: 'leave' }, function () { if (M.active) onPeerLeft(); render(); })
      .on('broadcast', { event: 'msg' }, function (m) { onMsg(m && m.payload); })
      .subscribe(function (status) { if (status === 'SUBSCRIBED') { meTracked(); render(); } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') renderError('接続に失敗しました。もう一度お試しください。'); });
  }
  function setReady(v) { ready = v; meTracked(); render(); maybeStart(); }
  function leave() { stopMatch(); if (channel) { try { channel.untrack(); } catch (e) {} try { channel.unsubscribe(); } catch (e) {} channel = null; } roomCode = null; role = null; ready = false; }
  function send(p) { if (channel) { try { channel.send({ type: 'broadcast', event: 'msg', payload: p }); } catch (e) {} } }

  // ホストが、両者準備OKになったら対戦開始を号令
  function maybeStart() {
    if (role !== 'host' || M.active || !ready) return;
    var others = peers().filter(function (p) { return p.id !== myId; });
    if (others.length < 1) return;
    var otherReady = others.every(function (p) { return p.ready; });
    if (otherReady) { send({ k: 'start' }); enterRound(1); }
  }

  /* ============ 対戦本体（フェーズ2） ============ */
  // 仮想フィールド座標（両者で共通）。各画面はこれをスケールして描画。
  var FW = 360, FH = 600, GOALY = 46, STARTY = FH - 70, NDEF = 5, RBR = 15, DEFR = 15, TACK = 26;
  var ROUND_SEC = 30;
  var M = {
    active: false, round: 0, amOffense: false, phase: 'idle', // countdown/play/over/result
    rb: { x: FW / 2, y: STARTY }, tx: FW / 2, defs: [], aim: { x: FW / 2, y: GOALY + 60 },
    yard: 0, status: 'play', t0: 0, cdEnd: 0, raf: 0, lastSend: 0, latest: null, latestT: 0,
    result: { 1: null, 2: null }, cv: null, cx: null, ptr: false
  };

  function myStats() {
    try { var c = (typeof CHARS !== 'undefined' && typeof selChar !== 'undefined') ? CHARS[selChar] : null;
      if (c) return { yps: (typeof SPV !== 'undefined' ? SPV[c.sp] : 2.1), cut: c.cut, name: c.name }; } catch (e) {}
    return { yps: 2.1, cut: 3, name: 'RB' };
  }
  function roundOffenseIsHost(n) { return n === 1; }

  function enterRound(n) {
    M.active = true; M.round = n; M.phase = 'countdown';
    M.amOffense = roundOffenseIsHost(n) ? (role === 'host') : (role === 'guest');
    M.status = 'play'; M.yard = 0;
    M.rb = { x: FW / 2, y: STARTY }; M.tx = FW / 2;
    M.aim = { x: FW / 2, y: GOALY + 80 };
    M.defs = [];
    for (var i = 0; i < NDEF; i++) M.defs.push({ x: (i + 0.5) * FW / NDEF, y: GOALY + 50 + (i % 2) * 40 });
    M.latest = null; M.cdEnd = performance.now() + 3000; M.t0 = 0;
    closeLobbyOverlay();
    setupCanvas(); bindInput(); render(); loop();
  }
  function stopMatch() {
    if (M.raf) { cancelAnimationFrame(M.raf); M.raf = 0; }
    unbindInput();
    if (M.cv && M.cv.parentNode) M.cv.parentNode.removeChild(M.cv);
    M.cv = null; M.cx = null; M.active = false; M.phase = 'idle';
  }
  function onPeerLeft() { if (M.active) { M.phase = 'result'; M.result.note = '相手が退出しました'; drawResult(); } }

  function setupCanvas() {
    if (M.cv) return;
    var cv = document.createElement('canvas');
    cv.id = 'tdv-cv';
    cv.style.cssText = 'position:fixed;inset:0;z-index:99996;width:100%;height:100%;touch-action:none;background:#06210f';
    document.body.appendChild(cv); M.cv = cv; M.cx = cv.getContext('2d');
    sizeCanvas();
    window.addEventListener('resize', sizeCanvas);
  }
  function sizeCanvas() {
    if (!M.cv) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    M.cv.width = Math.floor(window.innerWidth * dpr); M.cv.height = Math.floor(window.innerHeight * dpr);
    M.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function view() {
    var cw = window.innerWidth, ch = window.innerHeight;
    var s = Math.min(cw / FW, ch / FH);
    return { s: s, ox: (cw - FW * s) / 2, oy: (ch - FH * s) / 2, cw: cw, ch: ch };
  }
  function toScreen(x, y, v) { return [v.ox + x * v.s, v.oy + y * v.s]; }
  function toField(px, py, v) { return { x: (px - v.ox) / v.s, y: (py - v.oy) / v.s }; }

  /* ---- 入力 ---- */
  function onDown(e) { M.ptr = true; onMove(e); }
  function onUp() { M.ptr = false; }
  function onMove(e) {
    if (M.phase !== 'play') return;
    var p = pointFrom(e), v = view(), f = toField(p.x, p.y, v);
    if (M.amOffense) { M.tx = Math.max(RBR, Math.min(FW - RBR, f.x)); }
    else {
      M.aim.x = Math.max(0, Math.min(FW, f.x)); M.aim.y = Math.max(0, Math.min(FH, f.y));
      var now = performance.now(); if (now - M.lastSend > 60) { M.lastSend = now; send({ k: 'aim', x: Math.round(M.aim.x), y: Math.round(M.aim.y) }); }
    }
  }
  function pointFrom(e) { if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY }; return { x: e.clientX, y: e.clientY }; }
  function bindInput() {
    if (!M.cv) return;
    M.cv.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    M.cv.addEventListener('touchstart', onDown, { passive: true }); M.cv.addEventListener('touchmove', onMove, { passive: true }); M.cv.addEventListener('touchend', onUp);
  }
  function unbindInput() {
    if (!M.cv) return;
    M.cv.removeEventListener('mousedown', onDown); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
    M.cv.removeEventListener('touchstart', onDown); M.cv.removeEventListener('touchmove', onMove); M.cv.removeEventListener('touchend', onUp);
  }

  /* ---- ループ ---- */
  function loop() {
    M.raf = requestAnimationFrame(loop);
    var now = performance.now();
    if (M.phase === 'countdown') { if (now >= M.cdEnd) { M.phase = 'play'; M.t0 = now; } draw(); return; }
    if (M.phase !== 'play') { return; }
    if (M.amOffense) simOffense(now); else { /* defense: 受信状態を描画。エイムは送信済み */ }
    draw();
    if (M.amOffense && now - M.lastSend > 50) { M.lastSend = now; broadcastState(); }
  }
  function simOffense(now) {
    var st = myStats();
    var vy = 1.35 + (st.yps - 1.8) * 0.6;            // 足が速いほど前進が速い
    var lat = 4 + (st.cut || 3) * 0.5;               // 技が高いほど横の切り返しが速い
    // 前進
    M.rb.y -= vy;
    // 横移動（指の位置へ）
    M.rb.x += Math.max(-lat, Math.min(lat, (M.tx - M.rb.x) * 0.3));
    // ディフェンスはエイムへ寄る
    var ds = 1.9;
    for (var i = 0; i < M.defs.length; i++) {
      var d = M.defs[i];
      var ax = M.aim.x + (i - (NDEF - 1) / 2) * 16, ay = M.aim.y;
      var dx = ax - d.x, dy = ay - d.y, L = Math.hypot(dx, dy) || 1;
      d.x += dx / L * ds; d.y += dy / L * ds;
      // タックル判定
      var rx = M.rb.x - d.x, ry = M.rb.y - d.y;
      if (Math.hypot(rx, ry) < TACK) { endRound('tackled'); return; }
    }
    // ヤード
    M.yard = Math.max(0, Math.min(100, Math.round((STARTY - M.rb.y) / (STARTY - GOALY) * 100)));
    if (M.rb.y <= GOALY) { M.yard = 100; endRound('touchdown'); return; }
    // 時間切れ
    if ((now - M.t0) / 1000 >= ROUND_SEC) { endRound('timeup'); return; }
  }
  function broadcastState() {
    var d = []; for (var i = 0; i < M.defs.length; i++) d.push([Math.round(M.defs[i].x), Math.round(M.defs[i].y)]);
    send({ k: 'st', x: Math.round(M.rb.x), y: Math.round(M.rb.y), d: d, yd: M.yard, s: M.status });
  }
  function endRound(status) {
    M.status = status; M.phase = 'over';
    broadcastState();
    var finalYard = M.yard;
    M.result[M.round] = { offenseIsHost: roundOffenseIsHost(M.round), yard: finalYard, status: status };
    // オフェンス（権威）が結果を申告
    send({ k: 'rend', n: M.round, yd: finalYard, s: status });
    drawOver(status, finalYard);
    // ホストが次の遷移を司る
    if (role === 'host') setTimeout(hostAdvance, 2600);
  }
  function hostAdvance() {
    if (M.round === 1) { send({ k: 'round', n: 2 }); enterRound(2); }
    else {
      var h = (M.result[1] && M.result[1].yard) || 0;   // R1オフェンス=host
      var g = (M.result[2] && M.result[2].yard) || 0;   // R2オフェンス=guest
      send({ k: 'result', h: h, g: g }); showResult(h, g);
    }
  }

  /* ---- 受信 ---- */
  function onMsg(p) {
    if (!p) return;
    if (p.k === 'start') { if (role !== 'host') enterRound(1); return; }
    if (p.k === 'round') { enterRound(p.n); return; }
    if (p.k === 'aim') { if (M.active && M.amOffense) { M.aim.x = p.x; M.aim.y = p.y; } return; }
    if (p.k === 'st') {
      if (M.active && !M.amOffense) {
        M.latest = p; M.latestT = performance.now();
        if (M.phase === 'countdown') { M.phase = 'play'; M.t0 = performance.now(); }
        if (p.s && p.s !== 'play') { M.phase = 'over'; M.status = p.s; drawOver(p.s, p.yd); }
      }
      return;
    }
    if (p.k === 'rend') { M.result[p.n] = { offenseIsHost: roundOffenseIsHost(p.n), yard: p.yd, status: p.s }; return; }
    if (p.k === 'result') { showResult(p.h, p.g); return; }
    if (p.k === 'rematch') { backToLobby(); return; }
  }

  /* ---- 描画 ---- */
  function draw() {
    var cx = M.cx; if (!cx) return; var v = view();
    cx.clearRect(0, 0, v.cw, v.ch);
    // フィールド
    cx.fillStyle = '#1d7a34'; var p0 = toScreen(0, 0, v), p1 = toScreen(FW, FH, v);
    cx.fillRect(p0[0], p0[1], FW * v.s, FH * v.s);
    cx.strokeStyle = 'rgba(220,240,220,.35)'; cx.lineWidth = 2;
    for (var yy = 0; yy <= 100; yy += 10) {
      var fy = STARTY - (STARTY - GOALY) * (yy / 100); var a = toScreen(0, fy, v), b = toScreen(FW, fy, v);
      cx.beginPath(); cx.moveTo(a[0], a[1]); cx.lineTo(b[0], b[1]); cx.stroke();
      cx.fillStyle = 'rgba(220,240,220,.6)'; cx.font = (11 * v.s) + 'px sans-serif'; cx.textAlign = 'left';
      cx.fillText(yy + '', a[0] + 4, a[1] - 3);
    }
    // ゴールライン
    var g = toScreen(0, GOALY, v), g2 = toScreen(FW, GOALY, v);
    cx.strokeStyle = '#ffd23f'; cx.lineWidth = 4; cx.beginPath(); cx.moveTo(g[0], g[1]); cx.lineTo(g2[0], g2[1]); cx.stroke();

    // 状態（オフェンスは自分の計算、ディフェンスは受信）
    var rb, defs, yard;
    if (M.amOffense) { rb = M.rb; defs = M.defs; yard = M.yard; }
    else if (M.latest) { rb = { x: M.latest.x, y: M.latest.y }; defs = M.latest.d.map(function (a) { return { x: a[0], y: a[1] }; }); yard = M.latest.yd; }
    else { rb = M.rb; defs = M.defs; yard = 0; }

    // ディフェンス
    for (var i = 0; i < defs.length; i++) drawCircle(cx, v, defs[i].x, defs[i].y, DEFR, '#c8362d', '#7c1d18', '');
    // ディフェンス側のエイム表示
    if (!M.amOffense) { var am = toScreen(M.aim.x, M.aim.y, v); cx.strokeStyle = 'rgba(255,255,255,.7)'; cx.lineWidth = 2; cx.beginPath(); cx.arc(am[0], am[1], 10 * v.s, 0, 7); cx.stroke(); }
    // RB
    drawCircle(cx, v, rb.x, rb.y, RBR, '#5ec6ff', '#1f7fc0', '');

    // HUD
    cx.fillStyle = '#fff'; cx.textAlign = 'left'; cx.font = 'bold ' + Math.round(20 * Math.min(v.s, 2)) + 'px sans-serif';
    cx.fillText((M.amOffense ? '🏈 攻撃（あなた）' : '🛡 守備（あなた）'), 14, 30);
    cx.font = 'bold ' + Math.round(26 * Math.min(v.s, 2)) + 'px sans-serif';
    cx.fillText(yard + ' / 100 yd', 14, 62);
    if (M.phase === 'play') { var left = Math.max(0, ROUND_SEC - Math.floor((performance.now() - M.t0) / 1000)); cx.textAlign = 'right'; cx.fillText('⏱ ' + left, v.cw - 14, 62); }

    // カウントダウン
    if (M.phase === 'countdown') {
      var n = Math.ceil((M.cdEnd - performance.now()) / 1000);
      cx.fillStyle = 'rgba(0,0,0,.45)'; cx.fillRect(0, 0, v.cw, v.ch);
      cx.fillStyle = '#fff'; cx.textAlign = 'center'; cx.font = 'bold ' + Math.round(80) + 'px sans-serif';
      cx.fillText(n > 0 ? n : 'GO', v.cw / 2, v.ch / 2);
      cx.font = 'bold 18px sans-serif';
      cx.fillText(M.amOffense ? '上のゴールへ走れ！（指でRBを左右に）' : 'タップした場所に守備が集まる', v.cw / 2, v.ch / 2 + 50);
    }
  }
  function drawCircle(cx, v, x, y, r, fill, edge, label) {
    var p = toScreen(x, y, v); cx.beginPath(); cx.arc(p[0], p[1], r * v.s, 0, 7); cx.fillStyle = fill; cx.fill(); cx.lineWidth = 2; cx.strokeStyle = edge; cx.stroke();
  }
  function drawOver(status, yard) {
    var cx = M.cx; if (!cx) return; draw();
    var v = view(); cx.fillStyle = 'rgba(0,0,0,.55)'; cx.fillRect(0, 0, v.cw, v.ch);
    cx.fillStyle = '#fff'; cx.textAlign = 'center'; cx.font = 'bold 40px sans-serif';
    var t = status === 'touchdown' ? '🏈 タッチダウン！' : status === 'tackled' ? '💥 タックル！' : '⏱ タイムアップ';
    cx.fillText(t, v.cw / 2, v.ch / 2 - 20);
    cx.font = 'bold 26px sans-serif';
    cx.fillText('このラウンドの記録：' + yard + ' yd', v.cw / 2, v.ch / 2 + 24);
    cx.font = '16px sans-serif';
    cx.fillText(M.round === 1 ? 'まもなく攻守交代…' : '結果を集計中…', v.cw / 2, v.ch / 2 + 58);
  }

  /* ---- 結果 ---- */
  function showResult(hostYard, guestYard) {
    M.phase = 'result';
    var myYard = (role === 'host') ? hostYard : guestYard;
    var opYard = (role === 'host') ? guestYard : hostYard;
    var cx = M.cx; if (cx) { var v = view(); cx.fillStyle = 'rgba(6,20,12,.96)'; cx.fillRect(0, 0, v.cw, v.ch); }
    showResultUI(myYard, opYard);
  }
  function showResultUI(my, op) {
    stopMatchKeepOverlay();
    build();
    var ov = document.getElementById('tdv-ov'); var m = document.getElementById('tdv-modal');
    var verdict = my > op ? '🏆 あなたの勝ち！' : my < op ? '😢 あなたの負け…' : '🤝 引き分け';
    var col = my > op ? '#ffd23f' : my < op ? '#ff8a7a' : '#9fe0ff';
    m.innerHTML = '<h2 style="color:' + col + '">' + verdict + '</h2>' +
      '<div class="tdv-players"><div class="tdv-pl"><div class="nm">あなた</div><div class="rl">到達</div><div class="rd tdv-ok">' + my + ' yd</div></div>' +
      '<div class="tdv-pl"><div class="nm">相手</div><div class="rl">到達</div><div class="rd tdv-wait">' + op + ' yd</div></div></div>' +
      '<div class="tdv-act"><button class="tdv-pri" onclick="TDVersus._rematch()">もう一度（同じ相手と）</button>' +
      '<button class="tdv-ghost" onclick="TDVersus.close()">ホームへ</button></div>';
    ov.style.display = 'flex';
  }
  function stopMatchKeepOverlay() {
    if (M.raf) { cancelAnimationFrame(M.raf); M.raf = 0; } unbindInput();
    if (M.cv && M.cv.parentNode) M.cv.parentNode.removeChild(M.cv); M.cv = null; M.cx = null;
    M.active = false; M.phase = 'result';
  }
  function backToLobby() {
    stopMatch(); M.result = { 1: null, 2: null }; ready = false; meTracked();
    var ov = document.getElementById('tdv-ov'); if (ov) ov.style.display = 'flex'; render();
  }
  function closeLobbyOverlay() { var o = document.getElementById('tdv-ov'); if (o) o.style.display = 'none'; }

  /* ============ ロビーUI ============ */
  var CSS =
  '#tdv-btn{margin-top:8px;width:min(360px,92vw);padding:12px 6px;border:none;border-radius:10px;font-weight:800;font-size:15px;letter-spacing:1px;color:#3a0d0d;background:linear-gradient(180deg,#ff9d8a,#f0573b);box-shadow:0 5px 0 #a32c1a,0 8px 18px rgba(0,0,0,.4);cursor:pointer;font-family:inherit}' +
  '#tdv-btn:active{transform:translateY(3px);box-shadow:0 2px 0 #a32c1a}' +
  '#tdv-ov{position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,.66);display:none;align-items:center;justify-content:center;padding:14px;font-family:-apple-system,"Segoe UI",sans-serif}' +
  '#tdv-modal{background:#0a0f1e;color:#eef3ff;width:min(440px,94vw);max-height:90vh;overflow:auto;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.6);padding:20px;text-align:center}' +
  '#tdv-modal h2{margin:0 0 6px;font-size:22px}#tdv-modal p{font-size:13px;opacity:.9;line-height:1.7;margin:4px 0}' +
  '.tdv-act{display:flex;flex-direction:column;gap:9px;margin-top:14px;align-items:center}' +
  '.tdv-act button{width:min(300px,80vw);border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}' +
  '.tdv-pri{background:linear-gradient(180deg,#9fe0ff,#3bb4f5);color:#03263a;box-shadow:0 4px 0 #1a78ad}' +
  '.tdv-red{background:linear-gradient(180deg,#ff9d8a,#f0573b);color:#3a0d0d;box-shadow:0 4px 0 #a32c1a}' +
  '.tdv-ghost{background:rgba(255,255,255,.12);color:#fff;border:2px solid rgba(255,255,255,.45)}' +
  '.tdv-code{font-size:40px;font-weight:900;letter-spacing:10px;color:#ffd23f;margin:10px 0;background:#0c1530;border-radius:12px;padding:14px}' +
  '.tdv-input{font-size:26px;font-weight:800;letter-spacing:8px;text-align:center;text-transform:uppercase;width:min(260px,76vw);padding:12px;border-radius:10px;border:2px solid #3bb4f5;background:#0c1530;color:#fff;font-family:inherit}' +
  '.tdv-players{display:flex;gap:10px;justify-content:center;margin:14px 0}' +
  '.tdv-pl{flex:1;max-width:160px;background:#0c1530;border-radius:12px;padding:12px 8px}' +
  '.tdv-pl .nm{font-weight:800;font-size:14px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
  '.tdv-pl .rl{font-size:11px;opacity:.8}.tdv-pl .rd{margin-top:6px;font-size:13px;font-weight:800}' +
  '.tdv-wait{color:#7fd4ff}.tdv-ok{color:#37c46a}.tdv-err{color:#ff8a7a;font-weight:700;margin-top:8px}';

  function el(t, a, h) { var e = document.createElement(t); if (a) for (var k in a) e[k] = a[k]; if (h != null) e.innerHTML = h; return e; }
  var built = false, view2 = 'menu', errMsg = '';
  function build() {
    if (built || !document.body) return; built = true;
    document.head.appendChild(el('style', null, CSS));
    var ov = el('div', { id: 'tdv-ov' }); ov.appendChild(el('div', { id: 'tdv-modal' }));
    ov.addEventListener('click', function (e) { if (e.target === ov && !M.active && M.phase !== 'result') close(); });
    document.body.appendChild(ov);
  }
  function openMenu() { build(); view2 = 'menu'; errMsg = ''; render(); document.getElementById('tdv-ov').style.display = 'flex'; }
  function close() { leave(); var o = document.getElementById('tdv-ov'); if (o) o.style.display = 'none'; }
  function renderError(m) { errMsg = m; render(); }
  function roleLabel(r) { return r === 'host' ? '🏈 オフェンス（第1試合）' : r === 'guest' ? '🛡 ディフェンス（第1試合）' : '—'; }
  function render() {
    if (M.active) return; build(); var m = document.getElementById('tdv-modal'); if (!m) return; var h = '';
    if (!channel) {
      if (view2 === 'join') {
        h += '<h2>⚔ 部屋に入る</h2><p>友達から聞いた合言葉を入力してね。</p><div class="tdv-act">' +
             '<input id="tdv-codein" class="tdv-input" maxlength="5" placeholder="○○○○○" autocomplete="off">' +
             '<button class="tdv-red" onclick="TDVersus._join()">この合言葉で入る</button>' +
             '<button class="tdv-ghost" onclick="TDVersus._menu()">← もどる</button></div>';
      } else {
        h += '<h2>⚔ 対人対戦</h2><p>オフェンス（走る）対 ディフェンス（止める）の1対1。<br>友達と合言葉でつながって対戦しよう。</p><div class="tdv-act">' +
             '<button class="tdv-pri" onclick="TDVersus._create()">部屋を作る（合言葉を発行）</button>' +
             '<button class="tdv-red" onclick="TDVersus._joinView()">部屋に入る（合言葉を入力）</button>' +
             '<button class="tdv-ghost" onclick="TDVersus.close()">とじる</button></div>';
      }
      if (errMsg) h += '<p class="tdv-err">' + errMsg + '</p>'; m.innerHTML = h; return;
    }
    var pl = peers(), me = null, other = null;
    for (var i = 0; i < pl.length; i++) { if (pl[i].id === myId) me = pl[i]; else other = pl[i]; }
    h += '<h2>⚔ 対戦ロビー</h2><p>合言葉</p><div class="tdv-code">' + (roomCode || '') + '</div>';
    h += other ? '<p class="tdv-ok">相手が参加しました！両方が「準備OK」でスタートします。</p>'
               : '<p class="tdv-wait">相手の参加を待っています…<br>この合言葉「<b>' + roomCode + '</b>」を友達に伝えてね。</p>';
    h += '<div class="tdv-players"><div class="tdv-pl"><div class="nm">' + (me ? me.name : getName()) + '（あなた）</div><div class="rl">' + roleLabel(role) + '</div><div class="rd ' + (ready ? 'tdv-ok' : 'tdv-wait') + '">' + (ready ? '準備OK ✓' : '準備中…') + '</div></div>';
    if (other) h += '<div class="tdv-pl"><div class="nm">' + other.name + '</div><div class="rl">' + roleLabel(other.role) + '</div><div class="rd ' + (other.ready ? 'tdv-ok' : 'tdv-wait') + '">' + (other.ready ? '準備OK ✓' : '準備中…') + '</div></div>';
    h += '</div><div class="tdv-act">';
    if (other && me && me.ready && other.ready) {
      if (role === 'host') h += '<button class="tdv-pri" onclick="TDVersus._startMatch()">▶ 対戦スタート</button>';
      else h += '<button class="tdv-pri" disabled>ホストの開始を待っています…</button>';
    } else h += '<button class="' + (ready ? 'tdv-ghost' : 'tdv-red') + '" onclick="TDVersus._toggleReady()">' + (ready ? '準備をやめる' : '準備OK') + '</button>';
    h += '<button class="tdv-ghost" onclick="TDVersus._leave()">← 退出する</button></div>';
    if (errMsg) h += '<p class="tdv-err">' + errMsg + '</p>'; m.innerHTML = h;
  }

  window.TDVersus = {
    open: openMenu, close: close,
    _menu: function () { view2 = 'menu'; errMsg = ''; render(); },
    _create: function () { errMsg = ''; joinRoom(genCode(), 'host'); },
    _joinView: function () { view2 = 'join'; errMsg = ''; render(); },
    _join: function () { var inp = document.getElementById('tdv-codein'); var val = ((inp && inp.value) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); if (val.length < 4) { renderError('合言葉を正しく入力してください。'); return; } joinRoom(val, 'guest'); },
    _toggleReady: function () { setReady(!ready); },
    _startMatch: function () { if (role === 'host' && !M.active) { send({ k: 'start' }); enterRound(1); } },
    _leave: function () { leave(); view2 = 'menu'; render(); },
    _rematch: function () { send({ k: 'rematch' }); backToLobby(); },
  };

  /* ---- ホーム画面に「⚔ 対人対戦」ボタンを差し込む ---- */
  function injectButton() {
    var home = document.getElementById('homeScreen'); if (!home || document.getElementById('tdv-btn')) return;
    var btn = el('button', { id: 'tdv-btn' }, '⚔ 対人対戦'); btn.addEventListener('click', openMenu);
    var grid = home.querySelector('.homeGrid');
    if (grid && grid.parentNode) grid.parentNode.insertBefore(btn, grid.nextSibling); else home.appendChild(btn);
  }
  function start() { build(); injectButton(); setInterval(injectButton, 1000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
