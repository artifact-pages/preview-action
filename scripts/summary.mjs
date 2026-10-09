import { appendFile } from 'node:fs/promises'

// Job Summary contract (specification "Shared Action behavior"). The summary is
// rendered from the typed CLI result only, so it is the same for every caller.
const maxDocumentRows = 50
const maxChangeLines = 100

function code(value) {
  const text = String(value ?? '')
  return `\`${text.replaceAll('`', "'")}\``
}

function cell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, ' ')
}

function oneLine(value) {
  return String(value ?? '').trim().replace(/\s*\r?\n\s*/g, ' ')
}

function breakdown(changes) {
  const counts = new Map()
  for (const change of changes) counts.set(change.action, (counts.get(change.action) ?? 0) + 1)
  const parts = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([action, count]) => `${action} ${count}`)
  return parts.length ? ` (${parts.join(', ')})` : ''
}

function changeList(changes) {
  if (changes.length === 0) return []
  const lines = ['', `<details><summary>Changes (${changes.length})</summary>`, '', '```text']
  for (const change of changes.slice(0, maxChangeLines)) lines.push(`${change.action} ${change.path}`)
  if (changes.length > maxChangeLines) lines.push(`... and ${changes.length - maxChangeLines} more`)
  lines.push('```', '', '</details>')
  return lines
}

function siteIDsFromRegistryChanges(changes, actions) {
  const ids = []
  for (const change of changes) {
    const match = /^_indexes\/sites\.json#sites\/(.+)$/.exec(change.path ?? '')
    if (match && actions.includes(change.action)) ids.push(match[1])
  }
  return [...new Set(ids)].sort()
}

function idList(ids) {
  return ids.length ? ids.map(code).join(', ') : 'none'
}

// Returns the Markdown appended to GITHUB_STEP_SUMMARY.
export function renderSummary({ kind, operation, result, exitCode = 0, dryRun = false, dryRunReason = '', cliMetadata, cliExecutionStarted, cliOverrideRequested }) {
  const changes = Array.isArray(result?.changes) ? result.changes : []
  const outcome = result?.outcome ?? 'failed'
  const name = result?.operation || operation || 'artifact-pages'
  const lines = [`### Artifact Pages: ${name} (${outcome})`, '']

  if (result?.site) lines.push(`- **Site:** ${code(result.site)}`)
  if (dryRun) lines.push(`- **Mode:** dry-run${dryRunReason && dryRunReason !== 'dry-run input is true' ? ` (${oneLine(dryRunReason)})` : ''}`)

  if (name === 'site sync') {
    lines.push(`- **Changes:** ${changes.length}${breakdown(changes)}`)
    const pruned = (Array.isArray(result?.previewChanges) ? result.previewChanges : []).filter((change) => change.action === 'remove').length
    lines.push(`- **Pruned previews:** ${pruned}`)
  } else if (name === 'registry sync') {
    lines.push(`- **Registered:** ${idList(siteIDsFromRegistryChanges(changes, ['create', 'update']))}`)
    lines.push(`- **Removed:** ${idList(siteIDsFromRegistryChanges(changes, ['remove']))}`)
    if (typeof result?.registryUpdated === 'boolean') lines.push(`- **Registry updated:** ${result.registryUpdated}`)
  } else if (name === 'app deploy') {
    lines.push(`- **Object changes:** ${changes.length}`)
    if (result?.version) lines.push(`- **Version:** ${code(result.version)}`)
  } else if (name === 'app remove') {
    lines.push(`- **Removed application files:** ${Number(result?.filesRemoved ?? 0)}`)
  } else if (name === 'preview publish') {
    if (result?.groupListUrl) lines.push(`- **Preview list:** ${result.groupListUrl}`)
    const documents = Array.isArray(result?.documents) ? result.documents : []
    lines.push(`- **Documents:** ${documents.length}`)
    if (documents.length > 0) {
      lines.push('', '| Document | Path | Reason |', '| --- | --- | --- |')
      for (const document of documents.slice(0, maxDocumentRows)) {
        const title = cell(document.title || document.path)
        lines.push(`| ${document.url ? `[${title}](${document.url})` : title} | ${code(cell(document.path))} | ${cell(document.reason || 'changed')} |`)
      }
      if (documents.length > maxDocumentRows) lines.push('', `... and ${documents.length - maxDocumentRows} more`)
    }
  }

  const failed = outcome === 'failed' || exitCode !== 0 || Boolean(result?.error)
  if (failed) {
    lines.push('', `> **Error (exit ${exitCode}):** ${oneLine(result?.error || 'the operation failed without an error message')}`)
  }
  if (name !== 'preview publish') lines.push(...changeList(changes))
  if (cliExecutionStarted === false) {
    lines.push('', '- **CLI executed:** none (installation failed)')
    if (cliOverrideRequested) lines.push(`- **CLI override requested:** ${code(cliOverrideRequested)}`)
  }
  if (cliMetadata?.schemaVersion === 1 && cliMetadata.cliVersion) {
    lines.push('', `- **CLI executed:** ${code(cliMetadata.cliVersion)}`)
    if (cliMetadata.override) lines.push(`- **CLI override:** ${code(cliMetadata.overrideSource || 'environment')}${cliMetadata.configVersion ? ` (config ${code(cliMetadata.configVersion)})` : ''}`)
    else if (cliMetadata.overrideRequested) lines.push(`- **CLI override requested:** ${code(cliMetadata.overrideRequested)}${cliMetadata.overrideSource ? ` (${code(cliMetadata.overrideSource)})` : ''}`)
  }
  return `${lines.join('\n')}\n`
}

export function summaryEnabled(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text === 'true') return true
  if (text === 'false') return false
  throw new Error('input "summary" must be true or false')
}

// Appends the summary when enabled. A summary problem is a warning, never a failure.
export async function writeSummary(context, env = process.env) {
  try {
    if (!summaryEnabled(env.ARTIFACT_PAGES_INPUT_SUMMARY)) return false
    const path = env.GITHUB_STEP_SUMMARY
    if (!path) return false
    await appendFile(path, `${renderSummary(context)}\n`, 'utf8')
    return true
  } catch (error) {
    process.stderr.write(`::warning title=Artifact Pages summary::${oneLine(error.message)}\n`)
    return false
  }
}
