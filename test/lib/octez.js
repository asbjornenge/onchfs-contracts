// Minimal octez-client wrapper running in mockup mode inside a docker container.
// One container is started per test run and commands are `docker exec`'d into it.
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export const OCTEZ_IMAGE = process.env.OCTEZ_IMAGE ?? "tezos/tezos:octez-v23.2"
const CONTRACTS_DIR = resolve(import.meta.dirname, "../../tezos")

const NOISE = [
  /^Warning:/,
  /This is NOT the Tezos Mainnet/,
  /Do NOT use your fundraiser keys/,
  /The node you are connecting to/,
  /^\s*$/,
]

export class Octez {
  start() {
    this.dir = mkdtempSync(join(tmpdir(), "onchfs-mockup-"))
    this.container = execFileSync("docker", [
      "run", "-d", "--rm",
      "-u", `${process.getuid()}:${process.getgid()}`,
      "-v", `${this.dir}:/mockup`,
      "-v", `${CONTRACTS_DIR}:/contracts:ro`,
      "--entrypoint", "sleep",
      OCTEZ_IMAGE, "infinity",
    ]).toString().trim()
    this.client("create", "mockup")
    return this
  }

  stop() {
    if (this.container) execFileSync("docker", ["rm", "-f", this.container], { stdio: "ignore" })
    if (this.dir) rmSync(this.dir, { recursive: true, force: true })
  }

  client(...args) {
    try {
      const out = execFileSync("docker", [
        "exec", this.container, "octez-client",
        "--mode", "mockup", "--base-dir", "/mockup/base",
        ...args,
      ], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })
      return clean(out.toString())
    } catch (err) {
      const e = new Error(clean(`${err.stdout ?? ""}\n${err.stderr ?? ""}`))
      e.octez = true
      throw e
    }
  }

  originate(alias, file, storage) {
    const out = this.client(
      "originate", "contract", alias, "transferring", "0", "from", "bootstrap1",
      "running", `/contracts/${file}`, "--init", storage, "--burn-cap", "10", "--force",
    )
    const m = out.match(/New contract (KT1\w+) originated/)
    if (!m) throw new Error(`origination failed:\n${out}`)
    return m[1]
  }

  call(contract, entrypoint, arg) {
    const args = ["transfer", "0", "from", "bootstrap1", "to", contract, "--burn-cap", "10"]
    if (entrypoint) args.push("--entrypoint", entrypoint)
    args.push("--arg", arg)
    return this.client(...args)
  }

  view(contract, name, input) {
    return this.client("run", "view", name, "on", "contract", contract, "with", "input", input).trim()
  }
}

function clean(s) {
  return s.split("\n").filter(l => !NOISE.some(r => r.test(l))).join("\n")
}
