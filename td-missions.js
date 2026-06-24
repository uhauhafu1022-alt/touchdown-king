/* =========================================================================
 * タッチダウン王 ミッション機能（ドロップイン版 / 方式A：クライアント完結）
 * -------------------------------------------------------------------------
 * 使い方（これだけ）：
 *   index.html の </body> の直前に次の1行を追加し、
 *   このファイル td-missions.js を index.html と同じフォルダに置く：
 *
 *       <script src="./td-missions.js"></script>
 *
 *   ゲーム本体のコードは一切書き換え不要です。このモジュールが
 *   既存の startRun / win / shareX / shareLine を自動で“フック”して
 *   ミッションの進捗を進め、報酬は既存の coins / uni 変数と
 *   updateCoinHud() を使って反映します（表示の残高に正しく加算）。
 *
 *   画面右下に 🎯 ボタンが出ます（ホーム画面でのみ表示）。
 *   やり方が分かりにくいミッション（ホーム画面に追加など）は
 *   「挑戦する（やり方を見る）」で端末別の手順が見られます。
 *
 * ※テスト用の最小版（全部ローカル保存）。機種をまたいだ引き継ぎや
 *   二重受取防止が要るようになったら設計書の「方式B(Supabase併用)」へ拡張。
 * ========================================================================= */
(function () {
  'use strict';
  if (window.TDMission) return;

  /* ---------- localStorage（ゲーム側 lsGet/lsSet があれば流用） ---------- */
  function jget(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function jset(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function LSget(k, d) { try { if (typeof lsGet === 'function') return lsGet(k, d); } catch (e) {} return jget(k, d); }
  function LSset(k, v) { try { if (typeof lsSet === 'function') return lsSet(k, v); } catch (e) {} return jset(k, v); }

  const todayStr = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const todayStrOf = (d) => { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const weekKey = () => { const d = new Date(); const day = (d.getDay() + 6) % 7; const monday = new Date(d); monday.setDate(d.getDate() - day); return todayStrOf(monday); };

  /* ---------- ミッション定義（テスト版の初期セット） ---------- */
  const MISSIONS = [
    { id: 'd_open', type: 'daily', title: '今日ゲームを開く', target: 1, reward: { yard: 10 } },
    { id: 'd_play', type: 'daily', title: '今日1回プレイする', target: 1, reward: { yard: 15 }, hook: 'onPlayStart' },
    { id: 'd_td', type: 'daily', title: '今日タッチダウンを1回', target: 1, reward: { yard: 30 }, hook: 'onTouchdown' },

    { id: 'w_play5', type: 'weekly', title: '今週5回プレイする', target: 5, reward: { yard: 100 }, hook: 'onPlayStart' },

    { id: 'streak3', type: 'once', title: '3日連続でログイン', target: 3, reward: { yard: 30 }, kind: 'streak' },
    { id: 'streak7', type: 'once', title: '7日連続でログイン', target: 7, reward: { yard: 50, uni: 3 }, kind: 'streak' },

    { id: 'pwa', type: 'once', title: 'ホーム画面に追加する', target: 1, reward: { yard: 300, uni: 5 }, kind: 'pwa',
      desc: 'スマホのホーム画面に置くと一発で起動できます。', howto: 'pwa' },
    { id: 'share', type: 'once', title: '𝕏 か LINE でシェアする', target: 1, reward: { yard: 30 }, hook: 'onShare',
      desc: 'ホームの「📣 シェア」やスコア画面のシェアから。', howto: 'share' },
    { id: 'first_td', type: 'once', title: 'はじめてのタッチダウン（100ヤード完走）', target: 1, reward: { yard: 100 }, hook: 'onTouchdown' },
    { id: 'nfl_td', type: 'once', title: 'NFLレベルでタッチダウン', target: 1, reward: { yard: 200, uni: 5 }, hook: 'onTouchdown', level: 'NFL',
      desc: '最難関のNFLレベルで100ヤード走り切ろう。', howto: 'nfl' },
  ];

  /* ---------- やり方（挑戦ボタン） ---------- */
  function deviceKind() { const ua = navigator.userAgent || ''; if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'; if (/Android/i.test(ua)) return 'android'; return 'desktop'; }
  function howtoSteps(kind) {
    if (kind === 'pwa') {
      const d = deviceKind();
      if (d === 'ios') return { title: 'ホーム画面に追加する（iPhone / iPad）', steps: [
        'Safariでこのゲームを開きます（アプリ内ブラウザではなくSafariで）。',
        '画面下の「共有」ボタン（□に↑のマーク）をタップ。',
        'メニューを下にスクロールして「ホーム画面に追加」をタップ。',
        '右上の「追加」をタップ。ホーム画面にアイコンが出れば完了！',
        'そのアイコンから起動すると、このミッションが自動で達成されます。'] };
      if (d === 'android') return { title: 'ホーム画面に追加する（Android）', steps: [
        'Chromeでこのゲームを開きます。',
        '右上の「⋮」（メニュー）をタップ。',
        '「ホーム画面に追加」または「アプリをインストール」をタップ。',
        '「追加 / インストール」を選ぶと、ホーム画面にアイコンが出ます。',
        'そのアイコンから起動すると、このミッションが自動で達成されます。'] };
      return { title: 'アプリに追加する（パソコン）', steps: [
        'Chromeやエッジでこのゲームを開きます。',
        'アドレスバー右側のインストールアイコン（⊕ や 画面マーク）をクリック。',
        '「インストール」を選ぶとアプリとして追加されます。',
        'スマホで遊ぶ場合は、スマホのブラウザで同じURLを開いて追加してください。'] };
    }
    if (kind === 'share') return { title: 'シェアのやり方', steps: [
      'ホーム画面の「📣 シェア」を押すか、',
      'プレイ後のスコア画面の「𝕏 でシェア」または「LINEでシェア」を押します。',
      '投稿を送る（またはコピーする）と、このミッションが達成されます。'] };
    if (kind === 'nfl') return { title: 'NFLレベルの遊び方', steps: [
      'ホームの「▶ ゲームスタート」→「🎲 ランダムモード」を選びます。',
      'レベル選択で「🏆 NFLレベル（最難関 ⭐⭐⭐⭐）」を選びます。',
      'ディフェンスをかわして100ヤード走り切ればタッチダウン＝達成です。',
      '難しいときは、選手ガチャで足・技の高い選手をそろえると走りやすくなります。'] };
    return { title: 'やり方', steps: ['画面の説明にそって進めてください。'] };
  }

  /* ---------- 状態 ---------- */
  const ST = 'tdm_state';
  function load() { return jget(ST, { day: '', week: '', m: {} }); }
  function save(s) { jset(ST, s); }
  function cellOf(s, id) { return (s.m[id] = s.m[id] || { p: 0, done: false, claimed: false }); }
  function resetCycles(s) {
    const t = todayStr(), w = weekKey();
    if (s.day !== t) { MISSIONS.filter(m => m.type === 'daily').forEach(m => s.m[m.id] = { p: 0, done: false, claimed: false }); s.day = t; }
    if (s.week !== w) { MISSIONS.filter(m => m.type === 'weekly').forEach(m => s.m[m.id] = { p: 0, done: false, claimed: false }); s.week = w; }
  }

  /* ---------- 連続ログイン：ゲーム側の td_login_streak を流用 ---------- */
  function getStreak() { const v = LSget('td_login_streak', 0); return (typeof v === 'number' && v > 0) ? v : (parseInt(v, 10) || 0); }

  /* ---------- 報酬付与：ゲームの coins / uni / updateCoinHud を使う ---------- */
  function grant(yard, u) {
    let done = false;
    try {
      if (typeof coins !== 'undefined') {            // ゲーム本体のグローバル変数
        if (yard) { coins += yard; LSset('td_coins', coins); }
        if (u && typeof uni !== 'undefined') { uni += u; LSset('td_uni', uni); }
        if (typeof updateCoinHud === 'function') { try { updateCoinHud(); } catch (e) {} }
        done = true;
      }
    } catch (e) {}
    if (!done) { // フォールバック（万一グローバルに触れない場合）
      if (yard) jset('td_coins', (jget('td_coins', 0) || 0) + yard);
      if (u) jset('td_uni', (jget('td_uni', 0) || 0) + u);
    }
    window.dispatchEvent(new CustomEvent('tdm:granted', { detail: { yard: yard || 0, uni: u || 0 } }));
  }

  /* ---------- 進捗API ---------- */
  function progress(event, amount, meta) {
    amount = amount || 1; meta = meta || {};
    const s = load(); resetCycles(s); let ch = false;
    MISSIONS.forEach(m => {
      if (m.hook !== event) return;
      if (m.level && meta.level && meta.level !== m.level) return;
      const c = cellOf(s, m.id);
      if (c.claimed || c.done) return;
      c.p = Math.min(m.target, c.p + amount);
      if (c.p >= m.target) { c.done = true; toast('ミッション達成：' + m.title); }
      ch = true;
    });
    if (ch) { save(s); render(); paintBadge(); }
  }
  function claim(id) {
    const s = load(); const m = MISSIONS.find(x => x.id === id); const c = s.m[id];
    if (!m || !c || !c.done || c.claimed) return;
    grant(m.reward.yard || 0, m.reward.uni || 0);
    c.claimed = true; save(s);
    toast(rewardText(m.reward) + ' を受け取りました！');
    render(); paintBadge();
  }
  function rewardText(r) { const a = []; if (r.yard) a.push(r.yard + 'ヤード'); if (r.uni) a.push(r.uni + 'ユニ'); return a.join('＋'); }
  function pendingCount() { const s = load(); return MISSIONS.reduce((n, m) => { const c = s.m[m.id]; return n + (c && c.done && !c.claimed ? 1 : 0); }, 0); }

  /* ---------- UI ---------- */
  const CSS = `#tdm-btn{position:fixed;right:14px;bottom:14px;z-index:99998;width:54px;height:54px;border:none;border-radius:50%;background:#0c3d1c;color:#fff;font-size:25px;box-shadow:0 4px 14px rgba(0,0,0,.4);cursor:pointer;display:none}
#tdm-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#e23b3b;color:#fff;font-size:12px;line-height:20px;text-align:center;padding:0 5px;font-weight:bold;display:none}
#tdm-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center;padding:14px}
#tdm-modal{background:#04200c;color:#eafff0;width:min(560px,96vw);max-height:88vh;overflow:auto;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.5);padding:18px;font-family:-apple-system,'Segoe UI',sans-serif}
#tdm-modal h2{margin:0 0 4px;font-size:20px}
#tdm-modal .sub{opacity:.85;font-size:12px;margin-bottom:12px}
.tdm-sec{font-weight:bold;margin:14px 0 6px;font-size:14px;border-bottom:1px solid #1f5a33;padding-bottom:4px}
.tdm-row{background:#0a3018;border-radius:12px;padding:10px 12px;margin:8px 0}
.tdm-row .t{font-size:14px;font-weight:bold}
.tdm-row .r{font-size:12px;opacity:.85;margin-top:2px}
.tdm-bar{height:7px;background:#072811;border-radius:4px;margin-top:8px;overflow:hidden}
.tdm-bar>i{display:block;height:100%;background:#37c46a;width:0}
.tdm-act{display:flex;gap:8px;margin-top:9px;flex-wrap:wrap}
.tdm-act button{border:none;border-radius:9px;padding:8px 12px;font-size:13px;font-weight:bold;cursor:pointer}
.tdm-claim{background:#37c46a;color:#03210f}
.tdm-claimed{background:#15391f;color:#7fae8e}
.tdm-howto{background:#2b6fd6;color:#fff}
.tdm-prog{background:#15391f;color:#bfe6cd}
#tdm-modal .close{float:right;background:none;border:none;color:#cfe;font-size:22px;cursor:pointer;line-height:1}
#tdm-toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:100000;background:#0c3d1c;color:#fff;padding:10px 16px;border-radius:20px;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.4);opacity:0;transition:opacity .25s;pointer-events:none;text-align:center}
#tdm-toast.show{opacity:1}
.tdm-steps{background:#072811;border-radius:10px;padding:10px 14px;margin-top:8px}
.tdm-steps li{margin:5px 0;font-size:13px;line-height:1.6}`;

  function el(tag, attrs, html) { const e = document.createElement(tag); if (attrs) Object.assign(e, attrs); if (html != null) e.innerHTML = html; return e; }
  let built = false;
  function build() {
    if (built || !document.body) return; built = true;
    document.head.appendChild(el('style', null, CSS));
    const btn = el('button', { id: 'tdm-btn', title: 'ミッション' }, '🎯<span id="tdm-badge"></span>');
    btn.addEventListener('click', open);
    document.body.appendChild(btn);
    const ov = el('div', { id: 'tdm-ov' });
    ov.appendChild(el('div', { id: 'tdm-modal' }));
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    document.body.appendChild(el('div', { id: 'tdm-toast' }));
  }
  function open() { build(); render(); const o = document.getElementById('tdm-ov'); if (o) o.style.display = 'flex'; }
  function close() { const o = document.getElementById('tdm-ov'); if (o) o.style.display = 'none'; }
  function groupName(t) { return t === 'daily' ? '📅 デイリー' : t === 'weekly' ? '🗓 ウィークリー' : '🏅 達成ミッション'; }
  function render() {
    build(); const s = load(); resetCycles(s); save(s);
    const m = document.getElementById('tdm-modal'); if (!m) return;
    let h = `<button class="close" onclick="TDMission.close()">×</button><h2>🎯 ミッション</h2><div class="sub">クリアして「受け取る」を押すとコインがもらえます。</div>`;
    ['daily', 'weekly', 'once'].forEach(type => {
      const list = MISSIONS.filter(x => x.type === type); if (!list.length) return;
      h += `<div class="tdm-sec">${groupName(type)}</div>`;
      list.forEach(def => {
        const c = s.m[def.id] || { p: 0, done: false, claimed: false };
        const pct = Math.min(100, Math.round((c.p / def.target) * 100));
        h += `<div class="tdm-row"><div class="t">${def.title}</div><div class="r">報酬：${rewardText(def.reward)}${def.desc ? '　/　' + def.desc : ''}</div>` +
             `<div class="tdm-bar"><i style="width:${pct}%"></i></div><div class="r" style="margin-top:6px">進捗 ${c.p} / ${def.target}</div><div class="tdm-act">`;
        if (c.claimed) h += `<button class="tdm-claimed" disabled>受取済み ✓</button>`;
        else if (c.done) h += `<button class="tdm-claim" onclick="TDMission.claim('${def.id}')">受け取る（${rewardText(def.reward)}）</button>`;
        else if (def.howto) h += `<button class="tdm-howto" onclick="TDMission.howto('${def.id}')">挑戦する（やり方を見る）</button>`;
        else h += `<button class="tdm-prog" disabled>挑戦中…</button>`;
        h += `</div></div>`;
      });
    });
    m.innerHTML = h;
  }
  function howto(id) {
    const def = MISSIONS.find(x => x.id === id); if (!def || !def.howto) return;
    const g = howtoSteps(def.howto); const m = document.getElementById('tdm-modal');
    m.innerHTML = `<button class="close" onclick="TDMission.render()">×</button><h2>${g.title}</h2>` +
      `<div class="sub">手順どおりに進めると、このミッションは自動で達成されます。</div>` +
      `<ol class="tdm-steps">${g.steps.map(s => '<li>' + s + '</li>').join('')}</ol>` +
      `<div class="tdm-act" style="margin-top:12px"><button class="tdm-prog" onclick="TDMission.render()">← ミッション一覧に戻る</button></div>`;
  }
  function paintBadge() { const b = document.getElementById('tdm-badge'); if (!b) return; const n = pendingCount(); b.textContent = n; b.style.display = n > 0 ? 'block' : 'none'; }
  let toastT; function toast(msg) { build(); const t = document.getElementById('tdm-toast'); if (!t) return; t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

  /* ---------- 🎯ボタンの表示制御（ホーム画面のときだけ表示） ---------- */
  function tickButton() {
    const btn = document.getElementById('tdm-btn'); if (!btn) return;
    const home = document.getElementById('homeScreen');
    const show = home && !home.classList.contains('hidden');
    btn.style.display = show ? 'block' : 'none';
  }

  /* ---------- 自動判定 ---------- */
  function autoDetect() {
    const s = load(); resetCycles(s);
    // 今日ゲームを開いた
    const o = cellOf(s, 'd_open'); if (!o.claimed) { o.p = 1; o.done = true; }
    // 連続ログイン（ゲーム側のstreakを反映）
    const sk = getStreak();
    MISSIONS.filter(m => m.kind === 'streak').forEach(m => { const c = cellOf(s, m.id); if (c.claimed) return; c.p = Math.min(m.target, sk); c.done = c.p >= m.target; });
    // ホーム画面に追加(PWA)：standalone起動＝追加済み
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true || jget('td_pwa_installed', 0) === 1;
    if (standalone) { jset('td_pwa_installed', 1); const p = cellOf(s, 'pwa'); if (!p.claimed) { p.p = 1; p.done = true; } }
    save(s); paintBadge();
  }
  window.addEventListener('appinstalled', () => { jset('td_pwa_installed', 1); const s = load(); const p = cellOf(s, 'pwa'); if (!p.claimed) { p.p = 1; p.done = true; } save(s); toast('ミッション達成：ホーム画面に追加する'); render(); paintBadge(); });

  /* ---------- 既存関数を自動フック（ゲーム本体は無改造） ---------- */
  function wrap(name, ev, metaFn) {
    try {
      const orig = window[name];
      if (typeof orig === 'function' && !orig.__tdm) {
        const wrapped = function () { try { progress(ev, 1, metaFn ? metaFn() : {}); } catch (e) {} return orig.apply(this, arguments); };
        wrapped.__tdm = true; window[name] = wrapped;
      }
    } catch (e) {}
  }
  function installHooks() {
    wrap('startRun', 'onPlayStart');
    wrap('win', 'onTouchdown', function () { try { return { level: (typeof curLevel !== 'undefined' && curLevel) ? curLevel.name : '' }; } catch (e) { return {}; } });
    wrap('shareX', 'onShare');
    wrap('shareLine', 'onShare');
  }

  /* ---------- 公開API ---------- */
  window.TDMission = { progress, claim, open, close, render, howto, _missions: MISSIONS };

  /* ---------- 起動 ---------- */
  function start() {
    build(); installHooks(); autoDetect(); render(); paintBadge();
    tickButton(); setInterval(tickButton, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
