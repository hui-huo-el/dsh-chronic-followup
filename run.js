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
let SHARED_CDP = null;
let LAUNCHED_EDGE_PID = null;

const CONFIG = {
  EDGE_PATH: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  DEBUG_PORT: Number(process.env.CDP_PORT) || 9222,
  USER_DATA_DIR: path.join(__dirname, 'edge-profile'),
  BASE_URL: process.env.FOLLOWUP_BASE_URL || 'http://183.204.254.22:38888',
  ROUTE: { hp: '/archives/high-blood-pressure-records', dm: '/archives/diabetes-records' },
  COL: { hp: { name: 0, last: 7, next: 8, status: 9, age: 11 }, dm: { name: 0, last: 6, next: 7, status: 8, age: 10 } },
  LABEL: { hp: '高血压', dm: '糖尿病' },
  FLOW: { hp: 'scripts/flow-hypertension.js', dm: 'scripts/flow-diabetes.js' },
  RETRY: 3,
  MIN_WAIT: 8,   // 保存成功后最小等待秒数（防风控）
  MAX_WAIT: 12,   // 保存成功后最大等待秒数
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

function isSystemUrl(u) {
  if (typeof u !== 'string') return false;
  if (/passport|login|signin/i.test(u)) return false;
  // 不校验 IP/端口：只要命中系统内页特征即视为已登录态
  return /#\/(workbench|archives|main|subsystem|high-followup|diabetes-followup)/i.test(u) || u.includes('#/');
}

function looksLoggedIn(txt) {
  if (!txt) return false;
  return txt.includes('退出') || txt.includes('国家基本公共卫生') || txt.includes('档案名册') || txt.includes('待办事项') || txt.includes('常用系统');
}

async function waitSystem(cdp, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const u = await cdp.ev('location.href').catch(() => '');
    if (isSystemUrl(u)) return true;
    const txt = await pageText(cdp).catch(() => '');
    if (looksLoggedIn(txt)) return true;
    await sleep(800);
  }
  return false;
}

function pageText(cdp) {
  return cdp.ev("(document.body.innerText||'').replace(/\\s+/g,' ')");
}

async function waitForLogin(cdp) {
  const ready = async () => {
    const u = await cdp.ev('location.href').catch(() => '');
    if (isSystemUrl(u)) return true;
    const txt = await pageText(cdp).catch(() => '');
    return looksLoggedIn(txt);
  };
  if (await ready()) { console.log('已检测到登录态，继续。'); return true; }
  console.log('⚠️ 请在弹出的浏览器中完成登录，登录成功进入系统首页后，请回到此窗口按【回车键】继续...');
  let entered = false;
  const onData = () => { entered = true; };
  process.stdin.once('data', onData);
  for (let i = 0; i < 1800; i += 1) {
    if (entered) break;
    if (await ready()) break;
    await sleep(1000);
  }
  process.stdin.removeListener('data', onData);
  const ok = await ready();
  console.log(ok ? '登录确认完成。' : '未检测到登录态，仍按已登录继续（如失败请重跑）。');
  return ok;
}

async function findLoggedInPage() {
  const pages = await listPages();
  for (const p of pages) {
    if (!p.webSocketDebuggerUrl) continue;
    const c = await attach(p.webSocketDebuggerUrl).catch(() => null);
    if (!c) continue;
    const u = await c.ev('location.href').catch(() => '');
    if (isSystemUrl(u)) return c;
    const txt = await pageText(c).catch(() => '');
    if (looksLoggedIn(txt)) return c;
    try { c.ws.close(); } catch (e) {}
  }
  return null;
}

async function ensureSystem(cdp) {
  const host = new URL(CONFIG.BASE_URL).host;
  const existing = await findLoggedInPage();
  if (existing) {
    const u = await existing.ev('location.href').catch(() => '');
    if (isSystemUrl(u)) return existing;
  }
  const u0 = await cdp.ev('location.href').catch(() => '');
  if (!isSystemUrl(u0) && !looksLoggedIn(await pageText(cdp).catch(() => ''))) {
    await cdp.send('Page.navigate', { url: CONFIG.BASE_URL + '/' }).catch(() => {});   // 只落到站点根
  }
  await sleep(2000);
  if (await waitSystem(cdp, 10000)) return cdp;

  // 平台二级页：点「进入系统」（可能新开标签页）
  await cdp.ev("(function(){var els=[].slice.call(document.querySelectorAll('button,a'));var x=els.filter(function(b){return (b.innerText||'').indexOf('进入系统')>=0;})[0];if(x){x.click();return 'ok';}return 'no';})()").catch(() => 'no');

  for (let i = 0; i < 20; i += 1) {
    await sleep(1000);
    const pages = await listPages();
    const cands = pages.filter(p => (p.url || '').includes(host));
    for (const p of cands) {
      const c = await attach(p.webSocketDebuggerUrl).catch(() => null);
      if (!c) continue;
      if (await waitSystem(c, 2500)) return c;
    }
  }

  // 兜底：只要页面已登录就继续（避免误判卡死）
  const txt = await pageText(cdp).catch(() => '');
  if (looksLoggedIn(txt)) {
    console.warn('未确认到公卫系统首页，但检测到登录态，继续执行。');
    return cdp;
  }
  throw new Error('未能进入基本公共卫生系统：请确认浏览器已在 ' + CONFIG.BASE_URL + ' 登录并进入系统；若已登录仍报错，请关闭多余空白标签页后重试（脚本会优先选中已登录标签页）');
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
      '2': { disease: 'hp', statuses: ['过期'], auto: true },
      '3': { disease: 'dm', statuses: ['快到期'] },
      '4': { disease: 'dm', statuses: ['过期'], auto: true },
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
  const edgeChild = spawn(CONFIG.EDGE_PATH, [
    '--remote-debugging-port=' + CONFIG.DEBUG_PORT,
    '--user-data-dir=' + CONFIG.USER_DATA_DIR,
    '--no-first-run', '--no-default-browser-check',
    CONFIG.BASE_URL + '/',
  ], { detached: true, stdio: 'ignore' });
  edgeChild.unref();
  LAUNCHED_EDGE_PID = edgeChild.pid;
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

function closeLaunchedBrowser() {
  if (!LAUNCHED_EDGE_PID) return;
  try {
    const { spawnSync } = require('node:child_process');
    spawnSync('taskkill', ['/PID', String(LAUNCHED_EDGE_PID), '/T', '/F'], { timeout: 10000 });
  } catch (e) {
    try { process.kill(LAUNCHED_EDGE_PID); } catch (err) {}
  }
  LAUNCHED_EDGE_PID = null;
}

async function connect() {
  const host = new URL(CONFIG.BASE_URL).host;
  const pages = await listPages();
  if (!pages.length) throw new Error('没有可用标签页');
  const sys = pages.filter(p => (p.url || '').includes(host) && p.url !== 'about:blank');
  const pick = sys.find(p => isSystemUrl(p.url)) || sys[0] || pages.find(p => p.url !== 'about:blank') || pages[0];
  return attach(pick.webSocketDebuggerUrl);
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

async function waitText(cdp, txt, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await cdp.ev("(function(){var t=((document.body&&document.body.innerText)||'');return t.indexOf(" + JSON.stringify(txt) + ")>=0;})()").catch(() => false);
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

async function clickLabel(cdp, labels) {
  const expr = "(function(L){var els=[].slice.call(document.querySelectorAll('a,li,div,span,button,.el-menu-item,.el-submenu__title'));var hit=null;for(var i=0;i<els.length;i++){var e=els[i];if(!e.getClientRects().length)continue;var tx=(e.innerText||'').trim();if(!tx)continue;for(var j=0;j<L.length;j++){if(tx.indexOf(L[j])>=0){if(!hit||tx.length<hit.len)hit={el:e,len:tx.length};break;}}}if(!hit)return 'no';hit.el.click();return 'ok';})(" + JSON.stringify(labels) + ")";
  return cdp.ev(expr).catch(() => 'no');
}

async function pageLen(cdp) {
  return cdp.ev('((document.body && document.body.innerText)||"").trim().length').catch(() => 0);
}

async function hasBlankFuse(cdp) {
  const len = await pageLen(cdp);
  if (len < 30) return true;
  const menus = await cdp.ev("document.querySelectorAll('.el-menu-item,.el-submenu__title,.menu-item,button').length").catch(() => 0);
  return !menus;
}

// 等待元素（10s），超时刷新一次重试；仍失败按白屏熔断
async function waitSel(cdp, sel, ms, desc) {
  const once = () => cdp.ev('new Promise(function(res){var t0=Date.now();var tick=function(){var ok=document.querySelector(' + JSON.stringify(sel) + ');var len=((document.body && document.body.innerText)||"").trim().length;if(ok&&len>=20)return res("ok");if(Date.now()-t0>' + ms + ')return res("timeout");setTimeout(tick,300);};tick();})').catch(() => 'timeout');
  if ((await once()) === 'ok') return true;
  if (await hasBlankFuse(cdp)) throw new Error('页面疑似白屏，请手动刷新（' + (desc || sel) + '）');
  console.log('等待 ' + (desc || sel) + ' 超时，刷新页面重试一次...');
  await cdp.ev('location.reload()').catch(() => {});
  await sleep(4000);
  if ((await once()) === 'ok') return true;
  if (await hasBlankFuse(cdp)) throw new Error('页面疑似白屏，请手动刷新（刷新后仍未加载：' + (desc || sel) + '）');
  throw new Error('页面加载超时（' + (desc || sel) + '）');
}

// 模拟点击进入名册（严禁改 hash / Page.navigate 跳子页）
async function reattachSystemPage() {
  const host = new URL(CONFIG.BASE_URL).host;
  const pages = await listPages();
  const cands = pages.filter(p => (p.url || '').includes(host) || (p.url || '').includes('183.204'));
  for (const p of cands) {
    const c = await attach(p.webSocketDebuggerUrl).catch(() => null);
    if (!c) continue;
    const txt = await pageText(c).catch(() => '');
    if (txt.includes('国家基本公共卫生服务系统') || txt.includes('档案名册')) return c;
    try { c.ws.close(); } catch (err) {}
  }
  return null;
}

async function openRosterByMenu(cdp, disease) {
  const label = CONFIG.LABEL[disease];
  const roster = label + '档案名册';
  const has = async () => (await cdp.ev("((document.body&&document.body.innerText)||'').indexOf(" + JSON.stringify(roster) + ")>=0").catch(() => false)) === true;

  for (let i = 0; i < 10; i += 1) {
    if (!(await has())) {
      // 表单页/患者页：先关闭回到名册页，并等待菜单渲染完成
      if ((await clickLabel(cdp, ['关闭'])) === 'ok') {
        await sleep(1000);
        await waitText(cdp, roster, 8000);
      }
    }
    if (!(await has())) {
      if ((await clickLabel(cdp, ['首页', '工作台'])) === 'ok') {
        await sleep(1000);
        await waitText(cdp, roster, 8000);
      }
    }
    if (!(await has())) {
      await clickLabel(cdp, ['业务中心']);
      await sleep(1500);
      await clickLabel(cdp, ['基本公共卫生服务系统', '进入系统']);
      await waitText(cdp, '国家基本公共卫生服务系统', 10000);
      const nx = await reattachSystemPage();
      if (nx) { cdp = nx; SHARED_CDP = nx; }
      await waitText(cdp, roster, 8000);
    }
    if (!(await has())) {
      await clickLabel(cdp, ['基本公卫管理']);
      await sleep(1200);
      await waitText(cdp, roster, 6000);
    }
    if (await has()) {
      const clk = await clickLabel(cdp, [roster]);
      if (clk === 'ok') {
        await sleep(1200);
        // 等表格与查询按钮完全渲染
        const ready = await waitText(cdp, '查询', 10000);
        await waitSel(cdp, '.el-table, .el-table__body-wrapper', 12000, '名册表格').catch(() => {});
        if (ready && !(await hasBlankFuse(cdp))) return cdp;
      }
    }
    await sleep(1000);
  }
  throw new Error('页面疑似白屏，请手动刷新（多次尝试仍未找到「' + roster + '」菜单）');
}

async function runOne(cdp, disease, statuses, cutoff) {
  const T = { nav: 0, query: 0, open: 0, form: 0, flow: 0 };
  const c = CONFIG.COL[disease];
  const READ = "JSON.stringify((function(){var S=" + JSON.stringify(statuses) + ";var trs=[].slice.call(document.querySelectorAll('.el-table__body-wrapper tbody tr'));var out=[];for(var i=0;i<trs.length;i++){var td=[].slice.call(trs[i].querySelectorAll('td'));var tx=td.map(function(x){return (x.textContent||'').replace(/\\s+/g,' ').trim();});var o={idx:i,name:tx[" + c.name + "],last:tx[" + c.last + "],next:tx[" + c.next + "],status:tx[" + c.status + "],age:tx[" + c.age + "]};if(o.name&&S.indexOf(o.status)>=0)out.push(o);}return out;})())";
  let t0 = Date.now();
  cdp = await openRosterByMenu(cdp, disease);
  if (SHARED_CDP) cdp = SHARED_CDP;
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
  return { done: false, name: row.name, timings: T, cdp };
}

async function runTask(cdp, disease, statuses, cutoff, maxCount, timing) {
  let ok = 0, fail = 0;
  for (let i = 0; i < maxCount; i += 1) {
    const t0 = Date.now();
    let name = '-', success = false, lastErr = '', timings = null;
    for (let a = 1; a <= CONFIG.RETRY; a += 1) {
      try {
        const r = await runOne(cdp, disease, statuses, cutoff);
        if (r && r.cdp) cdp = r.cdp;
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
  try {
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
    if (task.auto) {
      maxCount = 9999;
      console.log('「过期」分类：不限制人数，自动跑到清空为止。');
    } else {
      const a = await ask('本次最大人数（直接回车默认 10 人）: ');
      maxCount = Number(a) > 0 ? Number(a) : 10;
    }
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
    // 全部任务结束
  } catch (e) {
    console.log('执行中断: ' + String((e && e.message) || e));
  } finally {
    closeLaunchedBrowser();
    console.log('已清理脚本启动的浏览器进程。');
  }
}

process.on('SIGINT', () => { closeLaunchedBrowser(); process.exit(0); });

main().catch(e => { closeLaunchedBrowser(); console.log('启动失败: ' + String((e && e.message) || e)); try { rl.close(); } catch (x) {} process.exitCode = 1; });
