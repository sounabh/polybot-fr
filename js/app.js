/**
 * frontend/js/app.js
 * Talks to the Node.js server at /api/*
 * No direct Polymarket API calls from the browser — everything goes through the server.
 */

/**
 * Where /api/* lives. Static hosts (Vercel, etc.) have no API — must point at your Node server.
 * Priority: window.POLY_API_BASE → localhost (same tab) → *.onrender.com (same app) → meta poly-api-base → REMOTE_API_DEFAULT
 */
const REMOTE_API_DEFAULT = 'https://polybot-bc.onrender.com';

function getPolyApiBase() {
  if (typeof window === 'undefined') return '';
  if (window.POLY_API_BASE) return String(window.POLY_API_BASE).replace(/\/$/, '');
  const { protocol, hostname, origin } = window.location;
  if (protocol !== 'http:' && protocol !== 'https:') return REMOTE_API_DEFAULT;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return origin;
  if (/\.onrender\.com$/i.test(hostname)) return origin;
  const meta = document.querySelector('meta[name="poly-api-base"]')?.getAttribute('content')?.trim();
  if (meta) return meta.replace(/\/$/, '');
  return REMOTE_API_DEFAULT;
}

const API_BASE = getPolyApiBase();

// ── State ─────────────────────────────────────────────────
const App = {
  page: 'dash', cat: 'all', markets: [],
  portfolio: null, leaderboard: [],
  pendingTrade: null,   // AI-proposed trade waiting for user confirm
  _rt: null,            // refresh interval
};

// ── API helper ────────────────────────────────────────────
function normalizeHttpError(text, status, data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (typeof data.error === 'string') return data.error;
    if (data.error && typeof data.error === 'object') {
      return data.error.message || data.error.code || JSON.stringify(data.error);
    }
    if (data.message) return data.message;
    if (data.detail) return data.detail;
  }
  const blob = `${text || ''} ${JSON.stringify(data || {})}`;
  if (/NOT_FOUND/i.test(blob) || status === 404) {
    return `API not found (tried ${API_BASE}). If the UI is on Vercel/Netlify, your Node API is elsewhere: set <meta name="poly-api-base" content="https://your-render-service.onrender.com"> or \`window.POLY_API_BASE\` before loading this script.`;
  }
  return text?.slice(0, 200) || `HTTP ${status}`;
}

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const url = API_BASE + '/api' + path;
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (!r.ok) return { error: normalizeHttpError(text, r.status, null) };
        return { error: text.slice(0, 120) || `HTTP ${r.status}` };
      }
    }
    if (!r.ok) {
      return { error: normalizeHttpError(text, r.status, data) };
    }
    return data;
  } catch (e) {
    return {
      error: e.message || 'Network error',
      hint: 'Check API URL (poly-api-base / POLY_API_BASE) and CORS on your Node server.',
    };
  }
}

// ── DOM helpers ───────────────────────────────────────────
const ge  = id => document.getElementById(id);
const qs  = s  => document.querySelector(s);
const qsa = s  => document.querySelectorAll(s);

const fmtUSD = (n, d=2) => {
  const x = +(n ?? 0);
  if (!Number.isFinite(x)) return '—';
  return x>=1e6?`$${(x/1e6).toFixed(1)}M`:x>=1e3?`$${(x/1e3).toFixed(1)}K`:`$${x.toFixed(d)}`;
};
const fmtPnl = n  => {
  const x = +(n ?? 0);
  if (!Number.isFinite(x)) return '—';
  return (x>=0?'+':'-')+'$'+Math.abs(x).toFixed(2);
};
const fmtD   = d  => { if(!d)return'—'; return new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}); };
const fmtDT  = d  => { if(!d)return'—'; return new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); };
const sa     = a  => a?a.slice(0,6)+'…'+a.slice(-4):'—';
const chip   = (t,c) => `<span class="chip chip-${c}">${t}</span>`;
const bdg    = n  => `<span class="bdg bdg-${n>=75?'exc':n>=55?'good':n>=35?'fair':'poor'}">${n}</span>`;
const pb     = p  => `<div class="pb"><div class="pb-f" style="width:${p}%"></div></div>`;
const ldr    = (m='Loading…') => `<div class="ldr"><div class="sp"></div><span>${m}</span></div>`;
const empty  = m => `<div class="empty">${m}</div>`;
const errBox = m => `<div class="notice err">❌ ${m}</div>`;
const esc    = s => (s||'').replace(/'/g,'').replace(/"/g,'').slice(0,60);

const CATS = [
  {id:'all',label:'All',icon:'🌐',tag:null},
  {id:'sports',label:'Sports',icon:'⚽',tag:'sports'},
  {id:'cricket',label:'Cricket/IPL',icon:'🏏',tag:'cricket'},
  {id:'politics',label:'Politics',icon:'🏛️',tag:'politics'},
  {id:'crypto',label:'Crypto',icon:'₿',tag:'crypto'},
  {id:'economy',label:'Economy',icon:'📈',tag:'economy'},
  {id:'tech',label:'Tech',icon:'💻',tag:'technology'},
  {id:'culture',label:'Culture',icon:'🎬',tag:'pop-culture'},
];

// ── Init ──────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  buildCats();
  checkStatus();
  loadDash();
  setInterval(checkStatus, 30000);
  App._rt = setInterval(() => {
    if (App.page === 'dash') loadDash();
    if (App.page === 'bot')  refreshBot();
  }, 15000);
  // Chat keyboard
  ge('chat-in').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
});

// ── Server status ─────────────────────────────────────────
async function checkStatus() {
  const s = await api('/status');
  if (s.error) { ge('srv-dot').classList.remove('on'); ge('wallet-info').textContent = 'server offline'; return; }
  ge('srv-dot').classList.add('on');
  ge('wallet-info').textContent = s.walletAddress ? sa(s.walletAddress) : 'no wallet';
  ge('wallet-info').className   = 'wallet-info' + (s.walletConnected ? ' on' : '');

  // Show network error banner if Polymarket APIs unreachable
  let netBanner = ge('net-error-banner');
  if (!netBanner) {
    netBanner = document.createElement('div');
    netBanner.id = 'net-error-banner';
    netBanner.style.cssText = 'position:fixed;top:90px;left:50%;transform:translateX(-50%);z-index:9999;width:min(600px,95vw);';
    document.body.appendChild(netBanner);
  }
  if (s.networkOk === false) {
    netBanner.innerHTML = `<div style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.4);border-radius:8px;padding:12px 16px;font-size:12.5px;color:#fca5a5;line-height:1.7">
      ❌ <strong>Cannot reach Polymarket APIs.</strong><br>
      Your server cannot connect to <code>gamma-api.polymarket.com</code> or <code>data-api.polymarket.com</code>.<br>
      This is why portfolio and markets show no data.<br><br>
      <strong>How to fix:</strong><br>
      1. Check internet connection on the machine running this server<br>
      2. Run in terminal: <code>nslookup gamma-api.polymarket.com</code><br>
      3. If no internet: connect to a network or use a VPN<br>
      4. If DNS issue: set DNS to 8.8.8.8 in your network settings<br>
      5. If geo-blocked: install a VPN (NordVPN, ProtonVPN, etc.) on the server machine
    </div>`;
  } else if (s.networkOk === true) {
    netBanner.innerHTML = '';
  }

  // Sync settings fields
  if (s.riskConfig) {
    ['daily','budget','exposure','stoploss','score'].forEach(k => {
      const keys = {daily:'dailyLimit',budget:'maxBudgetPct',exposure:'maxExposurePct',stoploss:'stopLossPct',score:'minScore'};
      const el  = ge(`s-${k}`);  if (el)  el.value = s.riskConfig[keys[k]] || el.value;
      const el2 = ge(`b-${k}`);  if (el2) el2.value = s.riskConfig[keys[k]] || el2.value;
    });
  }

  // Update server info panel
  const si = ge('srv-info');
  if (si) si.innerHTML = `
    <div>Wallet: <span class="mono ${s.walletConnected?'up':''}">${s.walletAddress||'not configured'}</span></div>
    <div>Polygon RPC: <span class="${s.polygonRpcOk===true?'up':s.polygonRpcOk===false?'dn':''}">${s.polygonRpcOk===true?'✅ on-chain balance':s.polygonRpcOk===false?'⚠️ RPC failed':'⏸ not set (set POLYGON_RPC_URL)'}</span></div>
    <div>Data: <span class="up">Gamma + Data API + CLOB v2</span></div>
    <div>Claude AI: <span class="${s.claudeConfigured?'up':'dn'}">${s.claudeConfigured?'✅ configured':'⚠️ no key'}</span></div>
    <div>Bot: <span class="${s.bot?.running?'up':''}">${s.bot?.running?'🟢 running':'⭕ stopped'}</span></div>
    <div>Uptime: <span>${Math.round((s.uptime||0)/60)}min</span></div>`;
}

// ── Navigation ────────────────────────────────────────────
function nav(page) {
  App.page = page;
  qsa('.page').forEach(p => p.classList.remove('active'));
  qsa('.nb').forEach(b => b.classList.toggle('active', b.dataset.p === page));
  ge(`p-${page}`)?.classList.add('active');
  const loaders = {
    dash: loadDash, profile: loadProfile, markets: loadMarkets,
    ai: initChat, lb: loadLB, trades: loadTrades,
    bot: refreshBot, settings: loadSettings,
  };
  (loaders[page] || (() => {}))();
}

// ══════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════
async function loadDash() {
  const [port, botSt] = await Promise.all([
    api('/portfolio'), api('/bot/status'),
  ]);
  if (port.error) {
    ge('d-bal').textContent = '—';
    ge('d-rp').textContent = '—';
    ge('d-up').textContent = '—';
    ge('d-pos').textContent = '—';
    ge('d-today').textContent = '—';
    ge('d-spnl').textContent = '—';
    const hint = port.hint ? `<div class="notice warn mb12">${port.hint}</div>` : '';
    ge('d-pos-tbl').innerHTML = hint + errBox(port.error);
    ge('d-trades-tbl').innerHTML = errBox(port.error);
    renderBotWidget(botSt || {});
    return;
  }
  App.portfolio = port;

  ge('d-bal').textContent  = fmtUSD(port.cashBalance);
  ge('d-rp').textContent   = fmtPnl(port.realizedPnl);
  ge('d-rp').className     = 'sv ' + (port.realizedPnl  >= 0 ? 'up' : 'dn');
  ge('d-up').textContent   = fmtPnl(port.unrealizedPnl);
  ge('d-up').className     = 'sv ' + (port.unrealizedPnl >= 0 ? 'up' : 'dn');
  ge('d-pos').textContent  = port.posCount || 0;

  if (port.riskPnl) {
    const td = port.riskPnl.todayTrades || 0;
    const dr = port.riskPnl.dailyRemaining || 0;
    ge('d-today').textContent = `${td}/${td + dr}`;
    const sp = port.riskPnl.realizedPnl || 0;
    ge('d-spnl').textContent  = fmtPnl(sp);
    ge('d-spnl').className    = 'sv ' + (sp >= 0 ? 'up' : 'dn');
  }

  if (port.walletConfigured === false) {
    ge('d-pos-tbl').innerHTML =
      `<div class="notice warn mb12">No <code>PRIVATE_KEY</code> in server <code>.env</code> — showing empty portfolio. Add your key and restart to load live Polymarket data.</div>` +
      empty('No open positions');
    ge('d-trades-tbl').innerHTML = empty('No recent trades');
  } else {
    renderPosMini(port.positions || [], 'd-pos-tbl');
    renderTradesMini((port.recentTrades || []).slice(0, 6), 'd-trades-tbl');
  }

  renderBotWidget(botSt);
}

function renderPosMini(pos, id) {
  const el = ge(id); if (!el) return;
  if (!pos.length) { el.innerHTML = empty('No open positions'); return; }
  el.innerHTML = `<div class="tscroll"><table class="tbl"><thead><tr><th>Market</th><th>Outcome</th><th>Size</th><th>P&L</th><th></th></tr></thead><tbody>
    ${pos.map(p => `<tr>
      <td class="cl">${p.title?.slice(0,42)}</td>
      <td>${chip(p.outcome, p.outcome==='YES'?'yes':'no')}</td>
      <td>${fmtUSD(p.size)}</td>
      <td class="${p.pnl>=0?'up':'dn'}">${fmtPnl(p.pnl)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="openSell('${p.conditionId}','${esc(p.title)}','${p.outcome}',${p.currentPrice||p.avgPrice||0},${p.size})">SELL</button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function renderTradesMini(tr, id) {
  const el = ge(id); if (!el) return;
  if (!tr.length) { el.innerHTML = empty('No recent trades'); return; }
  el.innerHTML = `<div class="tscroll"><table class="tbl"><thead><tr><th>Market</th><th>Side</th><th>Outcome</th><th>Value</th><th>Date</th></tr></thead><tbody>
    ${tr.map(t => `<tr>
      <td class="cl">${t.title?.slice(0,42)}</td>
      <td>${chip((t.side||'BUY').toUpperCase(), t.side==='sell'?'sell':'buy')}</td>
      <td>${chip(t.outcome, (t.outcome||'').toLowerCase())}</td>
      <td>${fmtUSD(t.usdcValue||t.size)}</td>
      <td class="sm mt">${fmtD(t.timestamp)}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function renderBotWidget(s) {
  const el = ge('d-bot-status'); if (!el) return;
  const pnl = s?.pnl || {};
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <div class="bot-dot ${s?.running?'on':''}"></div>
      <span class="fw">${s?.running ? '🟢 BOT RUNNING' : '⭕ BOT STOPPED'}</span>
      <span class="sm mt">Today: ${pnl.todayTrades||0}/${(pnl.todayTrades||0)+(pnl.dailyRemaining||4)} trades</span>
      <span class="sm mt">Session P&L: <span class="${pnl.realizedPnl>=0?'up':'dn'}">${fmtPnl(pnl.realizedPnl||0)}</span></span>
      <span class="sm mt">Win rate: ${pnl.winRate||0}%</span>
      ${pnl.paused?`<span class="chip chip-sell">PAUSED: ${pnl.pauseReason}</span>`:''}
      <button class="btn btn-${s?.running?'danger':'success'} btn-sm" onclick="${s?.running?'stopBot()':'nav(\'bot\')'}">
        ${s?.running?'■ Stop':'▶ Configure Bot'}
      </button>
    </div>`;
}

// ══════════════════════════════════════════════════════════
// PROFILE
// ══════════════════════════════════════════════════════════
async function loadProfile() {
  ge('profile-content').innerHTML = ldr('Loading your Polymarket profile…');
  const port = await api('/portfolio');
  if (port.error) { ge('profile-content').innerHTML = errBox(port.error); return; }
  App.portfolio = port;
  if (port.walletConfigured === false) {
    ge('profile-content').innerHTML =
      `<div class="notice warn mb16">Configure <code>PRIVATE_KEY</code> in the server <code>.env</code> and restart to load your Polymarket username, balance, and trades.</div>` +
      empty('Profile unavailable until wallet is configured');
    return;
  }

  ge('profile-content').innerHTML = `
    <div class="profile-hero">
      <div class="av">
        ${port.avatar?`<img src="${port.avatar}" onerror="this.style.display='none'">` : ''}
        <span class="av-l">${(port.username||port.address||'?')[0].toUpperCase()}</span>
      </div>
      <div style="flex:1">
        <div class="pf-name">${port.username || 'Anonymous'}</div>
        <div class="pf-addr mono sm" style="user-select:all">${port.address}</div>
        ${port.tradingAddress && port.tradingAddress.toLowerCase() !== (port.address||'').toLowerCase()
          ? `<div class="sm mt" style="opacity:.85">Trading profile: <span class="mono">${sa(port.tradingAddress)}</span></div>` : ''}
        ${port.bio?`<div class="pf-bio">${port.bio}</div>`:''}
      </div>
      <a href="https://polymarket.com/profile/${port.polymarketProfileAddress || port.tradingAddress || port.address}" target="_blank" class="btn btn-ghost btn-sm">polymarket.com ↗</a>
    </div>
    <div class="sg6" style="margin-bottom:18px">
      <div class="sc"><div class="sl">BALANCE</div><div class="sv up">${fmtUSD(port.cashBalance)}</div></div>
      <div class="sc"><div class="sl">PORTFOLIO VALUE</div><div class="sv">${fmtUSD((port.cashBalance||0)+(port.posValue||0))}</div></div>
      <div class="sc"><div class="sl">REALIZED P&L</div><div class="sv ${port.realizedPnl>=0?'up':'dn'}">${fmtPnl(port.realizedPnl)}</div></div>
      <div class="sc"><div class="sl">UNREALIZED P&L</div><div class="sv ${port.unrealizedPnl>=0?'up':'dn'}">${fmtPnl(port.unrealizedPnl)}</div></div>
      <div class="sc"><div class="sl">VOLUME</div><div class="sv">${fmtUSD(port.totalVolume)}</div></div>
      <div class="sc"><div class="sl">TRADES</div><div class="sv">${port.tradesCount||0}</div></div>
    </div>
    <div class="two-col">
      <div class="card"><div class="ctitle mb12">OPEN POSITIONS (${port.posCount})</div>
        ${posTable(port.positions||[])}
      </div>
      <div class="card"><div class="ctitle mb12">RECENT TRADES</div>
        ${trTable((port.recentTrades||[]).slice(0,12))}
      </div>
    </div>`;
}

function posTable(pos) {
  if (!pos.length) return empty('No open positions');
  return `<div class="tscroll"><table class="tbl"><thead><tr><th>Market</th><th>Outcome</th><th>Size</th><th>Avg</th><th>Current</th><th>P&L</th><th>Ends</th><th></th></tr></thead><tbody>
    ${pos.map(p => `<tr>
      <td class="cll">${p.title?.slice(0,52)}</td>
      <td>${chip(p.outcome, p.outcome==='YES'?'yes':'no')}</td>
      <td>${fmtUSD(p.size)}</td>
      <td class="mono">${(p.avgPrice||0).toFixed(3)}</td>
      <td class="mono">${(p.currentPrice||0).toFixed(3)}</td>
      <td class="${p.pnl>=0?'up':'dn'}">${fmtPnl(p.pnl)}</td>
      <td class="sm mt">${fmtD(p.endDate)}</td>
      <td><button class="btn btn-danger btn-sm" onclick="openSell('${p.conditionId}','${esc(p.title)}','${p.outcome}',${p.currentPrice||p.avgPrice||0},${p.size})">SELL</button></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function trTable(tr) {
  if (!tr.length) return empty('No trades yet');
  return `<div class="tscroll"><table class="tbl"><thead><tr><th>Market</th><th>Outcome</th><th>Side</th><th>Price</th><th>Value</th><th>Date</th></tr></thead><tbody>
    ${tr.map(t => `<tr>
      <td class="cll">${t.title?.slice(0,55)}</td>
      <td>${chip(t.outcome, (t.outcome||'').toLowerCase())}</td>
      <td>${chip((t.side||'BUY').toUpperCase(), t.side==='sell'?'sell':'buy')}</td>
      <td class="mono">${(t.price||0).toFixed(4)}</td>
      <td>${fmtUSD(t.usdcValue||t.size)}</td>
      <td class="sm mt">${fmtDT(t.timestamp)}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

// ══════════════════════════════════════════════════════════
// MARKETS
// ══════════════════════════════════════════════════════════
function buildCats() {
  ge('cat-tabs').innerHTML = CATS.map(c =>
    `<button class="cat-tab${c.id==='all'?' active':''}" data-id="${c.id}" onclick="selCat('${c.id}','${c.tag||''}')">
      ${c.icon} ${c.label}
    </button>`).join('');
}
function selCat(id, tag) {
  App.cat = id;
  qsa('.cat-tab').forEach(b => b.classList.toggle('active', b.dataset.id === id));
  loadMarkets(tag || undefined);
}
async function loadMarkets(tag) {
  const search = ge('mkt-search')?.value?.trim() || '';
  ge('mkt-grid').innerHTML = ldr('Loading markets…');
  const params = new URLSearchParams({ limit: 40 });
  const cat = CATS.find(c => c.id === App.cat);
  if (cat?.tag) params.set('tag', cat.tag);
  if (tag)      params.set('tag', tag);
  if (search)   params.set('search', search);
  const mkts = await api(`/markets?${params}`);
  if (!Array.isArray(mkts)) { ge('mkt-grid').innerHTML = errBox(mkts?.error || 'Failed'); return; }
  App.markets = mkts;
  renderMktGrid(mkts);
}
function filterMarkets() { const cat = CATS.find(c => c.id === App.cat); loadMarkets(cat?.tag); }

function renderMktGrid(mkts) {
  if (!mkts.length) { ge('mkt-grid').innerHTML = empty('No markets found'); return; }
  ge('mkt-grid').innerHTML = mkts.slice(0, 40).map(m => `
    <div class="mc" onclick="openModal('${m.id}')">
      ${m.image ? `<img class="mc-img" src="${m.image}" onerror="this.remove()">` : `<div class="mc-ph">${m.category?.slice(0,2)||'📊'}</div>`}
      <div class="mc-body">
        <div class="mc-tags">${m.tags?.slice(0,2).map(t=>`<span class="tag">${t}</span>`).join('')||''}</div>
        <div class="mc-title">${m.title}</div>
        <div class="prob-row"><span class="up fw">YES ${m.yesPct}%</span><span class="dn fw">NO ${m.noPct}%</span></div>
        ${pb(m.yesPct)}
        <div class="mc-meta"><span>24h: ${fmtUSD(m.volume24h)}</span><span>Liq: ${fmtUSD(m.liquidity)}</span></div>
        ${m.endDate?`<div class="mc-end">Ends ${fmtD(m.endDate)}</div>`:''}
        <div class="mc-btns" onclick="event.stopPropagation()">
          <button class="btn btn-yes" onclick="openBuy('${m.id}','${m.slug||m.id}','${esc(m.title)}','YES',${m.yesPrice},${m.yesPct})">BUY YES ${m.yesPct}%</button>
          <button class="btn btn-no"  onclick="openBuy('${m.id}','${m.slug||m.id}','${esc(m.title)}','NO',${m.noPrice},${m.noPct})">BUY NO ${m.noPct}%</button>
        </div>
      </div>
    </div>`).join('');
}

// ── Market Modal ──────────────────────────────────────────
async function openModal(id) {
  ge('modal-body').innerHTML = ldr('Loading market…');
  ge('modal-overlay').classList.remove('hidden');
  const m = await api(`/market/${id}`);
  if (!m || m.error) { ge('modal-body').innerHTML = errBox(m?.error||'Not found'); return; }
  ge('modal-body').innerHTML = `
    <div class="modal-title">${m.title}</div>
    ${m.description?`<div class="modal-desc">${m.description}</div>`:''}
    <div class="prob-row mb12"><span class="up fw" style="font-size:18px">YES ${m.yesPct}%</span><span class="dn fw" style="font-size:18px">NO ${m.noPct}%</span></div>
    ${pb(m.yesPct)}
    <div class="modal-stats">
      <div><div class="sl">24H VOLUME</div><div class="fw">${fmtUSD(m.volume24h)}</div></div>
      <div><div class="sl">LIQUIDITY</div><div class="fw">${fmtUSD(m.liquidity)}</div></div>
      <div><div class="sl">TOTAL VOLUME</div><div class="fw">${fmtUSD(m.volume)}</div></div>
      <div><div class="sl">ENDS</div><div class="fw">${fmtD(m.endDate)}</div></div>
    </div>
    <div class="modal-btns">
      <button class="btn btn-yes" onclick="openBuy('${m.id}','${m.slug||m.id}','${esc(m.title)}','YES',${m.yesPrice},${m.yesPct})">✅ BUY YES — ${m.yesPct}%</button>
      <button class="btn btn-no"  onclick="openBuy('${m.id}','${m.slug||m.id}','${esc(m.title)}','NO',${m.noPrice},${m.noPct})">❌ BUY NO — ${m.noPct}%</button>
      <button class="btn btn-ghost btn-sm" onclick="closeModal();nav('ai');setTimeout(()=>{ge('chat-in').value='Analyze this market: ${esc(m.title)}';sendChat();},150)">🤖 Ask AI</button>
    </div>`;
}
function closeModal() { ge('modal-overlay').classList.add('hidden'); }

// ══════════════════════════════════════════════════════════
// TRADE PANEL
// ══════════════════════════════════════════════════════════
function openBuy(id, slug, title, outcome, price, pct) {
  const bal = App.portfolio?.cashBalance || 0;
  const priceNum = parseFloat(price);
  let probPct = Number.isFinite(parseFloat(pct)) ? Math.round(parseFloat(pct)) : Math.round((Number.isFinite(priceNum) ? priceNum : 0.5) * 100);
  if (!Number.isFinite(probPct) || probPct < 0 || probPct > 100) probPct = Math.round((Number.isFinite(priceNum) ? priceNum : 0.5) * 100);

  ge('tp-market').value = id;
  ge('tp-slug').value   = slug;
  ge('tp-side').value   = 'buy';
  ge('tp-mode-lbl').textContent = 'BUY ORDER';
  ge('tp-title').textContent    = title;
  ge('tp-outcome').textContent  = outcome;
  ge('tp-outcome').className    = `ob ${outcome.toLowerCase()}`;
  ge('tp-prob-txt').textContent = `~${probPct}% implied · $${Number.isFinite(priceNum)?priceNum.toFixed(3):'—'}/share`;
  ge('tp-amt-lbl').textContent  = 'Amount (USDC to spend)';
  ge('tp-btn').textContent      = 'Place Order via Server';
  ge('tp-btn').onclick          = submitTrade;

  // Probability warning — implied chance this outcome wins (the side you clicked)

  if (probPct < 25)       { ge('tp-warn').textContent = `⚠️ HIGH RISK: only ~${probPct}% implied — long-shot`; ge('tp-warn').className = 'pw red'; }
  else if (probPct < 50)  { ge('tp-warn').textContent = `⚠️ Underdog — ~${probPct}% implied`; ge('tp-warn').className = 'pw amber'; }
  else                      { ge('tp-warn').textContent = `✅ ~${probPct}% implied — higher consensus`; ge('tp-warn').className = 'pw green'; }

  ge('tp-bal-line').textContent = bal > 0 ? `Balance: $${bal.toFixed(2)} USDC` : '⚠️ No balance — fund wallet';

  // Preset buttons based on real balance
  const raw = [0.10, 0.25, 0.50, 1.00, 2.00, 5.00, 10.00].filter(v => v <= bal);
  const presets = bal > 0.10 ? [...raw.slice(0,4), bal].filter((v,i,a) => a.indexOf(v) === i) : [];
  ge('tp-presets').innerHTML = presets.map(v =>
    `<button class="preset-btn" onclick="setAmt(${v})">${v===bal?`All ($${bal.toFixed(2)})`:`$${v.toFixed(2)}`}</button>`
  ).join('');

  ge('tp-amt').value = '';   // Always blank — user types their own amount
  ge('tp-result').innerHTML = '';
  updateCLI();
  ge('tp').classList.remove('hidden');
  closeModal();
}

function openSell(id, title, outcome, currentPrice, maxSize) {
  ge('tp-market').value = id;
  ge('tp-slug').value   = App.markets.find(m=>m.id===id)?.slug || id;
  ge('tp-side').value   = 'sell';
  ge('tp-mode-lbl').textContent = 'SELL ORDER';
  ge('tp-title').textContent    = `SELL: ${title}`;
  ge('tp-outcome').textContent  = outcome;
  ge('tp-outcome').className    = 'ob sell';
  ge('tp-prob-txt').textContent = `Selling at $${parseFloat(currentPrice).toFixed(3)}/share · Hold: ${parseFloat(maxSize).toFixed(2)} shares`;
  ge('tp-warn').textContent     = '⚠️ Selling closes your position. You receive USDC back.';
  ge('tp-warn').className       = 'pw amber';
  ge('tp-amt-lbl').textContent  = 'Shares to sell';
  ge('tp-btn').textContent      = 'Sell via Server';
  ge('tp-btn').onclick          = submitSell;
  ge('tp-bal-line').textContent = `Max: ${parseFloat(maxSize).toFixed(2)} shares`;

  const sz = parseFloat(maxSize);
  ge('tp-presets').innerHTML = [0.25,0.50,1.0].map(r => {
    const v = Math.max(0.10, (sz*r).toFixed(2));
    return `<button class="preset-btn" onclick="setAmt(${v})">${(r*100).toFixed(0)}% (${v})</button>`;
  }).join('') + `<button class="preset-btn" onclick="setAmt(${sz.toFixed(2)})">All</button>`;

  ge('tp-amt').value = sz.toFixed(2);
  ge('tp-result').innerHTML = '';
  updateCLI();
  ge('tp').classList.remove('hidden');
}

function closeTP() { ge('tp').classList.add('hidden'); ge('tp-amt').value=''; ge('tp-result').innerHTML=''; }
function setAmt(v) { ge('tp-amt').value = parseFloat(v).toFixed(2); updateCLI(); }
function onAmtChange() { updateCLI(); }

function updateCLI() {
  const id      = ge('tp-market').value || '';
  const slug    = ge('tp-slug').value || '';
  const outcome = ge('tp-outcome').textContent.replace('SELL: ','');
  const amt     = ge('tp-amt').value || '[amount]';
  const side    = ge('tp-side').value || 'buy';
  ge('tp-cli').textContent = `${side.toUpperCase()} ${outcome} · market ${id}${slug && slug !== id ? ` · slug ${slug}` : ''} · ${amt} USDC`;
}

function copyCLI() {
  const t = ge('tp-cli').textContent;
  navigator.clipboard.writeText(t).then(() => toast('Copied to clipboard','ok')).catch(() => {});
}

// ── Submit BUY ─────────────────────────────────────────────
async function submitTrade() {
  const id      = ge('tp-market').value;
  const slug    = ge('tp-slug').value;
  const outcome = ge('tp-outcome').textContent;
  const amt     = parseFloat(ge('tp-amt').value);
  const bal     = App.portfolio?.cashBalance || 0;
  const btn     = ge('tp-btn');

  // Validation
  if (!id || !outcome)         { toast('No market selected','err'); return; }
  if (!ge('tp-amt').value)     { toast('Please enter an amount','err'); ge('tp-amt').focus(); return; }
  if (isNaN(amt) || amt < 0.10){ toast('Minimum amount is $0.10','err'); return; }
  if (bal > 0 && amt > bal)    { toast(`$${amt.toFixed(2)} exceeds balance $${bal.toFixed(2)}`,'err'); return; }
  if (bal > 1 && amt > bal*0.75) {
    if (!confirm(`Betting $${amt.toFixed(2)} = ${Math.round(amt/bal*100)}% of your $${bal.toFixed(2)} balance. Continue?`)) return;
  }

  // Final confirmation
  const pm = ge('tp-prob-txt').textContent.match(/(\d+)%/);
  const pct = pm ? pm[1] : '—';
  if (!confirm(`CONFIRM ORDER\n\n${ge('tp-title').textContent}\nBuy: ${outcome} (~${pct}% implied)\nAmount: $${amt.toFixed(2)} USDC\n\nClick OK to submit.`)) return;

  btn.disabled = true; btn.innerHTML = `<div class="sp sp-sm"></div> Placing order…`;
  ge('tp-result').innerHTML = '';

  const r = await api('/trade', 'POST', {
    marketId: id, slug, outcome, side: 'buy',
    amount: amt, title: ge('tp-title').textContent,
  });

  if (r.error) {
    toast('❌ '+r.error,'err');
    ge('tp-result').innerHTML = errBox(r.error);
  } else {
    const msg = r.simulated ? `✅ Order signed! ID: ${r.orderId?.slice(0,16)}` : `🎉 Live! Order: ${r.orderId?.slice(0,16)}`;
    toast(msg, 'ok');
    ge('tp-result').innerHTML = `<div class="notice ok" style="font-size:11px;margin:0">${msg}${r.note?'<br><span class="sm">'+r.note+'</span>':''}</div>`;
    ge('tp-amt').value = '';
    api('/portfolio').then(p => { App.portfolio = p; }).catch(() => {});
  }
  btn.disabled = false; btn.innerHTML = 'Place Order via Server';
}

// ── Submit SELL ────────────────────────────────────────────
async function submitSell() {
  const id      = ge('tp-market').value;
  const slug    = ge('tp-slug').value;
  const outcome = ge('tp-outcome').textContent;
  const shares  = parseFloat(ge('tp-amt').value);
  const btn     = ge('tp-btn');

  if (!shares || shares < 0.10) { toast('Enter shares to sell (min 0.10)','err'); return; }

  const price = ge('tp-prob-txt').textContent.match(/\$([\d.]+)/)?.[1] || '0';
  const estReturn = (shares * parseFloat(price)).toFixed(2);
  if (!confirm(`CONFIRM SELL\n\n${ge('tp-title').textContent.replace('SELL: ','')}\nSelling: ${shares.toFixed(2)} ${outcome} shares\nEst. return: ~$${estReturn} USDC\n\nClick OK to submit.`)) return;

  btn.disabled = true; btn.innerHTML = `<div class="sp sp-sm"></div> Submitting…`;
  const r = await api('/trade', 'POST', {
    marketId: id, slug, outcome, side: 'sell',
    amount: shares, title: ge('tp-title').textContent,
  });

  if (r.error) { toast('❌ '+r.error,'err'); }
  else         { toast(`✅ Sell placed! ${r.orderId?.slice(0,16)}`,'ok'); closeTP(); }
  btn.disabled = false; btn.innerHTML = 'Sell via Server';
}

// ══════════════════════════════════════════════════════════
// LEADERBOARD
// ══════════════════════════════════════════════════════════
async function loadLB() {
  ge('lb-content').innerHTML = ldr('Loading leaderboard…');
  const lb = await api('/leaderboard?limit=25');
  if (!Array.isArray(lb)) { ge('lb-content').innerHTML = errBox(lb?.error||'Failed'); return; }
  App.leaderboard = lb;
  const medals = ['🥇','🥈','🥉'];
  ge('lb-content').innerHTML = `
    <div class="card mb16">
      <div class="ctitle mb16">🏆 ALL-TIME LEADERBOARD</div>
      <div class="tscroll"><table class="tbl"><thead><tr>
        <th>Rank</th><th>Trader</th><th>Profit</th><th>ROI</th><th>Win %</th><th>Trades</th><th>Volume</th><th>Actions</th>
      </tr></thead><tbody>
        ${lb.map((t,i) => `<tr>
          <td class="rn">${medals[i]||'#'+(i+1)}</td>
          <td><div class="tc">
            ${t.avatar?`<img class="tav" src="${t.avatar}" onerror="this.remove()">`:
              `<div class="tav-ph">${(t.name||'?')[0].toUpperCase()}</div>`}
            <div><div class="fw sm">${(t.name||sa(t.address)).slice(0,20)}</div>
            <div class="mono sm mt">${sa(t.address)}</div></div>
          </div></td>
          <td class="${t.profit>=0?'up':'dn'} fw">${fmtPnl(t.profit)}</td>
          <td class="${t.roi>=0?'up':'dn'}">${t.roi?.toFixed(1)||'—'}%</td>
          <td>${t.winRate?t.winRate.toFixed(0)+'%':'—'}</td>
          <td>${t.trades||'—'}</td>
          <td>${fmtUSD(t.volume)}</td>
          <td style="display:flex;gap:5px;flex-wrap:wrap">
            <button class="btn btn-accent btn-sm" onclick="loadTrader('${t.address}','${esc(t.name||t.address.slice(0,8))}')">📋 Trades</button>
            <button class="btn btn-ghost btn-sm" onclick="nav('ai');setTimeout(()=>{ge('chat-in').value='What do you know about this Polymarket trader and their strategy: ${sa(t.address)}';sendChat();},150)">🤖 AI</button>
          </td>
        </tr>`).join('')}
      </tbody></table></div>
    </div>
    <div id="trader-panel" class="mt16"></div>`;
}

async function loadTrader(addr, name) {
  const panel = ge('trader-panel');
  panel.innerHTML = ldr(`Loading ${name}'s trades…`);
  const data = await api(`/trader/${addr}?limit=20`);
  if (data.error) { panel.innerHTML = errBox(data.error); return; }
  const { profile, activity } = data;

  panel.innerHTML = `<div class="card" style="border-color:rgba(20,184,166,.2)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px">
      <div>
        <div class="ctitle">📋 ${name}</div>
        <div class="sm mt mono">${addr}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        ${profile?.realizedPnl!==undefined?`<span class="${profile.realizedPnl>=0?'up':'dn'} fw">P&L: ${fmtPnl(profile.realizedPnl)}</span>`:''}
        <a href="https://polymarket.com/profile/${addr}" target="_blank" class="btn btn-ghost btn-sm">Profile ↗</a>
      </div>
    </div>
    ${!activity?.length ? empty('No recent trades') : `
      <div class="tscroll"><table class="tbl"><thead><tr>
        <th>Market</th><th>Outcome</th><th>Side</th><th>Price</th><th>Size</th><th>Date</th><th>Copy</th>
      </tr></thead><tbody>
        ${activity.map(t => `<tr>
          <td class="cll">${(t.title||t.market||'').slice(0,55)}</td>
          <td>${chip(t.outcome,(t.outcome||'').toLowerCase())}</td>
          <td>${chip((t.side||'BUY').toUpperCase(),t.side==='sell'?'sell':'buy')}</td>
          <td class="mono">${(t.price||0).toFixed(3)}</td>
          <td>${fmtUSD(t.size)}</td>
          <td class="sm mt">${fmtD(t.timestamp)}</td>
          <td>
            <button class="btn btn-accent btn-sm" onclick="copyTrade('${t.market}','${esc(t.title||t.market)}','${t.outcome}',${t.price||0},${t.size||1})">COPY</button>
          </td>
        </tr>`).join('')}
      </tbody></table></div>`}
  </div>`;
  panel.scrollIntoView({ behavior:'smooth' });
}

function copyTrade(id, title, outcome, price, sz) {
  const bal     = App.portfolio?.cashBalance || 0;
  const orig    = parseFloat(sz || 0);
  const maxSafe = bal > 0 ? Math.min(bal * 0.30, 10) : 1;
  const suggested = orig > 0 ? Math.min(orig, maxSafe) : Math.min(1, maxSafe);
  const slug    = App.markets.find(m => m.id === id)?.slug || id;
  openBuy(id, slug, title, outcome, price, Math.round(parseFloat(price)*100));
  ge('tp-amt').value = Math.max(0.10, Math.round(suggested * 100) / 100).toFixed(2);
  updateCLI();
}

// ══════════════════════════════════════════════════════════
// TRADE HISTORY
// ══════════════════════════════════════════════════════════
async function loadTrades() {
  ge('trades-content').innerHTML = ldr('Loading trade history…');
  const port = await api('/portfolio');
  if (port.error) { ge('trades-content').innerHTML = errBox(port.error); return; }
  if (port.walletConfigured === false) {
    ge('trades-content').innerHTML =
      `<div class="notice warn mb12">Add <code>PRIVATE_KEY</code> to <code>.env</code> to load your trade history from Polymarket.</div>` +
      empty('No trades to show');
    return;
  }
  const tr = port.recentTrades || [];
  if (!tr.length) { ge('trades-content').innerHTML = empty('No trades on this wallet'); return; }
  ge('trades-content').innerHTML = `<div class="tscroll"><table class="tbl"><thead><tr>
    <th>Market</th><th>Outcome</th><th>Side</th><th>Price</th><th>Value</th><th>Date</th><th>Tx</th>
  </tr></thead><tbody>
    ${tr.map(t => `<tr>
      <td class="cll">${(t.title||t.market||'').slice(0,60)}</td>
      <td>${chip(t.outcome,(t.outcome||'').toLowerCase())}</td>
      <td>${chip((t.side||'BUY').toUpperCase(),t.side==='sell'?'sell':'buy')}</td>
      <td class="mono">${(t.price||0).toFixed(4)}</td>
      <td>${fmtUSD(t.usdcValue||t.size)}</td>
      <td class="sm mt">${fmtDT(t.timestamp)}</td>
      <td>${t.txHash?`<a href="https://polygonscan.com/tx/${t.txHash}" target="_blank" class="txl">↗</a>`:'—'}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

// ══════════════════════════════════════════════════════════
// AI CHAT
// ══════════════════════════════════════════════════════════
function initChat() {
  if (!ge('chat-msgs').children.length) addWelcome();
}
function clearChat() { ge('chat-msgs').innerHTML = ''; addWelcome(); }
function addWelcome() {
  const bal = App.portfolio?.cashBalance || 0;
  addMsg('assistant', `👋 **AI Trading Assistant**\n\nI analyze markets and **suggest trades** — you confirm each one before it's placed.\n\nYour balance: **$${bal.toFixed(2)} USDC**\n\nTry:\n• *"Show me IPL cricket markets"*\n• *"Buy $1 on MI winning"*\n• *"What's the best $1 bet right now?"*\n• *"Find Bitcoin price markets"*`);
}

function addMsg(role, text, extras={}) {
  const box = ge('chat-msgs');
  const div = document.createElement('div');
  div.className = `cmsg ${role}`;
  const html = text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^>\s*(.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n/g, '<br>');
  div.innerHTML = `<div class="cbub"><div>${text==='…'?'<div class="dots"><span></span><span></span><span></span></div>':html}</div>
    ${extras.action==='CONFIRM_TRADE'&&extras.proposal?`
      <div class="chat-acts">
        <button class="btn btn-success btn-sm" onclick="confirmAITrade()">✅ Confirm — Place Order</button>
        <button class="btn btn-danger btn-sm"  onclick="cancelAITrade()">✗ Cancel</button>
      </div>`:''}</div>`;
  box.querySelector('.cmsg.assistant:last-child .cbub .dots')?.closest('.cmsg')?.remove();
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendChat() {
  const inp = ge('chat-in');
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = '';
  addMsg('user', msg);
  addMsg('assistant', '…');
  const r = await api('/ai/analyze', 'POST', { message: msg });
  if (r.error) { addMsg('assistant', `❌ ${r.error}`); return; }
  if (r.proposal) App.pendingTrade = r.proposal;
  addMsg('assistant', r.text || 'Done.', { action: r.action, proposal: r.proposal });
}

function qp(text) { ge('chat-in').value = text; sendChat(); }

async function confirmAITrade() {
  if (!App.pendingTrade) return;
  const t = App.pendingTrade; App.pendingTrade = null;
  addMsg('assistant', `🚀 Placing order: **${t.side?.toUpperCase()||'BUY'} ${t.outcome}** $${t.amount} on "${t.title}"…`);
  const r = await api('/trade', 'POST', {
    marketId: t.marketId, slug: t.slug,
    outcome: t.outcome, side: t.side||'buy',
    amount: t.amount, title: t.title,
  });
  if (r.error) addMsg('assistant', `❌ Failed: ${r.error}`);
  else addMsg('assistant', r.simulated
    ? `✅ **Order signed!** ID: \`${r.orderId?.slice(0,16)}\`\n> Needs USDC balance to execute on-chain.`
    : `🎉 **Trade live!** Order: \`${r.orderId?.slice(0,16)}\` — Status: ${r.status}`);
}

function cancelAITrade() {
  App.pendingTrade = null;
  addMsg('assistant', '🚫 Trade cancelled. Let me know if you want to look at something else!');
}

// ══════════════════════════════════════════════════════════
// AUTO BOT
// ══════════════════════════════════════════════════════════
async function refreshBot() {
  const s = await api('/bot/status');
  ge('bot-dot').className = `bot-dot${s.running?' on':''}`;
  ge('bot-lbl').textContent = s.running ? 'RUNNING' : 'STOPPED';
  ge('bot-cycle').textContent = s.lastCycle ? `Last cycle: ${fmtDT(s.lastCycle)}` : '';
  ge('bot-start').disabled  = s.running;
  ge('bot-stop').disabled   = !s.running;

  const pnl = s.pnl || {};
  ge('r-today').textContent = `${pnl.todayTrades||0}/${(pnl.todayTrades||0)+(pnl.dailyRemaining||4)}`;
  const sp = pnl.realizedPnl || 0;
  ge('r-spnl').textContent  = fmtPnl(sp); ge('r-spnl').className = 'sv mono '+(sp>=0?'up':'dn');
  ge('r-wr').textContent    = pnl.winRate ? pnl.winRate+'%' : '—';

  // Exposure
  if (App.portfolio) {
    const exp = App.portfolio.posValue || 0;
    ge('r-exp').textContent = fmtUSD(exp);
  }

  // Target markets list
  if (s.targetMarkets?.length) {
    ge('target-list').textContent = `Watching: ${s.targetMarkets.map(id=>id.slice(0,12)+'…').join(', ')}`;
  }

  renderBotLog(s.logs || []);
  renderBotTrades(s.trades || []);
}

function renderBotLog(logs) {
  const el = ge('bot-log'); if (!el) return;
  if (!logs.length) { el.innerHTML = '<span class="sm mt">No activity yet…</span>'; return; }
  el.innerHTML = logs.slice(0,60).map(l => {
    const ts = new Date(l.time).toLocaleTimeString();
    const c  = l.level==='error'?'dn':l.msg.includes('✅')||l.msg.includes('🎉')?'up':'';
    return `<div class="lr"><span class="lts">${ts}</span><span class="${c}">${l.msg}</span></div>`;
  }).join('');
}

function renderBotTrades(trades) {
  const el = ge('bot-trades'); if (!el) return;
  if (!trades.length) { el.innerHTML = empty('No auto-trades yet'); return; }
  el.innerHTML = `<div class="tscroll"><table class="tbl"><thead><tr>
    <th>Market</th><th>Outcome</th><th>Amount</th><th>Price</th><th>Score</th><th>Source</th><th>Status</th><th>Time</th>
  </tr></thead><tbody>
    ${trades.map(t => `<tr>
      <td class="cl">${(t.title||t.market||'').slice(0,44)}</td>
      <td>${chip(t.outcome,(t.outcome||'').toLowerCase())}</td>
      <td>${fmtUSD(t.amount||0)}</td>
      <td class="mono">${(t.price||0).toFixed(3)}</td>
      <td>${bdg(t.aiScore||0)}</td>
      <td><span class="chip chip-buy">${(t.source||'clob_v2').replace(/_/g,' ')}</span></td>
      <td>${t.simulated?chip('SIGNED','sim'):chip('LIVE','live')}</td>
      <td class="sm mt">${fmtD(t.recordedAt||t.cycleAt)}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

async function startBot() {
  const r = await api('/bot/start', 'POST', {
    dailyLimit:   parseInt(ge('b-daily').value)    || 4,
    maxBudgetPct: parseInt(ge('b-budget').value)   || 20,
    maxExposure:  parseInt(ge('b-exposure').value)  || 60,
    stopLoss:     parseInt(ge('b-stoploss').value)  || 50,
    minScore:     parseInt(ge('b-score').value)    || 55,
  });
  if (r.error) toast('❌ '+r.error,'err');
  else { toast('🤖 Bot started!','ok'); refreshBot(); }
}

async function stopBot() {
  await api('/bot/stop','POST');
  toast('Bot stopped','warn');
  refreshBot();
}

async function addTarget() {
  const id = ge('target-id').value.trim();
  if (!id) return;
  await api('/bot/target','POST',{conditionId:id});
  ge('target-id').value = '';
  toast('Target market added','ok');
  refreshBot();
}

// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
async function loadSettings() {
  checkStatus();
  const port = App.portfolio || await api('/portfolio');
  const el   = ge('settings-account');
  if (!port || port.error) { el.innerHTML = empty('Could not load account'); return; }
  App.portfolio = port;
  if (port.walletConfigured === false) {
    el.innerHTML =
      `<div class="notice warn mb12">No wallet on the server — add <code>PRIVATE_KEY</code> to <code>.env</code> to link your Polymarket account here.</div>` +
      empty('Account not connected');
    return;
  }
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
      <div class="av" style="width:48px;height:48px">
        ${port.avatar?`<img src="${port.avatar}" onerror="this.style.display='none'">` : ''}
        <span class="av-l" style="font-size:20px">${(port.username||port.address||'?')[0].toUpperCase()}</span>
      </div>
      <div>
        <div class="fw">${port.username||'Anonymous'}</div>
        <div class="mono sm mt" style="user-select:all">${port.address}</div>
      </div>
      <a href="https://polymarket.com/profile/${port.polymarketProfileAddress || port.tradingAddress || port.address}" target="_blank" class="btn btn-ghost btn-sm">polymarket.com ↗</a>
    </div>
    <div class="sg4" style="margin-top:12px;margin-bottom:0">
      <div class="sc"><div class="sl">BALANCE</div><div class="sv up">${fmtUSD(port.cashBalance)}</div></div>
      <div class="sc"><div class="sl">REALIZED P&L</div><div class="sv ${port.realizedPnl>=0?'up':'dn'}">${fmtPnl(port.realizedPnl)}</div></div>
      <div class="sc"><div class="sl">UNREALIZED P&L</div><div class="sv ${port.unrealizedPnl>=0?'up':'dn'}">${fmtPnl(port.unrealizedPnl)}</div></div>
      <div class="sc"><div class="sl">TOTAL TRADES</div><div class="sv">${port.tradesCount||0}</div></div>
    </div>`;
}

async function saveClaudeKey() {
  const k = ge('ck-input').value.trim();
  const r = await api('/settings/claude-key','POST',{key:k});
  toast(r.ok ? (k?'✅ Claude key saved':'🗑 Key cleared') : '❌ Failed', r.ok?(k?'ok':'warn'):'err');
}

async function saveRisk() {
  const r = await api('/settings/risk','POST',{
    dailyLimit:     parseInt(ge('s-daily').value),
    maxBudgetPct:   parseInt(ge('s-budget').value),
    maxExposurePct: parseInt(ge('s-exposure').value),
    stopLossPct:    parseInt(ge('s-stoploss').value),
    minScore:       parseInt(ge('s-score').value),
  });
  toast(r.ok ? '✅ Risk settings saved' : '❌ Failed', r.ok?'ok':'err');
  // Sync bot page fields
  if (r.ok) checkStatus();
}

// ── Toast ─────────────────────────────────────────────────
function toast(msg, type='ok') {
  const t = ge('toast'); t.textContent=msg; t.className=`toast show ${type}`;
  setTimeout(() => t.classList.remove('show'), 3500);
}
