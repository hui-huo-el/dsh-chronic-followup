#!/usr/bin/env node
/**
 * sync-to-github.mjs — 用 GitHub Git Data API 提交整个目录，无需安装 git。
 * 用法：GH_TOKEN=xxx node scripts/sync-to-github.mjs --owner <owner> --repo <repo> [--private] [--message "feat: ..."]
 * 行为：仓库不存在则创建；把当前目录（遵守 .gitignore 的排除项）提交到默认分支。
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const flag = n => argv.includes('--' + n);

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('missing GH_TOKEN'); process.exit(1); }
const OWNER = arg('owner');
const REPO = arg('repo');
if (!OWNER || !REPO) { console.error('usage: --owner <owner> --repo <repo> [--private]'); process.exit(1); }
const MESSAGE = arg('message', 'chore: sync from local workspace ' + new Date().toISOString());

const EXCLUDE = /^(node_modules|\.git)(\\|$)|^\.github\/workflows\/|progress-.*\.jsonl$|worker-status\.json$|port\.txt$|\.env/i;

async function api(method, url, body) {
  const payload = body ? JSON.stringify(body) : null;
  const data = await new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com',
      path: url,
      method,
      headers: {
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-chronic-followup-sync',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 60000,
    }, res => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: b }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('github api timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
  let json = null;
  try { json = data.text ? JSON.parse(data.text) : null; } catch (e) { json = null; }
  if (data.status < 200 || data.status >= 300) {
    const err = new Error(method + ' ' + url + ' -> ' + data.status + ' ' + (json && json.message ? json.message : data.text.slice(0, 200)));
    err.status = data.status;
    err.body = json;
    throw err;
  }
  return json;
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (EXCLUDE.test(rel)) continue;
    if (e.isDirectory()) walk(full, base, out);
    else out.push({ rel, full });
  }
  return out;
}

// 1. 仓库
let repo;
try {
  repo = await api('GET', '/repos/' + OWNER + '/' + REPO);
  console.log('repo exists:', repo.full_name);
} catch (e) {
  if (e.status !== 404) throw e;
  repo = await api('POST', '/user/repos', { name: REPO, private: flag('private'), description: 'DSH skill plugin: chronic disease follow-up automation', auto_init: false });
  console.log('repo created:', repo.full_name, 'private=' + repo.private);
}
const branch = repo.default_branch || 'main';

// 2. 现有 HEAD（空仓库时没有）
let headSha = null;
try {
  const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + branch);
  headSha = ref.object.sha;
} catch (e) { if (e.status !== 404 && e.status !== 409) throw e; }

// 3. tree（内联文件内容，避免空仓库/批量 blob 的限制）
const files = walk(process.cwd());
const entries = files.map(f => ({ path: f.rel, mode: '100644', type: 'blob', content: fs.readFileSync(f.full, 'utf8') }));
const tree = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', headSha ? { base_tree: headSha, tree: entries } : { tree: entries });
const commit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
  message: MESSAGE,
  tree: tree.sha,
  ...(headSha ? { parents: [headSha] } : {}),
});
if (headSha) {
  await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + branch, { sha: commit.sha, force: false });
} else {
  await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha });
}
// 保证 main 分支存在（默认分支名可能不同）
try { await api('PATCH', '/repos/' + OWNER + '/' + REPO, { default_branch: branch }); } catch (e) {}
console.log(JSON.stringify({ repo: OWNER + '/' + REPO, branch, commit: commit.sha, files: entries.length }, null, 1));
