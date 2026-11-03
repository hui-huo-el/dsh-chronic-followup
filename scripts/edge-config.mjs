#!/usr/bin/env node
/**
 * edge-config.mjs — 后台跑批的固定浏览器配置。
 *
 * 设计目标：浏览器路径 / CDP 端口 / 目标地址全部由本文件与本地逻辑决定，
 * 模型不再需要临时查询进程或端口。所有纯逻辑（探测、启动、等待）都压进代码。
 *
 * 环境变量（可选覆盖）：
 *   EDGE_PATH        Edge 可执行文件路径
 *   EDGE_PROFILE_DIR 独立启动 Edge 时使用的用户数据目录
 *   FOLLOWUP_BASE_URL 公卫系统根地址（不写死在仓库里）
 *   CDP_PORT        已运行的 Edge CDP 端口（默认自动探测）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

export const EDGE_PATH = process.env.EDGE_PATH
  || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

export const EDGE_PROFILE_DIR = process.env.EDGE_PROFILE_DIR
  || 'C:\\Users\\Administrator\\.dsh-edge-followup\\profile';

export const BASE_URL = process.env.FOLLOWUP_BASE_URL || '';

export const CDP_PORT = Number(process.env.CDP_PORT || 0);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpText(port, pathname, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const req = http.get('http://127.0.0.1:' + port + pathname, { timeout }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => (b += c));
      res.on('end', () => resolve(b));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('CDP timeout')); });
  });
}

async function isEdgeCdp(port) {
  try {
    const info = JSON.parse(await httpText(port, '/json/version'));
    return /Edg\//.test(info.Browser || '') || /Edg\//.test(info['User-Agent'] || '');
  } catch (e) {
    return false;
  }
}

/** 本机已运行的 Edge 进程命令行（无进程时返回空数组）。 */
function runningEdgeCommandLines() {
  if (process.platform !== 'win32') return [];
  try {
    const out = cp.execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | ForEach-Object { $_.CommandLine }",
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (e) {
    return [];
  }
}

/** 从正在运行的 Edge 中找出可用的 CDP 端口（优先显式端口，校验是 Edge）。 */
export async function detectCdpPort() {
  if (CDP_PORT && (await isEdgeCdp(CDP_PORT))) return CDP_PORT;
  const ports = [];
  for (const line of runningEdgeCommandLines()) {
    const m = line.match(/--remote-debugging-port=(\d+)/);
    if (m && Number(m[1]) > 0 && !ports.includes(Number(m[1]))) ports.push(Number(m[1]));
  }
  for (const p of ports) {
    if (await isEdgeCdp(p)) return p;
  }
  return 0;
}

/** 读取 Edge 以 --remote-debugging-port=0 启动时写入的 DevToolsActivePort。 */
function portFromDevToolsFile(profileDir) {
  try {
    const txt = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8');
    const p = Number(txt.split(/\r?\n/)[0].trim());
    return p > 0 ? p : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * 确保本机有可用的 Edge CDP 端口：
 * 1) 复用已运行的 Edge（自动探测端口）；
 * 2) 没有则用固定路径启动 Edge，并等待其调试端口就绪。
 * 全程无模型参与。
 */
export async function ensureEdge() {
  let port = await detectCdpPort();
  if (port) return port;

  if (!fs.existsSync(EDGE_PATH)) {
    throw new Error('EDGE_NOT_FOUND: ' + EDGE_PATH);
  }
  fs.mkdirSync(EDGE_PROFILE_DIR, { recursive: true });
  try { fs.unlinkSync(path.join(EDGE_PROFILE_DIR, 'DevToolsActivePort')); } catch (e) {}

  cp.spawn(EDGE_PATH, [
    '--remote-debugging-port=0',
    '--user-data-dir=' + EDGE_PROFILE_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
    'about:blank',
  ], { detached: true, stdio: 'ignore', windowsHide: false }).unref();

  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    port = portFromDevToolsFile(EDGE_PROFILE_DIR);
    if (port && (await isEdgeCdp(port))) return port;
  }
  throw new Error('EDGE_CDP_NOT_READY');
}

export { httpText };
