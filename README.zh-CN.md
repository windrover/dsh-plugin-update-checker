# dsh-plugin-update-checker

> [中文](./README.zh-CN.md) · [English](./README.md)

一个 DeepSeek Harness 插件：在 **内置插件（Built-in plugins）** 设置分区中增加一个 **检查更新（Check updates）** 按钮。点击后，它会扫描每个已安装插件的 (1) npm 上的最新发布版本 与 (2) 与当前运行 DSH 运行时的兼容性，并以每个插件一行的形式展示结果。

它与只读的插件清单页并列，本身**不提供任何配置**——只做汇报。更新或启停插件仍然在右侧栏的 **插件（Plugins）** 页面或通过 `dsh plugin` 完成。

## ✨ 它做什么

| 检查项 | 数据来源 | 说明 |
|---|---|---|
| **更新可用性** | npm 注册表（`latest` tag 与已安装版本对比） | 仅针对发布到注册表的包。通过 tarball / git / 本地路径安装的包不会发布到注册表，因此显示为 *不受支持（Unsupported）*，而绝不会错误地显示 *已是最新*。 |
| **兼容性** | 插件的 `@deepseek-ai/dsh*` `peerDependencies` 与当前 DSH 版本对比 | 复用 `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`——也就是启动器在启动时用的同一个判断函数。若在 `compatibility.json` 中授予了精确版本豁免，则显示为 *兼容（已豁免）*。 |

兼容性与更新可用性是**独立计算**的——注册表慢或不可达，永远不会掩盖不兼容的 peer 依赖；反之，纯本地包仍然会得到兼容性结论。

**扫描用哪个注册表**：不再写死 `registry.npmjs.org`。主机自己读配置（环境变量 → profile 的 `.npmrc` → 用户 `~/.npmrc`，取第一个命中的），再**并发探测、取最先成功的那个**。规则分三种：**什么都没配** → 竞速「启动器同款镜像 + 公共注册表」；**配的是公共默认值**（npm 会自动往 `~/.npmrc` 写 `registry=https://registry.npmjs.org/`）→ 保留它并把镜像挂在后面，两者皆公共、无泄露风险；**配的是其它地址**（公司内部源、私有源）→ **只用它一个，绝不与任何公共注册表竞速**，否则会把内部包名泄露给第三方。国内网络下差别很大——实测同一台机器上公共注册表约 11s、镜像约 0.2s；竞速保证慢的那个即使排在第一也不会拖住快的。清单里显式声明了 `publishConfig.registry` 的包仍以该注册表为准。获胜注册表随行返回，点「更新」时沿用它——**从哪读到版本，就从哪安装**。

> 宿主半身只声明了 `webServer`，而 `remote` 是**浏览器侧**服务；当前 cordis 版本里访问未声明的服务会直接抛错（`cannot get property ... without inject`），所以宿主**不能**去问插件管理器要注册表——上面这套读配置的方式正是为此设计的。

## 📸 位置

打开 **设置 → 内置插件**。该分区现在有两个标签页：

- **插件清单（Plugin list）** —— 只读清单（由 DSH 自带）。
- **检查更新（Check updates）** —— 本插件。展示当前 DSH 版本、**检查更新** 按钮，以及结果表格（插件 / 已安装版本 / 最新版本 / 兼容性 / 更新）。

检查是按需触发的：点击按钮，主机扫描，表格填充。某个清单损坏或注册表不可达，只会隔离到对应那一行——绝不会让整张报表空白。

## 📦 安装

### 方式 A —— 从本 GitHub 仓库直接安装（推荐）

1. 打开右侧栏 **插件（Plugins）** 页面 → **添加插件**。
2. 在来源框里填入下面任意一种安装描述符（启动器通过 `installBundle` 解析，和 GUI 用的是同一个原语）：

   ```text
   github:windrover/dsh-plugin-update-checker
   # 或完整 URL：
   https://github.com/windrover/dsh-plugin-update-checker
   ```

3. 重启以加载新 bundle：

   ```bash
   dsh check     # 铁律 #1：重启前先预检
   dsh restart   # 重新加载 web profile，新 bundle 随之加载
   ```

4. 打开 **设置 → 内置插件 → 检查更新 → 检查更新。**
   检查按钮发起的 `fetch('/api/plugin-update-checker/scan')` 在已认证的浏览器会话内执行，无需手动 token。

> 本仓库是 **公开** 的，所以从 GitHub 直接安装无需额外认证。在 `registry.npmjs.org` 不可达的网络下，启动器会自动改用 `registry.npmmirror.com`。

### 方式 B —— 本地链接（用于开发 / 改这个插件）

1. 把包 clone 到 profile 能链接的位置：

   ```bash
   # 例如放在你的 DSH 工作区里
   git clone https://github.com/windrover/dsh-plugin-update-checker dsh-plugin-update-checker
   ```

2. 链接进 profile：在 profile 清单中加入 `link:` 依赖与 bundles 条目：

   ```jsonc
   // ~/.dsh/profiles/<你的 profile>/package.json
   {
     "dependencies": {
       "dsh-plugin-update-checker": "link:/abs/path/to/dsh-plugin-update-checker"
     },
     "dsh": { "profile": { "bundles": [ "…", "dsh-plugin-update-checker" ] } }
   }
   ```

   然后安装。本 profile 下 **`npm install` 会拒绝 `link:` 协议**——改用 `pnpm`（profile 是 pnpm workspace，这也是 `dsh` 底层用的）：

   ```bash
   cd ~/.dsh/profiles/web
   pnpm install --registry=https://registry.npmmirror.com   # link: 依赖不联网
   ```

   `dsh` 的 `wire_link_plugin_deps` 会自动把插件 import 的 `@deepseek-ai/*` 软链进它自己的 `node_modules`，但**不会处理普通 npm 包**——所以要把那唯一一条真依赖手动预链（link 插件的已知坑：link 插件解析不到没提升到它树里的包）：

   ```bash
   mkdir -p dsh-plugin-update-checker/node_modules
   ln -sfn ~/.npm/_npx/<active-dsh-hash>/node_modules/semver \
           dsh-plugin-update-checker/node_modules/semver
   ```

3. 重启并打开（`dsh check && dsh restart`，再走方式 A 同样的设置路径）。

## 🔌 实现方式

一个包，两端：

- **主机（Host）**（`lib/index.js` → `lib/host/update-checker.js`）注册 `POST /api/plugin-update-checker/scan`，遍历 profile 的 bundles（通过 `ctx.remote.pluginManager.listBundles()`，回退到扫描 `node_modules`），读取每个清单、评估 peer 兼容性、探测注册表。`cordis.patch.yml` 添加 Loader 行。
- **浏览器（Browser）**（`lib/client.js`）向内置插件分区的 `settings.plugins.tab` 槽注册一个标签页，并用 `react`（`require("react")`）和 DSH 已暴露的设计 token 渲染结果。包的 `id` 等于包 `name`——这是 `dsh-client-modules` 强制的契约。

## 🧪 测试

```bash
node test/client-contract.test.mjs
```

锁定浏览器半边的契约（id == 包名、唯一一个 `settings.plugins.tab` 注册、可渲染的 body 组件）。主机扫描已在开发期对真实 profile 演练过，返回 `{ ok, dshVersion, checkedAt, plugins: [...] }`。

## 📝 局限

- **只读** —— 只汇报，不更新、不启停。
- **注册表可达性** —— 注册表检查需要能访问所配置注册表的网络；离线或防火墙后的主机每个包显示 *未知（Unknown）*。
- **本地 / git / tarball 包** —— 不发布注册表版本，其更新状态为 *不受支持*；兼容性仍由本地清单评估。
