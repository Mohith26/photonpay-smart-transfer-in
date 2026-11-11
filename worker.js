// Re-runs the backtest for a what-if scenario off the main thread.
import { runScenario } from './src/report.js';
self.onmessage = (e) => {
  const { id, scenario } = e.data;
  try { const t0 = performance.now(); const result = runScenario(scenario); self.postMessage({ id, ok: true, result, ms: Math.round(performance.now() - t0) }); }
  catch (err) { self.postMessage({ id, ok: false, error: String((err && err.message) || err) }); }
};
