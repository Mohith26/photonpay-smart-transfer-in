// Precompute the default scenarios (first load) and the headline numbers quoted in the README.
//   node scripts/build-results.mjs
import fs from 'node:fs';
import { runScenario, DEFAULT_SCENARIO, scenarioKey } from '../src/report.js';

const scenarios = [DEFAULT_SCENARIO, { ...DEFAULT_SCENARIO, cadence: 'twice-weekly' }];
const out = { generatedBy: 'scripts/build-results.mjs', scenarios: {} };
for (const sc of scenarios) {
  const t0 = Date.now();
  const r = runScenario(sc);
  out.scenarios[scenarioKey(sc)] = r;
  const h = r.headline;
  console.log(scenarioKey(sc), `${Date.now() - t0} ms`, JSON.stringify(h));
}
out.defaultKey = scenarioKey(DEFAULT_SCENARIO);
fs.writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(out));
console.log('wrote data/results.json', fs.statSync(new URL('../data/results.json', import.meta.url)).size, 'bytes');
