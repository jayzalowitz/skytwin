# Internal Source Candidates

An internal source candidate is an immutable source snapshot for bounded
evaluation. It is not a public release, does not contain packaged application
artifacts, and cannot update the `latest` release feed. The public release gate
in [the release procedure](./release-procedure.md) remains the only path for
publishing a `v*` release.

## Create a candidate

Start from the exact commit that has been selected for evaluation. The checkout
must be clean, including untracked files, and must not use skip-worktree or
assume-unchanged index flags. The output directory must be a new directory
outside the checkout.

```bash
SOURCE_COMMIT="$(git rev-parse HEAD)"
test "${#SOURCE_COMMIT}" -eq 40
SHORT_COMMIT="$(printf '%s' "$SOURCE_COMMIT" | cut -c1-12)"
node scripts/source-candidate/create-source-candidate.mjs \
  --commit "$SOURCE_COMMIT" \
  --output-dir "../skytwin-source-candidate-$SHORT_COMMIT"
```

The packager accepts only a full lowercase commit SHA. It does not accept tags,
labels, release names, publication options, or an existing output directory.
It emits four local files:

- `skytwin-source-candidate-<short-sha>.tar.gz` — a deterministic `git archive`
  of the exact commit, with no `.git` directory.
- `SHA256SUMS` — SHA-256 checksums for the archive, notes, and manifest.
- `source-manifest.json` — the exact commit/tree, archive digest, and every
  tracked path, mode, Git object, and byte count.
- `CANDIDATE-NOTES.md` — fixed conservative evaluation boundaries and install
  instructions. The command accepts no custom promotional copy.

Creating these files does not push a ref, create a GitHub Release, upload an
artifact, contact a service, or change the beta claim ledger. Store and share
them only through the separately approved internal channel.

## Verify and install the archive

The archive path is the preferred immutable install route. Unlike the normal
one-command source installer, it cannot follow a moving `main` branch because
the extracted directory has no Git metadata.

```bash
shasum -a 256 -c SHA256SUMS
tar -xzf skytwin-source-candidate-<short-sha>.tar.gz
cd skytwin-source-candidate-<short-sha>
SKYTWIN_SOURCE_ARCHIVE=true ./install.sh
```

The explicit archive mode resolves the install directory from the extracted
`install.sh` itself, ignores any inherited `SKYTWIN_INSTALL_DIR`, refuses Git
metadata, and never enters the clone/fetch/merge path. It can still download
missing public prerequisites such as Node.js or CockroachDB, so this is not an
offline or no-network installation claim.

For source inspection without packaging, pin and verify a detached checkout:

```bash
SOURCE_COMMIT='<full 40-character commit SHA supplied by the candidate owner>'
git clone --no-checkout https://github.com/jayzalowitz/skytwin.git skytwin-candidate
git -C skytwin-candidate fetch --depth=1 origin "$SOURCE_COMMIT"
git -C skytwin-candidate checkout --detach "$SOURCE_COMMIT"
test "$(git -C skytwin-candidate rev-parse HEAD)" = "$SOURCE_COMMIT"
```

Do not run the top-level `install.sh` in that Git checkout if immutability is
required: its normal branch-oriented behavior intentionally fetches and
fast-forwards `main`. Use the verified archive install above, or follow the
manual dependency, database, build, and development commands in the README.

## Claim boundary

The account-free path is the seeded development demo reached through “Just show
me around.” Google and Microsoft account connections are outside this evaluation
path. An explicit Google source-development experiment remains unsupported and
is not candidate evidence.

A compatible local model and llama.cpp runtime are separate prerequisites and
are not bundled. Hosted providers remain opt-in. Local-first must not be
shortened to offline, no-cloud, or no-network: configured integrations, model
downloads, updates, and diagnostics may use the network. Verified-private
inference remains unavailable until its production provider and verifier exist.

The machine-checked beta claim ledger stays authoritative. A source candidate
does not change claim states, supported platforms, stop-ship conditions, signing
requirements, or clean-machine evidence requirements.
