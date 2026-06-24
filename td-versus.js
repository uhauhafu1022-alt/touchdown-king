/* =========================================================================
 * タッチダウン王 対人対戦（オフェンス vs ディフェンス）
 *   - ロビー：合言葉(Supabase Realtime)で2人接続→ホストが「▶対戦スタート」
 *   - 対戦：ゲーム本体の描画エンジンに統合（drawPlayer等を流用＝1Pと同じ見た目・
 *           ジャンプ・タックル）。縦フィールド。上半分=ディフェンス陣地。
 *   - ディフェンス：自陣(上半分)をタップすると、選んだ種類のディフェンスが出現し
 *           オフェンスへタックルしに行く。普通=連打し放題／強い種=クールタイム。
 *   - オフェンス：指でRBを左右、JUMPでかわす（無敵）。上のゴール(100yd)を目指す。
 *   - 攻守交代→進んだヤードで勝敗。
 *   既存コード無改造。グローバル(window.supabase,SUPA_URL,SUPA_ANON,user,
 *   ctx,W,H,drawPlayer,drawDowned,pX,pY,C,playerCos,DEFCHARS,update,render,state,STATE)
 *   を利用。</body>直前に <script src="./td-versus.js"></script>
 * ========================================================================= */
(function () {
  'use strict';
  if (window.TDVersus) return;

  /* ===================== 接続・ロビー ===================== */
  var client = null, channel = null;
  var myId = 'p_' + Math.random().toString(36).slice(2, 9);
  var role = null, roomCode = null, ready = false;

  function getName() { try { if (typeof user !== 'undefined' && user && user.name) return String(user.name).slice(0, 12); } catch (e) {} return 'プレイヤー'; }
  function getClient() { if (client) return client; try { if (window.supabase && typeof SUPA_URL !== 'undefined' && typeof SUPA_ANON !== 'undefined') client = window.supabase.createClient(SUPA_URL, SUPA_ANON); } catch (e) {} return client; }
  function genCode() { var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = ''; for (var i = 0; i < 5; i++) s += a.charAt(Math.floor(Math.random() * a.length)); return s; }
  function peers() { if (!channel || !channel.presenceState) return []; var st = channel.presenceState(), o = []; for (var k in st) for (var i = 0; i < st[k].length; i++) o.push(st[k][i]); return o; }
  function meTracked() { if (channel) { try { channel.track({ id: myId, role: role, name: getName(), ready: ready }); } catch (e) {} } }
  function joinRoom(code, asRole) {
    var c = getClient(); if (!c) { renderError('オンライン接続が必要です（少し待ってからもう一度）。'); return; }
    leave(); roomCode = code; role = asRole; ready = false; render();
    channel = c.channel('versus:' + code, { config: { presence: { key: myId } } });
    channel.on('presence', { event: 'sync' }, function () { render(); maybeStart(); })
      .on('presence', { event: 'join' }, function () { render(); maybeStart(); })
      .on('presence', { event: 'leave' }, function () { if (M.active) onPeerLeft(); render(); })
      .on('broadcast', { event: 'msg' }, function (m) { onMsg(m && m.payload); })
      .subscribe(function (s) { if (s === 'SUBSCRIBED') { meTracked(); render(); } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') renderError('接続に失敗しました。'); });
  }
  function setReady(v) { ready = v; meTracked(); render(); maybeStart(); }
  function leave() { stopMatch(); if (channel) { try { channel.untrack(); } catch (e) {} try { channel.unsubscribe(); } catch (e) {} channel = null; } roomCode = null; role = null; ready = false; }
  function send(p) { if (channel) { try { channel.send({ type: 'broadcast', event: 'msg', payload: p }); } catch (e) {} } }
  function maybeStart() { if (role !== 'host' || M.active || !ready) return; var o = peers().filter(function (p) { return p.id !== myId; }); if (o.length < 1) return; if (o.every(function (p) { return p.ready; })) { send({ k: 'start' }); enterRound(1); } }

  /* ===================== 対戦本体（エンジン統合） ===================== */
  var FIELD_TOP = 70;             // ゴールライン（画面上部の余白px、yはこの値）
  var NDEF_MAX = 14;
  var ROUND_SEC = 30;
  // ディフェンス種類
  var DEFTYPES = [
    { id: 'normal', name: '普通', r: 15, speed: 1.7, cd: 0, color: '#c8362d', dark: '#7c1d18' },
    { id: 'fast', name: '俊足', r: 12, speed: 2.7, cd: 2600, color: '#e08a2d', dark: '#8a4d10' },
    { id: 'big', name: '大型', r: 22, speed: 1.15, cd: 5200, color: '#9b3bd1', dark: '#5a1f80' },
  ];
  var M = {
    active: false, round: 0, amOffense: false, phase: 'idle',
    rb: { x: 0, y: 0, vx: 0, leg: 0, jump: 0, jumpMax: 1 }, tx: 0,
    defs: [], yard: 0, status: 'play', t0: 0, cdEnd: 0, lastSend: 0,
    latest: null, rbCos: null, result: { 1: null, 2: null },
    selType: 0, cdUntil: [0, 0, 0], ptrDown: false, mid: 0
  };

  function offStats() {
    try { var c = (typeof CHARS !== 'undefined' && typeof selChar !== 'undefined') ? CHARS[selChar] : null;
      if (c) return { yps: (typeof SPV !== 'undefined' ? SPV[c.sp] : 2.1), cut: c.cut, jp: (typeof JPV !== 'undefined' ? JPV[c.jp] : 46) }; } catch (e) {}
    return { yps: 2.1, cut: 3, jp: 46 };
  }
  function myCos() { try { if (typeof playerCos === 'function') return playerCos(); } catch (e) {} return { jersey: '#5ec6ff', dark: '#1f7fc0', upat: 'solid', helmKind: 'norm', legCol: '#26262c', legPat: '', shoeCol: '#f2f2f2', shoePat: '' }; }
  function roundOffenseIsHost(n) { return n === 1; }

  /* ---- エンジン統合：update/render を一度だけラップ ---- */
  var patched = false;
  function patchEngine() {
    if (patched) return; patched = true;
    try {
      var oUpd = window.update, oRen = window.render;
      if (typeof oUpd === 'function') window.update = function (dt) { if (M.active) { try { vsUpdate(dt); } catch (e) {} return; } return oUpd.apply(this, arguments); };
      if (typeof oRen === 'function') window.render = function () { if (M.active) { try { vsRender(); } catch (e) {} return; } return oRen.apply(this, arguments); };
    } catch (e) {}
  }

  function enterRound(n) {
    patchEngine();
    M.active = true; M.round = n; M.phase = 'countdown';
    M.amOffense = roundOffenseIsHost(n) ? (role === 'host') : (role === 'guest');
    M.status = 'play'; M.yard = 0; M.defs = []; M.latest = null;
    M.selType = 0; M.cdUntil = [0, 0, 0];
    var w = (typeof W !== 'undefined' ? W : 360), h = (typeof H !== 'undefined' ? H : 600);
    M.mid = h * 0.5;
    M.rb = { x: w / 2, y: h - 90, vx: 0, leg: 0, jump: 0, jumpMax: 1 }; M.tx = w / 2;
    M.cdEnd = performance.now() + 3000; M.t0 = 0;
    try { if (typeof showScreen === 'function') showScreen(null); } catch (e) {}
    try { if (typeof state !== 'undefined' && typeof STATE !== 'undefined') window.state = STATE.MENU; } catch (e) {}
    closeLobbyOverlay(); hideCoinHud(true);
    if (M.amOffense) send({ k: 'cos', c: myCos() });   // 守備側にRBの見た目を共有
    buildControls(); bindCanvas();
  }
  function stopMatch() {
    M.active = false; M.phase = 'idle';
    unbindCanvas(); removeControls(); hideCoinHud(false);
  }
  function onPeerLeft() { if (M.active) { M.phase = 'result'; finishToResult(null, null, '相手が退出しました'); } }

  /* ---- 入力 ---- */
  function ptXY(e) { var p = (e.touches && e.touches[0]) ? e.touches[0] : e; var x = (typeof pX === 'function') ? pX(p.clientX) : p.clientX; var y = (typeof pY === 'function') ? pY(p.clientY) : p.clientY; return { x: x, y: y }; }
  function onDown(e) { if (M.phase !== 'play') return; M.ptrDown = true; handlePoint(e, true); }
  function onMove(e) { if (M.phase !== 'play' || !M.ptrDown) return; handlePoint(e, false); }
  function onUp() { M.ptrDown = false; }
  function handlePoint(e, isDown) {
    var p = ptXY(e);
    if (M.amOffense) { var w = (typeof W !== 'undefined' ? W : 360); M.rb.x = Math.max(15, Math.min(w - 15, p.x)); }
    else { if (isDown) trySpawn(p.x, p.y); }
  }
  function bindCanvas() {
    var cv = (typeof canvas !== 'undefined') ? canvas : document.getElementById('game'); if (!cv) return; M._cv = cv;
    cv.addEventListener('mousedown', onDown); window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
    cv.addEventListener('touchstart', onDown, { passive: true }); cv.addEventListener('touchmove', onMove, { passive: true }); cv.addEventListener('touchend', onUp);
  }
  function unbindCanvas() {
    var cv = M._cv; if (!cv) return;
    cv.removeEventListener('mousedown', onDown); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
    cv.removeEventListener('touchstart', onDown); cv.removeEventListener('touchmove', onMove); cv.removeEventListener('touchend', onUp);
    M._cv = null;
  }

  // ディフェンス：自陣(上半分)にタップで出現
  function trySpawn(x, y) {
    if (y > M.mid - 6) { flashMsg('自分の陣地（上半分）に置けます'); return; }
    var ti = M.selType, t = DEFTYPES[ti], now = performance.now();
    if (t.cd > 0 && now < M.cdUntil[ti]) return;
    if (t.cd > 0) M.cdUntil[ti] = now + t.cd;
    send({ k: 'spawn', x: Math.round(x), y: Math.round(y), t: ti });
    spawnLocalEcho();                         // 守備画面でも即フィードバック（描画は受信stで上書き）
    updateTypeButtons();
  }
  function spawnLocalEcho() { try { if (typeof sHelmet === 'function') sHelmet(); } catch (e) {} }

  /* ---- 操作UI（DOM） ---- */
  function buildControls() {
    removeControls();
    var wrap = document.createElement('div'); wrap.id = 'tdv-ctrl';
    wrap.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99996;display:flex;justify-content:center;gap:8px;padding:10px 8px;pointer-events:none;font-family:-apple-system,sans-serif';
    if (M.amOffense) {
      var jb = btn('🦘 JUMP', '#1f7fc0'); jb.onclick = doJump; wrap.appendChild(jb);
    } else {
      DEFTYPES.forEach(function (t, i) {
        var b = btn(t.name, t.color); b.dataset.i = i; b.onclick = function () { M.selType = i; updateTypeButtons(); };
        wrap.appendChild(b);
      });
    }
    document.body.appendChild(wrap); M._ctrl = wrap; updateTypeButtons();
  }
  function btn(label, col) { var b = document.createElement('button'); b.textContent = label; b.style.cssText = 'pointer-events:auto;border:none;border-radius:12px;padding:12px 14px;font-size:15px;font-weight:800;color:#fff;background:' + col + ';box-shadow:0 4px 0 rgba(0,0,0,.35);font-family:inherit;min-width:78px'; return b; }
  function updateTypeButtons() {
    if (!M._ctrl || M.amOffense) return; var now = performance.now();
    Array.prototype.forEach.call(M._ctrl.children, function (b) {
      var i = +b.dataset.i, t = DEFTYPES[i];
      var cdLeft = t.cd > 0 ? Math.max(0, Math.ceil((M.cdUntil[i] - now) / 1000)) : 0;
      b.style.outline = (i === M.selType) ? '3px solid #ffd23f' : 'none';
      b.textContent = t.name + (t.cd > 0 ? (cdLeft > 0 ? ' ' + cdLeft + 's' : ' ✓') : ' ∞');
      b.style.opacity = (cdLeft > 0) ? '0.5' : '1';
    });
  }
  function removeControls() { if (M._ctrl && M._ctrl.parentNode) M._ctrl.parentNode.removeChild(M._ctrl); M._ctrl = null; }
  function hideCoinHud(hide) { try { var e = document.getElementById('coinHud'); if (e) e.style.visibility = hide ? 'hidden' : ''; } catch (e2) {} }
  var _flash = '', _flashT = 0; function flashMsg(m) { _flash = m; _flashT = performance.now() + 1200; }

  function doJump() { if (M.phase === 'play' && M.amOffense && M.rb.jump <= 0) { var s = offStats(); M.rb.jump = s.jp; M.rb.jumpMax = s.jp; try { if (typeof sJump === 'function') sJump(); } catch (e) {} } }

  /* ---- シミュレーション（オフェンス権威） ---- */
  function vsUpdate(dt) {
    dt = dt || 1; var now = performance.now();
    if (M.phase === 'countdown') { if (now >= M.cdEnd) { M.phase = 'play'; M.t0 = now; } return; }
    if (M.phase !== 'play') return;
    if (M.amOffense) {
      var s = offStats();
      var vy = 1.3 + (s.yps - 1.8) * 0.6;
      M.rb.y -= vy * dt;
      M.rb.vx = (M.tx - M.rb.x) * 0.3; M.rb.x += M.rb.vx * dt;
      M.rb.leg += (0.4 + Math.abs(M.rb.vx) * 0.05) * dt;
      if (M.rb.jump > 0) M.rb.jump -= dt;
      var airborne = M.rb.jump > 0;
      for (var i = 0; i < M.defs.length; i++) {
        var d = M.defs[i]; if (d.downed) { d.kb -= dt; continue; }
        var dx = M.rb.x - d.x, dy = M.rb.y - d.y, L = Math.hypot(dx, dy) || 1;
        d.x += dx / L * d.speed * dt; d.y += dy / L * d.speed * dt; d.leg += 0.45 * dt;
        if (!airborne && L < (d.r + 15 - 4)) { tackle(d); return; }
      }
      M.yard = Math.max(0, Math.min(100, Math.round((((typeof H !== 'undefined' ? H : 600) - 90) - M.rb.y) / (((typeof H !== 'undefined' ? H : 600) - 90) - FIELD_TOP) * 100)));
      if (M.rb.y <= FIELD_TOP) { M.yard = 100; endRound('touchdown'); return; }
      if ((now - M.t0) / 1000 >= ROUND_SEC) { endRound('timeup'); return; }
      if (now - M.lastSend > 50) { M.lastSend = now; broadcastState(); }
    }
  }
  function tackle(d) {
    d.downed = true; d.kb = 14;
    try { if (typeof burst === 'function') { burst(M.rb.x, M.rb.y, C.off, 18, 5); burst(M.rb.x, M.rb.y, C.def, 12, 5); } if (typeof sHelmet === 'function') sHelmet(); } catch (e) {}
    endRound('tackled');
  }
  function broadcastState() {
    var d = []; for (var i = 0; i < M.defs.length; i++) { var x = M.defs[i]; d.push([Math.round(x.x), Math.round(x.y), x.t, x.downed ? 1 : 0, Math.round(x.leg * 10)]); }
    send({ k: 'st', x: Math.round(M.rb.x), y: Math.round(M.rb.y), j: M.rb.jump > 0 ? 1 : 0, jm: Math.round(M.rb.jump), leg: Math.round(M.rb.leg * 10), d: d, yd: M.yard, s: M.status });
  }
  function endRound(status) {
    M.status = status; M.phase = 'over'; broadcastState();
    M.result[M.round] = { offenseIsHost: roundOffenseIsHost(M.round), yard: M.yard, status: status };
    send({ k: 'rend', n: M.round, yd: M.yard, s: status });
    removeControls();
    if (role === 'host') setTimeout(hostAdvance, 2600);
  }
  function hostAdvance() {
    if (M.round === 1) { send({ k: 'round', n: 2 }); enterRound(2); }
    else { var h = (M.result[1] && M.result[1].yard) || 0, g = (M.result[2] && M.result[2].yard) || 0; send({ k: 'result', h: h, g: g }); finishToResult(h, g, null); }
  }

  /* ---- 受信 ---- */
  function onMsg(p) {
    if (!p) return;
    if (p.k === 'start') { if (role !== 'host') enterRound(1); return; }
    if (p.k === 'round') { enterRound(p.n); return; }
    if (p.k === 'cos') { M.rbCos = p.c; return; }
    if (p.k === 'spawn') { if (M.active && M.amOffense) { if (M.defs.length < NDEF_MAX) { var t = DEFTYPES[p.t] || DEFTYPES[0]; M.defs.push({ x: p.x, y: p.y, t: p.t, r: t.r, speed: t.speed, leg: 0, downed: false, kb: 0, num: defNum(p.t) }); } } return; }
    if (p.k === 'st') { if (M.active && !M.amOffense) { M.latest = p; if (M.phase === 'countdown') { M.phase = 'play'; M.t0 = performance.now(); } if (p.s && p.s !== 'play') { M.phase = 'over'; M.status = p.s; removeControls(); } } return; }
    if (p.k === 'rend') { M.result[p.n] = { offenseIsHost: roundOffenseIsHost(p.n), yard: p.yd, status: p.s }; if (role === 'host') setTimeout(hostAdvance, 2600); return; }
    if (p.k === 'result') { finishToResult(p.h, p.g, null); return; }
    if (p.k === 'rematch') { backToLobby(); return; }
  }
  var _dnums = [1, 10, 12, 13, 15, 28, 45, 51, 85, 99, 19, 23, 42, 94, 96];
  function defNum(t) { return '' + _dnums[(t * 5 + Math.floor(Math.random() * 5)) % _dnums.length]; }

  /* ---- 描画（本体のdrawPlayer/drawDownedを流用） ---- */
  function vsRender() {
    if (typeof ctx === 'undefined') return;
    // 自己修復：対戦中はロビーを隠し、操作ボタンを必ず用意（enterRound取りこぼし対策）
    var _ov = document.getElementById('tdv-ov'); if (_ov && _ov.style.display !== 'none') _ov.style.display = 'none';
    if (M.phase !== 'over' && M.phase !== 'result' && !document.getElementById('tdv-ctrl')) { try { buildControls(); } catch (e) {} }
    if (!M._cv) { try { bindCanvas(); } catch (e) {} }
    hideCoinHud(true);
    var w = (typeof W !== 'undefined' ? W : 360), h = (typeof H !== 'undefined' ? H : 600);
    // フィールド
    ctx.fillStyle = '#1d7a34'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(220,240,220,.30)'; ctx.lineWidth = 2;
    for (var yy = 0; yy <= 100; yy += 10) { var fy = (h - 90) - ((h - 90) - FIELD_TOP) * (yy / 100); ctx.beginPath(); ctx.moveTo(0, fy); ctx.lineTo(w, fy); ctx.stroke(); ctx.fillStyle = 'rgba(220,240,220,.5)'; ctx.font = '11px sans-serif'; ctx.textAlign = 'left'; ctx.fillText(yy + '', 4, fy - 3); }
    // ゴール＆中央線
    ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, FIELD_TOP); ctx.lineTo(w, FIELD_TOP); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.setLineDash([8, 8]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, M.mid); ctx.lineTo(w, M.mid); ctx.stroke(); ctx.setLineDash([]);

    var rb, defs, yard, jumping, jm, leg;
    if (M.amOffense) { rb = M.rb; defs = M.defs; yard = M.yard; jumping = M.rb.jump > 0; jm = M.rb.jumpMax; leg = M.rb.leg; }
    else if (M.latest) {
      rb = { x: M.latest.x, y: M.latest.y }; yard = M.latest.yd; jumping = M.latest.j === 1; jm = M.latest.jm || 1; leg = (M.latest.leg || 0) / 10;
      defs = (M.latest.d || []).map(function (a) { return { x: a[0], y: a[1], t: a[2], downed: a[3] === 1, leg: a[4] / 10, r: (DEFTYPES[a[2]] || DEFTYPES[0]).r, num: '' }; });
    } else { rb = M.rb; defs = []; yard = 0; jumping = false; jm = 1; leg = 0; }

    // ディフェンス
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i], dt2 = DEFTYPES[d.t] || DEFTYPES[0];
      if (d.downed) { try { drawDowned(d.x, d.y, d.r, d.num || ''); } catch (e) {} }
      else { try { drawPlayer(d.x, d.y, d.r, d.leg || 0, { jersey: dt2.color, dark: dt2.dark, helm: '#e2554c', facing: 1, num: d.num || '' }); } catch (e) {} }
    }
    // RB（攻撃側は自分のコス、守備側は受信コス）
    var cos = M.amOffense ? myCos() : (M.rbCos || myCos());
    var sc = jumping ? 1 + 0.35 * Math.sin((1 - (jm ? (M.amOffense ? M.rb.jump : 0) / jm : 0)) * Math.PI) : 1;
    if (jumping) sc = 1.25;
    try {
      if (jumping) { ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 10; }
      drawPlayer(rb.x, rb.y, 15, leg, { jersey: cos.jersey, dark: cos.dark, helm: (typeof C !== 'undefined' ? C.offHelm : '#bfe8ff'), facing: 1, num: (typeof user !== 'undefined' && user.num) ? user.num : '22', ball: true, scale: sc, upat: cos.upat, helmKind: cos.helmKind, legCol: cos.legCol, legPat: cos.legPat, shoeCol: cos.shoeCol, shoePat: cos.shoePat });
      if (jumping) ctx.restore();
    } catch (e) {}

    // HUD
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = '900 20px -apple-system,sans-serif';
    ctx.fillText(yard + ' / 100 yd', 12, 32);
    ctx.font = '800 13px -apple-system,sans-serif'; ctx.fillStyle = '#ffd23f';
    ctx.fillText(M.amOffense ? '🏈 攻撃（あなた）' : '🛡 守備（あなた）', 12, 52);
    if (M.phase === 'play') { var left = Math.max(0, ROUND_SEC - Math.floor((performance.now() - M.t0) / 1000)); ctx.fillStyle = '#fff'; ctx.textAlign = 'right'; ctx.font = '900 20px -apple-system,sans-serif'; ctx.fillText('⏱ ' + left, w - 12, 32); }

    if (M.phase === 'countdown') {
      var n = Math.ceil((M.cdEnd - performance.now()) / 1000);
      ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '900 80px -apple-system,sans-serif'; ctx.fillText(n > 0 ? n : 'GO', w / 2, h / 2);
      ctx.font = '800 15px -apple-system,sans-serif'; ctx.fillText(M.amOffense ? '上のゴールへ！ 指で左右・JUMPでかわす' : '上半分をタップして守備を出す', w / 2, h / 2 + 40);
    }
    if (M.phase === 'over') {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '900 34px -apple-system,sans-serif';
      ctx.fillText(M.status === 'touchdown' ? '🏈 タッチダウン！' : M.status === 'tackled' ? '💥 タックル！' : '⏱ タイムアップ', w / 2, h / 2 - 10);
      ctx.font = '800 20px -apple-system,sans-serif'; ctx.fillText('記録 ' + yard + ' yd', w / 2, h / 2 + 22);
      ctx.font = '14px -apple-system,sans-serif'; ctx.fillText(M.round === 1 ? 'まもなく攻守交代…' : '結果を集計中…', w / 2, h / 2 + 50);
    }
    if (_flash && performance.now() < _flashT) { ctx.fillStyle = '#ffd23f'; ctx.textAlign = 'center'; ctx.font = '800 15px -apple-system,sans-serif'; ctx.fillText(_flash, w / 2, h - 90); }
  }

  /* ---- 結果 ---- */
  function finishToResult(hostYard, guestYard, note) {
    stopMatch();
    try { if (typeof state !== 'undefined' && typeof STATE !== 'undefined') window.state = STATE.MENU; } catch (e) {}
    build(); var ov = document.getElementById('tdv-ov'), m = document.getElementById('tdv-modal'); if (!m) return;
    var h, verdict, col;
    if (note) { h = '<h2>対戦終了</h2><p>' + note + '</p><div class="tdv-act"><button class="tdv-pri" onclick="TDVersus.close()">ホームへ</button></div>'; }
    else {
      var my = (role === 'host') ? hostYard : guestYard, op = (role === 'host') ? guestYard : hostYard;
      verdict = my > op ? '🏆 あなたの勝ち！' : my < op ? '😢 あなたの負け…' : '🤝 引き分け';
      col = my > op ? '#ffd23f' : my < op ? '#ff8a7a' : '#9fe0ff';
      h = '<h2 style="color:' + col + '">' + verdict + '</h2>' +
        '<div class="tdv-players"><div class="tdv-pl"><div class="nm">あなた</div><div class="rl">到達</div><div class="rd tdv-ok">' + my + ' yd</div></div>' +
        '<div class="tdv-pl"><div class="nm">相手</div><div class="rl">到達</div><div class="rd tdv-wait">' + op + ' yd</div></div></div>' +
        '<div class="tdv-act"><button class="tdv-pri" onclick="TDVersus._rematch()">もう一度（同じ相手と）</button>' +
        '<button class="tdv-ghost" onclick="TDVersus.close()">ホームへ</button></div>';
    }
    m.innerHTML = h; ov.style.display = 'flex';
  }
  function backToLobby() { stopMatch(); M.result = { 1: null, 2: null }; ready = false; meTracked(); try { if (typeof goHome === 'function') goHome(); } catch (e) {} var ov = document.getElementById('tdv-ov'); if (ov) ov.style.display = 'flex'; render(); }
  function closeLobbyOverlay() { var o = document.getElementById('tdv-ov'); if (o) o.style.display = 'none'; }

  /* ===================== ロビーUI ===================== */
  var CSS =
  '#tdv-btn{margin-top:8px;width:min(360px,92vw);padding:12px 6px;border:none;border-radius:10px;font-weight:800;font-size:15px;letter-spacing:1px;color:#3a0d0d;background:linear-gradient(180deg,#ff9d8a,#f0573b);box-shadow:0 5px 0 #a32c1a,0 8px 18px rgba(0,0,0,.4);cursor:pointer;font-family:inherit}#tdv-btn:active{transform:translateY(3px);box-shadow:0 2px 0 #a32c1a}' +
  '#tdv-ov{position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,.66);display:none;align-items:center;justify-content:center;padding:14px;font-family:-apple-system,"Segoe UI",sans-serif}' +
  '#tdv-modal{background:#0a0f1e;color:#eef3ff;width:min(440px,94vw);max-height:90vh;overflow:auto;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.6);padding:20px;text-align:center}' +
  '#tdv-modal h2{margin:0 0 6px;font-size:22px}#tdv-modal p{font-size:13px;opacity:.9;line-height:1.7;margin:4px 0}' +
  '.tdv-act{display:flex;flex-direction:column;gap:9px;margin-top:14px;align-items:center}.tdv-act button{width:min(300px,80vw);border:none;border-radius:10px;padding:13px;font-size:15px;font-weight:800;cursor:pointer;font-family:inherit}' +
  '.tdv-pri{background:linear-gradient(180deg,#9fe0ff,#3bb4f5);color:#03263a;box-shadow:0 4px 0 #1a78ad}.tdv-red{background:linear-gradient(180deg,#ff9d8a,#f0573b);color:#3a0d0d;box-shadow:0 4px 0 #a32c1a}.tdv-ghost{background:rgba(255,255,255,.12);color:#fff;border:2px solid rgba(255,255,255,.45)}' +
  '.tdv-code{font-size:40px;font-weight:900;letter-spacing:10px;color:#ffd23f;margin:10px 0;background:#0c1530;border-radius:12px;padding:14px}' +
  '.tdv-input{font-size:26px;font-weight:800;letter-spacing:8px;text-align:center;text-transform:uppercase;width:min(260px,76vw);padding:12px;border-radius:10px;border:2px solid #3bb4f5;background:#0c1530;color:#fff;font-family:inherit}' +
  '.tdv-players{display:flex;gap:10px;justify-content:center;margin:14px 0}.tdv-pl{flex:1;max-width:160px;background:#0c1530;border-radius:12px;padding:12px 8px}.tdv-pl .nm{font-weight:800;font-size:14px;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tdv-pl .rl{font-size:11px;opacity:.8}.tdv-pl .rd{margin-top:6px;font-size:13px;font-weight:800}.tdv-wait{color:#7fd4ff}.tdv-ok{color:#37c46a}.tdv-err{color:#ff8a7a;font-weight:700;margin-top:8px}';
  function el(t, a, h) { var e = document.createElement(t); if (a) for (var k in a) e[k] = a[k]; if (h != null) e.innerHTML = h; return e; }
  var built = false, view2 = 'menu', errMsg = '';
  function build() { if (built || !document.body) return; built = true; document.head.appendChild(el('style', null, CSS)); var ov = el('div', { id: 'tdv-ov' }); ov.appendChild(el('div', { id: 'tdv-modal' })); ov.addEventListener('click', function (e) { if (e.target === ov && !M.active && M.phase !== 'over') close(); }); document.body.appendChild(ov); }
  function openMenu() { build(); view2 = 'menu'; errMsg = ''; render(); document.getElementById('tdv-ov').style.display = 'flex'; }
  function close() { leave(); var o = document.getElementById('tdv-ov'); if (o) o.style.display = 'none'; try { if (typeof goHome === 'function') goHome(); } catch (e) {} }
  function renderError(m) { errMsg = m; render(); }
  function roleLabel(r) { return r === 'host' ? '🏈 オフェンス（第1試合）' : r === 'guest' ? '🛡 ディフェンス（第1試合）' : '—'; }
  function render() {
    if (M.active) return; build(); var m = document.getElementById('tdv-modal'); if (!m) return; var h = '';
    if (!channel) {
      if (view2 === 'join') h += '<h2>⚔ 部屋に入る</h2><p>友達から聞いた合言葉を入力してね。</p><div class="tdv-act"><input id="tdv-codein" class="tdv-input" maxlength="5" placeholder="○○○○○" autocomplete="off"><button class="tdv-red" onclick="TDVersus._join()">この合言葉で入る</button><button class="tdv-ghost" onclick="TDVersus._menu()">← もどる</button></div>';
      else h += '<h2>⚔ 対人対戦</h2><p>オフェンス（走る）対 ディフェンス（止める）の1対1。<br>友達と合言葉でつながって対戦しよう。</p><div class="tdv-act"><button class="tdv-pri" onclick="TDVersus._create()">部屋を作る（合言葉を発行）</button><button class="tdv-red" onclick="TDVersus._joinView()">部屋に入る（合言葉を入力）</button><button class="tdv-ghost" onclick="TDVersus.close()">とじる</button></div>';
      if (errMsg) h += '<p class="tdv-err">' + errMsg + '</p>'; m.innerHTML = h; return;
    }
    var pl = peers(), me = null, other = null; for (var i = 0; i < pl.length; i++) { if (pl[i].id === myId) me = pl[i]; else other = pl[i]; }
    h += '<h2>⚔ 対戦ロビー</h2><p>合言葉</p><div class="tdv-code">' + (roomCode || '') + '</div>';
    h += other ? '<p class="tdv-ok">相手が参加しました！両方が「準備OK」でスタートします。</p>' : '<p class="tdv-wait">相手の参加を待っています…<br>この合言葉「<b>' + roomCode + '</b>」を友達に伝えてね。</p>';
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
    _join: function () { var inp = document.getElementById('tdv-codein'); var v = ((inp && inp.value) || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); if (v.length < 4) { renderError('合言葉を正しく入力してください。'); return; } joinRoom(v, 'guest'); },
    _toggleReady: function () { setReady(!ready); },
    _startMatch: function () { if (role === 'host' && !M.active) { send({ k: 'start' }); enterRound(1); } },
    _leave: function () { leave(); view2 = 'menu'; render(); },
    _rematch: function () { send({ k: 'rematch' }); backToLobby(); },
  };
  function injectButton() { var home = document.getElementById('homeScreen'); if (!home || document.getElementById('tdv-btn')) return; var b = el('button', { id: 'tdv-btn' }, '⚔ 対人対戦'); b.addEventListener('click', openMenu); var grid = home.querySelector('.homeGrid'); if (grid && grid.parentNode) grid.parentNode.insertBefore(b, grid.nextSibling); else home.appendChild(b); }
  function start() { build(); injectButton(); setInterval(injectButton, 1000); setInterval(function () { if (M.active && !M.amOffense) updateTypeButtons(); }, 400); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
