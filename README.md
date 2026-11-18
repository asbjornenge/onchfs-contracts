# onchfs-contracts

Tezos (Michelson) contracts for onchfs with a `create_file` CID formula that
matches the EVM contract (`fxhash-onchfs/src/FileSystem.sol`). The same file
tree then gets the same CIDs on Tezos and EVM chains.

## Layout

```
tezos/
  onchfs_files.tz            # patched file-system contract ("cheap" CIDs)
  original/
    onchfs_files.tz          # as deployed: KT1BFSXud4o9NLqauoxiB7oUHxS1wfaf98Gu
                             #   (identical to fxhash KT1Ae7dT1gsLw2tRnUMXSCmEyF74KVkM6LUo)
    content_store.tz         # as deployed: KT1BEeVi6T44jiWPNsnG37ts96Sr5XGAk9rG
                             #   (identical to fxhash KT1JySSNRfQeRzrkZJypyoHDBRDaTbtTYAq1)
test/                        # node:test suite, runs octez-client mockup in docker
```

Originals were fetched from Tezos mainnet via tzkt (Micheline JSON) and
converted with `octez-client convert script`.

## The change

Only the `create_file` entrypoint differs:

| | file CID |
|---|---|
| original ("consistent") | `keccak(0x01 ‖ keccak(chunk_1 ‖ … ‖ chunk_n) ‖ keccak(metadata))`, which reads every chunk back via `VIEW "read"` |
| patched ("cheap") | `keccak(0x01 ‖ keccak(ptr_1 ‖ … ‖ ptr_n) ‖ keccak(metadata))`, which only checks `VIEW "chunk_exists"` |

Chunk pointers are `keccak(chunk)` on both chains, and directory CIDs were
already identical. Storage layout, views, `create_directory` and
`write_chunk` are unchanged, so the patched contract can point at an
existing content store and reuse chunks that are already inscribed.

**Caveat:** "cheap" CIDs depend on chunking. Every uploader on every chain
must use the same chunk size (onchfs-js default: 16384). Use
`fileHashingStrategy: "cheap"` in onchfs-js against this contract.

## Tests

Requires docker (image `tezos/tezos:octez-v23.2`, override with `OCTEZ_IMAGE`).

```
cd test && npm install && npm test
```

The tests check that:
- the original contract produces the onchfs-js `consistent` root CID
- the patched contract produces the onchfs-js `cheap` CIDs for every file and directory
- those CIDs equal an independent reimplementation of the `FileSystem.sol` formulas
- the read views still return the original content
- unknown chunk pointers are rejected and `create_file` is idempotent

## Deploy (not done)

```
octez-client originate contract onchfs_files transferring 0 from <you> \
  running tezos/onchfs_files.tz \
  --init 'Pair "KT1BEeVi6T44jiWPNsnG37ts96Sr5XGAk9rG" {}' --burn-cap 2
```
