import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { syncSwapYaml } from "./sync.ts"

let _autoSynced = false

const tui: TuiPlugin = (api: TuiPluginApi) => {
  if (!_autoSynced) {
    _autoSynced = true
    setTimeout(() => {
      const toast = (msg: string, variant: string) => {
        api.ui.toast({ variant: variant as any, message: msg, title: "Swap Sync" })
      }
      syncSwapYaml(toast).catch((err: Error) => {
        console.error("[swap-sync] Auto-sync failed:", err.message)
      })
    }, 2000)
  }

  api.command.register(() => [
    {
      title: "Swap: Sync Models from Copilot API",
      value: "swap.sync",
      category: "Swap",
      slash: { name: "sync-models", aliases: ["sync"] },
      onSelect: async () => {
        const showToast = (msg: string, variant: string) => {
          api.ui.toast({ variant: variant as any, message: msg, title: "Swap Sync" })
        }

        showToast("Syncing models and providers...", "info")
        try {
          await syncSwapYaml(showToast)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          api.ui.toast({ variant: "error", title: "Swap Sync", message: msg })
        }
      },
    },
  ])
}

export default { id: "opencode-swap-sync-tui", tui } as TuiPluginModule & { id: string }
