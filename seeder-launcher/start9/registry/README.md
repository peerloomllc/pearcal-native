# PearCal Seeder — StartOS community registry

Lets StartOS users install the seeder by **adding a registry URL** in their
Marketplace, instead of manually sideloading the `.s9pk` (and it gives them
"update available" notifications on new releases).

A StartOS 0.3.5.x registry is just an HTTP host that answers the marketplace
protocol's `GET /package/v0/...` endpoints. It's a **static file tree** — no
database, no registry service, no signing keyring (the s9pk is self-signed by
`start-sdk pack`; StartOS only checks the signature is internally valid).
`build-registry.sh` generates that tree from the built `.s9pk`.

## Combined (multi-package) registry

PeerLoom serves **one** registry (`peerloomllc.com`) that lists several seeders
(pearcircle-seeder, pearcal-seeder, …). `build-registry.sh` is **merge-aware**:
it upserts *this* package into whatever tree already exists at `OUT_DIR` and
leaves the others untouched. Only three files are shared across packages and get
merged — `index` (array; this id's entry is replaced in place), `latest`
(`{id: version}`), and `info` (categories unioned); everything else
(`manifest/<id>`, `instructions/<id>`, …) is namespaced by id.

> Every app publishing into the shared tree must use merge-aware tooling like
> this. A legacy `rm -rf package`-style generator would drop the other packages.

## Generate

```bash
cd seeder-launcher/start9
make                                # build the x86_64 .s9pk first
bash registry/build-registry.sh     # upsert into ./registry/dist (default OUT_DIR)
# -> registry/dist/package/v0/{info,index,latest,version/…,manifest/…,
#      release-notes/…,instructions/…,license/…,icon/…,pearcal-seeder.s9pk}
```

The JSON shapes mirror the live `registry.start9.com` exactly: `icon` is raw
base64 (no `data:` prefix), `instructions`/`license` are `/package/v0/...` paths,
and each index entry embeds the normalized manifest.

## Host it

Serve the tree as a static site. **The protocol paths are extensionless, so
Content-Type must be set by route, not file extension** — this is the one thing
a static host must get right:

| Path | Content-Type |
|------|--------------|
| `/package/v0/pearcal-seeder.s9pk` | `application/octet-stream` |
| `/package/v0/icon/pearcal-seeder` | `image/png` |
| `/package/v0/instructions/pearcal-seeder` | `text/markdown` |
| `/package/v0/license/pearcal-seeder` | `text/plain` |
| everything else under `/package/v0` | `application/json` |

`serve-registry.js` is a reference implementation of exactly these rules (used
for local testing): `node registry/serve-registry.js 8099 <dist-dir>`.

### Deployed at peerloomllc.com (Cloudflare)

The live registry is the PeerLoom website (a Cloudflare project that deploys on
merge to `main`). Its `_headers` sets the per-route Content-Types and
`_redirects` sends `/package/v0/pearcal-seeder.s9pk` to the GitHub Release asset
(the s9pk is hundreds of MiB, over Cloudflare's 25 MiB per-file limit). Registry
URL users add: `https://peerloomllc.com`.

On a seeder release this is automated by the release pipeline:
`build-start9-s9pk.sh` builds the s9pk (uploaded to the release tag by
`release.sh`), then `seeder-launcher/scripts/publish-start9-registry.sh`
upserts the metadata, points `_redirects` at the new tag, and (with
`WEBSITE_REGISTRY_PR=1`) opens + squash-merges the website PR — the merge is the
deploy.

To refresh it by hand against a website clone:

```bash
WEBSITE_DIR=/path/to/website \
  bash seeder-launcher/scripts/publish-start9-registry.sh 1.0.33
# review the diff under package/ + _redirects, then commit + open a website PR
# (or set WEBSITE_REGISTRY_PR=1 to do it automatically).
```

## Arch note

The PearCal Start9 package is **universal** (x86_64 + aarch64; see
`../manifest.yaml` hardware-requirements), matching the PearCircle seeder — one
`.s9pk` installs on both a typical x86 Start9 server and an arm one
(Raspberry Pi). The bare runtime binary is stripped at stage time
(`stage-payload.sh`), which trims the package without dropping an arch.
