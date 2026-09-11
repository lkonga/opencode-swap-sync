/**
 * opencode-swap-sync — V2 core (runtime-agnostic, no plugin API imports).
 *
 * This module holds the swap.yaml update logic shared by the V2 TUI plugin.
 * It intentionally depends on nothing from the V1 plugin API and on nothing
 * from the V2 TUI API, so it can be unit-tested with plain bun.
 *
 * The V1 entrypoints (`sync.ts`, `tui.ts`) are untouched and keep their own
 * implementation. This is the V2 implementation living alongside them.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as yaml from "yaml"

const DEFAULT_SWAP_YAML = "codes/llm-config-wiring/metadata/swap.yaml"

/**
 * Resolve the swap.yaml target. `SWAP_CONFIG_PATH` wins, matching V1.
 */
export function resolveSwapYamlPath(env = process.env) {
  return env.SWAP_CONFIG_PATH || path.join(os.homedir(), DEFAULT_SWAP_YAML)
}

function message(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the two swap.yaml sections from V2 `ModelInfo[]` / `ProviderInfo[]`.
 *
 * V2 shapes (packages/client/src/promise/generated/types.ts):
 *   ModelInfo    = { id, providerID, enabled, ... }
 *   ProviderInfo = { id, name, activation: "auto" | "enabled" | "disabled", ... }
 *
 * Output matches the V1 writer so both runtimes agree on the file format:
 *   providers:          { <name>: "enabled" | "disabled" }
 *   models_by_provider: { <providerID>: [<modelID>, ...] }
 */
export function buildSwapUpdate(models, providers) {
  const modelsByProvider = {}
  for (const model of models ?? []) {
    const providerID = model?.providerID
    const id = model?.id
    if (!providerID || !id) continue
    if (!modelsByProvider[providerID]) modelsByProvider[providerID] = []
    if (!modelsByProvider[providerID].includes(id)) modelsByProvider[providerID].push(id)
  }

  const providerMap = {}
  for (const provider of providers ?? []) {
    const name = provider?.name || provider?.id
    if (!name) continue
    // V2 carries `activation`; `enabled: false` is tolerated for older shapes.
    const disabled = provider?.activation === "disabled" || provider?.enabled === false
    providerMap[name] = disabled ? "disabled" : "enabled"
  }

  // Providers only known through model data are surfaced as enabled, mirroring
  // the V1 fallback used when `swap provider --json` was unavailable.
  for (const providerID of Object.keys(modelsByProvider)) {
    if (!(providerID in providerMap)) providerMap[providerID] = "enabled"
  }

  return { providers: providerMap, models_by_provider: modelsByProvider }
}

/**
 * Apply an update onto existing YAML text with the `yaml` document API, so
 * unrelated sections, comments, and ordering are preserved.
 */
export function applySwapUpdate(existingText, update) {
  const doc = yaml.parseDocument(existingText || "")
  doc.set("providers", update.providers)
  doc.set("models_by_provider", update.models_by_provider)
  return doc.toString()
}

/** Read-modify-write swap.yaml at an explicit path. */
export function writeSwapUpdate({ swapYamlPath, update }) {
  if (!fs.existsSync(swapYamlPath)) {
    fs.mkdirSync(path.dirname(swapYamlPath), { recursive: true })
    fs.writeFileSync(swapYamlPath, "{}\n", "utf-8")
  }
  const text = applySwapUpdate(fs.readFileSync(swapYamlPath, "utf-8"), update)
  fs.writeFileSync(swapYamlPath, text)
  return text
}

/**
 * Once-per-session auto-sync marker. V2 uses its own scope so a V1 run can
 * never suppress (or be suppressed by) the V2 run.
 */
export function autoSyncMarkerPath(scope = "v2") {
  return path.join(os.tmpdir(), `swap-sync-${scope}-auto-done`)
}

export function isAutoSyncDone(scope) {
  return fs.existsSync(autoSyncMarkerPath(scope))
}

export function markAutoSyncDone(scope) {
  try {
    fs.writeFileSync(autoSyncMarkerPath(scope), String(Date.now()), "utf-8")
  } catch {
    // best effort only
  }
}

/**
 * One sync pass. Data access and toasts are injected so the caller owns the
 * V2 public API surface and this flow stays testable.
 *
 * Safety: an empty model index never overwrites a populated swap.yaml. If the
 * V2 model route is unavailable (#212) the sync reports `skipped-empty`
 * instead of erasing existing entries.
 */
export async function runSwapSync({
  getModels,
  getProviders,
  swapYamlPath = resolveSwapYamlPath(),
  toast,
} = {}) {
  toast?.("Fetching models from the V2 model index...", "info")

  let models
  try {
    models = (await getModels?.()) ?? []
  } catch (error) {
    toast?.(`Failed to fetch models: ${message(error)}`, "error")
    return { status: "error", stage: "models", error: message(error) }
  }

  if (models.length === 0) {
    toast?.("No models available from the V2 index — swap.yaml left unchanged", "warning")
    return { status: "skipped-empty", models: 0, providers: 0, path: swapYamlPath }
  }

  const providerNames = new Set(models.map((model) => model?.providerID).filter(Boolean))
  toast?.(`Received ${models.length} models from ${providerNames.size} providers`, "info")

  let providers = []
  try {
    providers = (await getProviders?.()) ?? []
  } catch {
    toast?.("Provider status unavailable — inferred from model data", "warning")
  }

  const update = buildSwapUpdate(models, providers)
  try {
    writeSwapUpdate({ swapYamlPath, update })
  } catch (error) {
    toast?.(`Failed to write swap.yaml: ${message(error)}`, "error")
    return { status: "error", stage: "write", error: message(error) }
  }

  const providerCount = Object.keys(update.providers).length
  toast?.(`swap.yaml updated — ${models.length} model entries, ${providerCount} providers`, "success")
  return { status: "ok", models: models.length, providers: providerCount, path: swapYamlPath }
}
