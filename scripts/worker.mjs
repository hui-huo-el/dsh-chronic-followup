#!/usr/bin/env node
/**
 * worker.mjs — 连续批量执行（降本版）。
 * 静默：过程不输出，仅在结束时打印一行 JSON 摘要；状态写入 worker-status.json。
 * 用法：node scripts/worker.mjs --disease hp --status 过期 --max 200 [--chunk 4] [--concurrency 1] [--silent]
 */
import fs from 'node:fs';
import { runBatch, summarize } from './batch.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const disease = arg('disease', 'hp');
const statuses = [arg('status', '过期')];
const max = Number(arg('max', 500));
const chunk = Math.max(1, Number(arg('chunk', 4)));
const concurrency = Math.max(1, Math.min(4, Number(arg('concurrency', 1))));
const flowCode = fs.readFileSync(arg('flow', disease === 'hp' ? 'scripts/flow-hypertension.js' : 'scripts/flow-diabetes.js'), 'utf8');

const status = { disease, statuses, concurrency, started: new Date().toISOString(), done: 0, saved: 0, failed: 0, error: null, finished: false };
const write = () => { try { fs.writeFileSync('worker-status.json', JSON.stringify(status)); } catch (e) {} };
write();

while (status.done < max) {
  const res = await runBatch({ disease, statuses, count: chunk, flowCode });
  for (const r of res) {
    status.done += 1;
    if (r.saved) status.saved += 1;
    else { status.failed += 1; status.error = (r.row && r.row.name || '?') + ':' + r.error; }
  }
  write();
  if (status.error) break;
  if (!res.length || (res[0] && res[0].error === 'no-target-row')) { status.finished = true; break; }
}
status.finished = status.finished || !status.error;
write();
const line = summarize(disease, [], { staged: true });
console.log(JSON.stringify({ disease, done: status.done, saved: status.saved, failed: status.failed, finished: status.finished, error: status.error, concurrency }));
