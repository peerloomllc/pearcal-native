#!/usr/bin/env node
// Emit the StartOS 0.4 registry payload for a v2 s9pk.
//
// StartOS 0.4 marketplaces do not read the 0.3.5 static tree that
// build-registry.sh produces. They speak JSON-RPC over POST /rpc/v0, so
// `https://peerloomllc.com` fails on 0.4 with "RPC ERROR: Network Error Not
// Found" while still working perfectly on 0.3.5.x boxes.
//
// The whole payload is static per release, so it is generated here and served
// verbatim by a tiny Worker. That keeps the request path dumb: no s9pk
// inspection, no crypto, no start-cli at the edge.
//
// COMBINED registry: like build-registry.sh for the 0.3.5 tree, this UPSERTS
// this package into whatever payload already exists at --out — it does NOT
// write the file wholesale. peerloomllc.com is one registry listing several
// PeerLoom seeders (pearcal-seeder, pearcircle-seeder, ...), and 0.4 serves
// them from a SINGLE generated document, so a generator that overwrote it
// would silently delist every other app. Only this id's entry under
// packageIndex.packages is replaced; categories are unioned and the registry
// name is left alone.
//
// NOTE: every app publishing into the shared payload must use merge-aware
// tooling like this. Keep this file in step with the sibling copies in the
// other PeerLoom repos — they are deliberately near-identical.
//
// What 0.4 actually demands, established by driving a real 0.4 client
// (`start-cli -r <url> registry package index`) against a stub registry on
// 2026-07-27:
//   - `commitment` is MANDATORY. Omitting it fails deserialization outright.
//     Its value comes from the s9pk itself, so we can generate it.
//   - `icon` must be a real base64 data URL. `null` is rejected.
//   - `signatures` may be empty ONLY to browse. An unsigned entry lists fine
//     and then fails install with "Invalid Signature Signer(s) not accepted".
//     Self-signing is enough - see signCommitment below for why, and for what
//     exactly gets signed.
//
// Usage:
//   build-registry-04.js <path-to-v2.s9pk> --url <public-s9pk-url> \
//     [--icon <png>] [--out <file>] [--registry-name <name>] [--signing-key <pem>]
//
// Env: START_CLI overrides the start-cli binary. It must be the 0.4-era one
// (1.x); the 0.3.5 SDK's start-cli has no `s9pk inspect` and will fail.

const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

function arg (flag, fallback = null) {
  const i = process.argv.indexOf(flag)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const S9PK = process.argv[2]
if (!S9PK || S9PK.startsWith('--')) {
  console.error('usage: build-registry-04.js <v2.s9pk> --url <public-s9pk-url> [--icon f.png] [--out f.json]')
  process.exit(1)
}
if (!fs.existsSync(S9PK)) {
  console.error(`build-registry-04: s9pk not found: ${S9PK}`)
  process.exit(1)
}

const S9PK_URL = arg('--url')
if (!S9PK_URL) {
  console.error('build-registry-04: --url is required (where the s9pk is downloadable)')
  process.exit(1)
}

const START_CLI = process.env.START_CLI || 'start-cli'
const ICON = arg('--icon', path.join(path.dirname(S9PK), 'icon.png'))
const OUT = arg('--out', path.join(path.dirname(S9PK), 'registry-04.json'))
const REGISTRY_NAME = arg('--registry-name', 'PeerLoom Registry')
// The key the entry is self-signed with. Defaults to the same developer key
// that signs the s9pk itself, so the registry and the package share an identity.
const SIGNING_KEY = arg('--signing-key', process.env.START9_SIGNING_KEY || `${process.env.HOME}/.embassy/developer.key.pem`)

// Categories are the registry's own vocabulary; package entries reference
// these keys. Kept in step with the 0.3.5 tree so a package does not appear
// under different headings depending on which StartOS version is asking.
const CATEGORIES = {
  featured: { name: 'Featured' },
  networking: { name: 'Networking' },
}
const PACKAGE_CATEGORIES = ['featured', 'networking']

// `inspect` takes the s9pk BEFORE the subcommand (`inspect <s9pk> manifest`),
// which is the opposite of most start-cli commands and an easy hour to lose.
function inspect (sub) {
  const raw = execFileSync(START_CLI, ['s9pk', 'inspect', S9PK, sub], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return JSON.parse(raw)
}

// 0.3.5 manifests carry plain strings where 0.4 wants a locale map. Only
// en_US is claimed: asserting a translation we do not have would be worse
// than offering one language.
const loc = (v) => (typeof v === 'string' && v.length > 0 ? { en_US: v } : { en_US: '' })

// Sign the commitment so the entry can actually be INSTALLED, not just browsed.
//
// An unsigned entry lists fine and then fails install with "Invalid Signature
// Signer(s) not accepted". StartOS derives its accept-policy from the asset's
// OWN signatures - RegistryAsset::all_signers() returns
// AcceptSigners::All(signatures.keys()), and install/mod.rs calls
// `asset.validate(SIG_CONTEXT, asset.all_signers())`. So self-signing is
// sufficient: any key is accepted provided its signature verifies. With no
// signatures the policy is All([]), which never becomes Accepted - hence the
// error, permanently, whatever the key.
//
// What gets signed (sign/commitment/merkle_archive.rs): SHA-512 over the raw
// root_sighash bytes followed by root_maxsize as a big-endian u64. Signed with
// Ed25519ph - the PREHASHED variant - under context "s9pk" (s9pk/v2/mod.rs).
//
// openssl does this correctly and is used rather than a JS library because
// neither Node's crypto nor Python's cryptography exposes Ed25519ph with a
// context; both would silently produce a plain-Ed25519 signature that looks
// right and fails verification. Validated against the RFC 8032 section 7.3
// Ed25519ph test vector, which this openssl reproduces byte for byte.
function signCommitment (c) {
  const msg = Buffer.concat([
    Buffer.from(c.rootSighash, 'base64url'),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(c.rootMaxsize)); return b })(),
  ])

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's9sig-'))
  const msgFile = path.join(tmp, 'msg.bin')
  const sigFile = path.join(tmp, 'sig.bin')
  const pubFile = path.join(tmp, 'pub.pem')
  const ph = ['-pkeyopt', 'instance:ed25519ph', '-pkeyopt', 'context-string:s9pk']

  try {
    fs.writeFileSync(msgFile, msg)

    execFileSync('openssl', ['pkey', '-in', SIGNING_KEY, '-pubout', '-out', pubFile],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    execFileSync('openssl',
      ['pkeyutl', '-sign', '-inkey', SIGNING_KEY, '-rawin', '-in', msgFile, ...ph, '-out', sigFile],
      { stdio: ['ignore', 'ignore', 'pipe'] })

    // Fail closed. An entry whose signature does not verify would list happily
    // and then refuse to install, which is worse than not publishing at all.
    execFileSync('openssl',
      ['pkeyutl', '-verify', '-pubin', '-inkey', pubFile, '-rawin', '-in', msgFile,
        '-sigfile', sigFile, ...ph],
      { stdio: ['ignore', 'ignore', 'pipe'] })

    // Registry format, matching registry.start9.com: the key is a standard SPKI
    // PEM, and the value is the 64-byte signature DER-wrapped with the Ed25519
    // algorithm identifier (SEQUENCE { AlgorithmIdentifier, OCTET STRING }) in a
    // PEM block labelled SIGNATURE.
    const rawSig = fs.readFileSync(sigFile)
    if (rawSig.length !== 64) throw new Error(`expected a 64-byte signature, got ${rawSig.length}`)
    const der = Buffer.concat([Buffer.from('3049300506032b65700440', 'hex'), rawSig])
    const sigPem = '-----BEGIN SIGNATURE-----\n' +
      (der.toString('base64').match(/.{1,64}/g) ?? []).join('\n') +
      '\n-----END SIGNATURE-----\n'

    return { [fs.readFileSync(pubFile, 'utf8')]: sigPem }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

console.error(`==> inspecting ${path.basename(S9PK)} (this reads the whole package, give it a minute)`)
const manifest = inspect('manifest')
const commitment = inspect('commitment')

if (!fs.existsSync(ICON)) {
  console.error(`build-registry-04: icon not found: ${ICON} (0.4 rejects a null icon)`)
  process.exit(1)
}
const iconDataUrl = 'data:image/png;base64,' + fs.readFileSync(ICON).toString('base64')

const version = manifest.version // already "1.0.35:0" shape in a v2 manifest
if (!version) {
  console.error('build-registry-04: manifest has no version')
  process.exit(1)
}

const arches = manifest.hardwareRequirements?.arch ?? ['x86_64', 'aarch64']

// --- read whatever is already published ------------------------------------
// Missing or unreadable is normal (first run). Anything else present is another
// package's entry and must survive.
let prior = null
try {
  prior = JSON.parse(fs.readFileSync(OUT, 'utf8'))
} catch {
  prior = null
}
const priorPackages = prior?.packageIndex?.packages ?? {}

// Re-stamping publishedAt on every run would churn the payload even when
// nothing about the package changed, and publish-start9-registry.sh decides
// whether there is anything to publish by diffing the working tree. So carry
// the previous timestamp forward when this exact package is already published
// at the same version and commitment, and stamp fresh otherwise.
const priorAsset = priorPackages[manifest.id]?.versions?.[version]?.s9pks?.[0]?.[1]
const unchanged = priorAsset &&
  priorAsset.commitment?.rootSighash === commitment.rootSighash &&
  String(priorAsset.commitment?.rootMaxsize) === String(commitment.rootMaxsize) &&
  Array.isArray(priorAsset.urls) && priorAsset.urls[0] === S9PK_URL
const publishedAt = arg('--published-at',
  unchanged ? priorAsset.publishedAt : new Date().toISOString().replace('Z', '000000Z'))

const versionEntry = {
  title: manifest.title,
  description: {
    short: loc(manifest.description?.short),
    long: loc(manifest.description?.long),
  },
  releaseNotes: loc(manifest.releaseNotes),
  // start-cli appends a newline (and "-modified" for a dirty tree) to gitHash.
  gitHash: typeof manifest.gitHash === 'string' ? manifest.gitHash.trim() : null,
  license: manifest.license ?? null,
  packageRepo: manifest.packageRepo ?? null,
  upstreamRepo: manifest.upstreamRepo ?? null,
  marketingUrl: manifest.marketingUrl ?? null,
  donationUrl: manifest.donationUrl ?? null,
  osVersion: manifest.osVersion ?? null,
  sdkVersion: manifest.sdkVersion ?? null,
  hardwareAcceleration: manifest.hardwareAcceleration ?? false,
  userspaceFilesystems: manifest.userspaceFilesystems ?? false,
  virtualNetworking: manifest.virtualNetworking ?? false,
  plugins: manifest.plugins ?? [],
  satisfies: manifest.satisfies ?? [],
  icon: iconDataUrl,
  dependencyMetadata: {},
  sourceVersion: null,
  // One entry: a hardware predicate paired with where to get the file.
  s9pks: [[
    { device: [], ram: null, arch: arches },
    {
      publishedAt,
      urls: [S9PK_URL],
      commitment,
      signatures: signCommitment(commitment),
    },
  ]],
}

// --- UPSERT this package, preserving every other one -----------------------
// We publish a single version per package, so this id's versions map is
// replaced rather than accumulated; other ids are copied through untouched.
const packages = { ...priorPackages }
packages[manifest.id] = {
  authorized: {},
  categories: PACKAGE_CATEGORIES,
  versions: { [version]: versionEntry },
}
// Stable order by id so re-runs produce a deterministic diff.
const orderedPackages = Object.fromEntries(
  Object.entries(packages).sort(([a], [b]) => a.localeCompare(b)),
)

// Categories are unioned: another package may list under headings we do not.
const categories = { ...(prior?.packageIndex?.categories ?? {}), ...(prior?.info?.categories ?? {}), ...CATEGORIES }

const payload = {
  // The registry name belongs to the registry, not to any one package, so an
  // existing one wins - otherwise two apps with different defaults would flip
  // it back and forth on alternate releases.
  info: { name: prior?.info?.name ?? REGISTRY_NAME, icon: prior?.info?.icon ?? null, categories },
  packageIndex: {
    categories,
    packages: orderedPackages,
  },
}

fs.writeFileSync(OUT, JSON.stringify(payload, null, 2))
console.error(`==> wrote ${OUT}`)
console.error(`    ${manifest.id} ${version} | arch ${arches.join(',')} | rootSighash ${commitment.rootSighash}`)
console.error(`    payload lists ${Object.keys(orderedPackages).length} package(s): ${Object.keys(orderedPackages).join(', ')}`)
