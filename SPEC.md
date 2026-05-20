# opencode-swap-sync — Plugin Specification

## Purpose

A safe replacement for swap-tui's disabled `fetch_models()` and `fetch_providers()` network calls. Runs inside OpenCode's CAPI tunnel (proper proxy, auth, IP protection). Updates `swap.yaml` with live model/provider data.

## Trigger Model

### A. Automatic — On OpenCode Startup (after proxy verified)

The plugin hooks into OpenCode's startup lifecycle via the `config(cfg)` hook. After the plugin loads (which happens after proxy/CAPI tunnel is initialized), it schedules a deferred sync:

```typescript
config(cfg: Config) {
  // Schedule sync after proxy is confirmed healthy (defer 5s for startup settling)
  setTimeout(() => {
    syncSwapYaml().catch(err => {
      console.error("[swap-sync] Startup sync failed:", err.message)
    })
  }, 5000)
}
```

**Why this works:** Plugins load after OpenCode has initialized the proxy tunnel, set up HTTPS_PROXY, CAPI_* env vars, and verified proxy health via curl. By the time `config()` runs, the proxy is ready. The 5s delay lets any remaining startup settling complete.

### B. Manual — Via `/sync-models` Slash Command

User types `/sync-models` or `/sync` to trigger an immediate sync at any time.

## Architecture

```
Startup:
  OC starts → proxy init → CAPI tunnel ready → plugin loads
  → config() fires → setTimeout 5s → syncSwapYaml()
  → opencode models --verbose (via CAPI tunnel, safe)
  → swap provider --json (via CAPI tunnel, safe)
  → parse → update swap.yaml → toast result

Manual:
  User types /sync-models
  → plugin onSelect → syncSwapYaml()
  → same flow
```

## Plugin Structure

```
~/codes/opencode-plugins/opencode-swap-sync/
  sync.ts              ← backend plugin (slash command handler)
  tui.ts               ← TUI plugin (settings dialog, progress overlay)
  package.json         ← name: "opencode-swap-sync"
```

## Backend Plugin (`sync.ts`)

### Exports

```typescript
import type { PluginModule } from "@opencode-ai/plugin"
```

The plugin exports both a `config()` hook for auto-startup AND a slash command handler:

```typescript
export default {
  id: "opencode-swap-sync",
  config,
} as PluginModule & { id: string }
```

### `config(cfg)` — Auto-Startup Sync

Runs when OpenCode loads the plugin (post-proxy-initialization). Schedules a one-shot sync 5 seconds after load:

```typescript
function config(cfg: Config) {
  setTimeout(() => {
    syncSwapYaml().catch(err => {
      console.error("[swap-sync] Auto-sync failed:", err.message)
    })
  }, 5000)
}
```

The `setTimeout` approach avoids blocking plugin loading. The 5s delay ensures any remaining proxy/CAPI startup settling completes.

### `syncSwapYaml()` — Shared Sync Logic

Called by both auto-startup and slash command. Steps:

1. Read `SWAP_CONFIG_PATH` env var to locate `swap.yaml`
2. Run `opencode models --verbose` via `execSync` → parse JSON array
3. Run `swap provider --json` via `execSync` → parse JSON array
4. Read existing `swap.yaml` via `yaml` library
5. Update model/provider entries
6. Write `swap.yaml` back
7. Toast result (skip toast on auto-startup, use callback to notify UI)

```typescript
async function syncSwapYaml(toast?: (msg: string, variant: string) => void) {
  // 1. Resolve swap.yaml path
  const swapYamlPath = getSwapYamlPath()
  
  // 2. Fetch models
  toast?.("Fetching models from Copilot API...", "info")
  const modelOutput = execSync("opencode models --verbose", { encoding: "utf-8" })
  const models = JSON.parse(modelOutput)
  
  // 3. Fetch providers
  const providerOutput = execSync("swap provider --json", { encoding: "utf-8" })
  const providers = JSON.parse(providerOutput)
  
  // 4. Read swap.yaml
  const doc = yaml.parseDocument(fs.readFileSync(swapYamlPath, "utf-8"))
  
  // 5. Update provider config values (per-provider on/off)
  const providerMap: Record<string, string> = {}
  for (const p of providers) {
    providerMap[p.name] = p.enabled ? "enabled" : "disabled"
  }
  doc.set("providers", providerMap)
  
  // 6. Group models by provider and build model entries
  const modelsByProvider: Record<string, string[]> = {}
  for (const m of models) {
    const pid = m.providerID
    if (!modelsByProvider[pid]) modelsByProvider[pid] = []
    modelsByProvider[pid].push(m.id)
  }
  // Optionally store in a `models_by_provider` section
  doc.set("models_by_provider", modelsByProvider)
  
  // 7. Write back
  fs.writeFileSync(swapYamlPath, doc.toString())
  
  // 8. Success notification
  const providerCount = Object.keys(providerMap).length
  toast?.(`swap.yaml updated — ${models.length} models, ${providerCount} providers`, "success")
}
```

### Slash Command: `/sync-models`

Registers a manual trigger in addition to the auto-startup. Uses the same `syncSwapYaml()` function, passing the toast API for UI feedback.

```typescript
// In the plugin's TUI module or via api.command.register:
api.command.register(() => [{
  slash: { name: "sync-models", aliases: ["sync"] },
  category: "Swap",
  title: "Sync Models from Copilot API",
  onSelect: async () => {
    api.ui.toast({ variant: "info", title: "Sync", message: "Fetching models..." })
    try {
      await syncSwapYaml()
    } catch (err) {
      api.ui.toast({
        variant: "error",
        title: "Sync failed",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
}])
```

## Data Flow

### swap.yaml Format (Model Entry)

The `models` section in `swap.yaml` stores per-agent model overrides:

```yaml
models:
  explore: "google/gemini-flash"
  coder: "github-copilot/gpt-4.1"
```

The `providers` section stores enabled/disabled status:

```yaml
providers:
  github-copilot: enabled
  zai-anthropic: enabled
  my-claude: disabled
```

### Model JSON Format (from `opencode models --verbose`)

```json
[
  {
    "id": "gpt-4.1",
    "name": "GPT 4.1",
    "providerID": "github-copilot",
    "family": "gpt",
    "limit": { "context": 128000, "output": 16384 },
    "cost": { "input": 0, "output": 0 }
  }
]
```

### Provider JSON Format (from `swap provider --json`)

```json
[
  { "name": "github-copilot", "enabled": true },
  { "name": "zai-anthropic", "enabled": true }
]
```

## Update Logic

The plugin should:
1. Run `opencode models --verbose` → parse JSON array
2. Run `swap provider --json` → parse JSON array
3. Read existing `swap.yaml`
4. Update or add `models` and `providers` sections
5. Write back with YAML formatting preserved for non-touched sections

### YAML Preservation

Use `yaml` library to parse, modify, and stringify — don't do string replacement.

```typescript
import * as yaml from "yaml"

const doc = yaml.parseDocument(fs.readFileSync(swapYamlPath, "utf-8"))
// Modify doc contents
fs.writeFileSync(swapYamlPath, doc.toString())
```

## swap.yaml Path

Resolve relative to `SWAP_CONFIG_PATH` env var:

```typescript
function getSwapYamlPath(): string {
  return process.env.SWAP_CONFIG_PATH 
    || path.join(os.homedir(), "codes/llm-config-wiring/metadata/swap.yaml")
}
```

## Status Feedback

| Phase | Toast |
|-------|-------|
| Fetching models | `"Fetching models from Copilot API..."` (loading) |
| Models received | `"Received N models from X providers"` |
| Writing swap.yaml | `"Updating swap.yaml..."` |
| Complete | `"swap.yaml updated — M model entries, P providers"` |
| Error | `"Sync failed: {error}"` (error) |

## Registration

### `opencode.json`

```json
{
  "plugin": [
    "file:///home/lkonga/codes/opencode-plugins/opencode-swap-sync/sync.ts"
  ]
}
```

### `tui.json`

```json
{
  "plugin": [
    "/home/lkonga/codes/opencode-plugins/opencode-swap-sync/tui.ts"
  ]
}
```

## Security Notes

- Runs inside OpenCode → CAPI tunnel handles proxy/routing → no IP leak
- Uses `execSync` to call `opencode` CLI which inherits OC's env vars (HTTPS_PROXY, CAPI_*, etc.)
- **Auto-startup is safe** because `config()` runs AFTER proxy/CAPI tunnel initialization — by the time the plugin hook fires, the environment is already proxied
- swap.yaml is local file, no network egress except through OC's tunnel
- Plugin updates swap.yaml only — never modifies opencode.json or other configs
- `setTimeout` approach ensures startup sync is non-blocking — OC loads even if sync hangs

## References to swap Code

| File | Function | What it did (now disabled) |
|------|----------|--------------------------|
| `swap-tui/src/views/models.rs:69` | `fetch_models()` | Called `opencode models --verbose` via Command, parsed JSON → `HashMap<String, ModelInfo>` |
| `swap-tui/src/app.rs:842` | `fetch_providers_sync()` | Called `swap provider --json` via Command, parsed JSON → `Vec<ProviderInfo>` |
| `swap-tui/src/app.rs:2580` | `fetch_providers()` | Called `fetch_providers_sync()`, set `self.providers` |
| `swap-tui/src/views/models.rs:51` | `ModelInfo` struct | Model metadata struct (id, name, provider_id, limit, cost) |
| `swap-tui/src/app.rs:836` | `ProviderInfo` struct | Provider data struct (name, enabled) |
