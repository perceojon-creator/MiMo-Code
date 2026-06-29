#!/usr/bin/env bun
/**
 * Deploys the locally-built mimo binary to the global npm installation path.
 * Run after `bun run build:dev` to test changes without publishing.
 */

import fs from "fs"
import path from "path"
import os from "os"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

// Resolve the global npm root (AppData\Roaming\npm on Windows)
const npmRoot = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules")

const distBinary = path.join(dir, "dist/mimocode-windows-x64/bin/mimo.exe")

if (!fs.existsSync(distBinary)) {
  console.error(`Built binary not found at ${distBinary}`)
  console.error("Run 'bun run build:dev' first")
  process.exit(1)
}

const variants = [
  "mimocode-windows-x64",
  "mimocode-windows-x64-baseline",
]

// The binary packages are installed inside @mimo-ai/cli's node_modules
const cliNodeModules = path.join(npmRoot, "@mimo-ai", "cli", "node_modules", "@mimo-ai")

let deployed = false
for (const variant of variants) {
  const targetDir = path.join(cliNodeModules, variant, "bin")
  if (fs.existsSync(targetDir)) {
    const target = path.join(targetDir, "mimo.exe")
    fs.copyFileSync(distBinary, target)
    console.log(`Deployed to ${target}`)
    deployed = true
  }
}

if (!deployed) {
  console.warn("No target directories found in npm install, nothing to deploy")
} else {
  console.log("Done. Run 'mimo --version' to verify.")
}
