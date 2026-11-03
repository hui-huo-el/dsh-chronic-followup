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
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ==== 固定配置（如需换环境只改这里）====
const CONFIG = {
  EDGE_PATH: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  DEBUG_PORT: Number(process.env.CDP_PORT) || 9222,
  USER_DATA_DIR: path.join(__dirname, 'edge-profile'),
  BASE_URL: process.env.FOLLOWUP_BASE_URL || 'http://183.204.254.20:8088',
  ROUTE: { hp: '/archives/high-blood-pressure-records', dm: '/archives/diabetes-records' },
  COL: { hp: { name: 0, last: 7, next: 8, status: 9, age: 11 }, dm: { name: 0, last: 6, next: 7, status: 8, age: 10 } },
  LABEL: { hp: '高血压', dm: '糖尿病' },
  FLOW: { hp: 'scripts/flow-hypertension.js', dm: 'scripts/flow-diabetes.js' },
  RETRY: 3,
  MIN_WAIT: 20,   // 保存成功后最小等待秒数（防风控）
  MAX_WAIT: 35,   // 保存成功后最大等待秒数
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = line => process.stdout.write(line + '\n');
const errlog = line => { try { fs.appendFileSync(path.join(__dirname, 'error.log'), new Date().toISOString() + ' ' + line + '\n'); } catch (e) {} };

function argv(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(res => rl.question(q, ans => res(String(ans || '').trim())));

function pageText(cdp) {
  return cdp.ev("(document.body.innerText||'').replace(/\\s+/g,' ')");
}

async function waitForLogin(cdp) {
  const isReady = async () => {
    const txt = await pageText(cdp).catch(() => '');
    return txt.includes('退出') && txt.includes('国家基本公共卫生服务系统');
  };
  if (await isReady()) { console.log('已检测到登录态，继续。'); return true; }
  console.log('⚠️ 请在弹出的浏览器中完成登录，登录成功进入系统首页后，请回到此窗口按【回车键】继续...');
  let entered = false;
  const onData = () => { entered = true; };
  process.stdin.once('data', onData);
  for (let i = 0; i < 1800; i += 1) {
    if (entered) break;
    if (await isReady()) break;
    await sleep(1000);
  }
  process.stdin.removeListener('data', onData);
  const ok = await isReady();
  console.log(ok ? '登录确认完成。' : '未检测到登录态，仍按已登录继续（如失败请重跑）。');
  return ok;
}

async function ensureSystem(cdp) {
  const host = new URL(CONFIG.BASE_URL).host;
  await cdp.send('Page.navigate', { url: CONFIG.BASE_URL + '/#/archives/home' });
  await sleep(4500);
  let txt = await pageText(cdp);
  if (txt.includes('国家基本公共卫生服务系统')) return cdp;
  // 平台二级页：点「进入系统」（可能在新标签页打开）
  await cdp.ev("(function(){var bs=[].slice.call(document.querySelectorAll('button'));var b=bs.filter(function(x){return (x.innerText||'').indexOf('进入系统')>=0;})[0];if(b){b.click();return 'ok';}return 'no';})()");
  for (let i = 0; i < 15; i += 1) {
    await sleep(1200);
    const pages = await listPages();
    const target = pages.find(p => (p.url || '').includes(host));
    if (!target) continue;
    const next = await attach(target.webSocketDebuggerUrl).catch(() => null);
    if (!next) continue;
    const body = await pageText(next).catch(() => '');
    if (body.includes('国家基本公共卫生服务系统')) return next;
  }
  throw new Error('未能进入基本公共卫生系统，请先在浏览器中登录并进入系统后重试');
}

async function menu() {
  console.log('');
  console.log('请选择任务：');
  console.log('  1. 高血压 - 快到期');
  console.log('  2. 高血压 - 过期');
  console.log('  3. 糖尿病 - 快到期');
  console.log('  4. 糖尿病 - 过期');
  console.log('  5. 高血压 - 自定义截止日期');
  console.log('  6. 糖尿病 - 自定义截止日期');
  console.log('  7. 全部清空（跑完所有过期和快到期）');
  for (;;) {
    const c = await ask('请输入序号(1-7): ');
    const simple = {
      '1': { disease: 'hp', statuses: ['快到期'] },
      '2': { disease: 'hp', statuses: ['过期'] },
      '3': { disease: 'dm', statuses: ['快到期'] },
      '4': { disease: 'dm', statuses: ['过期'] },
      '7': { disease: 'both', statuses: ['过期', '快到期'] },
    };
    if (simple[c]) return { ...simple[c], cutoff: null };
    if (c === '5' || c === '6') {
      let d = '';
      while (!/^\d{4}-\d{2}-\d{2}$/.test(d)) d = await ask('请输入截止日期 YYYY-MM-DD: ');
      return { disease: c === '5' ? 'hp' : 'dm', statuses: ['过期', '快到期'], cutoff: d };
    }
  }
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

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
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

async function listPages() {
  return JSON.parse(await httpGet('http://127.0.0.1:' + CONFIG.DEBUG_PORT + '/json/list') || '[]').filter(t => t.type === 'page');
}

async function connect() {
  const pages = await listPages();
  if (!pages.length) throw new Error('没有可用标签页');
  return attach(pages[0].webSocketDebuggerUrl);
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

async function runOne(cdp, disease, statuses, cutoff) {
  const T = { nav: 0, query: 0, open: 0, form: 0, flow: 0 };
  const c = CONFIG.COL[disease];
  const READ = "JSON.stringify((function(){var S=" + JSON.stringify(statuses) + ";var trs=[].slice.call(document.querySelectorAll('.el-table__body-wrapper tbody tr'));var out=[];for(var i=0;i<trs.length;i++){var td=[].slice.call(trs[i].querySelectorAll('td'));var tx=td.map(function(x){return (x.textContent||'').replace(/\\s+/g,' ').trim();});var o={idx:i,name:tx[" + c.name + "],last:tx[" + c.last + "],next:tx[" + c.next + "],status:tx[" + c.status + "],age:tx[" + c.age + "]};if(o.name&&S.indexOf(o.status)>=0)out.push(o);}return out;})())";
  let t0 = Date.now();
  await cdp.send('Page.navigate', { url: CONFIG.BASE_URL + '/?t=' + Date.now() + '#' + CONFIG.ROUTE[disease] });
  await sleep(4500);
  T.nav = Date.now() - t0;
  t0 = Date.now();
  let rows = [];
  for (let a = 0; a < 6 && !rows.length; a += 1) {
    await cdp.ev("(function(){var b=[].slice.call(document.querySelectorAll('button')).filter(function(x){return (x.innerText||'').trim()==='查询';})[0];if(b)b.click();return 'ok';})()");
    for (let k = 0; k < 8 && !rows.length; k += 1) { await sleep(900); rows = JSON.parse((await cdp.ev(READ)) || '[]'); }
  }
  T.query = Date.now() - t0;
  if (!rows.length) return { done: true, name: '-' };
  let row = null;
  for (const r of rows) { if (cutoff && r.next && String(r.next) > cutoff) continue; row = r; break; }
  if (!row) return { done: true, name: '-' };
  t0 = Date.now();
  const clicked = await cdp.ev("(function(o){var trs=[].slice.call(document.querySelectorAll('.el-table__body-wrapper tbody tr'));var tr=trs[o.idx];var a=tr&&tr.querySelector('a.cli-btn');if(!a)return 'no';a.click();return 'ok';})(" + JSON.stringify({ idx: row.idx }) + ")");
  if (clicked !== 'ok') throw new Error('无法打开患者档案');
  await sleep(4000);
  const name = await cdp.ev("(function(){var m=(document.body.innerText||'').match(/^\\s*([\\u4e00-\\u9fa5]{2,4})\\s+(\\d{1,3})岁/m);return m?m[1]:'';})()");
  if (name !== row.name) throw new Error('姓名校验失败');
  T.open = Date.now() - t0;
  t0 = Date.now();
  await cdp.ev(fs.readFileSync(path.join(__dirname, CONFIG.FLOW[disease]), 'utf8'));
  if (!(await cdp.ev('window.__openFollowup()'))) throw new Error('随访表单未打开');
  T.form = Date.now() - t0;
  t0 = Date.now();
  const params = { date: pickDate(row.last), sbp: 110 + Math.floor(Math.random() * 30), dbp: 71 + Math.floor(Math.random() * 19), hr: 60 + Math.floor(Math.random() * 30), ex: exerciseFor(disease, Number(row.age)), expect: row.name };
  const out = await cdp.ev('window.__followup(' + JSON.stringify(params) + ')');
  T.flow = Date.now() - t0;
  if (!out || !out.ok) throw new Error((out && out.why) || '保存失败');
  return { done: false, name: row.name, timings: T };
}

async function runTask(cdp, disease, statuses, cutoff, maxCount, timing) {
  let ok = 0, fail = 0;
  for (let i = 0; i < maxCount; i += 1) {
    const t0 = Date.now();
    let name = '-', success = false, lastErr = '', timings = null;
    for (let a = 1; a <= CONFIG.RETRY; a += 1) {
      try {
        const r = await runOne(cdp, disease, statuses, cutoff);
        if (r.done) { console.log('[进度] ' + CONFIG.LABEL[disease] + ' 无更多匹配患者 - 结束'); return { ok, fail, empty: true }; }
        name = r.name; timings = r.timings; success = true; break;
      } catch (e) {
        lastErr = String((e && e.message) || e);
        await sleep(1200);
      }
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (success) {
      ok += 1;
      const extra = timing && timings ? ' [nav ' + timings.nav + 'ms / query ' + timings.query + 'ms / open ' + timings.open + 'ms / form ' + timings.form + 'ms / flow ' + timings.flow + 'ms]' : '';
      console.log('[进度] ' + name + ' - 成功 - ' + secs + 's' + extra);
      const wait = CONFIG.MIN_WAIT + Math.floor(Math.random() * (CONFIG.MAX_WAIT - CONFIG.MIN_WAIT + 1));
      console.log('[防风控] 摸鱼等待 ' + wait + ' 秒...');
      await sleep(wait * 1000);
    } else {
      fail += 1;
      console.log('[进度] ' + name + ' - 失败(已跳过) - ' + secs + 's');
      errlog(name + ' | ' + lastErr);
    }
  }
  return { ok, fail, empty: false };
}

async function main() {
  let task = null;
  if (process.argv.includes('--disease')) {
    const d = (argv('disease', 'hp') || 'hp').toLowerCase();
    task = { disease: d === 'both' ? 'both' : d, statuses: [argv('status', '快到期')], cutoff: argv('cutoff', '') || null };
  }

  await ensureBrowser();
  const cdp = await connect();
  await ensureSystem(cdp);
  await waitForLogin(cdp);

  if (!task) task = await menu();

  let maxCount = Number(argv('count', 0));
  if (!maxCount) {
    const a = await ask('本次最大人数（直接回车默认 10 人）: ');
    maxCount = Number(a) > 0 ? Number(a) : 10;
  }

  const diseases = task.disease === 'both' ? ['hp', 'dm'] : [task.disease];
  let totalOk = 0, totalFail = 0;
  for (const d of diseases) {
    console.log('== 开始 ' + CONFIG.LABEL[d] + ' / ' + task.statuses.join('+') + (task.cutoff ? ' / 截止 ' + task.cutoff : '') + ' / 上限 ' + maxCount + ' 人 ==');
    const r = await runTask(cdp, d, task.statuses, task.cutoff, maxCount, process.argv.includes('--timing'));
    totalOk += r.ok; totalFail += r.fail;
  }
  cdp.ws.close();
  rl.close();
  console.log('完成: 成功 ' + totalOk + ' / 失败 ' + totalFail + '（错误详见 error.log）');
}

main().catch(e => { console.log('启动失败: ' + String((e && e.message) || e)); try { rl.close(); } catch (x) {} process.exit(1); });
