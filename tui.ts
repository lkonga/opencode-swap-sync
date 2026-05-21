import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { syncSwapYaml } from "./sync.ts"

let _registered = false

const tui: TuiPlugin = (api: TuiPluginApi) => {
  const slot = "swap-sync/" + Date.now()
  console.log(`[swap-sync] tui() called at ${Date.now()}, already registered: ${_registered}`)

  // Auto-sync — runs once per session, guarded by module-level flag
  if (!_registered) {
    const autoKey = `swap-sync:auto:${Date.now()}` as any
    console.log(`[swap-sync] Scheduling auto-sync in 2s (key=${autoKey})`)
    setTimeout(() => {
      console.log(`[swap-sync] Auto-sync firing`)
      const toast = (msg: string, variant: string) => {
        api.ui.toast({ variant: variant as any, message: msg, title: "Swap Sync" })
      }
      syncSwapYaml(toast).then(() => {
        console.log(`[swap-sync] Auto-sync complete`)
      }).catch((err: Error) => {
        console.error(`[swap-sync] Auto-sync failed:`, err.message)
      })
    }, 2000)
  } else {
    console.log(`[swap-sync] Skipping auto-sync (already done this session)`)
  }

  // Register slash command — only ONCE per session
  if (!_registered) {
    _registered = true
    console.log(`[swap-sync] Registering /sync-models slash command`)
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
