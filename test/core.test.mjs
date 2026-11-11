import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rng, makeFleet, simulate, POLICIES, PLATFORMS, conformalQuantile, allocate, forecastCharges, batchHours } from '../src/sim.js';
import { runScenario, DEFAULT_SCENARIO, scenarioKey } from '../src/report.js';

const fleet = makeFleet();

test('generator is deterministic for a seed', () => {
  const a = makeFleet({ seed: 7 }), b = makeFleet({ seed: 7 });
  assert.deepEqual(a.cards.map((c) => c.daily), b.cards.map((c) => c.daily));
  assert.notDeepEqual(makeFleet({ seed: 8 }).cards[0].daily, a.cards[0].daily);
});

test('spend respects the platforms\' published pacing caps (Meta 175%/day, 7x/week; Google 2x/day)', () => {
  for (const c of fleet.cards) {
    const P = PLATFORMS[c.platform];
    c.daily.forEach((s, d) => assert.ok(s <= P.dailyCap * c.budget[d] + 1e-6, `${c.nickname} day ${d}`));
    if (P.weeklyCap) for (let w = 0; w + 7 <= fleet.days; w += 7) {
      const spent = c.daily.slice(w, w + 7).reduce((a, b) => a + b, 0);
      const cap = P.weeklyCap * Math.max(...c.budget.slice(w, w + 7));
      assert.ok(spent <= cap + 1e-6);
    }
  }
});

function oneCard(platform, perDay, days = 70) {
  const f = makeFleet({ cards: 1, days });
  const c = f.cards[0];
  c.platform = platform; c.ladderStart = 0; c.billDay = 99; // no bill date in the test window
  c.daily = new Array(days).fill(perDay); c.budget = new Array(days).fill(perDay);
  c.hourly = new Float64Array(days * 24).fill(perDay / 24);
  c.startBalance = 1e9;
  return f;
}

test('Meta billing: threshold charges climb the ladder after successful payments', () => {
  const f = oneCard('meta', 100, 40);
  const r = simulate(f, POLICIES.fixed(0), { trace: true, warmupDays: 0 });
  const charges = r.traces[0].charges;
  const total = charges.reduce((a, b) => a + b, 0);
  // 40 days x $100 = $4,000 of spend; the ladder 25, 50, 250, 500, 750, 750, ... bills 3,825 by threshold
  assert.equal(total, 25 + 50 + 250 + 500 + 750 * 4);
});

test('Google billing: a small account is charged after 30 days even below the threshold', () => {
  const f = oneCard('google', 1, 40);
  const r = simulate(f, POLICIES.fixed(0), { trace: true, warmupDays: 0 });
  const day = r.traces[0].charges.findIndex((x) => x > 0);
  assert.ok(day >= 29 && day <= 30, String(day));
});

test('split conformal quantile uses the finite-sample rank ceil((n+1)(1-a))', () => {
  const s = Array.from({ length: 99 }, (_, i) => i + 1);
  assert.equal(conformalQuantile(s, 0.1), 90);
  assert.equal(conformalQuantile([1, 2, 3], 0.1), Infinity);
  assert.equal(conformalQuantile([], 0.1), Infinity);
});

test('split conformal coverage (randomized): a fresh exchangeable score is covered with prob >= 1 - a', () => {
  const r = rng(5); let covered = 0; const trials = 4000, a = 0.1;
  for (let t = 0; t < trials; t++) {
    const draw = () => Math.exp(1.5 * (r() + r() + r() - 1.5));
    const q = conformalQuantile(Array.from({ length: 40 }, draw), a);
    if (draw() <= q) covered++;
  }
  assert.ok(covered / trials >= 1 - a - 0.015, String(covered / trials));
});

test('allocator (randomized): DP matches brute force on small instances and respects the cap', () => {
  const r = rng(11);
  for (let t = 0; t < 40; t++) {
    const items = Array.from({ length: 3 }, () => { const need = 20 * (1 + Math.floor(r() * 4)); const w = 1 + 9 * r(); const cuts = Array.from({ length: 5 }, () => r()).sort().reverse(); return { need, w, pFail: (a) => cuts[Math.min(4, Math.floor(a / 20))] }; });
    const cap = 20 * Math.floor(r() * 8);
    const { amounts, objective } = allocate(items, cap);
    assert.ok(amounts.reduce((a, b) => a + b, 0) <= cap);
    amounts.forEach((a, i) => assert.ok(a <= Math.ceil(items[i].need / 20) * 20));
    let best = Infinity;
    const opts = items.map((it) => Array.from({ length: Math.ceil(it.need / 20) + 1 }, (_, j) => j * 20));
    for (const a of opts[0]) for (const b of opts[1]) for (const c of opts[2]) if (a + b + c <= cap) best = Math.min(best, items[0].w * items[0].pFail(a) + items[1].w * items[1].pFail(b) + items[2].w * items[2].pFail(c));
    assert.ok(Math.abs(objective - best) < 1e-9, `${objective} vs ${best}`);
  }
});

test('billing-aware forecast is exact when the spend rate is known', () => {
  const f = oneCard('meta', 240, 10);
  const c = f.cards[0];
  const yhat = forecastCharges(c, { U: 0, k: 0, lastCharge: 0 }, 240, 0, 24 * 5, f.start);
  const r = simulate(f, POLICIES.fixed(0), { trace: true, warmupDays: 0 });
  const realized = r.traces[0].charges.slice(0, 5).reduce((a, b) => a + b, 0);
  assert.equal(yhat, realized);
});

test('money is conserved: start balances + transfers = successful charges + end balances', () => {
  for (const p of [POLICIES.fixed(2000), POLICIES.lastWeek(1.5), POLICIES.calibrated(0.02, 0.05)]) {
    const r = simulate(fleet, p, { trace: true, warmupDays: 0 });
    const start = fleet.cards.reduce((a, c) => a + c.startBalance, 0);
    const tin = r.traces.reduce((a, t) => a + t.transfers.reduce((x, y) => x + y, 0), 0);
    const ch = r.traces.reduce((a, t) => a + t.charges.reduce((x, y) => x + y, 0), 0);
    const end = r.finalBalances.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(start + tin - ch - end) < 1e-3, p.label);
  }
});

test('a declined charge pauses delivery and is retried at the next batch', () => {
  const f = oneCard('meta', 600, 6);
  f.cards[0].startBalance = 10; f.cards[0].ladderStart = 3; // threshold 500 > balance
  const r = simulate(f, POLICIES.fixed(0), { trace: true, warmupDays: 0, cadence: 'daily' }); // only covers failed charges
  assert.ok(r.declines >= 1);
  assert.ok(r.traces[0].charges.reduce((a, b) => a + b, 0) > 0, 'retried charge succeeded');
});

test('calibration: the realized decline rate stays under the target and moves with it', () => {
  const rates = [0.01, 0.03, 0.08].map((a) => simulate(fleet, POLICIES.calibrated(a, 0.1), { cadence: 'daily' }).windowDeclineRate);
  [0.01, 0.03, 0.08].forEach((a, i) => assert.ok(rates[i] <= a + 0.005, `${a}: ${rates[i]}`));
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2], JSON.stringify(rates));
});

test('the uncalibrated forecast alone misses far more often than the target', () => {
  const r = simulate(fleet, POLICIES.forecast(), { cadence: 'daily' });
  assert.ok(r.windowDeclineRate > 0.1);
});

test('batch schedule: daily at 10:00, twice weekly on Monday and Thursday', () => {
  assert.equal(batchHours(fleet, 'daily').length, fleet.days);
  const tw = batchHours(fleet, 'twice-weekly');
  assert.ok(tw.every((h) => h % 24 === 10 && [0, 3].includes(Math.floor(h / 24) % 7)));
});

test('headline numbers in data/results.json are reproduced exactly and beat the last-week rule', () => {
  const saved = JSON.parse(fs.readFileSync(new URL('../data/results.json', import.meta.url)));
  const s = saved.scenarios[scenarioKey(DEFAULT_SCENARIO)];
  const fresh = runScenario(DEFAULT_SCENARIO);
  assert.deepEqual(fresh.headline, s.headline);
  assert.ok(s.headline.realizedDeclineFree >= s.headline.targetDeclineFree - 0.005);
  assert.ok(s.headline.lessFloatVsLastWeek > 0.3);
});
