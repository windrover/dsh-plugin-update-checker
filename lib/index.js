/**
 * dsh-plugin-update-checker — Host half entry.
 *
 * Composes the scan route. The browser half (./client.js) registers the
 * "Check updates" tab into the Plugins settings section and calls the route.
 *
 * `inject` lists exactly the services the host logic touches. NOTE: `remote`
 * is a *browser*-side service (injected by dsh-client-ui-plugin-manager into
 * the browser half) — it does NOT exist on the host, so the host half must
 * never declare it. Updating is performed from the browser half via
 * ctx.remote.pluginManager.installBundle, exactly like the GUI "Add plugin"
 * dialog; the host half only serves the read-only scan route here.
 */

import { apply as applyUpdateChecker } from './host/update-checker.js'

export const name = 'dsh-plugin-update-checker'

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  applyUpdateChecker(ctx, config)
}
