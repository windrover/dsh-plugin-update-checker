# dsh-plugin-update-checker

> [English](./README.md) · [中文](./README.zh-CN.md)

A DeepSeek Harness plugin that adds a **Check updates** button to the **Built-in plugins** settings section. Click it and the plugin scans every installed plugin bundle for (1) the latest published version on the npm registry and (2) its compatibility with the running DSH runtime — then shows one row per bundle.

It lives beside the read-only inventory tab, itself contributing **no configuration**: it only reports. Updating or toggling a bundle is still done in the sidebar **Plugins** page or via `dsh plugin`.

## ✨ What it does

| Check | Source | Notes |
|---|---|---|
| **Update availability** | npm registry (`latest` dist-tag vs the installed version) | Registry-only. Bundles installed from a tarball / git / path publish nothing, so they are reported as *Unsupported* rather than falsely *Up to date*. |
| **Compatibility** | the bundle's `@deepseek-ai/dsh*` `peerDependencies` vs the running DSH version | Reuses `@deepseek-ai/dsh-app-boot`'s `evaluatePluginCompatibility`, the same helper the launcher applies on boot. An exact-version exemption granted in `compatibility.json` shows as *Compatible (exempted)*. |

Compatibility and update availability are computed **independently** — a slow or unreachable registry can never hide an incompatible peer range, and a local-only bundle still gets a compatibility verdict.

**Which registry the scan asks**: no longer a hardcoded `registry.npmjs.org`. The host reads the configuration itself (environment → the profile's `.npmrc` → the user's `~/.npmrc`, first hit wins) and then **probes the candidates concurrently, taking the first success**. Three cases: **nothing configured** → race the launcher's mirror against the public registry; **the public default configured** (npm writes `registry=https://registry.npmjs.org/` into `~/.npmrc` on its own) → keep it and add the mirror behind it, since both are public and nothing leaks; **anything else configured** (a corporate or internal registry) → **that one alone, never raced against a public registry**, because racing would leak internal package names to third parties. The difference is large behind a slow link — measured on one machine, the public registry answered in ~11 s where a mirror answered in ~0.2 s, and racing means a slow registry cannot hold up a fast one even when it is listed first. A bundle that declares `publishConfig.registry` still uses that registry. The winning registry travels with the row and is reused by the one-click update, so **the version is read from, and installed from, the same place**.

> The host half declares only `webServer`, and `remote` is a **browser-side** service; in this cordis version, touching an undeclared service throws (`cannot get property ... without inject`). The host therefore cannot ask the plugin manager for registries — reading the configuration, as above, is what that constraint requires.

## 📸 Where it sits

Open **Settings → Built-in plugins**. The section now has two tabs:

- **Plugin list** — the read-only inventory (shipped by DSH).
- **Check updates** — this plugin. It shows the running DSH version, a **Check updates** button, and the results table (plugin / installed / latest / compatibility / update).

The check is on demand: click the button, the host scans, and the table fills in. One broken manifest or an unreachable registry is isolated to its own row — it never blanks the whole report.

## 📦 Install

### Option A — from this GitHub repository (recommended)

1. Open the sidebar **Plugins** page → **Add plugin**.
2. In the source field, enter one of these install specs (the launcher resolves them through `installBundle`, the same primitive the GUI uses):

   ```text
   github:windrover/dsh-plugin-update-checker
   # or the full URL:
   https://github.com/windrover/dsh-plugin-update-checker
   ```

3. Restart to load the new bundle:

   ```bash
   dsh check     # iron rule #1: preflight before restart
   dsh restart   # reloads the web profile; the new bundle loads
   ```

4. Open **Settings → Built-in plugins → Check updates → Check updates.**
   The Check button's `fetch('/api/plugin-update-checker/scan')` runs inside the
   authenticated browser session, so it needs no manual token.

> This repository is **public**, so installing directly from GitHub works without any
> extra authentication. On networks where `registry.npmjs.org` is unreachable, the
> launcher uses `registry.npmmirror.com` automatically.

### Option B — local link (for development / editing the plugin)

1. Clone the package where your profile can link it:

   ```bash
   # e.g. inside your DSH workspace
   git clone https://github.com/windrover/dsh-plugin-update-checker dsh-plugin-update-checker
   ```

2. Link it into your profile. Add a `link:` dependency + a `bundles` entry to the profile manifest:

   ```jsonc
   // ~/.dsh/profiles/web/package.json
   {
     "dependencies": {
       "dsh-plugin-update-checker": "link:/abs/path/to/dsh-plugin-update-checker"
     },
     "dsh": { "profile": { "bundles": [ "…", "dsh-plugin-update-checker" ] } }
   }
   ```

   Then install. **`npm install` rejects the `link:` protocol** in this profile — use `pnpm` (the profile is a pnpm workspace), which is what `dsh` wires under the hood:

   ```bash
   cd ~/.dsh/profiles/web
   pnpm install --registry=https://registry.npmmirror.com   # link: deps don't hit the network
   ```

   `dsh`'s `wire_link_plugin_deps` auto-symlinks any `@deepseek-ai/*` the plugin
   imports into its own `node_modules`, but **it does not handle plain npm packages** —
   so pre-link the one real dependency yourself (the documented link-plugin gotcha:
   a `link:` plugin can't resolve packages that aren't hoisted into its tree):

   ```bash
   mkdir -p dsh-plugin-update-checker/node_modules
   ln -sfn ~/.npm/_npx/<active-dsh-hash>/node_modules/semver \
           dsh-plugin-update-checker/node_modules/semver
   ```

3. Restart and open it (`dsh check && dsh restart`, then the same Settings path as Option A).

## 🔌 How it is built

One bundle, two halves:

- **Host** (`lib/index.js` → `lib/host/update-checker.js`) registers `POST /api/plugin-update-checker/scan`, which walks the profile's bundles (via `ctx.remote.pluginManager.listBundles()`, falling back to scanning `node_modules`), reads each manifest, evaluates peer compatibility, and probes the registry. `cordis.patch.yml` adds the Loader row.
- **Browser** (`lib/client.js`) registers a tab into the `settings.plugins.tab` slot of the Built-in-plugins section and renders the result with `react` (`require("react")`) and the design tokens DSH already exposes. The bundle `id` equals the package `name` — the contract `dsh-client-modules` enforces.

## 🧪 Test

```bash
node test/client-contract.test.mjs
```

Pins the browser-half contract (id == package name, one `settings.plugins.tab` registration, renderable body). The host scan was exercised against the live profile during development and returns `{ ok, dshVersion, checkedAt, plugins: [...] }`.

## 📝 Limitations

- **Read-only** — it reports; it does not update or toggle anything.
- **Registry reachability** — registry checks need network access to the configured registry; offline or firewalled hosts show *Unknown* per bundle.
- **Local / git / tarball bundles** — publish no registry version, so their update status is *Unsupported*. Their compatibility is still evaluated from the local manifest.
