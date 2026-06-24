/* =========================================================================
 * タッチダウン王 対人対戦 — フェーズ1：ロビー（合言葉でつながる）
 * -------------------------------------------------------------------------
 * オフェンス vs ディフェンスの1対1対戦の土台。まずは「合言葉で同じ部屋に
 * 入って2人がつながり、準備OKを押す」ところまで。実際の対戦はフェーズ2で。
 *
 * 仕組み：すでに使っている Supabase の Realtime（Presence + Broadcast）。
 *   - 部屋 = チャンネル "versus:<合言葉>"
 *   - Presence で在室人数・相手の参加/離脱を検知
 * 既存コードは無改造。ゲームのグローバル（window.supabase / SUPA_URL /
 * SUPA_ANON / user）を読むだけ。
 *
 * 使い方：</body> 直前に <script src="./td-versus.js"></script> を追加。
 * ========================================================================= */
(function () {
  'use strict';
  if (window.TDVersus) return;

  var client = null, channel = null;
  var myId = 'p_' + Math.random().toString(36).slice(2, 9);
  var role = null, roomCode = null, ready = false, connecting = false;

  function getName() {
    try { if (typeof user !== 'undefined' && user && user.name) return String(user.name).slice(0, 12); } catch (e) {}
    return 'プレイヤー';
  }
  function getClient() {
    if (client) return client;
    try {
      if (window.supabase && typeof SUPA_URL !== 'undefined' && typeof SUPA_ANON !== 'undefined') {
        client = window.supabase.createClient(SUPA_URL, SUPA_ANON);
      }
    } catch (e) {}
    return client;
  }
  function genCode() {
    var a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    for (var i = 0; i < 5; i++) s += a.charAt(Math.floor(Math.random() * a.length));
    return s;
  }

  /* ---------- Realtime ---------- */
  function peers() {
    if (!channel || !channel.presenceState) return [];
    var st = channel.presenceState(), out = [];
    for (var k in st) { for (var i = 0; i < st[k].length; i++) out.push(st[k][i]); }
    return out;
  }
  function meTracked() {
    if (!channel) return;
    try { channel.track({ id: myId, role: role, name: getName(), ready: ready }); } catch (e) {}
  }
  function joinRoom(code, asRole) {
    var c = getClient();
    if (!c) { renderError('オンライン接続が必要です（少し待ってからもう一度）。'); return; }
    leave();
    roomCode = code; role = asRole; ready = false; connecting = true;
    render();
    channel = c.channel('versus:' + code, { config: { presence: { key: myId } } });
    channel
      .on('presence', { event: 'sync' }, function () { connecting = false; render(); })
      .on('presence', { event: 'join' }, function () { render(); })
      .on('presence', { event: 'leave' }, function () { render(); })
      .on('broadcast', { event: 'msg' }, function (m) { onMsg(m && m.payload); })
      .subscribe(function (status) {
        if (status === 'SUBSCRIBED') { connecting = false; meTracked(); render(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { renderError('接続に失敗しました。もう一度お試しください。'); }
      });
  }
  function setReady(v) { ready = v; meTracked(); render(); }
  function leave() {
    if (channel) { try { channel.untrack(); } catch (e) {} try { channel.unsubscribe(); } catch (e) {} channel = null; }
    roomCode = null; role = null; ready = false; connecting = false;
  }
  function send(payload) { if (channel) { try { channel.send({ type: 'broadcast', event: 'msg', payload: payload }); } catch (e) {} } }
  function onMsg(p) { /* フェーズ2で対戦データを処理 */ }

  /* ---------- UI ---------- */
  var CSS =
  '#tdv-btn{margin-top:8px;width:min(360px,92vw);padding:12px 6px;border:none;border-radius:10px;font-weight:800;font-size:15px;letter-spacing:1px;color:#3a0d0d;background:linear-gradient(180deg,#ff9d8a,#f0573b);box-shadow:0 5px 0 #a32c1a,0 8px 18px rgba(0,0,0,.4);cursor:pointer;font-family:inherit}' +
  '#tdv-btn:active{transform:translateY(3px);box-shadow:0 2px 0 #a32c1a}' +
  '#tdv-ov{position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,.66);display:none;align-items:center;justify-content:center;padding:14px;font-family:-apple-system,"Segoe UI",sans-serif}' +
  '#tdv-modal{background:#0a0f1e;color:#eef3ff;width:min(440px,94vw);max-height:90vh;overflow:auto;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.6);padding:20px;text-align:center}' +
  '#tdv-modal h2{margin:0 0 6px;font-size:22px}' +
  '#tdv-modal p{font-size:13px;opacity:.9;line-height:1.7;margin:4px 0}' +
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
  '.tdv-pl .rl{font-size:11px;opacity:.8}' +
  '.tdv-pl .rd{margin-top:6px;font-size:12px;font-weight:800}' +
  '.tdv-wait{color:#7fd4ff}.tdv-ok{color:#37c46a}' +
  '.tdv-err{color:#ff8a7a;font-weight:700;margin-top:8px}';

  function el(t, a, h) { var e = document.createElement(t); if (a) for (var k in a) e[k] = a[k]; if (h != null) e.innerHTML = h; return e; }
  var built = false, view = 'menu', errMsg = '';
  function build() {
    if (built || !document.body) return; built = true;
    document.head.appendChild(el('style', null, CSS));
    var ov = el('div', { id: 'tdv-ov' });
    ov.appendChild(el('div', { id: 'tdv-modal' }));
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
  }
  function openMenu() { build(); view = 'menu'; errMsg = ''; render(); document.getElementById('tdv-ov').style.display = 'flex'; }
  function close() { leave(); var o = document.getElementById('tdv-ov'); if (o) o.style.display = 'none'; }
  function renderError(m) { errMsg = m; render(); }

  function render() {
    build();
    var m = document.getElementById('tdv-modal'); if (!m) return;
    var h = '';
    if (!channel) {
      if (view === 'join') {
        h += '<h2>⚔ 部屋に入る</h2><p>友達から聞いた合言葉を入力してね。</p>' +
             '<div class="tdv-act"><input id="tdv-codein" class="tdv-input" maxlength="5" placeholder="○○○○○" autocomplete="off">' +
             '<button class="tdv-red" onclick="TDVersus._join()">この合言葉で入る</button>' +
             '<button class="tdv-ghost" onclick="TDVersus._menu()">← もどる</button></div>';
      } else {
        h += '<h2>⚔ 対人対戦</h2><p>オフェンス（走る）対 ディフェンス（止める）の1対1。<br>友達と合言葉でつながって対戦しよう。</p>' +
             '<div class="tdv-act"><button class="tdv-pri" onclick="TDVersus._create()">部屋を作る（合言葉を発行）</button>' +
             '<button class="tdv-red" onclick="TDVersus._joinView()">部屋に入る（合言葉を入力）</button>' +
             '<button class="tdv-ghost" onclick="TDVersus.close()">とじる</button></div>';
      }
      if (errMsg) h += '<p class="tdv-err">' + errMsg + '</p>';
      m.innerHTML = h; return;
    }
    // in a room — lobby
    var pl = peers(), me = null, other = null;
    for (var i = 0; i < pl.length; i++) { if (pl[i].id === myId) me = pl[i]; else other = pl[i]; }
    h += '<h2>⚔ 対戦ロビー</h2>';
    h += '<p>合言葉</p><div class="tdv-code">' + (roomCode || '') + '</div>';
    if (!other) {
      h += '<p class="tdv-wait">相手の参加を待っています…<br>この合言葉「<b>' + roomCode + '</b>」を友達に伝えてね。</p>';
    } else {
      h += '<p class="tdv-ok">相手が参加しました！両方が「準備OK」でスタートします。</p>';
    }
    h += '<div class="tdv-players">';
    h += '<div class="tdv-pl"><div class="nm">' + (me ? me.name : getName()) + '（あなた）</div><div class="rl">' + roleLabel(role) + '</div><div class="rd ' + (ready ? 'tdv-ok' : 'tdv-wait') + '">' + (ready ? '準備OK ✓' : '準備中…') + '</div></div>';
    if (other) h += '<div class="tdv-pl"><div class="nm">' + other.name + '</div><div class="rl">' + roleLabel(other.role) + '</div><div class="rd ' + (other.ready ? 'tdv-ok' : 'tdv-wait') + '">' + (other.ready ? '準備OK ✓' : '準備中…') + '</div></div>';
    h += '</div>';
    h += '<div class="tdv-act">';
    if (other && me && me.ready && other.ready) {
      h += '<button class="tdv-pri" disabled>対戦準備完了！（対戦本体は次のアップデートで実装）</button>';
    } else {
      h += '<button class="' + (ready ? 'tdv-ghost' : 'tdv-red') + '" onclick="TDVersus._toggleReady()">' + (ready ? '準備をやめる' : '準備OK') + '</button>';
    }
    h += '<button class="tdv-ghost" onclick="TDVersus._leave()">← 退出する</button></div>';
    if (errMsg) h += '<p class="tdv-err">' + errMsg + '</p>';
    m.innerHTML = h;
  }
  function roleLabel(r) { return r === 'host' ? '🏈 オフェンス（第1試合）' : r === 'guest' ? '🛡 ディフェンス（第1試合）' : '—'; }

  /* ---------- 公開API（UIから呼ぶ） ---------- */
  window.TDVersus = {
    open: openMenu, close: close,
    _menu: function () { view = 'menu'; errMsg = ''; render(); },
    _create: function () { errMsg = ''; joinRoom(genCode(), 'host'); },
    _joinView: function () { view = 'join'; errMsg = ''; render(); },
    _join: function () {
      var inp = document.getElementById('tdv-codein'); var v = (inp && inp.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
      if (v.length < 4) { renderError('合言葉を正しく入力してください。'); return; }
      joinRoom(v, 'guest');
    },
    _toggleReady: function () { setReady(!ready); },
    _leave: function () { leave(); view = 'menu'; render(); },
  };

  /* ---------- ホーム画面に「⚔ 対人対戦」ボタンを差し込む ---------- */
  function injectButton() {
    var home = document.getElementById('homeScreen');
    if (!home || document.getElementById('tdv-btn')) return;
    var btn = el('button', { id: 'tdv-btn' }, '⚔ 対人対戦');
    btn.addEventListener('click', openMenu);
    var grid = home.querySelector('.homeGrid');
    if (grid && grid.parentNode) grid.parentNode.insertBefore(btn, grid.nextSibling);
    else home.appendChild(btn);
  }
  function start() { build(); injectButton(); setInterval(injectButton, 1000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
