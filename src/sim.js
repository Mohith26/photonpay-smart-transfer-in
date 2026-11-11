// Smart transfer-in for PhotonPay Regular Cards used to pay ad platforms.
// 1) A seeded generator of ad accounts (Meta / Google) with public billing mechanics.
// 2) An hourly simulator of card balances, threshold billing, declines and ad downtime.
// 3) Transfer-in policies: flat buffer, multiple of last week's charges, billing-aware forecast,
//    and the calibrated policy (forecast + adaptive conformal buffer).
// 4) An exact budget-constrained allocator (multiple-choice knapsack by DP) for when the
//    funding account cannot cover every card.
// Pure functions, no dependencies; runs in Node and in the browser.

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const randn = (r) => { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Public billing mechanics.
// Meta: charged when unbilled costs reach the payment threshold; threshold rises after successful
// payments (starts small, e.g. USD 25); leftover costs charged on the monthly bill date;
// daily spend may reach 175% of the daily budget, weekly spend at most 7x (Meta Business Help Centre
// 776240779095515, 105373712886516, 190490051321426). The ladder after USD 25 varies by account;
// we use a commonly reported one: 25, 50, 250, 500, 750.
// Google Ads automatic payments: charged when costs reach the threshold or 30 days after the last
// charge; threshold 50 -> 200 -> 350 -> 500; daily spend up to 2x the daily budget.
export const PLATFORMS = {
  meta: { label: 'Meta Ads', ladder: [25, 50, 250, 500, 750], dailyCap: 1.75, weeklyCap: 7, thirtyDay: false, billDay: true },
  google: { label: 'Google Ads', ladder: [50, 200, 350, 500], dailyCap: 2.0, weeklyCap: null, thirtyDay: true, billDay: false },
};
export const SMOOTH = 20; // $ added to spend ratios so idle cards do not divide by zero
export const MIN_TRANSFER = 20; // PhotonPay help centre: minimum transfer in per Regular Card is 20 USD

// Share of a day's spend by hour (HKT), ad delivery peaks in the target market's daytime.
const DIURNAL = (() => { const w = []; for (let h = 0; h < 24; h++) w.push(0.35 + Math.exp(-((h - 21) ** 2) / 18) + 0.8 * Math.exp(-((h - 9) ** 2) / 10)); const s = w.reduce((a, b) => a + b, 0); return w.map((x) => x / s); })();
const DOW = [1.0, 1.03, 1.04, 1.01, 0.97, 0.93, 0.96]; // Mon..Sun

export function makeFleet({ seed = 20261029, cards = 48, days = 91, start = '2026-08-10' } = {}) {
  const r = rng(seed);
  const fleet = { seed, days, hours: days * 24, start, cards: [] };
  const regions = ['US', 'UK', 'DE', 'SG', 'AU', 'BR', 'MX', 'JP'];
  for (let i = 0; i < cards; i++) {
    const platform = r() < 0.6 ? 'meta' : 'google';
    const P = PLATFORMS[platform];
    const base = Math.min(5000, Math.max(40, Math.round(Math.exp(Math.log(320) + 0.8 * randn(r)) / 10) * 10));
    // budget schedule with campaign events: scale-ups, cuts, pauses
    const budget = new Array(days).fill(base);
    let cur = base;
    for (let d = 0; d < days; d++) {
      if (r() < 1 / 13) {
        const u = r();
        if (u < 0.45) cur = Math.min(8000, Math.round((cur * (1.4 + 1.1 * r())) / 10) * 10);
        else if (u < 0.75) cur = Math.max(30, Math.round((cur * (0.4 + 0.3 * r())) / 10) * 10);
        else { const len = 3 + Math.floor(6 * r()); for (let k = d; k < Math.min(days, d + len); k++) budget[k] = 0; d += len - 1; continue; }
      }
      budget[d] = cur;
    }
    // realized (intended) daily spend
    const daily = new Array(days).fill(0);
    let weekSum = 0;
    for (let d = 0; d < days; d++) {
      if (d % 7 === 0) weekSum = 0;
      const b = budget[d];
      if (b <= 0) continue;
      let s = b * DOW[d % 7] * Math.exp(0.22 * randn(r) - 0.024);
      s = Math.min(s, P.dailyCap * b);
      if (P.weeklyCap) s = Math.min(s, Math.max(0, P.weeklyCap * b - weekSum));
      daily[d] = Math.round(s * 100) / 100;
      weekSum += daily[d];
    }
    const hourly = new Float64Array(days * 24);
    for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) hourly[d * 24 + h] = daily[d] * DIURNAL[h];
    const nick = `${platform === 'meta' ? 'META' : 'GADS'}-${regions[Math.floor(r() * regions.length)]}-${String(i + 1).padStart(2, '0')}`;
    fleet.cards.push({
      id: i, platform, nickname: nick,
      cardNo: `558325******${String(1000 + Math.floor(r() * 9000))}`,
      cardId: `XR${String(19900000000000000000n + BigInt(Math.floor(r() * 1e15)) * 1000n + BigInt(i))}`,
      base, budget, daily, hourly,
      ladderStart: platform === 'meta' ? 2 + Math.floor(r() * 3) : 1 + Math.floor(r() * 3),
      billDay: 1 + Math.floor(r() * 28),
      startBalance: Math.round((base * (2 + 3 * r())) / 10) * 10,
    });
  }
  return fleet;
}

// Day-of-month for hour index h (start date fixed in UTC terms; HKT offset irrelevant for the model).
function dayOfMonth(startISO, h) { const d = new Date(startISO + 'T00:00:00Z'); d.setUTCHours(d.getUTCHours() + h); return d.getUTCDate(); }
export function batchHours(fleet, cadence) {
  // cadence: 'daily' | 'twice-weekly' (Mon, Thu) | 'weekly' (Mon); batch at 10:00
  const out = [];
  for (let d = 0; d < fleet.days; d++) {
    const dow = d % 7; // start is a Monday
    if (cadence === 'daily' || (cadence === 'twice-weekly' && (dow === 0 || dow === 3)) || (cadence === 'weekly' && dow === 0)) out.push(d * 24 + 10);
  }
  return out;
}

// Billing step: advance one hour of spend through the platform's billing rules.
// state: { U (unbilled), k (ladder index), lastCharge (hour), pending (failed charge amount) }
function billingHour(card, st, spend, h, startISO) {
  const P = PLATFORMS[card.platform];
  const charges = [];
  st.U += spend;
  const T = P.ladder[st.k];
  if (st.U >= T - 1e-9) { charges.push({ amount: T, kind: 'threshold' }); st.U -= T; }
  if (P.billDay && h % 24 === 0 && dayOfMonth(startISO, h) === card.billDay && st.U > 0.5) { charges.push({ amount: Math.round(st.U * 100) / 100, kind: 'bill date' }); st.U = 0; }
  if (P.thirtyDay && h - st.lastCharge >= 30 * 24 && st.U > 0.5) { charges.push({ amount: Math.round(st.U * 100) / 100, kind: '30 days' }); st.U = 0; }
  return charges;
}

// Billing-aware point forecast of charges in the next H hours, from a spend-rate estimate.
export function forecastCharges(card, st, ratePerDay, h0, H, startISO) {
  const P = PLATFORMS[card.platform];
  const s = { U: st.U, k: st.k, lastCharge: st.lastCharge };
  let total = st.pending || 0;
  for (let h = h0; h < h0 + H; h++) {
    const spend = ratePerDay * DIURNAL[h % 24];
    for (const c of billingHour(card, s, spend, h, startISO)) { total += c.amount; s.lastCharge = h; if (c.kind === 'threshold' && s.k < P.ladder.length - 1) s.k++; }
  }
  return total;
}

// ---------- policies ----------
// Each policy returns the target balance for a card at a batch; transfer = max(0, target - balance),
// rounded up to whole dollars and at least MIN_TRANSFER when positive.
export const POLICIES = {
  fixed: (x) => ({ id: 'fixed', label: `Flat buffer $${x}`, target: () => x }),
  lastWeek: (k) => ({ id: 'lastWeek', label: `${k}x last 7 days' charges`, target: (c) => k * c.charges7 }),
  forecast: () => ({ id: 'forecast', label: 'Billing-aware forecast', includesPending: true, target: (c) => c.yhat }),
  calibrated: (alpha, gamma = 0.02) => ({ id: 'calibrated', label: `Calibrated (target ${Math.round((1 - alpha) * 1000) / 10}% decline-free)`, alpha, gamma, calibrated: true, includesPending: true, target: (c, cal) => { const q = Math.max(1, cal.q(c)); const fs = Math.max(0, (c.fspend + SMOOTH) * q - SMOOTH); return forecastCharges(c.card, c.st, (fs * 24) / c.H, c.h, c.H, c.start); } }),
};

// Split-conformal quantile with finite-sample correction: the ceil((n+1)(1-a))-th smallest score.
export function conformalQuantile(scores, a) {
  const n = scores.length;
  if (n === 0) return Infinity;
  const k = Math.ceil((n + 1) * (1 - a));
  if (k > n) return Infinity;
  if (k < 1) return -Infinity;
  const s = [...scores].sort((x, y) => x - y);
  return s[k - 1];
}

// ---------- simulator ----------
export function simulate(fleet, policy, { cadence = 'daily', warmupDays = 28, window = 400, cap = null, trace = false } = {}) {
  const H = fleet.hours, batches = batchHours(fleet, cadence);
  const isBatch = new Map(batches.map((b, i) => [b, i]));
  const warmH = warmupDays * 24;
  const cards = fleet.cards.map((c) => ({
    c, bal: c.startBalance, st: { U: 0, k: c.ladderStart, lastCharge: 0 }, pending: 0, paused: false,
    obsDaily: new Array(fleet.days).fill(0), chargesDaily: new Array(fleet.days).fill(0), pausedHours: 0,
    win: null,
    tr: trace ? { bal: new Array(fleet.days).fill(0), charges: new Array(fleet.days).fill(0), transfers: new Array(fleet.days).fill(0), declines: new Array(fleet.days).fill(0), paused: new Array(fleet.days).fill(0) } : null,
  }));
  const scores = { meta: [], google: [] };
  let alphaT = policy.alpha ?? null;
  const alphaPath = [];
  const out = { windows: 0, windowsDeclined: 0, declines: 0, downtimeHours: 0, lostSpend: 0, floatHours: 0, floatSamples: 0, transfers: 0, transferred: 0, attempted: 0, scoredHours: 0, perCard: cards.map(() => ({ windows: 0, declined: 0, downtime: 0, float: 0, n: 0, transferred: 0 })), log: [] };
  const lastDecision = new Array(cards.length).fill(null);
  for (let h = 0; h < H; h++) {
    const bi = isBatch.get(h);
    if (bi !== undefined) {
      const nextB = batches[bi + 1] ?? H;
      const Hh = nextB - h;
      const scoring = h >= warmH;
      // close previous windows: score + coverage bookkeeping
      if (lastDecision[0]) {
        let miss = 0, n = 0;
        cards.forEach((k, i) => {
          const w = k.win; if (!w) return;
          const covered = !w.declined;
          if (w.scoring) { out.windows++; out.perCard[i].windows++; if (!covered) { out.windowsDeclined++; out.perCard[i].declined++; } }
          // censored when declined: the true need is unknown but above the balance -> +Infinity score
          const score = w.declined ? Infinity : (w.spend + SMOOTH) / (w.fspend + SMOOTH);
          const S = scores[k.c.platform]; S.push(score); if (S.length > window) S.shift();
          if (policy.calibrated) { n++; if (!covered) miss++; }
        });
        if (policy.calibrated && n && h > warmH) { alphaT = Math.min(0.5, Math.max(1e-4, alphaT + policy.gamma * (policy.alpha - miss / n))); }
      }
      alphaPath.push(alphaT);
      // decide transfers
      const decisions = cards.map((k, i) => {
        const d = Math.floor(h / 24);
        const hist = k.obsDaily.slice(Math.max(0, d - 14), d);
        let rate = 0, wsum = 0;
        hist.forEach((v, j) => { const w = Math.pow(0.5, (hist.length - 1 - j) / 3); rate += w * v; wsum += w; });
        rate = wsum ? rate / wsum : k.c.base;
        const charges7 = k.chargesDaily.slice(Math.max(0, d - 7), d).reduce((a, b) => a + b, 0);
        const yhat = forecastCharges(k.c, { ...k.st, pending: k.pending }, rate, h, Hh, fleet.start);
        const T = PLATFORMS[k.c.platform].ladder[k.st.k];
        const fspend = (rate * Hh) / 24;
        const scale = T + fspend;
        const ctx = { yhat, T, scale, fspend, charges7, rate, platform: k.c.platform, pending: k.pending, H: Hh, card: k.c, st: { ...k.st, pending: k.pending }, h, start: fleet.start };
        const useWarm = h < warmH;
        const cal = { q: (cc) => { const S = scores[cc.platform]; const q = conformalQuantile(S, alphaT); if (Number.isFinite(q)) return q; const fin = S.filter(Number.isFinite); return fin.length ? Math.max(...fin) * 1.25 : 3; } };
        // warm-up (identical for every policy): generous funding so that forecast errors are observed uncensored
        let target = useWarm ? Math.max(2.5 * charges7, 5 * k.c.base) + k.pending : policy.target(ctx, cal);
        // every policy at least covers a failed (pending) charge; forecast-based targets already include it
        if (!useWarm && !policy.includesPending) target += k.pending;
        let amt = Math.max(0, Math.ceil(target - k.bal));
        if (amt > 0 && amt < MIN_TRANSFER) amt = MIN_TRANSFER;
        return { amt, ctx, target };
      });
      if (cap != null && h >= warmH) {
        const need = decisions.reduce((a, d) => a + d.amt, 0);
        if (need > cap) applyCap(decisions, cards, scores, alphaT, cap);
      }
      if (trace && bi === batches.length - 1) {
        out.lastBatch = { h, horizon: Hh, alpha: alphaT, cards: decisions.map((dec, i) => {
          const k = cards[i], S = scores[k.c.platform].slice().sort((a, b) => a - b);
          const pFail = (bal) => failProb(S, dec.ctx, bal);
          const P = PLATFORMS[k.c.platform];
          return { id: k.c.id, bal: Math.round(k.bal * 100) / 100, pending: k.pending, yhat: Math.round(dec.ctx.yhat * 100) / 100, scale: dec.ctx.scale, T: dec.ctx.T, rate: dec.ctx.rate, target: Math.round(dec.target * 100) / 100, amt: dec.amt, unbilled: Math.round(k.st.U * 100) / 100, threshold: P.ladder[k.st.k], pFailBefore: pFail(k.bal - k.pending), pFailAfter: pFail(k.bal - k.pending + dec.amt), paused: k.paused,
            curve: (() => { const top = Math.max(200, 2 * dec.amt, dec.ctx.rate * 2); const pts = []; for (let j = 0; j <= 16; j++) { const a = Math.round((top * j) / 16); pts.push([a, Math.round(pFail(k.bal - k.pending + a) * 1e4) / 1e4]); } return pts; })() };
        }), scores: { meta: scores.meta.filter(Number.isFinite).slice(-400), google: scores.google.filter(Number.isFinite).slice(-400), censored: { meta: scores.meta.filter((x) => !Number.isFinite(x)).length, google: scores.google.filter((x) => !Number.isFinite(x)).length } } };
      }
      decisions.forEach((dec, i) => {
        const k = cards[i];
        if (k.tr && dec.amt > 0) k.tr.transfers[Math.floor(h / 24)] += dec.amt;
        if (dec.amt > 0) { k.bal += dec.amt; out.transfers += h >= warmH ? 1 : 0; out.transferred += h >= warmH ? dec.amt : 0; out.perCard[i].transferred += h >= warmH ? dec.amt : 0; }
        // retry a failed charge
        if (k.pending > 0 && k.bal >= k.pending - 1e-9) { k.bal -= k.pending; k.chargesDaily[Math.floor(h / 24)] += k.pending; if (k.tr) k.tr.charges[Math.floor(h / 24)] += k.pending; k.pending = 0; k.paused = false; k.st.lastCharge = h; }
        k.win = { yhat: dec.ctx.yhat, T: dec.ctx.T, scale: dec.ctx.scale, fspend: dec.ctx.fspend, spend: 0, charges: 0, declined: false, scoring: h >= warmH, target: dec.target, amt: dec.amt };
        lastDecision[i] = dec;
      });
      if (h >= warmH) out.log.push({ h, n: decisions.filter((d) => d.amt > 0).length, total: decisions.reduce((a, d) => a + d.amt, 0) });
    }
    // spend + billing for this hour
    let floatNow = 0;
    cards.forEach((k, i) => {
      const intended = k.c.hourly[h];
      const d = Math.floor(h / 24);
      if (k.paused) {
        k.pausedHours++;
        if (h >= warmH) { out.downtimeHours++; out.perCard[i].downtime++; out.lostSpend += intended; }
      } else {
        k.obsDaily[d] += intended;
        if (k.win) k.win.spend += intended;
        for (const ch of billingHour(k.c, k.st, intended, h, fleet.start)) {
          if (k.win) k.win.charges += ch.amount;
          if (h >= warmH) out.attempted++;
          if (k.bal + 1e-9 >= ch.amount) {
            k.bal -= ch.amount; k.chargesDaily[d] += ch.amount; k.st.lastCharge = h; if (k.tr) k.tr.charges[d] += ch.amount;
            if (ch.kind === 'threshold' && k.st.k < PLATFORMS[k.c.platform].ladder.length - 1) k.st.k++;
          } else {
            // declined: the platform pauses delivery until the payment succeeds
            k.pending += ch.amount; k.paused = true; if (k.win) k.win.declined = true;
            if (h >= warmH) out.declines++;
            if (k.tr) k.tr.declines[d]++;
          }
        }
      }
      floatNow += k.bal;
      if (k.tr && h % 24 === 23) { k.tr.bal[d] = Math.round(k.bal * 100) / 100; if (k.paused) k.tr.paused[d] = 1; }
      if (h >= warmH) { out.perCard[i].float += k.bal; out.perCard[i].n++; }
    });
    if (h >= warmH) { out.floatHours += floatNow; out.floatSamples++; }
  }
  out.avgFloat = out.floatHours / out.floatSamples;
  out.windowDeclineRate = out.windows ? out.windowsDeclined / out.windows : 0;
  out.alphaPath = alphaPath;
  out.finalBalances = cards.map((k) => k.bal);
  if (trace) out.traces = cards.map((k) => k.tr);
  out.policy = { id: policy.id, label: policy.label, alpha: policy.alpha ?? null };
  return out;
}

// Exact allocation of a limited funding balance across cards (multiple-choice knapsack by DP over
// $20 units): minimise sum_i w_i * P(decline_i | transfer a_i), where P is read off the conformal
// score distribution, w_i = forecast daily spend (what a decline puts at risk).
export function allocate(items, cap, unit = MIN_TRANSFER) {
  // items: [{ need, w, pFail(a) }]; returns amounts (multiples of unit, each <= need rounded up)
  const U = Math.floor(cap / unit);
  const n = items.length;
  const opts = items.map((it) => { const m = Math.ceil(it.need / unit); const o = []; for (let j = 0; j <= m; j++) o.push(it.w * it.pFail(j * unit)); return o; });
  let prev = new Float64Array(U + 1);
  const choice = [];
  for (let i = 0; i < n; i++) {
    const cur = new Float64Array(U + 1).fill(Infinity);
    const ch = new Int32Array(U + 1);
    const o = opts[i];
    for (let u = 0; u <= U; u++) {
      for (let j = 0; j < o.length && j <= u; j++) {
        const v = prev[u - j] + o[j];
        if (v < cur[u] - 1e-12) { cur[u] = v; ch[u] = j; }
      }
    }
    choice.push(ch); prev = cur;
  }
  let u = U; const amounts = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) { const j = choice[i][u]; amounts[i] = j * unit; u -= j; }
  return { amounts, objective: prev[U] };
}

function applyCap(decisions, cards, scores, alphaT, cap) {
  const items = decisions.map((d, i) => {
    const k = cards[i], S = scores[k.c.platform].slice().sort((a, b) => a - b);
    return { need: d.amt, w: Math.max(1, d.ctx.rate), pFail: (a) => failProb(S, d.ctx, k.bal - k.pending + a) };
  });
  const { amounts } = allocate(items, cap);
  decisions.forEach((d, i) => { d.amt = amounts[i] > 0 ? Math.max(MIN_TRANSFER, amounts[i]) : 0; });
}

// Interpolate float at a given decline rate along a sweep (no extrapolation).
export function floatAtRate(sweep, rate) {
  const pts = sweep.map((s) => [s.windowDeclineRate, s.avgFloat]).sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const [r0, f0] = pts[i], [r1, f1] = pts[i + 1];
    if (rate >= r0 && rate <= r1) return r1 === r0 ? Math.min(f0, f1) : f0 + ((f1 - f0) * (rate - r0)) / (r1 - r0);
  }
  return null;
}

// Probability that a card with balance `bal` declines in the window: the smallest spend ratio that
// would exhaust `bal` (found by bisection through the monotone billing map) vs the conformal scores.
export function failProb(sortedScores, ctx, bal) {
  if (!sortedScores.length) return 1;
  const need = (g) => forecastCharges(ctx.card, ctx.st, (Math.max(0, (ctx.fspend + SMOOTH) * g - SMOOTH) * 24) / ctx.H, ctx.h, ctx.H, ctx.start);
  if (need(0) > bal) return 1;
  let lo = 0, hi = 1;
  while (need(hi) <= bal && hi < 1e4) hi *= 2;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (need(m) <= bal) lo = m; else hi = m; }
  let c = 0; for (const v of sortedScores) if (v > lo) c++;
  return c / sortedScores.length;
}
