import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { syncSwapYaml } from "./sync.ts"
import fs from "fs"
import os from "os"
import path from "path"

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

const tui: TuiPlugin = (api: TuiPluginApi) => {
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

  // Register slash command — only ONCE per module lifetime
  if (!_registered) {
    _registered = true
    console.log(`[swap-sync] Registering /sync-models`)
    api.command.register(() => [
      {
        title: "Swap: Sync Models from Copilot API",
        value: "swap.sync",
        category: "Swap",
        slash: { name: "sync-models", aliases: ["sync"] },
        onSelect: async () => {
          console.log(`[swap-sync] Manual /sync-models triggered`)
          const showToast = (msg: string, variant: string) => {
            api.ui.toast({ variant: variant as any, message: msg, title: "Swap Sync" })
          }
          showToast("Syncing models and providers...", "info")
          try {
            await syncSwapYaml(showToast)
            console.log(`[swap-sync] Manual sync complete`)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            console.error(`[swap-sync] Manual sync failed:`, msg)
            api.ui.toast({ variant: "error", title: "Swap Sync", message: msg })
          }
        },
      },
    ])
  }
}

export default { id: "opencode-swap-sync-tui", tui } as TuiPluginModule & { id: string }
