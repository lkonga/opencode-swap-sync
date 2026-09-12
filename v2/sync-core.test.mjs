import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  applySwapUpdate,
  autoSyncMarkerPath,
  buildSwapUpdate,
  isAutoSyncDone,
  markAutoSyncDone,
  resolveSwapYamlPath,
  runSwapSync,
  writeSwapUpdate,
} from "./sync-core.mjs"

// V2 shapes (packages/client/src/promise/generated/types.ts).
const model = (id, providerID) => ({ id, providerID, name: id, enabled: true })
const provider = (name, activation) => ({ id: name, name, activation })

let dir
let swapYamlPath

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-sync-v2-test-"))
  swapYamlPath = path.join(dir, "nested", "swap.yaml")
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("buildSwapUpdate", () => {
  test("maps V2 ModelInfo/ProviderInfo into the V1 file format", () => {
    const update = buildSwapUpdate(
      [model("gpt-4.1", "github-copilot"), model("claude-sonnet", "zai-anthropic")],
      [provider("github-copilot", "enabled"), provider("zai-anthropic", "disabled")],
    )

    expect(update.providers).toEqual({ "github-copilot": "enabled", "zai-anthropic": "disabled" })
    expect(update.models_by_provider).toEqual({
      "github-copilot": ["gpt-4.1"],
      "zai-anthropic": ["claude-sonnet"],
    })
  })

  test("treats activation auto/enabled as enabled and enabled:false as disabled", () => {
    const update = buildSwapUpdate([], [
      provider("a", "auto"),
      provider("b", "enabled"),
      provider("c", "disabled"),
      { id: "d", name: "d", enabled: false },
    ])
    expect(update.providers).toEqual({ a: "enabled", b: "enabled", c: "disabled", d: "disabled" })
  })

  test("infers providers only known through model data as enabled", () => {
    const update = buildSwapUpdate([model("m1", "zai-anthropic")], [])
    expect(update.providers).toEqual({ "zai-anthropic": "enabled" })
  })

  test("dedupes model ids and skips malformed entries", () => {
    const update = buildSwapUpdate(
      [model("m1", "p"), model("m1", "p"), { id: "x" }, { providerID: "p" }, null],
      [],
    )
    expect(update.models_by_provider).toEqual({ p: ["m1"] })
  })

  test("tolerates missing inputs", () => {
    expect(buildSwapUpdate()).toEqual({ providers: {}, models_by_provider: {} })
  })
})

describe("applySwapUpdate", () => {
  test("preserves unrelated sections and comments", () => {
    const existing = [
      "# swap config",
      "models:",
      '  coder: "github-copilot/gpt-4.1"',
      "providers:",
      "  stale: disabled",
      "",
    ].join("\n")

    const out = applySwapUpdate(existing, {
      providers: { fresh: "enabled" },
      models_by_provider: { fresh: ["m1"] },
    })

    expect(out).toContain("# swap config")
    expect(out).toContain('coder: "github-copilot/gpt-4.1"')
    expect(out).toContain("fresh: enabled")
    expect(out).not.toContain("stale: disabled")
  })

  test("handles empty input", () => {
    const out = applySwapUpdate("", { providers: {}, models_by_provider: {} })
    expect(out).toContain("providers: {}")
    expect(out).toContain("models_by_provider: {}")
  })
})

describe("writeSwapUpdate", () => {
  test("creates the file and parent directories when absent", () => {
    writeSwapUpdate({
      swapYamlPath,
      update: { providers: { p: "enabled" }, models_by_provider: { p: ["m1"] } },
    })
    expect(fs.existsSync(swapYamlPath)).toBe(true)
    expect(fs.readFileSync(swapYamlPath, "utf-8")).toContain("m1")
  })
})

describe("runSwapSync", () => {
  test("writes swap.yaml from injected V2 collections", async () => {
    const toasts = []
    const result = await runSwapSync({
      swapYamlPath,
      getModels: async () => [model("m1", "p1"), model("m2", "p2")],
      getProviders: async () => [provider("p1", "enabled"), provider("p2", "disabled")],
      toast: (msg, variant) => toasts.push([variant, msg]),
    })

    expect(result.status).toBe("ok")
    expect(result.models).toBe(2)
    expect(result.providers).toBe(2)
    const written = fs.readFileSync(swapYamlPath, "utf-8")
    expect(written).toContain("p1: enabled")
    expect(written).toContain("p2: disabled")
    expect(toasts.at(-1)[0]).toBe("success")
  })

  test("never overwrites an existing swap.yaml with an empty model index", async () => {
    fs.mkdirSync(path.dirname(swapYamlPath), { recursive: true })
    fs.writeFileSync(swapYamlPath, 'providers:\n  keep: enabled\n', "utf-8")

    const result = await runSwapSync({
      swapYamlPath,
      getModels: async () => [],
      getProviders: async () => [],
      toast: () => {},
    })

    expect(result.status).toBe("skipped-empty")
    expect(fs.readFileSync(swapYamlPath, "utf-8")).toBe('providers:\n  keep: enabled\n')
  })

  test("falls back to inferred providers when the provider fetch fails", async () => {
    const toasts = []
    const result = await runSwapSync({
      swapYamlPath,
      getModels: async () => [model("m1", "p1")],
      getProviders: async () => {
        throw new Error("timeout")
      },
      toast: (msg, variant) => toasts.push([variant, msg]),
    })

    expect(result.status).toBe("ok")
    expect(fs.readFileSync(swapYamlPath, "utf-8")).toContain("p1: enabled")
    expect(toasts.some(([variant]) => variant === "warning")).toBe(true)
  })

  test("reports errors and does not write when the model fetch fails", async () => {
    const result = await runSwapSync({
      swapYamlPath,
      getModels: async () => {
        throw new Error("models unavailable")
      },
      getProviders: async () => [],
      toast: () => {},
    })

    expect(result.status).toBe("error")
    expect(result.stage).toBe("models")
    expect(fs.existsSync(swapYamlPath)).toBe(false)
  })
})

describe("paths and markers", () => {
  test("resolveSwapYamlPath honours SWAP_CONFIG_PATH", () => {
    expect(resolveSwapYamlPath({ SWAP_CONFIG_PATH: "/tmp/custom.yaml" })).toBe("/tmp/custom.yaml")
    expect(resolveSwapYamlPath({})).toContain("swap.yaml")
  })

  test("auto-sync markers are scoped and do not share the V1 marker", () => {
    const scope = `v2-test-${process.pid}`
    const marker = autoSyncMarkerPath(scope)
    expect(marker).not.toBe(autoSyncMarkerPath("v1"))
    expect(marker).toContain("swap-sync-v2-test")
    expect(isAutoSyncDone(scope)).toBe(false)
    markAutoSyncDone(scope)
    expect(isAutoSyncDone(scope)).toBe(true)
    fs.rmSync(marker, { force: true })
  })
})

describe("V2 TUI entrypoint contract", () => {
  const source = fs.readFileSync(new URL("./tui.tsx", import.meta.url), "utf-8")

  test("uses the public V2 TUI plugin surface only", () => {
    expect(source).toContain('from "@opencode/plugin/tui"')
    expect(source).toContain("Plugin.define(")
    expect(source).toContain("context.ui.slot(")
    expect(source).toContain("context.keymap.layer(")
    expect(source).toContain("context.ui.router.register(")
    expect(source).toContain("context.ui.router.navigate({ type: \"plugin\", name: \"pool-stats\" })")
    expect(source).toContain("context.ui.toast.show(")
    expect(source).toContain("context.data.location.model.sync(")
    expect(source).toContain("context.data.location.provider.sync(")
  })

  test("does not use V1 plugin seams or the V1 binary", () => {
    expect(source).not.toContain("@opencode-ai/plugin/tui")
    expect(source).not.toContain("keymap.registerLayer")
    expect(source).not.toContain("api.route")
    expect(source).not.toContain("api.command.register")
    expect(source).not.toContain("TuiPlugin")
    expect(source).not.toContain("child_process")
    expect(source).not.toContain("execFile")
    expect(source).not.toContain("execSync")
  })

  test("registers no invented keybind", () => {
    expect(source).toContain('mode: "global"')
    expect(source).toContain("bind: false")
    expect(source).not.toMatch(/bind:\s*["'][a-z]/)
  })

  test("keeps the V1 slash command names", () => {
    expect(source).toContain('slash: { name: "sync-models" }')
    expect(source).toContain('slash: { name: "pool-stats" }')
  })

  test("transpiles as TSX", () => {
    const transpiler = new Bun.Transpiler({ loader: "tsx" })
    expect(() => transpiler.transformSync(source)).not.toThrow()
    expect(transpiler.transformSync(source)).toContain("Plugin.define")
  })
})
