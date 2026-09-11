/**
 * opencode-swap-sync — V2 TUI plugin.
 *
 * V2 entrypoint, loaded from cli.json `plugins` (V2 has no tui.json). Uses
 * only the public V2 TUI plugin surface exposed as `@opencode/plugin/tui`:
 *   Plugin.define            packages/plugin/src/tui/plugin.ts
 *   context.ui.slot          packages/plugin/src/tui/context.ts (slot: 463)
 *   context.keymap.layer     packages/plugin/src/tui/context.ts (keymap: 411)
 *   context.ui.router        packages/plugin/src/tui/context.ts (router: 438)
 *   context.ui.toast.show    packages/plugin/src/tui/context.ts (toast: 251)
 *   context.data.location.*  packages/plugin/src/tui/context.ts (data: 59)
 *
 * The V1 entrypoint (`../tui.ts`) is untouched and still loads under V1.
 */
import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import { isAutoSyncDone, markAutoSyncDone, resolveSwapYamlPath, runSwapSync } from "./sync-core.mjs"

const STATS_PATH = process.env.POOL_STATS_PATH || "/tmp/pool-stats.json"
const AUTO_SYNC_DELAY_MS = 2000

function loadStats() {
  try {
    if (fs.existsSync(STATS_PATH)) {
      return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"))
    }
  } catch {}
  return null
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function PoolStatsView() {
  const stats = loadStats()
  const acquired = stats?.current?.acquired || []
  const free = stats?.current?.free || []
  const total = acquired.length + free.length
  const totals = stats?.totals || {}
  const history = stats?.history || []
  const recentHistory = history.slice(-20).reverse()

  return (
    <box flexDirection="column" padding={1}>
      <text bold color="cyan">Pool Browser Stats</text>
      <text> </text>
      <text bold>Capacity</text>
      <text>  Free: <text color="green">{String(free.length)}</text>/{total}  In use: <text color={acquired.length > 0 ? "yellow" : "green"}>{String(acquired.length)}</text>/{total}</text>
      {acquired.length > 0 && (
        <text>  Acquired: <text color="yellow">{acquired.join(", ")}</text></text>
      )}
      <text> </text>
      <text bold>Lifecycle Totals</text>
      <text>  Acquires: {String(totals.acquire || 0)}  Fails: {String(totals.acquireFail || 0)}</text>
      <text>  Releases: {String(totals.release || 0)}  Fails: {String(totals.releaseFail || 0)}</text>
      <text>  Auto-releases: {String(totals.autoRelease || 0)}</text>
      <text>  Patches: {String(totals.patchApply || 0)}  Fails: {String(totals.patchFail || 0)}</text>
      <text> </text>
      <text bold>Recent Events</text>
      {recentHistory.length === 0 && <text color="gray">  No events recorded</text>}
      {...recentHistory.map((evt) => {
        const typeColor = evt.type.includes("fail") ? "red"
          : evt.type === "acquire" ? "green"
          : evt.type === "release" ? "blue"
          : evt.type === "auto_release" ? "magenta"
          : evt.type === "patch_apply" ? "cyan"
          : "white"
        const detail = evt.detail?.mcpName || ""
        return (
          <text>  <text color="gray">{formatTime(evt.ts)}</text> <text color={typeColor}>{evt.type.replace(/_/g, " ")}</text> {detail}</text>
        )
      })}
      <text> </text>
      {stats?.lastUpdated && (
        <text color="gray">Last updated: {formatTime(stats.lastUpdated)} ({formatDuration(Date.now() - stats.lastUpdated)} ago)</text>
      )}
      {!stats && <text color="yellow">No stats file found at {STATS_PATH}</text>}
    </box>
  )
}

/**
 * Sync using the public V2 data collections instead of shelling out to a CLI,
 * so the V2 plugin never invokes the V1 binary.
 */
async function syncNow(context, options = {}) {
  const { silent = false } = options
  const toast = (msg, variant) => {
    if (silent && variant === "info") return
    context.ui.toast.show({ variant: variant || "info", title: "Swap Sync", message: msg })
  }

  try {
    return await runSwapSync({
      swapYamlPath: resolveSwapYamlPath(),
      toast,
      getModels: async () => {
        await context.data.location.model.sync(context.location)
        return context.data.location.model.list(context.location) ?? []
      },
      getProviders: async () => {
        await context.data.location.provider.sync(context.location)
        return context.data.location.provider.list(context.location) ?? []
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    context.ui.toast.show({ variant: "error", title: "Swap Sync", message: msg })
    return { status: "error", error: msg }
  }
}

/**
 * Keymap layers are owned by the calling component, so commands are registered
 * from a component rendered into the `app` slot. `bind: false` is deliberate:
 * V2 validates configured keybind ids and fails hard on unknown ones
 * (packages/tui/src/config/keybind.ts:314), so these commands expose slash /
 * palette entries only and never invent a keybind id.
 */
function Commands(props) {
  props.context.keymap.layer(() => ({
    commands: [
      {
        id: "swap.sync",
        title: "Swap: Sync Models from the V2 Index",
        description: "Refresh swap.yaml from the V2 model and provider index",
        group: "Swap",
        palette: true,
        bind: false,
        slash: { name: "sync-models" },
        run: async () => {
          await syncNow(props.context)
        },
      },
      {
        id: "swap.pool-stats",
        title: "Pool Browser Stats",
        description: "Open the pooled browser stats page",
        group: "Swap",
        palette: true,
        bind: false,
        slash: { name: "pool-stats" },
        run: () => {
          props.context.ui.router.navigate({ type: "plugin", name: "pool-stats" })
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "opencode-swap-sync-v2-tui",
  setup(context) {
    context.ui.router.register({ name: "pool-stats", render: () => <PoolStatsView /> })

    context.ui.slot({
      append: "app",
      render: () => <Commands context={context} />,
    })

    // Auto-sync once per session, mirroring the V1 entrypoint's behaviour with
    // a V2-scoped marker so the two runtimes never suppress each other.
    if (isAutoSyncDone()) return

    const timer = setTimeout(() => {
      void syncNow(context, { silent: true })
        .then(() => markAutoSyncDone())
        .catch(() => {})
    }, AUTO_SYNC_DELAY_MS)

    return () => clearTimeout(timer)
  },
})
