#!/usr/bin/env node
/**
 * batch.mjs — 单人/小批量随访执行器。
 * 用法：node scripts/batch.mjs --disease hp|dm --status 过期|快到期 --count 4 --flow scripts/flow-hypertension.js
 * 环境变量：FOLLOWUP_BASE_URL（系统根地址）、CDP_PORT（浏览器调试端口）
 */
import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

export const BASE = process.env.FOLLOWUP_BASE_URL || arg('base-url', 'http://127.0.0.1:8080');
export const PORT = Number(process.env.CDP_PORT || arg('port', 58772));

const ROUTE = {
  hp: '/archives/high-blood-pressure-records',
  dm: '/archives/diabetes-records',
};
const COL = {
  hp: { name: 0, last: 7, next: 8, status: 9, age: 11 },
  dm: { name: 0, last: 6, next: 7, status: 8, age: 10 },
};
const LABEL = { hp: '高血压', dm: '糖尿病' };

export function appendLog(disease, rec) {
  const line = JSON.stringify({
    ts: new Date().toISOString(), disease: LABEL[disease] || disease,
    name: rec.row && rec.row.name, age: rec.row && rec.row.age,
    last: rec.row && rec.row.last, status: rec.row && rec.row.status,
    saved: !!rec.saved, error: rec.error || null, params: rec.params || null,
    state: (rec.flow && rec.flow.state) || null,
  });
  try { fs.appendFileSync(disease + '-progress.jsonl', line + '\n', 'utf8'); } catch (e) {}
}

// 到期日 = 上次 + 3 个月；实际日随机提前 0~20 天，不晚于 3 个月、不落在未来
export function pickDate(last, today = new Date()) {
  const [y, m, d] = last.split('-').map(Number);
  const due = new Date(y, m - 1 + 3, d);
  const early = Math.floor(Math.random() * 21);
  let when = new Date(due.getFullYear(), due.getMonth(), due.getDate() - early);
  if (when > today) when = new Date(today.getTime() - Math.floor(Math.random() * 3) * 86400000);
  const lastObj = new Date(y, m - 1, d);
  if (when <= lastObj) when = new Date(lastObj.getTime() + 80 * 86400000);
  const p2 = n => String(n).padStart(2, '0');
  const hh = 7 + Math.floor(Math.random() * 13);
  const mm = Math.floor(Math.random() * 60);
  return when.getFullYear() + '-' + p2(when.getMonth() + 1) + '-' + p2(when.getDate()) + ' ' + p2(hh) + ':' + p2(mm) + ':00';
}

export function exerciseFor(disease, age) {
  if (disease === 'hp') return age >= 80 ? [3, 30, 5, 30] : age >= 75 ? [4, 30, 5, 30] : 'keep';
  if (age >= 80) return [3, 30, 5, 30];
  if (age >= 75) return [4, 30, 5, 30];
  if (age < 65) return [5, 30, 5, 30];
  return 'keep';
}

async function pageTarget(port) {
  const list = await new Promise((res, rej) => {
    const req = http.get('http://127.0.0.1:' + port + '/json/list', { timeout: 5000 }, r => {
      let b = ''; r.setEncoding('utf8'); r.on('data', c => b += c); r.on('end', () => res(JSON.parse(b)));
    });
    req.on('error', rej);
    req.setTimeout(5000, () => { req.destroy(); rej(new Error('CDP timeout')); });
  });
  return list.filter(t => t.type === 'page').find(t => (t.url || '').includes(BASE.replace(/^https?:\/\//, '').split(':')[0])) || list.filter(t => t.type === 'page')[0];
}

export async function runBatch({ disease = 'hp', statuses = ['过期'], count = 1, flowCode, base = BASE, port = PORT } = {}) {
  const t = await pageTarget(port);
  if (!t) throw new Error('no CDP page target');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const pending = new Map(); let id = 0;
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP ws error')); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  };

  const c = COL[disease];
  const READ = "JSON.stringify((function(){var S=" + JSON.stringify(statuses) + ";var trs=[].slice.call(document.querySelectorAll('.el-table__body-wrapper tbody tr'));for(var i=0;i<trs.length;i++){var td=[].slice.call(trs[i].querySelectorAll('td'));var tx=td.map(function(x){return (x.textContent||'').replace(/\\s+/g,' ').trim();});var o={idx:i,name:tx[" + c.name + "],last:tx[" + c.last + "],next:tx[" + c.next + "],status:tx[" + c.status + "],age:tx[" + c.age + "]};if(o.name&&S.indexOf(o.status)>=0)return o;}return null;})())";

  const results = [];
  for (let n = 0; n < count; n += 1) {
    const rec = { round: n + 1 };
    try {
      await send('Page.navigate', { url: base + '/?t=' + Date.now() + '#' + ROUTE[disease] });
      await sleep(4500);
      let raw = 'null';
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await ev("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').trim()==='查询';})[0];if(!b)return 'no';b.click();return 'ok';})()");
        for (let k = 0; k < 10; k += 1) { await sleep(900); raw = await ev(READ); if (raw && raw !== 'null') break; }
        if (raw && raw !== 'null') break;
        await sleep(1500);
      }
      const row = JSON.parse(raw || 'null');
      if (!row) { rec.error = 'no-target-row'; results.push(rec); appendLog(disease, rec); break; }
      rec.row = row;
      await ev("(function(o){var trs=[].slice.call(document.querySelectorAll('.el-table__body-wrapper tbody tr'));var tr=trs[o.idx];if(!tr)return 'norow';var a=tr.querySelector('a.cli-btn');if(!a)return 'noanchor';a.click();return 'ok';})(" + JSON.stringify({ idx: row.idx }) + ")");
      await sleep(4000);
      const name = await ev("(function(){var m=(document.body.innerText||'').match(/^\\s*([\\u4e00-\\u9fa5]{2,4})\\s+(\\d{1,3})岁/m);return m?m[1]:'';})()");
      if (name !== row.name) { rec.error = 'name-mismatch:' + name + '!=' + row.name; results.push(rec); appendLog(disease, rec); break; }
      await ev(flowCode);
      if (!(await ev('window.__openFollowup()'))) { rec.error = 'followup-form-not-open'; results.push(rec); appendLog(disease, rec); break; }
      rec.params = {
        date: pickDate(row.last),
        sbp: 110 + Math.floor(Math.random() * 30),
        dbp: 71 + Math.floor(Math.random() * 19),
        hr: 60 + Math.floor(Math.random() * 30),
        ex: exerciseFor(disease, Number(row.age)),
        expect: row.name,
      };
      const out = await ev('window.__followup(' + JSON.stringify(rec.params) + ')');
      rec.flow = out;
      rec.saved = !!(out && out.ok);
      if (!rec.saved) rec.error = (out && out.why) || 'save-failed';
    } catch (e) {
      rec.error = String((e && e.message) || e).slice(0, 300);
    }
    results.push(rec);
    appendLog(disease, rec);
    if (rec.error) break;
    await sleep(1200);
  }
  ws.close();
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const disease = arg('disease', 'hp');
  const flowPath = arg('flow', disease === 'hp' ? 'scripts/flow-hypertension.js' : 'scripts/flow-diabetes.js');
  const flowCode = fs.readFileSync(flowPath, 'utf8');
  const res = await runBatch({ disease, statuses: [arg('status', '过期')], count: Number(arg('count', 1)), flowCode });
  console.log(res.map(r => [r.row && r.row.name, r.row && r.row.age, r.params && r.params.date, r.saved ? 'OK' : 'ERR:' + r.error].join(' ')).join('\n'));
}
