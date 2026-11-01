#!/usr/bin/env node
/** worker.mjs — 连续批量执行直到名册没有匹配状态的患者。 */
import fs from 'node:fs';
import { runBatch } from './batch.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const disease = arg('disease', 'hp');
const statuses = [arg('status', '过期')];
const max = Number(arg('max', 500));
const chunk = Number(arg('chunk', 4));
const flowCode = fs.readFileSync(arg('flow', disease === 'hp' ? 'scripts/flow-hypertension.js' : 'scripts/flow-diabetes.js'), 'utf8');

const status = { disease, statuses, started: new Date().toISOString(), done: 0, saved: 0, failed: 0, error: null, finished: false };
const write = () => { try { fs.writeFileSync('worker-status.json', JSON.stringify(status)); } catch (e) {} };
write();

while (status.done < max) {
  const res = await runBatch({ disease, statuses, count: chunk, flowCode });
  for (const r of res) {
    status.done += 1;
    if (r.saved) status.saved += 1; else { status.failed += 1; status.error = (r.row && r.row.name) + ':' + r.error; }
  }
  write();
  if (status.error) break;
  if (!res.length || res[0].error === 'no-target-row') { status.finished = true; break; }
}
status.finished = status.finished || !status.error;
write();
console.log(JSON.stringify(status));
