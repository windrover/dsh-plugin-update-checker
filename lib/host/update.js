/**
 * dsh-plugin-update-checker — host/update.js
 *
 * One-click update, driven through the host's own plugin manager.
 *
 * WHY THIS IS NOT ONE `installBundle` CALL (the shape the browser half used to
 * send): dsh 0.2.1's manager refuses `add` for a package that is already a
 * profile dependency — `ManagementFailure('already-installed')`, thrown before
 * pnpm runs whenever the host runs with HMR (the desktop app always does,
 * `ownerContext.get('hmr') !== undefined`, #896). An update is exactly that
 * shape, so the call came back `application: 'failed'` with nothing written,
 * and the browser half read the untouched profile as "the release-age policy
 * held it back" — a guess that was wrong twice: pnpm's release-age gate
 * auto-collects the requested version into `minimumReleaseAgeExclude` and
 * proceeds, and the profile had not been written at all.
 *
 * The manager has no in-place update. The app's own Plugins page and dshmarket
 * both update by removing the bundle and installing it again, so that is what
 * this module does — and it does it here on the host, where the manager service
 * lives and where the orchestration can be tested against a fake manager.
 *
 * Removing first is only safe for bundles the manager can remove, and never for
 * this plugin itself: `removeBundle` unloads the running composition, which
 * would take the route serving this very request with it (dshmarket's #900).
 * The self case therefore answers with the command line instead.
 */
import { default as semver } from 'semver'

const PACKAGE_NAME = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+$/
/** Outcomes that mean the manager kept the change (see `ChangeResult.application`). */
const APPLIED = new Set(['applied', 'restart-required', 'overridden'])
const MAX_MESSAGE = 800

/**
 * Validate the update request body.
 *
 * The version is required and must be a plain semver: this route installs what
 * the scan reported, and a range or tag here would resolve to something the
 * user never approved. The registry is a hint from the row that reported the
 * update, so it only ever narrows where pnpm looks, never what it installs.
 *
 * @returns `{ name, version, registry? }`, or `{ error }` for a malformed body.
 */
export function parseUpdateRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { error: 'expected a JSON object' }
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!PACKAGE_NAME.test(name)) return { error: 'name must be a package name' }
  const version = typeof body.version === 'string' ? body.version.trim() : ''
  if (semver.valid(version) === null) return { error: 'version must be a semantic version' }
  const raw = typeof body.registry === 'string' ? body.registry.trim().replace(/\/+$/, '') : ''
  const registry = /^https?:\/\/\S+$/i.test(raw) ? raw : undefined
  return { name, version, ...(registry === undefined ? {} : { registry }) }
}

/**
 * Install one exact version, removing the installed copy first when the manager
 * refuses `add` because that package is already a dependency.
 *
 * @param manager the host `pluginManager` service.
 * @param request `{ name, version, registry? }` from {@link parseUpdateRequest}.
 * @param options `{ selfName }` — the package name of this plugin, which must
 *   never be removed through here.
 * @returns a JSON-ready result: `{ ok: true, ... }` or `{ ok: false, stage, code?, message }`.
 */
export async function performUpdate(manager, request, options = {}) {
  const { name, version, registry } = request
  const spec = `${name}@${version}`
  const steps = []
  const install = () => invoke(manager, 'installBundle', spec, {
    enabled: true,
    requestId: `update-checker:${name}:${Date.now()}`,
    ...(registry === undefined ? {} : { registry }),
  })

  const first = await install()
  steps.push('install')
  if (APPLIED.has(first.application)) return success(first, name, version, steps)
  if (codeOf(first) !== 'already-installed') return failure('install', first)

  // The manager will not re-add a declared dependency, so the installed copy
  // has to go first. Never for this plugin: the route answering this request is
  // inside the bundle being removed.
  if (name === options.selfName) {
    return { ok: false, stage: 'install', code: 'self-update', message: `refusing to remove the running ${name}; update it from a terminal`, spec }
  }

  const removed = await invoke(manager, 'removeBundle', name)
  steps.push('remove')
  if (removed.application === 'failed' || removed.application === 'cancelled') {
    return failure('remove', removed)
  }

  const second = await install()
  steps.push('install-after-remove')
  if (APPLIED.has(second.application)) return success(second, name, version, steps)
  // The old build is gone at this point: say so, so the panel can tell the user
  // to restore the plugin rather than leaving them with a silently missing one.
  return { ...failure('install-after-remove', second), removed: true }
}

function success(result, name, version, steps) {
  return {
    ok: true,
    name,
    version,
    application: result.application,
    restartRequired: result.application === 'restart-required',
    changed: result.changed === true,
    steps,
    ...(typeof result.version === 'string' ? { installedVersion: result.version } : {}),
  }
}

function failure(stage, result) {
  const error = result?.error
  const code = codeOf(result)
  const output = tail(result?.packageResult?.output)
  return {
    ok: false,
    stage,
    ...(code === undefined ? {} : { code }),
    message: messageOf(error),
    ...(output === undefined ? {} : { output }),
  }
}

/** Call one manager method, folding a throw into the manager's own result shape. */
async function invoke(manager, method, ...args) {
  if (typeof manager?.[method] !== 'function') {
    return { application: 'failed', error: { code: 'unavailable', message: `the plugin manager does not implement ${method}` } }
  }
  try {
    const result = await manager[method](...args)
    return result ?? { application: 'failed', error: { code: 'no-result', message: 'the plugin manager returned no result' } }
  } catch (error) {
    return { application: 'failed', error: { ...(typeof error?.code === 'string' ? { code: error.code } : {}), message: messageOf(error) } }
  }
}

function codeOf(result) {
  const code = result?.error?.code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error) {
  const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : error === undefined ? 'the plugin manager did not explain the failure' : String(error)
  return text.length > MAX_MESSAGE ? `…${text.slice(-MAX_MESSAGE)}` : text
}

/** The end of a pnpm run, where its ERR_PNPM_* line and the reason live. */
function tail(output) {
  if (typeof output !== 'string' || output.trim() === '') return undefined
  const text = output.trim()
  return text.length > MAX_MESSAGE ? `…${text.slice(-MAX_MESSAGE)}` : text
}
