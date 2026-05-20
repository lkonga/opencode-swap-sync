import fs from "fs"
import path from "path"
import os from "os"
import { execFile } from "child_process"
import * as yaml from "yaml"
import type { Config } from "@opencode-ai/plugin"

function getSwapYamlPath(): string {
  return process.env.SWAP_CONFIG_PATH
    || path.join(os.homedir(), "codes/llm-config-wiring/metadata/swap.yaml")
}

function parseModelOutput(output: string): any[] {
  const models: any[] = []
  let currentModel: string | null = null
  let jsonBuffer = ""
  let braceCount = 0
  let inJson = false

  for (const line of output.split("\n")) {
    const trimmed = line.trim()

    // Model path line (provider/model-id), starts model block
    // Must include "/" but NOT be a JSON value (no quotes, no colons)
    if (trimmed.includes("/") && !trimmed.includes('"') && !trimmed.includes(":")) {
      currentModel = trimmed
      continue
    }

    // JSON start
    if (trimmed.startsWith("{")) {
      inJson = true
      jsonBuffer = trimmed
      braceCount = 1
      continue
    }

    // Inside JSON — track brace count
    if (inJson) {
      jsonBuffer += trimmed
      for (const ch of trimmed) {
        if (ch === "{") braceCount++
        if (ch === "}") braceCount--
      }
      if (braceCount === 0) {
        try {
          const parsed = JSON.parse(jsonBuffer)
          parsed._key = currentModel
          models.push(parsed)
        } catch { /* skip malformed entries */ }
        inJson = false
        jsonBuffer = ""
        currentModel = null
      }
    }
  }
  return models
}

function execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }, (err, stdout) => {
      if (err && !stdout) {
        reject(new Error(err.message))
      } else {
        resolve(stdout || "")
      }
    })
  })
}

export async function syncSwapYaml(toast?: (msg: string, variant: string) => void) {
  const swapYamlPath = getSwapYamlPath()

  // Fetch models (async, non-blocking)
  toast?.("Fetching models from Copilot API...", "info")
  const modelOutput = await execAsync("opencode", ["models", "--verbose"], 30000)
  const models = parseModelOutput(modelOutput)
  const providerNames = [...new Set<string>(models.map((m: any) => m.providerID).filter(Boolean))]
  toast?.(`Received ${models.length} models from ${providerNames.length} providers`, "info")

  // Build update maps from models first (providers inferred from model data)
  const modelsByProvider: Record<string, string[]> = {}
  for (const m of models) {
    const pid = m.providerID
    if (pid) {
      if (!modelsByProvider[pid]) modelsByProvider[pid] = []
      modelsByProvider[pid].push(m.id)
    }
  }

  // Fetch provider status (async, non-blocking) — fails gracefully on timeout
  let providerMap: Record<string, string> = {}
  try {
    const providerOutput = await execAsync("swap", ["provider", "--json"], 15000)
    const providers = JSON.parse(providerOutput)
    for (const p of providers) {
      providerMap[p.name] = p.enabled ? "enabled" : "disabled"
    }
  } catch {
    // Timeout is expected (swap provider --json takes ~30s) — infer from model data
    for (const pid of Object.keys(modelsByProvider)) {
      providerMap[pid] = "enabled"
    }
    toast?.("Provider status unavailable (timeout) — inferred from model data", "warning")
  }

  // Write swap.yaml
  if (!fs.existsSync(swapYamlPath)) {
    fs.writeFileSync(swapYamlPath, "{}", "utf-8")
  }
  const doc = yaml.parseDocument(fs.readFileSync(swapYamlPath, "utf-8"))
  doc.set("providers", providerMap)
  doc.set("models_by_provider", modelsByProvider)
  fs.writeFileSync(swapYamlPath, doc.toString())

  const modelCount = models.length
  const providerCount = Object.keys(providerMap).length
  toast?.(`swap.yaml updated — ${modelCount} model entries, ${providerCount} providers`, "success")
}

export default async () => {
  return {
    config(_cfg: Config) {
      // DISABLED: backend startup path — auto-sync now lives in TUI plugin (tui.ts)
      // which fires after proxy/CAPI tunnel is confirmed ready.
    },
  }
}
