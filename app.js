import { scenarioKey, DEFAULT_SCENARIO } from './src/report.js';
import { allocate, MIN_TRANSFER, PLATFORMS } from './src/sim.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const usd = (x, d = 2) => (x == null || !Number.isFinite(x) ? '–' : x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (x, d = 1) => (x == null ? '–' : (100 * x).toFixed(d) + '%');
const LS = 'photonpay.smart-transfer-in.v1';
const icons = () => window.lucide && window.lucide.createIcons();

// ---------- state ----------
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
const state = {
  route: 'regular', sc: { ...DEFAULT_SCENARIO, ...(saved.sc || {}) }, card: null, plan: false, step: 1,
  q: '', risk: 'all', tab: 'all', page: 1, applied: saved.applied || {}, history: saved.history || [],
  edits: {}, deselected: {}, funding: saved.funding ?? 150000, result: null, pre: null, reqId: 0, busy: false,
};
function readHash() {
  const [path, qs] = location.hash.replace(/^#\/?/, '').split('?');
  state.route = path === 'smart' ? 'smart' : 'regular';
  const p = new URLSearchParams(qs || '');
  if (p.has('target')) { const t = Number(p.get('target')); if (t > 0.8 && t < 1) state.sc.alpha = Math.round((1 - t) * 1000) / 1000; }
  if (['daily', 'twice-weekly'].includes(p.get('cadence'))) state.sc.cadence = p.get('cadence');
  state.card = p.has('card') ? Number(p.get('card')) : null;
  state.plan = p.get('plan') === '1';
  if (p.has('risk')) state.risk = p.get('risk');
  if (p.has('q')) state.q = p.get('q');
}
function writeHash() {
  const p = new URLSearchParams({ target: (1 - state.sc.alpha).toFixed(3), cadence: state.sc.cadence });
  if (state.card != null) p.set('card', state.card);
  if (state.plan) p.set('plan', '1');
  if (state.risk !== 'all') p.set('risk', state.risk);
  if (state.q) p.set('q', state.q);
  history.replaceState(null, '', `#/${state.route}?${p}`);
  localStorage.setItem(LS, JSON.stringify({ sc: state.sc, applied: state.applied, history: state.history, funding: state.funding }));
}

// ---------- worker ----------
let worker = null;
try { worker = new Worker('./worker.js', { type: 'module' }); } catch { worker = null; }
const pending = new Map();
if (worker) worker.onmessage = (e) => { const cb = pending.get(e.data.id); if (cb) { pending.delete(e.data.id); cb(e.data); } };
function run(sc) {
  const key = scenarioKey(sc);
  if (state.pre && state.pre.scenarios[key]) return Promise.resolve({ ok: true, result: state.pre.scenarios[key] });
  if (!worker) return import('./src/report.js').then((m) => ({ ok: true, result: m.runScenario(sc) }));
  const id = ++state.reqId;
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ id, scenario: sc }); });
}

// ---------- helpers ----------
function toast(msg, ok = true) { const t = $('#toast'); t.innerHTML = `<i data-lucide="${ok ? 'circle-check' : 'circle-alert'}" style="color:${ok ? 'var(--success)' : 'var(--danger)'}"></i>${msg}`; icons(); t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 2400); }
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const interp = (curve, a) => { if (a <= curve[0][0]) return curve[0][1]; for (let i = 1; i < curve.length; i++) if (a <= curve[i][0]) { const [x0, y0] = curve[i - 1], [x1, y1] = curve[i]; return y0 + ((y1 - y0) * (a - x0)) / Math.max(1e-9, x1 - x0); } return curve[curve.length - 1][1]; };
const appliedKey = () => scenarioKey(state.sc);
const appliedFor = (id) => (state.applied[appliedKey()] || {})[id] || 0;
function riskOf(p) { return p >= 0.2 ? { cls: 'bad', label: 'High', col: 'var(--danger)' } : p >= 0.05 ? { cls: 'warn', label: 'Medium', col: 'var(--warning)' } : { cls: 'ok', label: 'Low', col: 'var(--success)' }; }
function rows() {
  const r = state.result, P = r.plan;
  return P.cards.map((pc) => {
    const c = r.fleet.cards[pc.id];
    const applied = appliedFor(pc.id);
    const bal = pc.bal + applied;
    const p = interp(pc.curve, applied);
    const etaH = pc.rate > 0 ? Math.max(0, ((pc.threshold - pc.unbilled) / pc.rate) * 24) : null;
    return { ...pc, c, applied, balNow: bal, risk: p, rk: riskOf(p), etaH, rec: Math.max(0, pc.amt - applied) };
  });
}
function filtered() {
  return rows().filter((x) => (!state.q || (x.c.cardNo + ' ' + x.c.nickname).toLowerCase().includes(state.q.toLowerCase()))
    && (state.risk === 'all' || x.rk.cls === state.risk) && (state.tab !== 'disabled'));
}
const platIcon = (p) => (p === 'meta' ? '<i style="background:#0866ff">f</i>' : '<i style="background:#fbbc04;color:#121212">G</i>');

// ---------- pages ----------
function render() {
  $$('.tabs a').forEach((a) => a.classList.toggle('on', a.dataset.route === state.route));
  $$('.tabs a').forEach((a) => a.setAttribute('aria-selected', a.dataset.route === state.route));
  document.title = `Issuing · ${state.route === 'smart' ? 'Smart transfer-in' : 'Regular card'} · PhotonPay`;
  if (state.route === 'smart') renderSmart(); else renderRegular();
  icons();
  if (state.card != null) openCard(state.card, false); else closeCard(false);
  if (state.plan) openPlan(false);
}

function renderRegular() {
  const r = state.result, P = r.plan, rs = rows();
  const todo = rs.filter((x) => x.rec > 0);
  const total = todo.reduce((a, x) => a + x.rec, 0);
  const high = rs.filter((x) => x.rk.cls === 'bad').length;
  const avoided = rs.reduce((a, x) => a + Math.max(0, x.risk - interp(x.curve, x.applied + x.rec)), 0);
  const totalBal = rs.reduce((a, x) => a + x.balNow, 0);
  const daily = r.fleet.cards.reduce((a, c) => a + c.avgDaily, 0);
  const list = filtered();
  const per = 10, pages = Math.max(1, Math.ceil(list.length / per));
  state.page = Math.min(state.page, pages);
  const slice = list.slice((state.page - 1) * per, state.page * per);
  const spark = r.traces.length ? sparkPath(r.traces.reduce((acc, t) => t.charges.map((v, i) => (acc[i] || 0) + v), []).slice(-30)) : '';
  $('#page').innerHTML = `
  <div class="sum">
    <div class="box bal">
      <div class="pcard"><i>PHOTONPAY</i></div>
      <div><div class="kv-t">Available balance <i data-lucide="info"></i></div>
        <div class="big">${usd(totalBal)}<small>USD</small> <i data-lucide="chevron-down" style="width:12px;height:12px;vertical-align:middle"></i></div>
        <button class="lnk" id="openBatch">Batch transfer in</button></div>
      <div style="text-align:right"><div class="kv-t" style="justify-content:flex-end">Available Cards</div><div class="big">${rs.length}</div></div>
    </div>
    <div class="box">
      <div style="display:flex;justify-content:space-between"><div class="kv-t">Transaction amount(USD) <i data-lucide="info"></i></div><div class="seg2"><button class="on">By day</button><button>By month</button></div></div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:20px;align-items:end">
        <div><div class="big">${usd(daily, 0)}</div><button class="lnk">View more</button></div>
        <svg viewBox="0 0 300 50" style="width:100%;height:56px" aria-label="Charges, last 30 days"><path d="${spark}" fill="none" stroke="#ffbf00" stroke-width="2"/></svg>
      </div>
    </div>
  </div>
  <div class="updated">Last updated ${dateAt(P.h)} 10:00:00 <i data-lucide="rotate-cw" style="width:12px;height:12px;vertical-align:-1px"></i></div>
  <div class="banner" id="banner"></div>
  <section class="smart" aria-label="Smart transfer-in">
    <div class="badge"><i data-lucide="sparkles"></i></div>
    <div>
      <h3>Smart transfer-in <span class="pill ${todo.length ? 'warn' : 'ok'}">${todo.length ? `${todo.length} cards to fund today` : 'All cards funded'}</span></h3>
      <p>Each card gets enough for its ad platform's next billing charges until the next run (${state.sc.cadence === 'daily' ? 'daily 10:00 HKT' : 'Mon and Thu 10:00 HKT'}), sized so that ${pct(1 - state.sc.alpha, 1)} of card-days stay decline-free.</p>
      <div class="stats">
        <div><b>${usd(total, 0)} USD</b><span>recommended transfer in</span></div>
        <div><b style="color:${high ? 'var(--danger)' : 'var(--text)'}">${high}</b><span>cards at high decline risk</span></div>
        <div><b>${avoided.toFixed(1)}</b><span>expected declines avoided today</span></div>
        <div><b>${pct(r.headline.realizedDeclineFree, 1)}</b><span>decline-free card-days in backtest</span></div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <button class="btn primary" id="review" ${todo.length ? '' : 'disabled'}><i data-lucide="wand-sparkles"></i>Review plan</button>
      <a class="lnk" href="#/smart" style="text-align:center;margin:0">How it's sized</a>
    </div>
  </section>
  <div class="stabs"><a class="${state.tab === 'all' ? 'on' : ''}" data-tab="all">All <sup>${rs.length}</sup></a><a class="${state.tab === 'active' ? 'on' : ''}" data-tab="active">Active <sup>${rs.length}</sup></a><a class="${state.tab === 'disabled' ? 'on' : ''}" data-tab="disabled">Disabled <sup>0</sup></a><span class="sp"></span><button class="btn primary"><i data-lucide="plus"></i>Create card</button></div>
  <div class="filters">
    <label class="inp"><i data-lucide="search" style="width:15px;height:15px"></i>Last 4 Digits <i data-lucide="chevron-down" style="width:12px;height:12px"></i><input id="q" value="${state.q}" placeholder="" aria-label="Search card number or nickname"/></label>
    <span class="inp sel">Card creation time <i data-lucide="chevron-down" style="width:12px;height:12px"></i></span>
    <span class="inp sel hide-md">Card status <i data-lucide="chevron-down" style="width:12px;height:12px"></i></span>
    <span class="inp sel hide-md">Scheme <i data-lucide="chevron-down" style="width:12px;height:12px"></i></span>
    <span class="inp sel">Currency <i data-lucide="chevron-down" style="width:12px;height:12px"></i></span>
    <select class="inp sel ${state.risk !== 'all' ? 'on' : ''}" id="riskSel" aria-label="Decline risk filter" style="padding-right:6px"><option value="all">Decline risk</option><option value="bad">High</option><option value="warn">Medium</option><option value="ok">Low</option></select>
    <span class="sp"></span><button class="sqbtn" id="exportCsv" title="Export plan (E)" aria-label="Export plan as CSV"><i data-lucide="download"></i></button><button class="sqbtn" aria-label="Column settings"><i data-lucide="settings-2"></i></button>
  </div>
  ${slice.length ? `<table aria-label="Regular cards"><thead><tr><th><span class="cb"></span></th><th>Card number / nickname</th><th>Platform</th><th class="num">Card amount</th><th>Next charge</th><th>Decline risk</th><th class="num">Smart transfer in</th><th>Card status</th><th class="hide-md">Card currency</th><th>Action</th></tr></thead><tbody>
  ${slice.map((x) => `<tr data-id="${x.id}" class="${state.card === x.id ? 'sel' : ''}"><td><span class="cb"></span></td><td>${x.c.cardNo}<span class="mc"></span><span class="nick">${x.c.nickname}</span></td><td><span class="plat">${platIcon(x.c.platform)}${PLATFORMS[x.c.platform].label}</span></td><td class="num">${usd(x.balNow)} USD</td><td>${x.pending > 0 ? '<span class="pill bad">Declined, retrying</span>' : `$${x.threshold} ${x.etaH == null ? '' : `<span class="nick" style="display:inline">${x.etaH < 0.5 ? 'due now' : 'in ' + (x.etaH < 24 ? Math.round(x.etaH) + ' h' : (x.etaH / 24).toFixed(1) + ' d')}</span>`}`}</td><td><div class="risk"><span class="pill ${x.rk.cls}" style="width:max-content">${x.rk.label} · ${pct(x.risk, 1)}</span></div></td><td class="num">${x.rec > 0 ? `${usd(x.rec, 0)} USD` : `<span style="color:var(--text-3);font-weight:400">${x.applied ? 'Funded' : '–'}</span>`}</td><td><span class="pill ok"><i data-lucide="circle-check"></i>Normal</span></td><td class="hide-md">USD</td><td><span class="act" data-act="transfer">Transfer in</span><span class="act hide-md">Edit nickname</span><i data-lucide="ellipsis" style="vertical-align:middle"></i></td></tr>`).join('')}
  </tbody></table>
  <div class="pager">Total ${list.length} <span class="inp sel" style="height:30px">10/page <i data-lucide="chevron-down" style="width:12px;height:12px"></i></span><span class="pg" data-pg="prev">‹</span>${Array.from({ length: pages }, (_, i) => `<span class="pg ${state.page === i + 1 ? 'on' : ''}" data-pg="${i + 1}">${i + 1}</span>`).join('')}<span class="pg" data-pg="next">›</span></div>`
  : `<div class="empty"><i data-lucide="credit-card"></i><br>No cards match these filters. <button class="lnk" id="clearF">Clear filters</button></div>`}
  ${footer()}`;
  $('#q') && ($('#q').oninput = (e) => { state.q = e.target.value; state.page = 1; writeHash(); renderRegular(); icons(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); });
  $('#riskSel').value = state.risk;
  $('#riskSel').onchange = (e) => { state.risk = e.target.value; state.page = 1; writeHash(); renderRegular(); icons(); };
  $('#clearF') && ($('#clearF').onclick = () => { state.q = ''; state.risk = 'all'; writeHash(); renderRegular(); icons(); });
  $$('.stabs a').forEach((a) => (a.onclick = () => { state.tab = a.dataset.tab; renderRegular(); icons(); }));
  $$('.pager .pg').forEach((g) => (g.onclick = () => { const v = g.dataset.pg; state.page = v === 'prev' ? Math.max(1, state.page - 1) : v === 'next' ? Math.min(pages, state.page + 1) : Number(v); renderRegular(); icons(); }));
  $$('tbody tr').forEach((tr) => (tr.onclick = (e) => { if (e.target.dataset.act === 'transfer') { state.deselected = {}; for (const x of rows()) if (x.id !== Number(tr.dataset.id)) state.deselected[x.id] = true; openPlan(); return; } openCard(Number(tr.dataset.id)); }));
  $('#review') && ($('#review').onclick = () => { state.deselected = {}; openPlan(); });
  $('#openBatch').onclick = () => { state.deselected = {}; openPlan(); };
  $('#exportCsv').onclick = exportCsv;
}

function sparkPath(vals) { const mx = Math.max(...vals, 1); return vals.map((v, i) => `${i ? 'L' : 'M'}${((300 * i) / (vals.length - 1)).toFixed(1)} ${(46 - (40 * v) / mx).toFixed(1)}`).join(''); }
function dateAt(h) { const d = new Date(state.result.fleet.start + 'T00:00:00Z'); d.setUTCHours(d.getUTCHours() + h); return d.toISOString().slice(0, 10).replaceAll('-', '.'); }
const footer = () => `<div class="foot"><span>Unofficial concept demo by Mohith Gajjela. Not affiliated with PhotonPay. Synthetic ad accounts; Meta and Google billing rules from their public help centres.</span><a href="https://github.com/Mohith26/photonpay-smart-transfer-in">Source</a></div>`;

// ---------- smart tab ----------
function renderSmart() {
  const r = state.result, h = r.headline, S = r.sweeps;
  $('#page').innerHTML = `
  <div class="kpis">
    <div class="box kpi"><span>Decline-free card-days</span><b>${pct(h.realizedDeclineFree, 2)}</b><div class="sub" style="color:var(--text-2)">target ${pct(h.targetDeclineFree, 1)} · ${h.windows.toLocaleString()} card-days scored</div></div>
    <div class="box kpi"><span>Average money parked on cards</span><b>$${usd(h.avgFloat, 0)}</b><div class="sub">${h.lessFloatVsLastWeek != null ? `${Math.round(100 * h.lessFloatVsLastWeek)}% less than last-week top-ups` : 'last-week rule never this safe'}</div></div>
    <div class="box kpi"><span>Same decline rate with a flat buffer</span><b>${h.fixedFloatAtSameRate != null ? '$' + usd(h.fixedFloatAtSameRate, 0) : 'n/a'}</b><div class="sub">${h.lessFloatVsFixed != null ? `Smart transfer-in needs ${Math.round(100 * h.lessFloatVsFixed)}% less` : 'flat buffer never reaches this rate'}</div></div>
    <div class="box kpi"><span>Ad downtime from declines</span><b>${h.downtimeHours} h</b><div class="sub" style="color:var(--text-2)">$${usd(h.lostSpend, 0)} of ad spend paused · forecast alone: ${pct(1 - h.forecastOnlyDeclineRate, 1)} decline-free</div></div>
  </div>
  <div class="grid2">
    <div class="box" style="position:relative"><div class="busy" id="busy"><div><div class="spin"></div>Re-running backtest…</div></div>
      <div style="display:flex;justify-content:space-between;align-items:center"><div><div class="kv-t">Money on cards vs. decline rate</div><div style="font-size:12px;color:var(--text-3);margin-top:3px">${r.fleet.cards.length} ad cards · ${r.fleet.days} days · first 28 days warm-up · each dot is one setting</div></div>
      <div class="legend"><span><i style="background:var(--chart-1)"></i>Smart transfer-in</span><span><i style="background:var(--chart-2)"></i>k × last 7 days</span><span><i style="background:#bdbdbd"></i>Flat buffer</span><span><i style="background:var(--chart-3)"></i>Forecast only</span></div></div>
      <div class="chart" id="fchart"><svg id="fsvg" role="img" aria-label="Frontier: average card balance against decline rate for each policy"></svg><div class="tip" id="ftip"></div></div>
    </div>
    <div class="box ctl">
      <div class="kv-t">Settings</div>
      <div><label for="target">Decline-free target <output>${pct(1 - state.sc.alpha, 1)}</output></label><input type="range" id="target" min="0.95" max="0.995" step="0.005" value="${1 - state.sc.alpha}"/></div>
      <div><label>Run schedule</label><div class="seg2" style="width:100%;display:flex"><button style="flex:1" data-c="daily" class="${state.sc.cadence === 'daily' ? 'on' : ''}">Daily 10:00</button><button style="flex:1" data-c="twice-weekly" class="${state.sc.cadence === 'twice-weekly' ? 'on' : ''}">Mon + Thu</button></div></div>
      <div style="font-size:12.5px;color:var(--text-2);line-height:1.6"><b style="color:var(--text)">How it's sized.</b> For each card, a billing-aware forecast replays the platform's rules (Meta: payment threshold ladder and monthly bill date; Google: threshold or 30 days) on the card's recent spend. Adaptive conformal calibration then scales that spend by the smallest factor that recent windows exceeded only ${pct(state.sc.alpha, 1)} of the time. Charges only grow with spend, so covering the spend covers the charges.</div>
      <div style="display:flex;gap:8px"><button class="btn" id="exportJson"><i data-lucide="file-json"></i>Export backtest</button><button class="btn primary" id="toPlan">Review today's plan</button></div>
    </div>
  </div>
  <div class="sect">Policies compared <span>at each policy's own setting · scored after warm-up</span></div>
  <table class="ptable" aria-label="Policy comparison"><thead><tr><th>Policy</th><th class="num">Decline-free card-days</th><th class="num">Declines</th><th class="num">Ad downtime</th><th class="num">Avg money on cards</th><th class="num">Transfers</th></tr></thead><tbody>
  ${[S.calibrated.find((x) => Math.abs(x.alpha - state.sc.alpha) < 1e-9) || S.calibrated[0], S.lastWeek.find((x) => x.k === 1.5), S.lastWeek.find((x) => x.k === 1), S.fixed.find((x) => x.x === 4000), S.forecast].map((x, i) => `<tr style="cursor:default"><td>${i === 0 ? '<b>Smart transfer-in</b> · ' + x.label.replace('Calibrated ', '') : x.label}</td><td class="num">${pct(1 - x.windowDeclineRate, 2)}</td><td class="num">${x.declines}</td><td class="num">${x.downtimeHours} h</td><td class="num">$${usd(x.avgFloat, 0)}</td><td class="num">${x.transfers}</td></tr>`).join('')}
  </tbody></table>
  ${footer()}`;
  drawFrontier();
  $('#target').oninput = (e) => { state.sc.alpha = Math.round((1 - Number(e.target.value)) * 1000) / 1000; $('#target').previousElementSibling.querySelector('output').textContent = pct(1 - state.sc.alpha, 1); schedule(); };
  $$('[data-c]').forEach((b) => (b.onclick = () => { state.sc.cadence = b.dataset.c; schedule(); }));
  $('#exportJson').onclick = exportJson;
  $('#toPlan').onclick = () => { location.hash = '#/regular'; setTimeout(() => openPlan(), 50); };
}
let deb = null;
function schedule() { writeHash(); clearTimeout(deb); deb = setTimeout(recompute, 250); }

function drawFrontier() {
  const svg = $('#fsvg'); if (!svg) return;
  const S = state.result.sweeps, W = svg.clientWidth || 800, H = svg.clientHeight || 320, pad = { l: 56, r: 16, t: 14, b: 34 };
  const series = [
    { name: 'Flat buffer', col: '#bdbdbd', pts: S.fixed.map((x) => ({ ...x, tag: `$${x.x}` })) },
    { name: 'k × last 7 days', col: '#2e9aff', pts: S.lastWeek.map((x) => ({ ...x, tag: `${x.k}×` })) },
    { name: 'Smart transfer-in', col: '#ffbf00', pts: S.calibrated.map((x) => ({ ...x, tag: pct(1 - x.alpha, 1) + ' target' })) },
  ];
  const all = [...series.flatMap((s) => s.pts), S.forecast];
  const xMax = Math.min(0.08, Math.max(0.03, 1.8 * Math.max(...S.calibrated.map((p) => p.windowDeclineRate))));
  const yMax = Math.max(...all.filter((p) => p.windowDeclineRate <= xMax).map((p) => p.avgFloat)) * 1.08;
  const X = (v) => pad.l + ((W - pad.l - pad.r) * Math.min(v, xMax)) / xMax, Y = (v) => H - pad.b - ((H - pad.t - pad.b) * v) / yMax;
  let g = '';
  for (let i = 0; i <= 5; i++) { const v = (yMax * i) / 5; g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#eee"/><text x="${pad.l - 8}" y="${Y(v) + 4}" font-size="11" fill="rgba(18,18,18,.5)" text-anchor="end">$${Math.round(v / 1000)}k</text>`; }
  for (let i = 0; i <= 5; i++) { const v = (xMax * i) / 5; g += `<text x="${X(v)}" y="${H - 12}" font-size="11" fill="rgba(18,18,18,.5)" text-anchor="middle">${(100 * v).toFixed(1)}%</text>`; }
  g += `<text x="${(W + pad.l) / 2}" y="${H - 0}" font-size="11" fill="rgba(18,18,18,.5)" text-anchor="middle">card-days with a declined ad charge</text>`;
  for (const s of series) {
    const pts = s.pts.filter((p) => p.windowDeclineRate <= xMax).sort((a, b) => a.windowDeclineRate - b.windowDeclineRate);
    g += `<path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.windowDeclineRate).toFixed(1)} ${Y(p.avgFloat).toFixed(1)}`).join('')}" fill="none" stroke="${s.col}" stroke-width="2"/>`;
    g += pts.map((p) => `<circle cx="${X(p.windowDeclineRate)}" cy="${Y(p.avgFloat)}" r="${s.col === '#ffbf00' && Math.abs(p.alpha - state.sc.alpha) < 1e-9 ? 6.5 : 4}" fill="#fff" stroke="${s.col}" stroke-width="2" data-tip="${s.name}: ${p.tag}|${pct(1 - p.windowDeclineRate, 2)} decline-free|$${usd(p.avgFloat, 0)} on cards|${p.downtimeHours} h ad downtime"/>`).join('');
  }
  const f = S.forecast;
  if (f.windowDeclineRate <= xMax) g += `<circle cx="${X(f.windowDeclineRate)}" cy="${Y(f.avgFloat)}" r="5" fill="#8d61f2" data-tip="Forecast only (no buffer)|${pct(1 - f.windowDeclineRate, 2)} decline-free|$${usd(f.avgFloat, 0)} on cards|${f.downtimeHours} h ad downtime"/>`;
  else g += `<text x="${W - pad.r}" y="${pad.t + 10}" font-size="11" fill="#8d61f2" text-anchor="end">Forecast only: ${pct(f.windowDeclineRate, 1)} decline rate (off chart)</text>`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.innerHTML = g;
  const tip = $('#ftip');
  $$('circle[data-tip]', svg).forEach((c) => { c.style.cursor = 'pointer'; c.onmouseenter = () => { const [a, b, d, e] = c.dataset.tip.split('|'); tip.innerHTML = `<b>${a}</b><br>${b}<br>${d}<br>${e}`; tip.style.display = 'block'; tip.style.left = Math.min(Number(c.getAttribute('cx')) + 12, W - 180) + 'px'; tip.style.top = Math.max(0, Number(c.getAttribute('cy')) - 70) + 'px'; }; c.onmouseleave = () => (tip.style.display = 'none'); });
}

// ---------- card drawer ----------
function openCard(id, push = true) {
  const x = rows().find((y) => y.id === id); if (!x) return;
  state.card = id; if (push) writeHash();
  const t = state.result.traces[id];
  const d = $('#drawer');
  d.innerHTML = `<div class="dh"><h3>Card details</h3><button class="close" aria-label="Close" id="dClose"><i data-lucide="x"></i></button></div>
  <div class="db">
    <div style="display:flex;gap:16px;align-items:center"><div class="pcard" style="width:170px;height:106px"><i>PHOTONPAY</i></div><div><div style="font-weight:600;font-size:15px">${x.c.nickname}</div><div style="color:var(--text-2);font-size:13px;margin-top:4px">${x.c.cardNo}<span class="mc"></span></div><div style="margin-top:8px"><span class="plat">${platIcon(x.c.platform)}${PLATFORMS[x.c.platform].label}</span> <span class="pill ${x.rk.cls}" style="margin-left:6px">${x.rk.label} risk · ${pct(x.risk, 1)}</span></div></div></div>
    <div class="box" style="padding:14px 16px"><div class="kv-t" style="margin-bottom:8px">Balance, charges and transfers <span style="font-weight:400;color:var(--text-3);font-size:12px">· last ${t.bal.length} days</span></div><svg id="cchart" viewBox="0 0 500 170" style="width:100%;height:170px" role="img" aria-label="Card balance history"></svg>
      <div class="legend" style="margin-top:6px"><span><i style="background:#121212"></i>End-of-day balance</span><span><i style="background:var(--chart-1)"></i>Transfer in</span><span><i style="background:#c7c7c7"></i>Ad charges</span><span><i style="background:var(--danger)"></i>Decline</span></div></div>
    <div class="kvg">
      <span>Card amount</span><b>${usd(x.balNow)} USD</b>
      <span>Platform billing</span><b>${x.c.platform === 'meta' ? `threshold $${x.threshold}, bill date day ${x.c.billDay}` : `threshold $${x.threshold} or 30 days`}</b>
      <span>Unbilled ad costs (est.)</span><b>${usd(x.unbilled)} USD</b>
      <span>Recent spend rate (EWMA, 3-day half-life)</span><b>${usd(x.rate, 0)} USD/day</b>
      <span>Forecast charges until next run</span><b>${usd(x.yhat, 0)} USD</b>
      <span>Calibrated target balance</span><b>${usd(x.target, 0)} USD</b>
      <span>Smart transfer in</span><b>${x.rec > 0 ? usd(x.rec, 0) + ' USD' : 'none needed'}</b>
      <span>Decline risk now → after transfer</span><b>${pct(x.pFailBefore, 1)} → ${pct(x.pFailAfter, 1)}</b>
    </div>
    <div style="font-size:12px;color:var(--text-3);line-height:1.6">Risk = share of recent ${x.c.platform === 'meta' ? 'Meta' : 'Google'} card-windows whose spend grew by more than this balance can absorb, after passing the spend through the platform's billing rules. Declined windows count as misses.</div>
    <div style="display:flex;gap:8px"><button class="btn primary" id="dTransfer" ${x.rec > 0 ? '' : 'disabled'}>Transfer in ${x.rec > 0 ? usd(x.rec, 0) + ' USD' : ''}</button><button class="btn">Set limits</button></div>
  </div>`;
  d.classList.add('show'); d.setAttribute('aria-hidden', 'false'); $('#scrim').classList.add('show'); icons();
  drawCard(t);
  $('#dClose').onclick = () => closeCard(); $('#dTransfer').onclick = () => { state.deselected = {}; for (const y of rows()) if (y.id !== id) state.deselected[y.id] = true; closeCard(); openPlan(); };
  $$('tbody tr').forEach((tr) => tr.classList.toggle('sel', Number(tr.dataset.id) === id));
}
function drawCard(t) {
  const svg = $('#cchart'), W = 500, H = 170, pad = { l: 44, r: 6, t: 8, b: 20 };
  const n = t.bal.length, mx = Math.max(...t.bal, ...t.transfers, ...t.charges, 1) * 1.1;
  const X = (i) => pad.l + ((W - pad.l - pad.r) * i) / (n - 1), Y = (v) => H - pad.b - ((H - pad.t - pad.b) * v) / mx, bw = (W - pad.l - pad.r) / n * 0.42;
  let g = '';
  for (let k = 0; k <= 3; k++) { const v = (mx * k) / 3; g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="#f0f0f0"/><text x="${pad.l - 6}" y="${Y(v) + 3}" font-size="9" fill="rgba(18,18,18,.5)" text-anchor="end">${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v)}</text>`; }
  g += `<rect x="${pad.l}" y="${pad.t}" width="${X(27) - pad.l}" height="${H - pad.t - pad.b}" fill="rgba(0,0,0,.03)"/><text x="${pad.l + 4}" y="${pad.t + 10}" font-size="9" fill="rgba(18,18,18,.45)">warm-up</text>`;
  t.paused.forEach((p, i) => { if (p) g += `<rect x="${X(i) - 3}" y="${pad.t}" width="6" height="${H - pad.t - pad.b}" fill="rgba(242,87,74,.12)"/>`; });
  t.charges.forEach((v, i) => { if (v > 0) g += `<rect x="${X(i) - bw}" y="${Y(v)}" width="${bw}" height="${Y(0) - Y(v)}" fill="#d0d0d0"/>`; });
  t.transfers.forEach((v, i) => { if (v > 0) g += `<rect x="${X(i)}" y="${Y(v)}" width="${bw}" height="${Y(0) - Y(v)}" fill="#ffbf00"/>`; });
  g += `<path d="${t.bal.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('')}" fill="none" stroke="#121212" stroke-width="1.6"/>`;
  t.declines.forEach((v, i) => { if (v > 0) g += `<circle cx="${X(i)}" cy="${Y(0) - 4}" r="4" fill="#f2574a"/>`; });
  [0, 30, 60, n - 1].forEach((i) => (g += `<text x="${X(i)}" y="${H - 5}" font-size="9" fill="rgba(18,18,18,.5)" text-anchor="middle">${dateAt(i * 24).slice(5)}</text>`));
  svg.innerHTML = g;
}
function closeCard(push = true) { $('#drawer').classList.remove('show'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#scrim').classList.remove('show'); if (state.card != null) { state.card = null; if (push) writeHash(); } $$('tbody tr').forEach((tr) => tr.classList.remove('sel')); }
$('#scrim').onclick = () => closeCard();

// ---------- batch transfer in (smart plan) ----------
function planRows() { return rows().filter((x) => x.rec > 0 || state.edits[x.id] > 0).map((x) => ({ ...x, amt: state.edits[x.id] ?? x.rec, on: !state.deselected[x.id] })); }
function openPlan(push = true) {
  state.plan = true; state.step = state.step === 3 ? 1 : state.step; if (push) writeHash();
  const m = $('#batch'); m.classList.add('show'); drawPlan();
}
function closePlan() { state.plan = false; state.step = 1; state.edits = {}; $('#batch').classList.remove('show'); writeHash(); }
function drawPlan() {
  const pr = planRows(), sel = pr.filter((x) => x.on);
  const total = sel.reduce((a, x) => a + x.amt, 0);
  const avoided = sel.reduce((a, x) => a + Math.max(0, x.risk - interp(x.curve, x.applied + x.amt)), 0);
  const short = total > state.funding;
  const m = $('#batch');
  const body = state.step === 3 ? `<div class="okbox" style="grid-column:1/3"><div class="ring"><i data-lucide="check" style="width:28px;height:28px"></i></div><h1 style="font-size:20px">Transfer in submitted</h1><p class="desc" style="margin:8px auto">${sel.length} cards · ${usd(total, 0)} USD from your USD account. Card balances update in a few seconds.</p></div>`
  : `<div>
      <div class="steps"><i style="${state.step === 2 ? 'grid-column:1/3' : ''}"></i></div>
      <h1>${state.step === 1 ? 'Batch fund cards' : 'Confirm transfer in'}</h1>
      <p class="desc">${state.step === 1 ? 'Smart transfer-in pre-filled each card with what its ad platform is likely to charge before the next run, plus a calibrated buffer. Edit any amount; risk updates as you type.' : 'Review the amounts and the funding account, then submit.'}</p>
      ${state.step === 1 ? `<div class="filters" style="margin:0"><span class="inp" style="width:240px"><i data-lucide="search" style="width:15px;height:15px"></i>Card number / Nickname</span><span class="inp sel">Card BIN <b style="color:var(--text);font-weight:500;margin-left:4px">558325 (MasterCard)</b><i data-lucide="chevron-down" style="width:12px;height:12px"></i></span><span class="inp sel">Currency <b style="color:var(--text);font-weight:500;margin-left:4px">USD</b><i data-lucide="chevron-down" style="width:12px;height:12px"></i></span></div>` : ''}
      <div class="selbar"><span class="x">✕</span>${sel.length} items selected <span style="margin-left:auto;font-size:12.5px;color:var(--text-2)">Sorted by decline risk</span></div>
      <table aria-label="Cards to fund"><thead><tr><th><span class="cb ${sel.length === pr.length ? 'on' : ''}" id="all"></span></th><th>Card number</th><th>Nickname</th><th class="num">Card balance</th><th class="num">Forecast charges</th><th class="num">Transfer in amount</th><th>Decline risk</th></tr></thead><tbody>
      ${pr.sort((a, b) => b.risk - a.risk).map((x) => { const after = interp(x.curve, x.applied + x.amt); return `<tr data-id="${x.id}" style="cursor:default"><td><span class="cb ${x.on ? 'on' : ''}" data-tog="${x.id}" role="checkbox" aria-checked="${x.on}" tabindex="0"></span></td><td>${x.c.cardNo}</td><td>${x.c.nickname}</td><td class="num">${usd(x.balNow)} USD</td><td class="num" style="font-weight:400">${usd(x.yhat, 0)}</td><td class="num">${state.step === 1 ? `<input class="amt" data-amt="${x.id}" value="${x.amt}" inputmode="numeric" aria-label="Transfer in amount for ${x.c.nickname}"/>` : usd(x.amt, 0) + ' USD'}</td><td><span class="pill ${riskOf(x.risk).cls}">${pct(x.risk, 1)}</span> → <span class="pill ${riskOf(after).cls}" data-after="${x.id}">${pct(after, 1)}</span></td></tr>`; }).join('')}
      </tbody></table>
    </div>
    <aside class="fee"><h4>Fee confirmation</h4><div class="kvg">
      <span>Transfer in amount</span><b>${usd(total, 2)} USD</b><span>Handling fee</span><b>per your pricing</b><span>Number of cards to transfer in</span><b>${sel.length}</b></div><hr>
      <div class="kvg"><span>Funding account</span><b>USD · ${usd(state.funding, 0)}</b><span>Account payable amount</span><b>${usd(total, 2)} USD</b><span>Expected declines avoided</span><b>${avoided.toFixed(2)}</b></div>
      <div style="margin-top:14px"><label style="font-size:12px;color:var(--text-2)" for="fund">What if the USD account only had</label><input class="amt" id="fund" style="width:100%;margin-top:6px;text-align:left" value="${state.funding}"/></div>
      ${short ? `<div class="warnbox" style="margin-top:12px">The plan needs ${usd(total - state.funding, 0)} USD more than the account holds. <button class="lnk" id="fit" style="margin:4px 0 0;display:block">Fit to balance (fund where declines cost most)</button></div>` : ''}
    </aside>`;
  m.innerHTML = `<div class="sheet"><div class="sh"><h2 id="batchH">Batch transfer in</h2><button class="close" aria-label="Close" id="pClose"><i data-lucide="x"></i></button></div><div class="sb">${body}</div>
    <div class="sf">${state.step === 2 ? '<button class="btn" id="back">Back</button>' : ''}${state.step === 3 ? '<button class="btn primary" id="done">Done</button>' : `<button class="btn primary" id="next" ${sel.length && !short && total > 0 ? '' : 'disabled'}>${state.step === 1 ? 'Next' : 'Submit'}</button>`}</div></div>`;
  icons();
  $('#pClose').onclick = closePlan;
  $$('[data-tog]').forEach((c) => (c.onclick = c.onkeydown = (e) => { if (e.type === 'keydown' && e.key !== ' ' && e.key !== 'Enter') return; const id = Number(c.dataset.tog); state.deselected[id] = !state.deselected[id]; drawPlan(); }));
  $('#all') && ($('#all').onclick = () => { const allOn = pr.every((x) => x.on); pr.forEach((x) => (state.deselected[x.id] = allOn)); drawPlan(); });
  $$('[data-amt]').forEach((inp) => (inp.onchange = () => { let v = Math.max(0, Math.round(Number(inp.value) || 0)); if (v > 0 && v < MIN_TRANSFER) { v = MIN_TRANSFER; toast(`Minimum transfer in is ${MIN_TRANSFER} USD per card`, false); } state.edits[Number(inp.dataset.amt)] = v; drawPlan(); }));
  $('#fund') && ($('#fund').onchange = (e) => { state.funding = Math.max(0, Number(e.target.value) || 0); writeHash(); drawPlan(); });
  $('#fit') && ($('#fit').onclick = () => {
    const items = sel.map((x) => ({ need: x.amt, w: Math.max(1, x.rate), pFail: (a) => interp(x.curve, x.applied + a) }));
    const { amounts } = allocate(items, state.funding);
    sel.forEach((x, i) => (state.edits[x.id] = amounts[i] > 0 ? Math.max(MIN_TRANSFER, amounts[i]) : 0));
    toast('Plan fitted to the available balance (exact allocation)'); drawPlan();
  });
  $('#next') && ($('#next').onclick = () => { if (state.step === 1) { state.step = 2; drawPlan(); } else submit(sel, total); });
  $('#back') && ($('#back').onclick = () => { state.step = 1; drawPlan(); });
  $('#done') && ($('#done').onclick = () => { closePlan(); render(); });
}
function submit(sel, total) {
  const key = appliedKey(); state.applied[key] = state.applied[key] || {};
  sel.forEach((x) => { if (x.amt > 0) state.applied[key][x.id] = (state.applied[key][x.id] || 0) + x.amt; });
  state.funding = Math.max(0, state.funding - total);
  state.history.unshift({ at: Date.now(), cards: sel.length, total }); state.history = state.history.slice(0, 20);
  state.step = 3; writeHash(); drawPlan(); toast(`Transfer in submitted: ${usd(total, 0)} USD to ${sel.length} cards`);
}

// ---------- export ----------
function exportCsv() {
  const lines = ['card_id,card_number,nickname,platform,balance_usd,threshold_usd,unbilled_usd,spend_rate_usd_day,forecast_charges_usd,target_balance_usd,smart_transfer_in_usd,decline_risk_before,decline_risk_after'];
  for (const x of rows()) lines.push([x.c.cardId, x.c.cardNo, x.c.nickname, x.c.platform, x.balNow.toFixed(2), x.threshold, x.unbilled, x.rate.toFixed(2), x.yhat, x.target, x.rec, x.pFailBefore, interp(x.curve, x.applied + x.rec).toFixed(4)].join(','));
  download(`smart-transfer-in-plan-${dateAt(state.result.plan.h)}.csv`, lines.join('\n'), 'text/csv'); toast('Plan exported');
}
function exportJson() { const r = state.result; download('smart-transfer-in-backtest.json', JSON.stringify({ scenario: r.scenario, headline: r.headline, sweeps: r.sweeps, calibrated: r.calibrated }, null, 1), 'application/json'); toast('Backtest exported'); }

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') && e.key !== 'Escape') return;
  if (e.key === '/') { e.preventDefault(); if (state.route !== 'regular') { location.hash = '#/regular'; } setTimeout(() => $('#q') && $('#q').focus(), 30); }
  else if (e.key.toLowerCase() === 'b') { state.deselected = {}; openPlan(); }
  else if (e.key.toLowerCase() === 's') location.hash = '#/smart';
  else if (e.key.toLowerCase() === 'r') location.hash = '#/regular';
  else if (e.key.toLowerCase() === 'e') exportCsv();
  else if (e.key.toLowerCase() === 'j') exportJson();
  else if (e.key === '?') $('#keys').classList.add('show');
  else if (e.key === 'Escape') { if ($('#batch').classList.contains('show')) closePlan(); closeCard(); $('#keys').classList.remove('show'); }
});
$$('[data-close]').forEach((b) => (b.onclick = () => b.closest('.modal').classList.remove('show')));
$('#kbdBtn').onclick = () => $('#keys').classList.add('show');
$('#searchIc').onclick = () => { location.hash = '#/regular'; setTimeout(() => $('#q') && $('#q').focus(), 30); };
window.addEventListener('hashchange', () => { const prev = state.route; readHash(); if (state.result) { if (prev !== state.route) render(); else render(); } });
window.addEventListener('resize', () => state.route === 'smart' && drawFrontier());

// ---------- boot ----------
async function recompute() {
  const sc = { ...state.sc };
  const b = $('#busy'); b && b.classList.add('show');
  const res = await run(sc);
  if (scenarioKey(sc) !== scenarioKey(state.sc)) return;
  if (!res.ok) { toast('Backtest failed: ' + res.error, false); b && b.classList.remove('show'); return; }
  state.result = res.result; render();
}
async function boot() {
  $('#page').innerHTML = `<div class="sum"><div class="box"><span class="skel" style="width:60%;height:100px"></span></div><div class="box"><span class="skel" style="width:60%;height:100px"></span></div></div><div style="margin-top:16px"><span class="skel" style="width:100%;height:110px"></span></div>`;
  icons(); readHash();
  try { state.pre = await fetch('data/results.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  catch (err) { $('#page').innerHTML = `<div class="banner show">Could not load the backtest (${err.message}). Reload to retry.</div>`; return; }
  await recompute(); writeHash(); window.__ready = true;
}
boot();
