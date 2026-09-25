# dsh-plugin-guard

给 DeepSeek Harness 的插件守卫：**安装前静态预检 + 安装时三选弹窗 + 插件级版本回退**，并且在 DSH 已经起不来的时候仍然能工作。

它补的是生态里没人管的那一段：社区插件在「点击下载」的瞬间没有任何兼容性判定，`dsh.engines.dsh` 缺失或走了全新安装时更是完全不查；出了问题之后也只能整 profile 事务回滚，而不是把这一个插件退回上一个能用的版本。

## 它做什么

| 能力 | 位置 | 说明 |
|---|---|---|
| 安装前静态预检 | 客户端拦截 + host 网关 + 终端 CLI | 解析目标包（npm / 本地路径 / git），按下面的规则出结论 |
| 安装时弹窗 | 浏览器模态框 | 阻断/警告时列出逐条证据，三个动作：**取消** / **强行继续**（写入跳过日志，事后可查）/ **装指定版本**（改 spec 后重新预检） |
| 插件版本历史 | `设置 → 插件 → 插件守卫` | 记录每次成功启动时各插件的版本，标出「上次成功启动的版本」，一键回退 |
| 配置预检 | CLI `configcheck` / 设置页 | 用 DSH 自己的 `!!js` YAML 方言解析 profile 补丁层、home 补丁与所有 agent preset，**加载每条行插件自己的 `Config` schema** 逐条校验；并检出 preset 显示名重复与混在 `.agent-presets` 里的备份目录 |
| 启动检测预检 | CLI `bootcheck` / 设置页 / 安装后自动 | 静态：每个声明 `dsh.client` 的包必须有 `exports["./client"]` 且文件真实存在（否则就是浏览器里的 `bundle script … failed to load`）；运行期：读 host 当前要发给浏览器的图，校验 `rev/entries/batches` 形状与每条目能否解析出 bundle |
| 回退安全网 | 自动 | **安装前自动快照** profile 的清单与补丁；回退前也快照；**回退失败自动还原**；备份可在设置页单条「还原」或「删除」，也可用 `restore` / `backups delete` |
| 终端保命 | `dsh-plugin-guard` | 不依赖 DSH 能启动：`status` / `precheck` / `history` / `rollback` / `restore` / `backup` / `skips` |

## 安装

要求：DSH ≥ `0.1.5-rc.1`，Node `^22.19.0 || >=24.0.0`。**无依赖、无需构建**。

```sh
# 从本地目录 / 解开的压缩包
dsh plugin --profile web add file:/absolute/path/to/dsh-plugin-guard

# 从 git 仓库
dsh plugin --profile web add git+https://github.com/SHXJSH-1/dsh-plugin-guard.git
```

包声明了 `dsh.bundle.patch`，官方 CLI 会把它加进 `dsh.profile.bundles` 并挂载行 `ui-plugin-guard`；重启 `dsh web` 后生效。安装失败时先看 `<profile>\pnpm-workspace.yaml` 里的 `allowBuilds` 是否还留着 `set this to true or false` 这类占位符（pnpm 会因此非零退出），以及 `package.json` 不能带 BOM。

## 配置

**推荐用 DSH 自己的设置面板**：`设置 → 插件 → 插件守卫`。安装时拦截、预检、历史回退、备份还原、崩溃监视/开机自启开关都在那里，不需要手改文件。

CLI（`dsh-plugin-guard ...`）与少数场景用环境变量；**本插件不含任何密钥、Token 或密码**，所以 `.env.example` 里全是可选项与占位符（见该文件，复制成 `.env` 才生效）：

| 变量 | 用途 | 默认值 / 获取方式 |
|---|---|---|
| `DSH_HOME` | DSH 的 profile 根目录 | `%USERPROFILE%\.dsh`（Windows）/ `~/.dsh`；DSH 自己也在用它 |
| `DSH_PROFILE` | 不带 `--profile` 时 CLI 的目标 profile | 依次尝试 `--profile` → 本变量 → 子命令 → 桌面版选择 → 名为 `web` 的 profile → 唯一候选 |
| `DSH_PLUGIN_GUARD_HOME` | 守卫自己的数据目录（`history.json`、`backups/`、`watchdog.log`） | `<DSH_HOME>/plugin-guard` |
| `DSH_PLUGIN_GUARD_DSH` | `dsh` CLI 入口路径，CLI 不在 PATH 时用 | 自动从全局 npm 前缀 / DSH 安装树推断 |
| `DSH_PLUGIN_GUARD_REGISTRY` | 预检读取包元数据用的 npm registry | `https://registry.npmjs.org` |
| `DSH_PLUGIN_GUARD_WATCHDOG_ANSWER` | 崩溃监视弹窗的测试替身：`yes` / `no` / `cancel`（设了就不弹窗，直接按该值执行） | 空（正常交互） |
| `DSH_DESKTOP_DEFAULT_PROFILE` | 仅桌面版：默认打开的 profile | DSH 桌面版自己写入 |

代码全部通过 `process.env.<NAME>` 读取，没设就用上面这些默认值，不会因为缺变量而失败。`APPDATA` / `USERPROFILE` 是 Windows 自带变量，只用来定位用户的「启动」文件夹与用户目录。

## 开发与测试

没有构建步骤：源码即产物（`lib/*.js` 是 ESM，`lib/cli.mjs` 是 CLI 入口）。编辑器/类型提示配置放在 `jsconfig.json`。

```sh
node scripts/check.mjs      # 自检：模块可解析、清单声明的路径都存在、浏览器半区能渲染
```

`scripts/check.mjs` 检查四件事：`lib/` 下每个模块能被 `node --check` 解析；`package.json` 里声明的路径（`main` / `exports` / `bin` / `dsh.bundle.patch` / `files`）都真实存在；`cordis.patch.yml` 插入行的 `name` 与本包名一致（不一致的话，装的人一律 `cannot resolve` 起不来）；浏览器半区能被渲染出来（`test/tab-render-check.mjs`：用假 `react` + 假 `__ModuleLoader__` 直接调 tab 组件，能抓"渲染期就抛错"这类致命问题）。

`examples/` 里是故意写坏的夹具（悬空补丁行、入口 import 不到文件的包），照各自的 README 用，别直接留在 profile 里。

## 判定规则

严重度：`blocker`（会让 DSH 起不来）· `warn`（可强行继续）· `info`（只记录，不弹窗）。

| 规则 | 依据 | 严重度 |
|---|---|---|
| `engines-dsh` | `dsh.engines.dsh` / `engines.dsh` 与当前 DSH 版本比对 | 不匹配 → blocker |
| `compat-declared-incompatible` | `dsh.compatibility.dshReleases` 把当前版本标为非 compatible | blocker |
| `compat-nearest-incompatible` | 当前版本未列出，最近的可比版本被标为非 compatible | warn |
| `peer-mismatch` | 目标声明的 peer 版本与「profile + DSH 安装树」实际可用的版本不符（`@deepseek-ai/*` 核心包由 DSH 安装树提供） | warn |
| `peer-outside-profile` | profile 的 pnpm 配置是 `autoInstallPeers: false`，且目标的 peer 只在 DSH 安装树里 → 这类包的补丁行若引用这些包的子路径，装后校验会判「入口引用不可解析」并自动回滚 | warn |
| `dep-duplicate-version` | 目标依赖的版本与已有版本不同 → pnpm 会并存两份 | warn |
| `row-id-collision` / `row-name-collision` | 目标 `cordis.patch.yml` 要插入的 id / name 已被占用（本地源可读文件时按行比对） | blocker |
| `row-unresolvable` | 补丁行引用的包在 profile 与 DSH 安装树里都解析不到 | warn |
| `bundle-entry` | 目标已在 `dsh.profile.bundles` 里，重复安装可能重复挂载 | warn |
| `already-installed` / `version-change` | 同版本重复安装；或将升级/降级某插件（附回退目标） | warn |
| `engines-dsh-missing` / `peer-absent` / `row-check-skipped` / `compat-unlisted` | 无法判定或无法比对的信息 | info |
| `package-size` | 解包后体积与文件数（来自 registry 的 `dist.unpackedSize` / `fileCount`），看一眼就知道装完会占多少磁盘 | info |
| `package-stale` | 该版本的发布时间（来自 registry 的 `time` 表），用来判断这个包是不是已经停更 | info |

版本比较按**版本序**（等价 `includePrerelease`）：插件写 `>=0.1.2-rc.1` 时，`0.1.5-rc.2` 视为满足——严格 node-semver 会拒绝这一对，那会把整个市场都误报成不兼容。真正要求更新版本（`>=0.2.0`）时照旧报警。

## 拦截点

社区插件市场、插件管理器 Tab、预设中心都通过同一个 `pluginManager` cordis 服务安装（`ctx.inject(["pluginManager"])` → `face.install(spec)`）。本插件在客户端半区 inject 到该服务后替换其实例上的 `install`，因此**不改任何第三方代码**就能拦住这些入口。

## 数据位置

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/plugin-guard/history.json` | 每次成功启动的插件版本快照，以及每个插件的版本与成功启动次数 |
| `$DSH_HOME/plugin-guard/skips.json` | 被「强行继续」跳过的警告 |
| `$DSH_HOME/plugin-guard/rollbacks.json` | 回退记录与 CLI 输出尾部 |
| `$DSH_HOME/plugin-guard/restores.json` | 每次还原（含自动还原）的记录 |
| `$DSH_HOME/plugin-guard/backups/<时间戳>/` | 变更前的 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` / `pnpm-workspace.yaml`；`manifest.json` 记 `kind: auto`（安装前自动快照）或 `manual`，以及当时的插件版本。可单条删除（只删带自家 `manifest.json` 的目录，且拒绝指向备份根之外） |
| `$DSH_HOME/plugin-guard/cache/` | registry packument 缓存（10 分钟） |

`DSH_PLUGIN_GUARD_HOME` 可覆盖根目录；`DSH_PLUGIN_GUARD_REGISTRY` 可指向镜像；`DSH_PLUGIN_GUARD_DSH` 可指定 DSH 安装目录。

## 终端命令

```sh
dsh-plugin-guard status                     # profile、DSH 版本、CLI 可用性、历史计数
dsh-plugin-guard precheck <spec>            # 安装前预检；blocker 时退出码 1
dsh-plugin-guard install <spec>             # 命令行版守卫：预检 → 快照 → 官方 CLI 安装 → 启动检测自检（非通过时需 --yes 确认）
dsh-plugin-guard configcheck [<文件>...]    # 校验补丁层与 agent preset 的 config；blocker 时退出码 1
dsh-plugin-guard bootcheck                  # 校验 client bundle 声明与文件是否落盘
dsh-plugin-guard history [<插件>]           # 版本历史与上次成功启动的版本
dsh-plugin-guard rollback <插件>[@<版本>]   # 省略版本 = 上次成功启动的版本；先备份再经官方 CLI 装回
dsh-plugin-guard restore [<备份id>|latest]  # 把清单与补丁还原到某次备份（默认最近一次）
dsh-plugin-guard backup                     # 只备份 profile 的清单与补丁
dsh-plugin-guard backups                    # 列出备份（id / 类型 / 占用空间 / 时间 / 原因，末行给总量）
dsh-plugin-guard backups delete <id|latest>  # 删除某一份备份
dsh-plugin-guard skips                      # 被强行继续的警告
```

`rollback` 失败时（例如目标版本不存在）会自动用刚做的备份还原 `package.json` / `pnpm-lock.yaml` / `cordis.patch.yml` / `pnpm-workspace.yaml`，并提示 `node_modules` 可能仍是半更新状态、需要再跑一次安装。要关掉这个行为用 `--no-restore-on-fail`。

## 两张自检

**配置预检 `configcheck`** 回答"这份配置挂得上吗"。它用 DSH 自己的 YAML 方言（含 `!!js` 表达式节点）解析文件，对每条带 `config` 的行解析出该行的插件模块、读取其 `Config` schema 并校验，报错文本与 loader 一致。它还会列出：

- `preset-name-collision`：多个 preset 目录用同一个显示名（选错就挂载到另一份配置）；
- `preset-backup-dir`：`.agent-presets` 里混着 `*.bak-*` 之类目录（会作为第二个 preset 出现，且常带失效配置）；
- `config-parse`：文件本身解析失败。

因为要 import 第三方插件模块，它在**子进程**里跑（CLI 直接调用，host 通过 `/configcheck` 起子进程），绝不在 host 进程内加载插件代码。

**启动检测预检 `bootcheck`** 回答"浏览器/主机还能启动插件吗"。静态那一半逐个包检查 `dsh.client` 声明形状（`platform` 字符串、`inject`/`external` 字符串数组）、`exports["./client"]` 是否可解析、bundle 文件是否存在、`dsh.bundle.patch` 是否存在，**以及 `dsh.profile.bundles` 里每个包名能否解析**（`bundle-package-missing`：悬空的 bundle 条目会让 DSH 在 `loadProfile` 阶段就抛 `cannot resolve profile bundle …`，此时它一个文件都还没写）；运行期那一半读 host 的组合结果，校验 `rev` 是字符串、`entries`/`batches` 是数组、每条目能解析出客户端 bundle。页面上那句 `client-modules: boot manifest batches must be an array` 与 `bundle script … failed to load` 都属于这一层。

**安装后自动冒烟**：每次通过 `pluginManager` 安装成功后，浏览器半区自动跑一次 `bootcheck`；若发现 blocker，直接弹窗告诉你"这个包可能让下次启动失败"，并提示可以用 `restore` 回到安装前状态。


## 崩溃监视：DSH 起不来时自己弹窗

插件拦不住"启动本身"——它自己就跑在 DSH 里。loader 挂到一半就退出时，任何插件代码都不会执行，所以"在崩溃的那次里面弹窗"是不可能做到的。守卫换了个做法：**由一次成功启动派发一个独立守护进程**（detached，不注册服务、不写开机项、不加计划任务、不动你的启动器），由它在外面盯着下一次启动。

它怎么判断"这次启动失败了"——三条信号加一条确认规则，每一条都是踩出来的：

1. **启动改写了 include 根**：`profiles/<profile>/cordis.yml` 在组合阶段会被重写（组合成功后才写），覆盖"装载阶段失败"这一类；
2. **有 DSH 进程在启动这个 profile**：守护进程每 2 秒看一眼 node 进程表，发现新的 `dsh/lib/bin.js web` 进程就记一次启动尝试。这是唯一能看见"一个文件都没写就死掉"那类失败的信号——实测 bundle 悬空时 `loadProfile` 直接抛错，profile 目录**零文件改动**；
3. **主动体检**：只要 profile 出现阻塞级问题（比如上面那个悬空 bundle 条目），守护进程会在**你启动之前**就弹窗说"下次启动会失败"——这类故障是确定性的，不用等谁来启动它；
4. **成功确认**：`plugin-guard/history.json` 被写入启动记录**并且**那个进程在记录之后再活过 30 秒。这 30 秒是踩出来的：我们自己的行先挂载、启动记录 20 秒后写出，而排在后面的行随后加载失败——记录写完 1 秒后进程就死了，只看记录会把它误判成"启动成功"。

没等到确认（进程退出、或 120 秒宽限期过完）→ 弹**原生 Windows 对话框**（`[System.Windows.Forms.MessageBox]`，不依赖 DSH、不依赖浏览器）：

```
DSH 等了 120 秒仍未启动成功，判定为启动失败。

可疑项：
× [row-package-missing] 补丁行 boot-probe 引用的包解析不到

[是] 回退到最近一次备份（2026-09-23T15-00-51-953Z）
[否] 只移除最近安装的插件
[取消] 什么都不做，命令写进 LAST-RESCUE.txt

对应命令（也可手动执行）：
  node "…\lib\cli.mjs" restore latest --profile web
  node "…\lib\cli.mjs" safe-mode --profile web
```

可疑项来自启动检测（静态），所以弹窗会点名是哪一行 / 哪个包，而不是只说"起不来了"。

- 点「是」/「否」→ 当场执行（跑的就是上面那套已经实测过的 CLI 代码：`restore latest` / `safe-mode`），结果写进 `plugin-guard/watchdog.log`，并再弹一个只读的结果框告诉你成没成；
- 点「取消」→ 什么都不改；对话内容与两条命令**始终**会写进 `plugin-guard/LAST-RESCUE.txt`，即使对话框没弹出来或你直接关了它。

```
dsh-plugin-guard watchdog status   # 在不在跑、pid、最近 8 行日志
dsh-plugin-guard watchdog off      # 关掉：写 watchdog.stop 标记并杀掉当前守护进程
dsh-plugin-guard watchdog on       # 打开：下次成功启动重新派发
dsh-plugin-guard watchdog run      # 前台跑一轮（调试用，Ctrl+C 结束）
```

默认开启，每次成功启动自愈（pid 死了会自动再派一个）。边界：守护进程**由成功启动派发**，它保护的永远是"下一次"——如果新装的包让 DSH **第一次启动就崩**，那一次没有人能弹窗，只能用终端 `dsh-plugin-guard restore latest --profile <名字>` 或 `safe-mode` 救回来。它最长存活 7 天后自行退出，不驻留系统。

### 电脑重启之后还在吗

**默认不在**：守护进程不注册服务、不加计划任务、不开机自启，重启电脑就没了（要等 DSH 成功启动一次才会再派一个）。要覆盖"重启后第一次启动就崩"这种最尴尬的情况，把自启打开：

```
dsh-plugin-guard watchdog autostart on      # 往「启动」文件夹写一个静默 .vbs，只拉起守护进程
dsh-plugin-guard watchdog autostart status  # 看开没开、文件在哪
dsh-plugin-guard watchdog autostart off     # 关掉（删掉那个文件）
```

- 它**不启动 DSH**、也不改你的启动方式：登录后只是让守护进程在场，你照旧点自己那个启动器（或者敲 `dsh web`）。
- **关掉是立刻生效的**：`autostart off`（或设置页里取消勾选）会删掉登录项**并且当场停掉正在跑的守护进程**，不用等重启、也不用等下一次启动。再打开则立刻重新起一个。
- **设置页里也有同一个开关**：设置 → 插件 → 插件守卫 → 状态卡最下面那行「常驻守护进程（开机自启）」复选框（走 `/api/plugin-guard/autostart`，和上面的命令共用同一份写入逻辑，不会两边不一致）。
- 生成的是纯 ASCII 的 `.vbs`（默认 DSH_HOME 时路径写成 `%USERPROFILE%`；非默认路径则整个文件用 **UTF-16LE + BOM** 写——WSH 认这个编码，实测不写 BOM 会让中文用户名变成乱码），位置：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\dsh-plugin-guard-watchdog.vbs`——可以直接打开看，也可以直接删。
- **单实例**：开机自启和"DSH 成功启动"都想派守护进程时，后到的会自己退出（日志 `another watchdog is already running (pid …); exiting`），不会弹两次窗。
- 自启只在**登录之后**生效；如果 DSH 是用服务方式在登录前拉起的，那时守护进程还不在场。
- 踩过的坑 1（已修）：通过 `…\node_modules\dsh-plugin-guard\lib\watchdog.js`（junction）启动时，`import.meta.url` 会解析成真实路径、与 `process.argv[1]` 不等，早期代码因此判定"我不是入口"→ **守护进程静默退出、什么都不做**。现在两边都用 `realpathSync` 比较。
- 踩过的坑 2（已修）：**别的 DSH_HOME / 别的 profile 的 `dsh web` 看起来一模一样**。守护进程原来见到任何 DSH 进程就当成"自己 profile 的启动尝试"，实测造成一次假弹窗（隔离 lab 启动时，正式环境的守护进程弹了窗）。现在进程只有在**本 profile 已经露出启动痕迹**（`cordis.yml` 被改写）时才被计入；"一个文件都不写"的那一类由主动体检负责，不靠进程信号。

## 回退的安全网

0. **每次安装前自动快照**：预检通过或被强行继续后、真正调用安装之前，host 先复制一份 profile 清单与补丁（`kind: auto`）。所以"上一个已知状态"永远存在，不需要你先见之明；取消安装不会浪费快照。自动快照保留最近 25 份、全部备份保留最近 40 份，超出即删最旧。
1. 点回退 → 先把 profile 的四个文件复制进 `plugin-guard/backups/<时间戳>/`，并在 `manifest.json` 里记下当时的插件版本；
2. 经官方 `dsh plugin add` 装回目标版本；
3. 安装失败 → **自动还原**第 1 步的备份（`restores.json` 留痕）；安装成功但你重启后发现问题 → 用 `dsh-plugin-guard restore <备份id>` 或设置页里的「还原到这个备份」回到当初的状态。
4. **还原之后守卫会再跑一次 `dsh plugin --profile <p> install` 对齐 `node_modules`，并复验启动检测**。备份里只有清单、没有依赖树；少了这一步就会变成"回退 → 还是起不来 → 再回退"的死循环——实测还原后清单里有 `X`、`node_modules` 里没有 `X`，DSH 在 `loadProfile` 直接报 `cannot resolve profile bundle "X"`。
5. `safe-mode` 现在认两个可疑对象、取时间更新的那个：**最近一次安装**（来自安装前自动快照）和**最近改动过的插件目录**（按 `node_modules/<包>/package.json` 的 mtime）。第二个是为命令行安装准备的——那种安装没有快照，实测正是靠 mtime 认出了元凶；移错了也不会丢，移之前先备份，输出里写清移的是谁。

还原只改这 4 个文件，`node_modules` 由下一次 `dsh plugin` 安装对齐。整个过程不需要 DSH 能启动。

不带 `--profile` 时会依次尝试：`--profile` 参数 → `DSH_PROFILE` → argv 里的子命令 → 桌面版选择 → `profiles/` 下名为 `web` 的 profile → 唯一候选。全部失败时 `status` 与 `precheck` 仍以「无 profile」模式报告。

## 已知边界

- **唯一写入器**：安装与回退都通过官方 `dsh plugin` CLI，本插件从不自己改 profile 文件。
- **零第三方依赖**：设置页的 Tab 用的是官方 `settings.plugins.tab` 插槽（由 `@deepseek-ai/dsh-client-ui-settings-plugins` 声明），预检框、版本历史、一键回退、终端命令都不需要插件市场或插件管理器存在。没有它们时「安装时拦截」自然失效——因为 GUI 里根本没有安装入口可拦。
- **非 web profile**：启动记录与 `webServer` 解耦（host 半区 `inject: []`，路由在 `ctx.inject(['webServer'])` 里注册），所以 headless / sdk / acp profile 也会写版本历史，`dsh-plugin-guard rollback` 在那些 profile 一样可用；HTTP 路由只在有 `webServer` 的 profile 上出现。
- **插件是 per-profile 的**：守卫只保护它被安装进的那个 profile；其他 profile 需要各自 `dsh plugin --profile <名字> add`。
- **更新路径**：插件管理器自己的更新按钮先经过它自带的 `dsh.engines.dsh` 门禁与 host 路由；本插件只拦安装（`install`），不拦 `update(id)`——那个 API 拿到的是行 id 而不是包名，猜映射比不拦更危险。
- **命令行安装**：`dsh plugin add …` 在启动器层执行，插件进程根本不在场，**没有任何钩子能拦**（这是设计边界，不是遗漏）。要命令行也受保护就用 `dsh-plugin-guard install <spec>`：预检 → 结论非「通过」时询问（脚本用 `--yes`）→ 安装前自动快照 → 官方 CLI 安装 → 失败自动还原 → 成功则跑启动检测（静态）。用原始 `dsh plugin add` 装的包，只能在**装之前**手动 `precheck`、或**下次启动**被 `bootcheck` 抓。
- **创意工坊**：里面装**插件**走的是同一个 `pluginManager` 服务（`market/lib/client.js:1492` → `face.install`），**会被拦**；装**预设/皮肤/宠物**走的是工坊自己的网关（`gateway.install`），**不被拦**——皮肤宠物是资源无风险，预设坏了要靠 `configcheck`。
- **官方安装器通道**：DSHCode / checkout 版 web 上走官方 `/plugin-installer` loopback RPC 的安装不经过 `pluginManager` 服务，本插件拦不到。
- **git 源**：克隆前拿不到清单，只能报「无法预检」并让你决定。
- **行级冲突**：npm 发布包在安装前拿不到包内 `cordis.patch.yml`，只能按包名核对；本地路径 / `link:` 源可做完整行比对。但**"peer 只在 profile 之外"这类注定触发装后回滚的形状能提前判**（`peer-outside-profile`，只看清单不读包体）。
- **浏览器界面**：装机后需要重启 `dsh web`（或另起一个实例）才会加载；弹窗与设置页需要人工点击验证。
- **崩溃监视的边界**：它由**成功启动**派发，所以第一次启动就崩的安装没人给你弹窗（用终端 `restore`/`safe-mode`）；同一 profile 只保证一个守护进程，多个 profile 会各自有一个；最长活 7 天。
- **极短的失败可能漏掉进程信号**：启动进程只活 1 秒左右时可能整个落在两次轮询之间（实测遇到过）。确定性的故障由"主动体检"兜住，纯运行期的偶发崩溃可能两样都漏——那时你看到的是启动器自己的报错。
- **别只信启动记录**：见上文第 4 条，记录可能"早写"，所以守护进程要求记录之后进程再活 30 秒。副作用：你启动成功后 30 秒内就把 DSH 关掉，这次算"未确认"（不会误报，因为记录到进程死亡的时间差小于 30 秒时它才会去问你）。
- **本地 `file:` 插件是快照**：`file:` 安装会把包复制进 `node_modules`，你随后在源码里新增的文件不会自动进去（`link:`/junction 则实时生效）。少文件时 loader 报 `Cannot find module …`——**静态校验查不出这类**（那要复刻 Node 的模块解析），只能靠上面的启动信号抓到；`file:` 装的守卫改完代码要重新 `dsh plugin --profile <p> add file:<路径>` 才会生效。
- **配置预检的边界**：只验"声明形状与 schema"；配置里含 `!!js` 表达式时运行期可能算出别的值（这类行会标注"含表达式"）；行插件的模块导入不了时归入"未校验"而不猜。
- **启动检测预检的边界**：它发现不了**浏览器侧陈旧页面**（例如 `?rev=` 与当前图不一致导致的 bundle 加载失败）——那种情况硬刷新即可；它也不拦官方 `/plugin-installer` 通道的安装（那份安装没有自动冒烟）。
- **历史记录按 profile 分开**（键为 `<profile>::<包名>`）：同一插件装在不同 profile、版本不同时不会互相覆盖；早期版本写的"裸键"数据只用于补全本 profile 已装插件的版本，不会把别的 profile 的行带出来。

## 验证状态：哪些是真跑过的，哪些还只是单元级

写下来是为了不把"测试通过"当成"生产可用"——本项目已经出现过一次这种情况（Tab 的样式从没被注入，单元测试全绿，真实界面却是无样式纯文本）。

**已在真实环境跑通**

- 浏览器里打开 `设置 → 插件 → 插件守卫`：Tab 渲染、样式生效、状态卡显示真实数字
- 在真实 Tab 里点「预检」→ 走真实 host 网关 → 真实 registry → 结论渲染
- **安装拦截**：在插件管理器的安装框里输入包名并点安装 → 弹出守卫的预检窗；点取消后确认没有任何东西被安装（profile 指纹未变）
- host 全部 12 条路由；启动记录写入；`configcheck` / `bootcheck`
- 隔离 profile：真降级、真失败→自动还原、真还原、真删除备份
- **web profile 上真回退失败**（目标版本不存在）→ HTTP 500 + 自动还原 4 个文件，profile 指纹前后一致
- **非 web profile**（headless）：host 半区确实加载并写了启动记录（验证 `inject: []` 的解耦）
- 终端 `dsh-plugin-guard` 通过 `.npm` shim 在任意目录运行
- **崩溃监视**：`watchdog on` 真派出了独立守护进程；它真的检测到启动尝试（`cordis.yml` mtime 变化 + 新 dsh 进程）；用一行坏补丁（`boot-probe → definitely-not-installed-pkg`）制造真崩溃后，它真的判定失败并执行了回退（日志：`operator chose rollback: ok ✓ 已从备份 2026-09-23T15-00-51-953Z 还原`），补丁层回到 `[]`；原生 `MessageBox` 确认能真正阻塞出窗口（进程存活直到被杀）。
- **三类失败分别实测过**（都在隔离 lab 里、都靠日志与 HTTP 状态判定，不靠"觉得"）：
  - **悬空 bundle 条目**（清单里有、`node_modules` 里没有）→ 主动体检 `profile is not bootable: bundle-package-missing` → 弹窗点名 `× [bundle-package-missing] profile bundles 里的 dsh-quick-ask 解析不到` → 回退 + 对齐依赖 → 依赖真的回来了、lab 又能服务（HTTP 401）；
  - **loader 装载失败**（`bad-import-fixture`：入口 import 一个不存在的文件）→ 静态校验**查不出**（这正是选它的原因）→ 靠启动信号抓到，并识破"记录写完 2 秒后进程就死"（`start recorded a boot and died 2s later`）→ 回退 + 对齐；
  - **健康启动不误报**：正常起完 → `start attempt detected` → `start confirmed`，全程没有弹窗。
- **救援闭环**：还原/移除之后自动 `dsh plugin install` 对齐依赖并复验（实测 `✓ 依赖已对齐` + `启动检测（静态）：通过`）；`safe-mode` 靠 mtime 认出了命令行装进来的元凶 `dsh-bad-import-fixture` 并移除，之后 lab 真的能启动。

**仍然只有单元级或从未在真实环境执行**

- 安装**成功后**的冒烟弹窗（需要真装一个包才会触发）
- 弹窗里「用所选版本安装」这条分支
- **崩溃监视的人机链路**：完整流程是用 `DSH_PLUGIN_GUARD_WATCHDOG_ANSWER=yes|cancel` 自动应答跑通的，真人坐那儿点「是」/「否」/「取消」还没走过（对话框本身已确认能弹出来并阻塞，第二个"处理结果"框只在非自动应答时出现，也还没被真人看过）
- **开机自启（登录项）已在真实重启中验证通过**：2026-09-24 12:57:44 开机 → `autostart.log` 记下 `12:59:15 autostart`（登录时触发）→ 守护进程 `pid 17572` 启动时间 12:59:15，**早于用户启动 DSH**；随后 DSH 启动被检测到并 `start confirmed (served a page)`；DSH 起来时没有产生第二个守护进程（单实例生效）。
- **开机自启的边角**：`.vbs` 用 `cscript` 编译通过（exit 0；含中文路径时用 UTF-16 写也验证过）、真的拉起过守护进程、那个进程活过了测试进程树。
- **设置页那个开关**：`/api/plugin-guard/autostart` 在一次真实的运行实例上跑通了（开→文件出现且内容正确 + 守护进程现在就起；关→文件消失 + **守护进程当场被杀**、`watchdog.stop` 标记出现；`/status` 的 `autostart.enabled` 跟着变）。组件渲染用一个假 React 的渲染检查（`test/tab-render-check.mjs`）验证过：tab 不再抛错、复选框在树里、`onChange` 已接线、提示文案在——但**肉眼效果还没人看过**（要等 DSH 重启后打开设置页）。
- `bootcheck` 的 fail 分支在真实 host 上（真实启动检测一直是 pass；fail 只用替身测过）
- 两个实例同时写 `plugin-guard/history.json` 的并发竞态
- **结构性盲区**：如果插件自己的客户端 bundle 加载失败，Tab 根本不会出现，界面上无从察觉——那时只能靠终端 CLI

## license

MIT，见 [LICENSE](./LICENSE)。
