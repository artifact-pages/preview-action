import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// CLI installation for the published composite Actions (TD14). A published Action
// repository carries a generated `release.json` naming the product version and the
// repository whose release holds the CLI. The Action always installs exactly that
// CLI, checksum-verified, so the Action version (also under a SHA pin) decides the
// CLI version. There is no source build and no fallback.
//
// Unreleased source (this monorepo's actions/<name>, no release.json) cannot name a
// release. CI exercises it with a CLI built in the job, passed as
// ARTIFACT_PAGES_TEST_CLI; that variable is ignored by every published Action.

// Platforms the release workflow builds and the Actions can run. Windows is not
// built, so the Actions do not support Windows runners.
export const platforms = [
  { os: 'linux', arch: 'amd64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'darwin', arch: 'amd64' },
  { os: 'darwin', arch: 'arm64' },
]

const runnerOS = { Linux: 'linux', macOS: 'darwin' }
const runnerArch = { X64: 'amd64', ARM64: 'arm64' }

export function assetName(version, os, arch) {
  return `artifact-pages_v${version}_${os}_${arch}`
}

export function checksumsName(version) {
  return `artifact-pages_v${version}_checksums.txt`
}

export function noticesName(version) {
  return `artifact-pages_v${version}_THIRD_PARTY_NOTICES.txt`
}

// Reads the generated release.json. Returns undefined when the Action runs from
// unreleased source. A present but malformed file is an error: it must never degrade
// into the unreleased path.
export function readRelease(actionRoot) {
  let text
  try {
    text = readFileSync(path.join(actionRoot, 'release.json'), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  const release = JSON.parse(text)
  if (release.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(release.version ?? '')) throw new Error('release.json does not name a release version')
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(release.repository ?? '') || release.repository.split('/').some((part) => part === '.' || part === '..')) throw new Error('release.json does not name a release repository')
  return { version: release.version, repository: release.repository }
}

// Returns { version, tag, repository, asset, ... }; throws for an unsupported runner.
export function selectPrebuilt({ release, runnerOs, runnerArch: arch }) {
  const os = runnerOS[runnerOs]
  const cpu = runnerArch[arch]
  if (!os || !cpu) throw new Error(`no released CLI for runner ${runnerOs || '(unknown)'}/${arch || '(unknown)'}; use a Linux or macOS runner`)
  const { version, repository } = release
  const tag = `v${version}`
  const base = `https://github.com/${repository}/releases/download/${tag}/`
  const asset = assetName(version, os, cpu)
  return { version, tag, repository, asset, checksums: checksumsName(version), assetUrl: base + asset, checksumsUrl: base + checksumsName(version) }
}

export function parseChecksums(text) {
  const entries = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]([^\s/\\]+)$/.exec(line.trim())
    if (match) entries.set(match[2], match[1].toLowerCase())
  }
  return entries
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function download(url, { fetchImpl, token }) {
  const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
  if (response.status === 200) return Buffer.from(await response.arrayBuffer())
  if ((response.status === 403 || response.status === 429) && token) {
    // Rate limited without authentication: retry through the API with the workflow token.
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url)
    if (match) {
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      const release = await fetchImpl(`https://api.github.com/repos/${match[1]}/releases/tags/${match[2]}`, { headers, signal: AbortSignal.timeout(30000) })
      if (release.status === 200) {
        const asset = (await release.json()).assets?.find((candidate) => candidate.name === match[3])
        if (asset?.url) {
          const authenticated = await fetchImpl(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' }, redirect: 'follow', signal: AbortSignal.timeout(60000) })
          if (authenticated.status === 200) return Buffer.from(await authenticated.arrayBuffer())
        }
      }
    }
  }
  const error = new Error(`download of ${url} returned HTTP ${response.status}`)
  error.status = response.status
  throw error
}

// Downloads, verifies and installs the binary at `destination`. Any failure (no
// release, missing asset or checksum entry, mismatch) throws: the Action must not
// run a CLI it could not verify.
export async function installPrebuilt(options) {
  const selection = selectPrebuilt(options)
  const fetchImpl = options.fetchImpl ?? fetch
  const token = options.token ?? ''
  let checksums
  let binary
  try {
    checksums = parseChecksums((await download(selection.checksumsUrl, { fetchImpl, token })).toString('utf8'))
    if (!checksums.has(selection.asset)) throw new Error(`${selection.checksums} has no entry for ${selection.asset}`)
    binary = await download(selection.assetUrl, { fetchImpl, token })
  } catch (error) {
    throw new Error(`release ${selection.tag} of ${selection.repository} is unavailable: ${String(error.message).replace(token || '\u0000', '***')}`)
  }
  const actual = sha256(binary)
  if (actual !== checksums.get(selection.asset)) {
    throw new Error(`checksum mismatch for ${selection.asset}: expected ${checksums.get(selection.asset)}, got ${actual}`)
  }
  writeFileSync(options.destination, binary)
  chmodSync(options.destination, 0o755)
  return { reason: `${selection.asset} verified against ${selection.checksums}`, version: selection.version }
}

// Unreleased source only: installs the CLI that CI built from the same commit.
export function installTestCli({ testCli, destination }) {
  if (!testCli || !existsSync(testCli)) throw new Error('unreleased Action source needs ARTIFACT_PAGES_TEST_CLI to name a built artifact-pages binary')
  copyFileSync(testCli, destination)
  chmodSync(destination, 0o755)
  return { reason: `unreleased source; using the CLI built by this workflow (${path.basename(testCli)})` }
}

async function main() {
  const env = process.env
  const rootIndex = process.argv.indexOf('--action-root')
  const actionRoot = rootIndex >= 0 ? process.argv[rootIndex + 1] : ''
  const destination = path.join(env.RUNNER_TEMP, 'artifact-pages')
  try {
    const release = readRelease(actionRoot)
    let result
    if (release) {
      if (env.ARTIFACT_PAGES_TEST_CLI) process.stdout.write('::notice title=Artifact Pages CLI::ARTIFACT_PAGES_TEST_CLI is ignored by a published Action.\n')
      result = await installPrebuilt({ release, runnerOs: env.RUNNER_OS, runnerArch: env.RUNNER_ARCH, destination, token: env.ARTIFACT_PAGES_TOKEN ?? '' })
      process.stdout.write(`Artifact Pages CLI v${result.version}: ${result.reason}.\n`)
    } else {
      result = installTestCli({ testCli: env.ARTIFACT_PAGES_TEST_CLI, destination })
      process.stdout.write(`Artifact Pages CLI: ${result.reason}.\n`)
    }
  } catch (error) {
    process.stderr.write(`::error title=Artifact Pages CLI::${String(error.message).replace(env.ARTIFACT_PAGES_TOKEN || '\u0000', '***')}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
