// Helpers bridging the onchfs JS reference implementation and Michelson calls.
import onchfs from "onchfs"
import sha3 from "js-sha3"

export const hex = u8 => "0x" + Buffer.from(u8).toString("hex")
export const keccak = (...parts) => new Uint8Array(sha3.keccak256.arrayBuffer(Buffer.concat(parts.map(p => Buffer.from(p)))))

/** Deterministic pseudo-random (incompressible) bytes. */
export function randomBytes(n, seed = 1) {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    out[i] = x & 0xff
  }
  return out
}

const enc = new TextEncoder()

/** A small project: one tiny file, one multi-chunk file in a subdirectory. */
export const FIXTURE = [
  { path: "index.html", content: enc.encode("<!doctype html><h1>onchfs</h1>") },
  { path: "lib/blob.bin", content: randomBytes(40_000, 42) }, // 3 chunks @ 16384
  { path: "lib/style.css", content: enc.encode("body{margin:0}") },
]

export function prepare(strategy, files = FIXTURE) {
  const root = onchfs.files.prepare(files, { fileHashingStrategy: strategy })
  return { root, inscriptions: onchfs.inscriptions.prepare(root) }
}

/** Michelson literal for a list of bytes. */
const bytesList = items => `{ ${items.map(hex).join(" ; ")} }`

/** Michelson literal for a map string -> bytes (keys must be sorted). */
function dirMap(files) {
  const names = Object.keys(files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  return `{ ${names.map(n => `Elt "${n}" ${hex(files[n])}`).join(" ; ")} }`
}

/** Inscribe every inscription of a prepared tree on a files contract. */
export function inscribe(octez, filesContract, inscriptions) {
  for (const ins of inscriptions) {
    switch (ins.type) {
      case "chunk":
        octez.call(filesContract, "write_chunk", hex(ins.content))
        break
      case "file":
        octez.call(filesContract, "create_file", `Pair ${bytesList(ins.chunks)} ${hex(ins.metadata)}`)
        break
      case "directory":
        octez.call(filesContract, "create_directory", dirMap(ins.files))
        break
    }
  }
}

/** Independent re-implementation of FileSystem.sol `createFile` checksum. */
export function solidityFileCid(chunkPointers, metadata) {
  return keccak(
    [0x01],
    keccak(...chunkPointers), // keccak256(abi.encodePacked(bytes32[]))
    keccak(metadata),
  )
}

/**
 * Independent re-implementation of FileSystem.sol `createDirectory` checksum,
 * given entries in the order the caller passes them (onchfs-js sorts names).
 * concatenateFiles() prepends each (pointer, keccak(name)) pair, so the last
 * entry ends up first.
 */
export function solidityDirCid(entries) {
  const parts = []
  for (const [name, cid] of entries) parts.unshift(cid, keccak(Buffer.from(name)))
  return keccak([0x00], ...parts)
}

/** Recompute the whole tree's root CID using only the Solidity formulas. */
export function solidityTreeCid(inscriptions) {
  const fileCids = new Map() // onchfs-js cid hex -> solidity cid
  let last
  for (const ins of inscriptions) {
    if (ins.type === "file") {
      last = solidityFileCid(ins.chunks, ins.metadata)
      fileCids.set(hex(ins.cid), last)
    } else if (ins.type === "directory") {
      const names = Object.keys(ins.files).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      last = solidityDirCid(names.map(n => [n, fileCids.get(hex(ins.files[n]))]))
      fileCids.set(hex(ins.cid), last)
    }
  }
  return last
}
