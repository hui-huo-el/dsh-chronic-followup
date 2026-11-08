> ### ⚠️ 免责与合规声明（必读）
> **本插件（dsh-chronic-followup）仅为基层慢病随访录入提供辅助与效率支持，严禁用于任何形式的虚假随访记录生成、伪造或数据造假。**
> 1. **辅助性质**：本工具仅作为人工录入的辅助手段，**最终数据准确性、合规性及临床合理性须由使用者（医务人员）逐条审核并承担全部责任**。使用者应在保存前对每条记录进行人工确认。
> 2. **使用授权**：请在获得所在机构正式授权的合规环境（如测试/演练环境）中使用。**严禁未经许可在正式业务系统批量运行。**
> 3. **风险自担**：本软件按“现状”（AS IS）提供，不附带任何明示或暗示的担保。作者不对因使用本工具产生的任何直接或间接损失承担责任。
> 4. **隐私保护**：使用者须自行确保运行环境与数据存储符合《个人信息保护法》及医疗健康数据相关法规的要求。
> 5. 本插件仅为插件开发学习使用，如下载后请在下载测试学习开发之后 24 小时内删除。
> **使用本工具即表示您已阅读、理解并同意上述全部条款。如不同意，请立即停止使用并删除本软件。**

# dsh-chronic-followup

> DeepSeek Harness（DSH）技能插件：**基层慢病（高血压 / 糖尿病）公卫随访批量录入助手**。
> 在已登录的国家基本公共卫生服务系统里，按《慢病随访自动化作业指导书》逐人完成
> 「新增随访 → 引用医疗数据 → 核对用药 → 保存」，并保证每条记录的日期、血压、心率、
> 体征、用药、运动、目标体重都符合规则。

## 一、功能

| 能力 | 说明 |
| --- | --- |
| 名册筛选 | 支持「过期 / 快到期」两种随访状态，自动从名册首行走起 |
| 日期规则 | 到期日 = 上次随访 + 3 个月；实际随访日 = **到期日前随机提前 0~20 天**，时刻 07~19 点随机，不早于上次、不落在未来 |
| 症状 | 照抄上次随访 |
| 血压 | 收缩压 110–139 / 舒张压 71–89 随机，且不与上次完全相同 |
| 心率 | 60–89 随机，且不与上次相同（糖尿病表单无此字段则跳过） |
| 引用医疗数据 | 先取消「全选」；勾选体温/脉率/呼吸/空腹血糖/身高/体重/腰围等体征（**血压不勾**）；用药只勾最近一次随访记录 |
| 用药核对 | 提交后逐项核对：药物名称 / 剂型 / 规格 / 频率 / 用量 / 用法 / 依从性 |
| 目标体重 | = 原体重 |
| 运动指导 | 高血压：≥80 岁 `3/30 5/30`、75–79 岁 `4/30 5/30`、其余保持；糖尿病：另加 <65 岁 `5/30 5/30`，65–74 岁保持 |
| 糖尿病专项 | 足背动脉搏动统一「触及正常」；主食(克/天) 统一 `240/240` |
| 极致降本 | **纯本地逻辑驱动、静默输出**：脚本内完成全部判断与循环，模型只读一行 JSON 摘要，不产生整页 HTML/AX 树回显，Token 消耗极低 |
| 安全校验 | 保存前校验页头患者姓名一致、用药行非空、必填项齐全；登录失效 / 页面卡死立即停止 |

## 二、安装（在 DSH 中）

### 方式 A：插件管理器（推荐，一键）
打开 **设置 → 插件 → 安装**，粘贴下面这条安装 spec：

```text
github:hui-huo-el/dsh-chronic-followup
```

> 仓库为 **private** 时，DSH/pnpm 需要凭据：先在本机配置 `GITHUB_TOKEN`（或 SSH key），
> 或用带凭据的写法 `github:hui-huo-el/dsh-chronic-followup#main` + 本机 `~/.npmrc` 的
> `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}`。设为 public 后上述原样即可安装。

### 方式 B：命令行（有 git 的机器）
```bash
dsh plugin add github:hui-huo-el/dsh-chronic-followup
```

### 方式 C：手动挂载（开发调试）
```bash
git clone https://github.com/hui-huo-el/dsh-chronic-followup.git
```
把仓库放进 profile 的 `node_modules/`，并在 `cordis.patch.yml` 追加：
```yaml
- id: dsh-chronic-followup
  name: "dsh-chronic-followup"
```

## 三、使用（独立运行，无需 DSH / 无需 AI）

> **首次运行流程**：双击 `run.bat` → 自动拉起 Edge → 控制台提示登录 → 在浏览器里登录并进入系统首页 → 回到窗口按【回车】（脚本同时会自动检测登录态）→ 选择任务菜单 →
> 输入人数上限（回车默认 10）→ 自动执行。菜单含：高血压/糖尿病的「快到期」「过期」、自定义截止日期（只跑到期日 ≤ 该日期）、全部清空。

### 双击运行（推荐）
1. 首次双击 `run.bat` → 自动拉起 Edge（独立配置目录 `edge-profile/`）；
2. 在窗口里**手动登录一次**，之后登录态会保留；
3. 再次双击 `run.bat` 即可开始默认任务（高血压 / 快到期 / 5 人）。

### 命令行运行
```bash
node run.js --disease hp --status 快到期 --count 5
node run.js --disease dm --status 过期 --count 10
```
- `--disease`：`hp` 高血压 / `dm` 糖尿病
- `--status`：`过期` / `快到期`
- `--count`：本次最多处理人数（遇无匹配患者自动结束）
- 单人失败自动重试 3 次，仍失败则跳过并写入 `error.log`
- 控制台每完成一人输出一行：`[进度] 姓名 - 成功/失败 - 耗时`

> 环境地址写死在 `run.js` 顶部 `CONFIG`（`EDGE_PATH` / `DEBUG_PORT` / `BASE_URL`），换环境只改这一处。

## 四、使用（DSH 插件模式，可选）

1. 在 DSH 会话里用 `browser_*` 打开系统并登录：
   ```
   http://<内网地址>:<端口>/#/archives/high-blood-pressure-records
   ```
2. 取得浏览器 CDP 端口（浏览器以 `--remote-debugging-port` 启动）：
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
     Where-Object { $_.CommandLine -like '*<profile-dir>*' } |
     Select-Object -First 1 -ExpandProperty CommandLine
   ```
3. 设置环境变量并先跑单人验证：
   ```bash
   export FOLLOWUP_BASE_URL="http://<内网地址>:<端口>"
   export CDP_PORT=<端口>
   node scripts/batch.mjs --disease hp --status 过期 --count 1
   ```
4. 确认该患者已从「过期」列表消失后放开批量：
   ```bash
   node scripts/worker.mjs --disease hp --status 过期 --max 200
   node scripts/worker.mjs --disease dm --status 快到期 --max 200
   ```
5. 每批结束看 `hp-progress.jsonl` / `dm-progress.jsonl` 的 `saved:true` 数量，与名册变化比对。

### 命令行参数（降本相关）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--silent` | 开 | 静默模式：过程零输出，仅结束打印一行 JSON 摘要 |
| `--debug` | 关 | 还原每步明细，仅排障时使用（会显著增加 Token） |
| `--concurrency` | 1 | 并发数 1–4；单标签页驱动，内部按 1 执行以免互相干扰 |
| `--chunk` | 4 | worker 每轮处理人数（一轮脚本 = 一次模型请求） |
| `--count` / `--max` | 1 / 500 | 单次执行人门限 / 连续执行上限 |

> 降本用法：`node scripts/worker.mjs --disease hp --status 过期 --max 100 --chunk 5`（默认静默，只回一行统计）

## 四、目录结构
```
dsh-chronic-followup/
├── lib/index.js                     # Cordis 插件入口（无副作用）
├── cordis.patch.yml                 # dsh.bundle.patch 指向的装载层
├── skills/chronic-followup/SKILL.md # 技能说明书（DSH 自动发现）
├── scripts/
│   ├── batch.mjs                    # 单人/小批量执行器
│   ├── worker.mjs                   # 连续批量执行器
│   ├── flow-hypertension.js         # 高血压页面流程（注入浏览器执行）
│   ├── flow-diabetes.js             # 糖尿病页面流程
│   └── sync-to-github.mjs           # 用 GitHub API 提交（无需 git）
├── examples/patient-sample.json     # 脱敏示例
└── .github/workflows/release.yml    # CI：校验 + tag 触发 npm 发布
```

## 五、隐私与合规
- **仓库不含任何真实患者数据**：`progress-*.jsonl`、`worker-status.json`、`port.txt` 全部被 `.gitignore` 排除，CI 也会检查并阻断误提交。
- 系统地址不写死：通过 `FOLLOWUP_BASE_URL` 注入，仓库里只有占位符。
- 运行日志仅保存在本机，按机构的数据安全要求定期清理。
- 请在取得机构授权、并在合规环境下使用；不要将随访数据导出到非受控位置。

## 六、自动更新（CI/CD）

> 本仓库当前令牌仅有 `repo` scope，GitHub 禁止经 API 写入 `.github/workflows/**`（404）。
> 工作流已放在 `ci/release.yml`，按 `ci/README.md` 两步启用即可（网页复制或换带 `workflow` scope 的令牌）。

- **本地改动 → 推送**（无需 git）：
  ```bash
  GH_TOKEN=<你的 token> node scripts/sync-to-github.mjs --owner hui-huo-el --repo dsh-chronic-followup
  ```
- **有 git 的机器**：`git add -A && git commit -m "feat: ..." && git push`
- **CI**：push 到 `main` 自动跑语法检查、包清单校验、患者数据泄露检查；打 `v*` tag 且配置了 `NPM_TOKEN` 时自动发布到 npm。

## 七、常见问题

| 现象 | 处理 |
| --- | --- |
| 启动报「未能进入基本公共卫生系统」 | 在打开的 Edge 窗口里手动登录并进入系统，然后重跑；登录态会保存在 `edge-profile/` |
| 现象 | 处理 |
| --- | --- |
| `no-target-row` | 名册里该状态的患者已处理完，或查询未返回（换状态/等页面刷新） |
| `name-mismatch` | 点错行或页面未切换，脚本会中止，不会写错人 |
| `followup-form-not-open` | 慢病管理菜单未展开，重试或手动点一次「高血压随访/糖尿病随访」 |
| 保存无「新增成功」 | 有必填项缺失，看返回的 `missing:` 列表补齐后重试 |

## License
MIT © 2026 hui-huo-el
