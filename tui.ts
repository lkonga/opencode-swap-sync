/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { syncSwapYaml } from "./sync.ts"
import fs from "fs"
import os from "os"
import path from "path"

const STATS_PATH = process.env.POOL_STATS_PATH || "/tmp/pool-stats.json"

function loadStats() {
  try {
    if (fs.existsSync(STATS_PATH)) {
      return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"))
    }
  } catch {}
  return null
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function formatDuration(ms: number) {
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
      {...recentHistory.map((evt: any) => {
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

let _registered = false

function autoSyncMarkerPath(): string {
  return path.join(os.tmpdir(), "swap-sync-auto-done")
}

function isAutoSyncDone(): boolean {
  return fs.existsSync(autoSyncMarkerPath())
}

function markAutoSyncDone() {
  try { fs.writeFileSync(autoSyncMarkerPath(), String(Date.now()), "utf-8") } catch {}
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  console.log(`[swap-sync] tui() called, registered=${_registered}`)

  // Auto-sync — once per session using file marker (survives hot reload)
  if (!isAutoSyncDone()) {
    console.log(`[swap-sync] Scheduling auto-sync in 2s`)
    setTimeout(() => {
      console.log(`[swap-sync] Auto-sync firing`)
      const toast = (msg: string, variant: string) => {
        api.ui.toast({ variant: variant as any, message: msg, title: "Swap Sync" })
      }
      syncSwapYaml(toast).then(() => {
        console.log(`[swap-sync] Auto-sync complete`)
        markAutoSyncDone()
      }).catch((err: Error) => {
        console.error(`[swap-sync] Auto-sync failed:`, err.message)
      })
    }, 2000)
  } else {
    console.log(`[swap-sync] Auto-sync already done this session (marker exists)`)
  }

  // Register commands and routes — only ONCE per module lifetime
  if (!_registered) {
    _registered = true
    console.log(`[swap-sync] Registering commands and routes`)

    api.keymap.registerLayer({
      commands: [
        {
          name: "swap.sync",
          title: "Swap: Sync Models from Copilot API",
          category: "Swap",
          namespace: "palette",
          slashName: "sync-models",
          run() {
            const showToast = (msg: string, variant: string) => {
              api.ui.toast({ variant: variant as any, message: msg, title: "Swap Sync" })
            }
            showToast("Syncing models and providers...", "info")
            syncSwapYaml(showToast).then(() => {
              console.log(`[swap-sync] Manual sync complete`)
            }).catch((err: any) => {
              const msg = err instanceof Error ? err.message : String(err)
              console.error(`[swap-sync] Manual sync failed:`, msg)
              api.ui.toast({ variant: "error", title: "Swap Sync", message: msg })
            })
          },
        },
        {
          name: "swap.pool-stats",
          title: "Pool Browser Stats",
          category: "Swap",
          namespace: "palette",
          slashName: "pool-stats",
          run() {
            api.route.navigate("pool-stats")
          },
        },
      ],
      bindings: [],
    })

    api.route.register([
      {
        name: "pool-stats",
        render: () => PoolStatsView(),
      },
    ])
  }
}

export default { id: "opencode-swap-sync-tui", tui } as TuiPluginModule & { id: string }
