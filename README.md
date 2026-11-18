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
scripts/migrate.js           # plan a migration of inodes from an old files contract
migrations/                  # old -> new CID mappings of executed migrations
```

## Deployments

| network | contract | content store |
|---|---|---|
| tezos:mainnet | `KT1M3JKHiEzo8iLve8AWtRVHd1vW2jiCjXd1` | `KT1BEeVi6T44jiWPNsnG37ts96Sr5XGAk9rG` |
| Tezos X / Etherlink mainnet (Michelson, `NetXohUVN5QWR4f`) | `KT1JYZ2o6keUiTChNKUQnWDcMkjzES3djjRY` | `KT1K2ZoHEoTCfbq8BqNE8qrZpANFqRE7YdVt` |

Tezos X Michelson RPC: `https://michelson.etherlink.mainnet.octez.io`, indexer
`https://api.etherlink.tzkt.io`. Storage costs 1 mutez/byte there (L1: 250).
Note: octez-client may fail with `live_blocks` not found while waiting for
inclusion; the operation is still injected, check the indexer.

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
npm install && npm test
```

The tests check that:
- the original contract produces the onchfs-js `consistent` root CID
- the patched contract produces the onchfs-js `cheap` CIDs for every file and directory
- those CIDs equal an independent reimplementation of the `FileSystem.sol` formulas
- the read views still return the original content
- unknown chunk pointers are rejected and `create_file` is idempotent

## Deploy

```
octez-client originate contract onchfs_files transferring 0 from <you> \
  running tezos/onchfs_files.tz \
  --init 'Pair "<content_store>" {}' --burn-cap 1
```

Costs about 0.64 ꜩ on mainnet (2300 bytes of storage).

## Migrating from an old contract

`scripts/migrate.js` reads inodes from an old (consistent-CID) contract via
tzkt, recomputes their CIDs bottom-up with the cheap formula, skips anything
already present on the new contract and prints a plan:

```
npm run migrate -- <old_contract> <new_contract> <old_cid>... > plan.json
jq '.batches[0]' plan.json > batch0.json   # repeat for every batch, in order
octez-client multiple transfers from <you> using "$(cat batch0.json)" --burn-cap 2
```

When the new contract uses the same content store, chunks are not
re-uploaded. To migrate to another chain (e.g. Tezos X), set `CHUNKS=1` to copy
chunk contents from the old content store and `TZKT_NEW` to the indexer of the
new chain:

```
TZKT_NEW=https://api.etherlink.tzkt.io/v1 CHUNKS=1 npm run migrate -- ...
``` Inode storage is roughly 130 B per file and 110–180 B per small
directory. See `migrations/` for the 2026-11-18 migrations of
`KT1BFSXud4o9NLqauoxiB7oUHxS1wfaf98Gu` (31 inodes) to L1 (~1.1 ꜩ) and to
Tezos X (~0.19 ꜩ incl. originations, chunks and fees). Both yield identical CIDs.
