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

## 📸 位置

打开 **设置 → 内置插件**。该分区现在有两个标签页：

- **插件清单（Plugin list）** —— 只读清单（由 DSH 自带）。
- **检查更新（Check updates）** —— 本插件。展示当前 DSH 版本、**检查更新** 按钮，以及结果表格（插件 / 已安装版本 / 最新版本 / 兼容性 / 更新）。

检查是按需触发的：点击按钮，主机扫描，表格填充。某个清单损坏或注册表不可达，只会隔离到对应那一行——绝不会让整张报表空白。

## 📦 安装

本插件作为普通的 DSH 本地链接包挂载。

### 1. 把包放到 profile 能链接的位置

```bash
# 例如放在你的 DSH 工作区里
git clone <本仓库> dsh-plugin-update-checker
```

### 2. 链接进 profile

使用右侧栏 **插件（Plugins）** 页面（**添加插件** → 绝对本地路径），或在 profile 清单中加入：

```jsonc
// ~/.dsh/profiles/<你的 profile>/package.json
{
  "dependencies": {
    "dsh-plugin-update-checker": "link:/abs/path/to/dsh-plugin-update-checker"
  }
}
```

然后运行 `dsh plugin install`（或重启 harness，让链接安装、浏览器包被服务）。

### 3. 依赖

主机半边需要 `semver` 与 `@deepseek-ai/dsh-app-boot`，DSH 安装已自带；只有在 profile 目录树之外开发时才需要手动 `npm install`。

### 4. 打开它

**设置 → 内置插件 → 检查更新 → 检查更新。**

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
