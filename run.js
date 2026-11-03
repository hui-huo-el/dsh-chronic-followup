#!/usr/bin/env node
/**
 * run.js — 慢病随访独立执行器（无 AI / 无 DSH 依赖）
 * 用法: node run.js --disease hp|dm --status 过期|快到期 --count 5
 * 首次运行：会自动拉起 Edge，请在窗口里手动登录一次，登录态保存在 edge-profile/。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==== 固定配置（如需换环境只改这里）====
const CONFIG = {
  EDGE_PATH: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  DEBUG_PORT: 9222,
  USER_DATA_DIR: path.join(__dirname, 'edge-profile'),
  BASE_URL: process.env.FOLLOWUP_BASE_URL || 'http://183.204.254.20:8088',
  ROUTE: { hp: '/archives/high-blood-pressure-records', dm: '/archives/diabetes-records' },
  COL: { hp: { name: 0, last: 7, status: 9, age: 11 }, dm: { name: 0, last: 6, status: 8, age: 10 } },
  LABEL: { hp: '高血压', dm: '糖尿病' },
  FLOW: { hp: 'scripts/flow-hypertension.js', dm: 'scripts/flow-diabetes.js' },
  RETRY: 3,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = line => process.stdout.write(line + '\n');
const errlog = line => { try { fs.appendFileSync(path.join(__dirname, 'error.log'), new Date().toISOString() + ' ' + line + '\n'); } catch (e) {} };

function argv(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function httpGet(url) {
  return new Promise(res => {
    const req = http.get(url, { timeout: 4000 }, r => { let b = ''; r.setEncoding('utf8'); r.on('data', c => b += c); r.on('end', () => res(b)); });
    req.on('error', () => res(''));
    req.setTimeout(4000, () => { req.destroy(); res(''); });
  });
}

async function ensureBrowser() {
  for (let i = 0; i < 3; i += 1) {
    if (await httpGet('http://127.0.0.1:' + CONFIG.DEBUG_PORT + '/json/version')) return true;
    await sleep(1000);
  }
  if (!fs.existsSync(CONFIG.EDGE_PATH)) throw new Error('未找到 Edge: ' + CONFIG.EDGE_PATH);
  spawn(CONFIG.EDGE_PATH, [
    '--remote-debugging-port=' + CONFIG.DEBUG_PORT,
    '--user-data-dir=' + CONFIG.USER_DATA_DIR,
    '--no-first-run', '--no-default-browser-check',
    CONFIG.BASE_URL + '/#/archives/home',
  ], { detached: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    if (await httpGet('http://127.0.0.1:' + CONFIG.DEBUG_PORT + '/json/version')) return true;
  }
  throw new Error('Edge 未能在 30s 内启动调试端口 ' + CONFIG.DEBUG_PORT);
}

async function connect() {
  const list = JSON.parse(await httpGet('http://127.0.0.1:' + CONFIG.DEBUG_PORT + '/json/list') || '[]');
  const pages = list.filter(t => t.type === 'page');
  const t = pages.find(p => (p.url || '').includes(new URL(CONFIG.BASE_URL).host)) || pages[0];
  if (!t) throw new Error('没有可用标签页');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  const pending = new Map(); let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('CDP 连接失败')); });
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error('CDP 错误')) : p.resolve(m.result); } };
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常');
    return r.result && r.result.value;
  };
  return { ws, send, ev };
}

function pickDate(last, today = new Date()) {
  const [y, m, d] = last.split('-').map(Number);
  const due = new Date(y, m - 1 + 3, d);
  let when = new Date(due.getFullYear(), due.getMonth(), due.getDate() - Math.floor(Math.random() * 21));
  if (when > today) when = new Date(today.getTime() - Math.floor(Math.random() * 3) * 86400000);
  const lastObj = new Date(y, m - 1, d);
  if (when <= lastObj) when = new Date(lastObj.getTime() + 80 * 86400000);
  const p2 = n => String(n).padStart(2, '0');
  return when.getFullYear() + '-' + p2(when.getMonth() + 1) + '-' + p2(when.getDate()) + ' ' + p2(7 + Math.floor(Math.random() * 13)) + ':' + p2(Math.floor(Math.random() * 60)) + ':00';
}

function exerciseFor(disease, age) {
  if (disease === 'hp') return age >= 80 ? [3, 30, 5, 30] : age >= 75 ? [4, 30, 5, 30] : 'keep';
  if (age >= 80) return [3, 30, 5, 30];
  if (age >= 75) return [4, 30, 5, 30];
  if (age < 65) return [5, 30, 5, 30];
  return 'keep';
}

async function runOne(cdp, disease, status) {
  const c = CONFIG.COL[disease];
  const READ = "JSON.stringify((function(){var S=" + JSON.stringify([status]) + ";var trs=[].slice.call(document.querySelectorAll('.el-table__body-wrapper tbody tr'));for(var i=0;i<trs.length;i++){var td=[].slice.call(trs[i].querySelectorAll('td'));var tx=td.map(function(x){return (x.textContent||'').replace(/\\s+/g,' ').trim();});var o={idx:i,name:tx[" + c.name + "],last:tx[" + c.last + "],status:tx[" + c.status + "],age:tx[" + c.age + "]};if(o.name&&S.indexOf(o.status)>=0)return o;}return null;})())";
  await cdp.send('Page.navigate', { url: CONFIG.BASE_URL + '/?t=' + Date.now() + '#' + CONFIG.ROUTE[disease] });
  await sleep(4500);
  let raw = 'null';
  for (let a = 0; a < 6 && (!raw || raw === 'null'); a += 1) {
    await cdp.ev("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').trim()==='查询';})[0];if(b)b.click();return 'ok';})()");
    for (let k = 0; k < 8 && (!raw || raw === 'null'); k += 1) { await sleep(900); raw = await cdp.ev(READ); }
  }
  const row = JSON.parse(raw || 'null');
  if (!row) return { done: true, name: '-' };
  const clicked = await cdp.ev("(function(o){var trs=[].slice.call(document.querySelectorAll('.el-table__body-wrapper tbody tr'));var tr=trs[o.idx];var a=tr&&tr.querySelector('a.cli-btn');if(!a)return 'no';a.click();return 'ok';})(" + JSON.stringify({ idx: row.idx }) + ")");
  if (clicked !== 'ok') throw new Error('无法打开患者档案');
  await sleep(4000);
  const name = await cdp.ev("(function(){var m=(document.body.innerText||'').match(/^\\s*([\\u4e00-\\u9fa5]{2,4})\\s+(\\d{1,3})岁/m);return m?m[1]:'';})()");
  if (name !== row.name) throw new Error('姓名校验失败');
  await cdp.ev(fs.readFileSync(path.join(__dirname, CONFIG.FLOW[disease]), 'utf8'));
  if (!(await cdp.ev('window.__openFollowup()'))) throw new Error('随访表单未打开');
  const params = { date: pickDate(row.last), sbp: 110 + Math.floor(Math.random() * 30), dbp: 71 + Math.floor(Math.random() * 19), hr: 60 + Math.floor(Math.random() * 30), ex: exerciseFor(disease, Number(row.age)), expect: row.name };
  const out = await cdp.ev('window.__followup(' + JSON.stringify(params) + ')');
  if (!out || !out.ok) throw new Error((out && out.why) || '保存失败');
  return { done: false, name: row.name };
}

async function main() {
  const disease = (argv('disease', 'hp') || 'hp').toLowerCase();
  const status = argv('status', '快到期');
  const count = Math.max(1, Number(argv('count', 5)));
  if (!CONFIG.ROUTE[disease]) throw new Error('--disease 只能是 hp 或 dm');

  await ensureBrowser();
  const cdp = await connect();
  let ok = 0, fail = 0;
  log('目标: ' + CONFIG.LABEL[disease] + ' / ' + status + ' / 最多 ' + count + ' 人');
  for (let i = 0; i < count; i += 1) {
    const t0 = Date.now();
    let name = '-', success = false, lastErr = '';
    for (let attempt = 1; attempt <= CONFIG.RETRY; attempt += 1) {
      try {
        const r = await runOne(cdp, disease, status);
        name = r.name;
        if (r.done) { log('[进度] 无更多' + status + '患者 - 结束'); cdp.ws.close(); log('完成: 成功 ' + ok + ' / 失败 ' + fail); return; }
        success = true; break;
      } catch (e) {
        lastErr = String((e && e.message) || e);
        await sleep(1500);
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (success) { ok += 1; log('[进度] ' + name + ' - 成功 - ' + secs + 's'); }
    else { fail += 1; log('[进度] ' + name + ' - 失败(已跳过) - ' + secs + 's'); errlog(name + ' | ' + lastErr); }
  }
  cdp.ws.close();
  log('完成: 成功 ' + ok + ' / 失败 ' + fail + ' （错误详见 error.log）');
}

main().catch(e => { log('启动失败: ' + String((e && e.message) || e)); process.exit(1); });
