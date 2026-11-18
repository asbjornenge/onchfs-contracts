import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { Octez } from "./lib/octez.js"
import { FIXTURE, prepare, inscribe, hex, keccak, solidityFileCid, solidityTreeCid } from "./lib/onchfs.js"

const octez = new Octez()
let store, filesOriginal, filesCheap

before(() => {
  octez.start()
  store = octez.originate("store", "original/content_store.tz", "{}")
  filesOriginal = octez.originate("files_original", "original/onchfs_files.tz", `Pair "${store}" {}`)
  filesCheap = octez.originate("files_cheap", "onchfs_files.tz", `Pair "${store}" {}`)
})

after(() => octez.stop())

const exists = (contract, cid) => {
  try { octez.view(contract, "get_inode_at", `Pair ${hex(cid)} {}`); return true }
  catch (e) { if (e.octez) return false; throw e }
}

test("fixture discriminates between strategies", () => {
  const a = prepare("consistent").root.cid
  const b = prepare("cheap").root.cid
  assert.notEqual(hex(a), hex(b))
  assert.ok(prepare("cheap").inscriptions.some(i => i.type === "file" && i.chunks.length > 1), "has a multi-chunk file")
})

test("original contract (on-chain today) yields onchfs-js 'consistent' CIDs", () => {
  const { root, inscriptions } = prepare("consistent")
  inscribe(octez, filesOriginal, inscriptions)
  assert.ok(exists(filesOriginal, root.cid), "root cid present")
  assert.ok(!exists(filesOriginal, prepare("cheap").root.cid), "cheap cid absent")
})

test("patched contract yields onchfs-js 'cheap' CIDs", () => {
  const { root, inscriptions } = prepare("cheap")
  inscribe(octez, filesCheap, inscriptions)
  for (const ins of inscriptions.filter(i => i.type !== "chunk"))
    assert.ok(exists(filesCheap, ins.cid), `${ins.type} ${hex(ins.cid)} present`)
  assert.ok(exists(filesCheap, root.cid))
  assert.ok(!exists(filesCheap, prepare("consistent").root.cid), "consistent cid absent")
})

test("patched contract CIDs equal the EVM FileSystem.sol formula", () => {
  const { root, inscriptions } = prepare("cheap")
  for (const f of inscriptions.filter(i => i.type === "file"))
    assert.equal(hex(solidityFileCid(f.chunks, f.metadata)), hex(f.cid))
  const evmRoot = solidityTreeCid(inscriptions)
  assert.equal(hex(evmRoot), hex(root.cid))
  assert.ok(exists(filesCheap, evmRoot), "EVM-computed root exists on Tezos contract")
})

test("read views still return original content on patched contract", () => {
  const { root } = prepare("cheap")
  const blob = FIXTURE.find(f => f.path === "lib/blob.bin").content
  const out = octez.view(filesCheap, "get_inode_at", `Pair ${hex(root.cid)} { "lib" ; "blob.bin" }`)
  const fileCid = out.match(/Pair (0x[0-9a-f]+)/)[1]
  const file = octez.view(filesCheap, "read_file", fileCid)
  const content = file.match(/Pair (0x[0-9a-f]+)/)[1]
  // stored content may be compressed by onchfs-js; blob is random so it is stored raw
  assert.equal(content, hex(blob))
})

test("create_file rejects unknown chunk pointers", () => {
  const bogus = hex(keccak(Buffer.from("not a chunk")))
  assert.throws(
    () => octez.call(filesCheap, "create_file", `Pair { ${bogus} } 0x00`),
    /ONCHFS_CHUNK_NOT_FOUND/,
  )
})

test("create_file is idempotent", () => {
  const { inscriptions } = prepare("cheap")
  const f = inscriptions.find(i => i.type === "file")
  octez.call(filesCheap, "create_file", `Pair { ${f.chunks.map(hex).join(" ; ")} } ${hex(f.metadata)}`)
  assert.ok(exists(filesCheap, f.cid))
})
