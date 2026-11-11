// Scenario runner shared by the build script, the tests and the browser worker.
import { makeFleet, simulate, POLICIES, PLATFORMS, floatAtRate } from './sim.js';

export const DEFAULT_SCENARIO = { cadence: 'daily', alpha: 0.01, gamma: 0.1, cap: null };
export const scenarioKey = (sc) => `${sc.cadence}|${sc.alpha}|${sc.gamma}|${sc.cap ?? 'none'}`;
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const summary = (r) => ({ label: r.policy.label, id: r.policy.id, alpha: r.policy.alpha, windowDeclineRate: r4(r.windowDeclineRate), windows: r.windows, windowsDeclined: r.windowsDeclined, declines: r.declines, downtimeHours: r.downtimeHours, lostSpend: Math.round(r.lostSpend), avgFloat: Math.round(r.avgFloat), transfers: r.transfers, transferred: Math.round(r.transferred) });

let fleetCache = null;
export function getFleet() { if (!fleetCache) fleetCache = makeFleet(); return fleetCache; }

export const SWEEPS = { lastWeek: [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3], fixed: [1000, 2000, 3000, 4000, 6000, 8000, 12000], alpha: [0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12] };

export function runScenario(sc = DEFAULT_SCENARIO, { sweeps = true } = {}) {
  const fleet = getFleet();
  const opts = { cadence: sc.cadence, cap: sc.cap };
  const main = simulate(fleet, POLICIES.calibrated(sc.alpha, sc.gamma), { ...opts, trace: true });
  const out = {
    scenario: sc,
    fleet: { seed: fleet.seed, days: fleet.days, start: fleet.start, cards: fleet.cards.map((c) => ({ id: c.id, platform: c.platform, nickname: c.nickname, cardNo: c.cardNo, cardId: c.cardId, base: c.base, avgDaily: r2(c.daily.reduce((a, b) => a + b, 0) / fleet.days), budgetNow: c.budget[fleet.days - 1], billDay: c.billDay })) },
    calibrated: summary(main),
    plan: main.lastBatch ? { ...main.lastBatch, cards: main.lastBatch.cards.map((c) => ({ ...c, scale: r2(c.scale), rate: r2(c.rate), pFailBefore: r4(c.pFailBefore), pFailAfter: r4(c.pFailAfter) })), alpha: r4(main.lastBatch.alpha) } : null,
    traces: main.traces,
    alphaPath: main.alphaPath.map((a) => (a == null ? null : r4(a))),
    batchLog: main.log,
  };
  if (sweeps) {
    const lw = SWEEPS.lastWeek.map((k) => simulate(fleet, POLICIES.lastWeek(k), opts));
    const fx = SWEEPS.fixed.map((x) => simulate(fleet, POLICIES.fixed(x), opts));
    const cal = SWEEPS.alpha.map((a) => (a === sc.alpha ? main : simulate(fleet, POLICIES.calibrated(a, sc.gamma), opts)));
    const fc = simulate(fleet, POLICIES.forecast(), opts);
    out.sweeps = { lastWeek: lw.map(summary).map((s, i) => ({ ...s, k: SWEEPS.lastWeek[i] })), fixed: fx.map(summary).map((s, i) => ({ ...s, x: SWEEPS.fixed[i] })), calibrated: cal.map(summary), forecast: summary(fc) };
    const rate = main.windowDeclineRate;
    const lwF = floatAtRate(lw, rate), fxF = floatAtRate(fx, rate);
    const lw15 = lw[SWEEPS.lastWeek.indexOf(1.5)];
    out.headline = {
      targetDeclineFree: r4(1 - sc.alpha), realizedDeclineFree: r4(1 - rate), realizedDeclineRate: r4(rate),
      windows: main.windows, avgFloat: Math.round(main.avgFloat),
      lastWeekFloatAtSameRate: lwF == null ? null : Math.round(lwF), fixedFloatAtSameRate: fxF == null ? null : Math.round(fxF),
      lessFloatVsLastWeek: lwF == null ? null : r4(1 - main.avgFloat / lwF), lessFloatVsFixed: fxF == null ? null : r4(1 - main.avgFloat / fxF),
      lastWeek15: summary(lw15), lostSpend: Math.round(main.lostSpend), downtimeHours: main.downtimeHours,
      forecastOnlyDeclineRate: r4(fc.windowDeclineRate),
    };
  }
  return out;
}

export { PLATFORMS };
