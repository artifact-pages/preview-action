import { randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolvePreviewRefs, resolvePullRequestReference } from './preview-refs.mjs'
import { evaluatePublishOn } from './publish-on.mjs'
import { writeSummary } from './summary.mjs'

function input(name) {
  return process.env[`ARTIFACT_PAGES_INPUT_${name.toUpperCase().replaceAll('-', '_')}`] ?? ''
}

function required(name) {
  const value = input(name).trim()
  if (!value) throw new Error(`input "${name}" is required for this operation`)
  return value
}

function flag(args, name, value) {
  if (value !== '') args.push(`--${name}`, value)
}

function boolInput(name) {
  const value = input(name).trim().toLowerCase()
  if (value === '' || value === 'false') return false
  if (value === 'true') return true
  throw new Error(`input "${name}" must be true or false`)
}

// publish, registry and app-deploy runs honor `publish-on`: a run outside the condition is a dry-run.
function effectiveDryRun() {
  return evaluatePublishOn({ dryRun: boolInput('dry-run') })
}

// Each Action selects exactly one CLI operation; there is no operation input.
const operations = {
  publish: 'site publish',
  preview: 'preview publish',
  registry: 'registry register',
  'app-deploy': 'app deploy',
}

function buildArguments() {
  const kind = process.env.ARTIFACT_PAGES_ACTION_KIND
  const operation = operations[kind]
  if (!operation) throw new Error(`unsupported Action kind: ${kind || '(missing kind)'}`)
  const args = operation.split(' ')
  let dryRunReason = ''
  const publishDryRun = () => {
    const decision = effectiveDryRun()
    dryRunReason = decision.reason
    if (decision.dryRun) args.push('--dry-run')
  }

  if (kind === 'registry') {
    flag(args, 'config', input('config'))
    publishDryRun()
  } else if (kind === 'app-deploy') {
    flag(args, 'archive', input('archive').trim())
    flag(args, 'repository', input('repository') || 'artifact-pages/artifact-pages')
    flag(args, 'config', input('config'))
    publishDryRun()
  } else if (kind === 'publish') {
    args.push('--site', required('site'))
    flag(args, 'source', input('source'))
    flag(args, 'config', input('config'))
    publishDryRun()
  } else {
    args.push('--site', required('site'))
    flag(args, 'source', input('source').trim())
    const refs = resolvePreviewRefs()
    flag(args, 'head', refs.head)
    flag(args, 'default-ref', refs.defaultRef)
    flag(args, 'pull-request', resolvePullRequestReference().reference)
    flag(args, 'base-url', input('base-url').trim())
    flag(args, 'config', input('config').trim())
    for (const line of input('include').split(/\r?\n/)) {
      const include = line.trim()
      if (include) flag(args, 'include', include)
    }
    if (boolInput('dry-run')) args.push('--dry-run')
  }

  args.push('--format', 'json')
  return { kind, operation, args, dryRunReason }
}

function cliOperationName(kind) {
  return operations[kind] ?? 'artifact-pages'
}

function compactResult(raw, fallbackOperation, fallbackSite, exitCode, stderr) {
  try {
    return JSON.parse(raw)
  } catch {
    return {
      operation: fallbackOperation,
      outcome: 'failed',
      site: fallbackSite,
      changes: [],
      error: stderr.trim() || 'artifact-pages did not return a JSON result',
      exitCode,
    }
  }
}

async function writeOutputs(result, exitCode, fallbackSite) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (!outputPath) return
  const values = {
    operation: result.operation ?? '',
    outcome: result.outcome ?? 'failed',
    site: result.site ?? fallbackSite ?? '',
    'registry-updated': typeof result.registryUpdated === 'boolean' ? String(result.registryUpdated) : '',
    changes: JSON.stringify(result.changes ?? []),
    'preview-changes': JSON.stringify(result.previewChanges ?? []),
    result: JSON.stringify(result),
    'exit-code': String(exitCode),
    error: result.error ?? '',
  }
  if (result.operation === 'preview publish') {
    values['group-list-url'] = result.groupListUrl ?? ''
    values.documents = JSON.stringify(result.documents ?? [])
  }
  const delimiter = `ARTIFACT_PAGES_${randomUUID().replaceAll('-', '')}`
  const content = Object.entries(values)
    .map(([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
    .join('')
  await appendFile(outputPath, content, 'utf8')
}

async function main() {
  const cliPath = process.env.ARTIFACT_PAGES_CLI
  const fallbackSite = input('site').trim()
  let built
  let child

  try {
    if (!cliPath) throw new Error('ARTIFACT_PAGES_CLI must name the built artifact-pages binary')
    built = buildArguments()
    child = spawnSync(cliPath, built.args, {
      cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
      env: process.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    if (child.error) throw child.error
    if (built.dryRunReason && built.dryRunReason !== 'dry-run input is true') {
      process.stderr.write(`::notice title=Artifact Pages dry-run::${built.dryRunReason}; running as a dry-run.\n`)
    }
  } catch (error) {
    const operation = cliOperationName(built?.kind ?? process.env.ARTIFACT_PAGES_ACTION_KIND)
    const exitCode = 2
    const result = {
      operation,
      outcome: 'failed',
      ...(fallbackSite ? { site: fallbackSite } : {}),
      changes: [],
      error: error.message,
    }
    process.stdout.write(`${JSON.stringify(result)}\n`)
    await writeOutputs(result, exitCode, fallbackSite)
    await writeSummary({ kind: built?.kind ?? process.env.ARTIFACT_PAGES_ACTION_KIND, operation, result, exitCode })
    process.exitCode = exitCode
    return
  }

  const exitCode = Number.isInteger(child.status) ? child.status : 1
  const result = compactResult(child.stdout ?? '', cliOperationName(built.kind), fallbackSite, exitCode, child.stderr ?? '')
  process.stdout.write(child.stdout ?? '')
  process.stderr.write(child.stderr ?? '')
  await writeOutputs(result, exitCode, fallbackSite)
  await writeSummary({
    kind: built.kind,
    operation: cliOperationName(built.kind),
    result,
    exitCode,
    dryRun: built.args.includes('--dry-run'),
    dryRunReason: built.dryRunReason,
  })
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
