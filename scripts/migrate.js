#!/usr/bin/env node
// Plan a migration of inodes from an existing (consistent-CID) onchfs files
// contract to a new (cheap-CID) one sharing the same content store.
//
// Usage: node scripts/migrate.js <old_contract> <new_contract> <old_cid>... > plan.json
//
// Reads the old inodes bigmap from tzkt, recomputes each inode's CID with the
// cheap formula (bottom-up), skips inodes already present on the new contract
// and prints a plan: { mapping: {old: new}, batch: [...] } where `batch` is the
// JSON accepted by `octez-client multiple transfers from <src> using <json>`.
// Chunks are never re-uploaded.
import sha3 from "js-sha3"

const TZKT = process.env.TZKT ?? "https://api.tzkt.io/v1"
const [oldKT, newKT, ...roots] = process.argv.slice(2)
if (!oldKT || !newKT || roots.length === 0) {
  console.error("usage: migrate.js <old_contract> <new_contract> <old_cid>...")
  process.exit(1)
}

const keccak = (...parts) => Buffer.from(sha3.keccak256.arrayBuffer(Buffer.concat(parts.map(p => Buffer.from(p)))))
const hx = h => Buffer.from(h.replace(/^0x/, ""), "hex")
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

async function bigmapKeys(contract) {
  const storage = await (await fetch(`${TZKT}/contracts/${contract}/storage`)).json()
  const out = new Map()
  for (let offset = 0; ; offset += 1000) {
    const page = await (await fetch(`${TZKT}/bigmaps/${storage.inodes}/keys?active=true&limit=1000&offset=${offset}&select=key,value`)).json()
    for (const { key, value } of page) out.set(key, value)
    if (page.length < 1000) return out
  }
}

const oldInodes = await bigmapKeys(oldKT)
const newInodes = await bigmapKeys(newKT)
const mapping = {}
const batch = []

function migrate(oldCid) {
  if (mapping[oldCid]) return mapping[oldCid]
  const inode = oldInodes.get(oldCid)
  if (!inode) throw new Error(`inode ${oldCid} not found on ${oldKT}`)
  let cid, call
  if (inode.file) {
    const { chunk_pointers, metadata } = inode.file
    cid = keccak([0x01], keccak(...chunk_pointers.map(hx)), keccak(hx(metadata))).toString("hex")
    call = {
      entrypoint: "create_file",
      arg: `Pair { ${chunk_pointers.map(p => "0x" + p).join(" ; ")} } 0x${metadata}`,
    }
  } else {
    const names = Object.keys(inode.directory).sort(byteOrder)
    const entries = names.map(n => [n, migrate(inode.directory[n])])
    const parts = []
    for (const [name, c] of entries) parts.unshift(hx(c), keccak(Buffer.from(name)))
    cid = keccak([0x00], ...parts).toString("hex")
    call = {
      entrypoint: "create_directory",
      arg: `{ ${entries.map(([n, c]) => `Elt "${n}" 0x${c}`).join(" ; ")} }`,
    }
  }
  mapping[oldCid] = cid
  if (!newInodes.has(cid)) batch.push({ destination: newKT, amount: "0", ...call })
  return cid
}

for (const root of roots) migrate(root.replace(/^0x/, ""))
console.log(JSON.stringify({ from: oldKT, to: newKT, mapping, batch }, null, 2))
