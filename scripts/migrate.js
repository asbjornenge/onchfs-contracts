#!/usr/bin/env node
// Plan a migration of inodes from an existing onchfs files contract to a new
// (cheap-CID) one, optionally on another Tezos network.
//
// Usage: node scripts/migrate.js <old_contract> <new_contract> <old_cid>... > plan.json
//
// Env:
//   TZKT      tzkt API of the old contract   (default https://api.tzkt.io/v1)
//   TZKT_NEW  tzkt API of the new contract   (default TZKT)
//   CHUNKS=1  also copy chunk contents from the old content store, for when the
//             new contract uses a different content store (e.g. another chain)
//
// Reads the old inodes bigmap from tzkt, recomputes each inode's CID with the
// cheap formula (bottom-up), skips inodes (and chunks) already present on the
// new contract and prints a plan:
//   { mapping: {old: new}, batches: [[...], ...] }
// Each batch is the JSON accepted by
//   octez-client multiple transfers from <src> using <json>
// and is kept below the 32 KB operation size limit. Run them in order.
import sha3 from "js-sha3"

const TZKT = process.env.TZKT ?? "https://api.tzkt.io/v1"
const TZKT_NEW = process.env.TZKT_NEW ?? TZKT
const COPY_CHUNKS = process.env.CHUNKS === "1"
const MAX_BATCH_BYTES = 24_000

const [oldKT, newKT, ...roots] = process.argv.slice(2)
if (!oldKT || !newKT || roots.length === 0) {
  console.error("usage: migrate.js <old_contract> <new_contract> <old_cid>...")
  process.exit(1)
}

const keccak = (...parts) => Buffer.from(sha3.keccak256.arrayBuffer(Buffer.concat(parts.map(p => Buffer.from(p)))))
const hx = h => Buffer.from(h.replace(/^0x/, ""), "hex")
const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))

async function getJson(url) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.ok) return res.json()
    if (res.status !== 429 || attempt > 10) throw new Error(`${res.status} ${url}`)
    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)))
  }
}

async function bigmap(api, id) {
  const out = new Map()
  for (let offset = 0; ; offset += 1000) {
    const page = await getJson(`${api}/bigmaps/${id}/keys?active=true&limit=1000&offset=${offset}&select=key,value`)
    for (const { key, value } of page) out.set(key, value)
    if (page.length < 1000) return out
  }
}

const storageOf = (api, kt) => getJson(`${api}/contracts/${kt}/storage`)
const [oldStorage, newStorage] = [await storageOf(TZKT, oldKT), await storageOf(TZKT_NEW, newKT)]
const oldInodes = await bigmap(TZKT, oldStorage.inodes)
const newInodes = await bigmap(TZKT_NEW, newStorage.inodes)

let oldChunks, newChunks
if (COPY_CHUNKS) {
  const [oldStore, newStore] = [
    await storageOf(TZKT, oldStorage.content_store),
    await storageOf(TZKT_NEW, newStorage.content_store),
  ]
  oldChunks = await bigmap(TZKT, oldStore)
  newChunks = await bigmap(TZKT_NEW, newStore)
}

const mapping = {}
const chunkOps = []
const inodeOps = []
const queuedChunks = new Set()

function copyChunk(ptr) {
  if (!COPY_CHUNKS || newChunks.has(ptr) || queuedChunks.has(ptr)) return
  const content = oldChunks.get(ptr)
  if (content === undefined) throw new Error(`chunk ${ptr} not found in old content store`)
  if (keccak(hx(content)).toString("hex") !== ptr) throw new Error(`chunk ${ptr} content does not hash to its key`)
  queuedChunks.add(ptr)
  chunkOps.push({ destination: newKT, amount: "0", entrypoint: "write_chunk", arg: `0x${content}` })
}

function migrate(oldCid) {
  if (mapping[oldCid]) return mapping[oldCid]
  const inode = oldInodes.get(oldCid)
  if (!inode) throw new Error(`inode ${oldCid} not found on ${oldKT}`)
  let cid, call
  if (inode.file) {
    const { chunk_pointers, metadata } = inode.file
    chunk_pointers.forEach(copyChunk)
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
  if (!newInodes.has(cid)) inodeOps.push({ destination: newKT, amount: "0", ...call })
  return cid
}

for (const root of roots) migrate(root.replace(/^0x/, ""))

// chunks first, then inodes bottom-up; split by approximate binary size
const batches = []
let current = [], size = 0
for (const op of [...chunkOps, ...inodeOps]) {
  const opSize = op.arg.length / 2 + 100
  if (current.length && size + opSize > MAX_BATCH_BYTES) {
    batches.push(current)
    current = [], size = 0
  }
  current.push(op)
  size += opSize
}
if (current.length) batches.push(current)

console.log(JSON.stringify({ from: oldKT, to: newKT, mapping, batches }, null, 2))
