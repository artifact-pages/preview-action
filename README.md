> This repository is generated from [artifact-pages/artifact-pages](https://github.com/artifact-pages/artifact-pages) (`actions/preview`) on every release. Open issues and pull requests there.

# Artifact Pages preview

Publishes the documents a pull request changes as a pre-merge preview of a registered site (`artifact-pages preview publish`). Before the CLI or any provider is used it verifies that the pull request comes from the workflow repository and, when a pull request is resolved, checks it through the GitHub API. It rejects `pull_request_target`. Gate pull-request jobs to same-repository branches and configure provider credentials in a step before this Action.

## Usage

```yaml
on:
  pull_request:
jobs:
  preview:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-24.04
    permissions:
      contents: read
      pull-requests: write
      id-token: write
    steps:
      # ... configure provider credentials ...
      - uses: artifact-pages/preview-action@v0.1.0
        with:
          site: docs
          comment: true
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `site` | required | Registered site ID. |
| `source` | registered source path | Source directory inside the checkout. |
| `head` | event head SHA, else `HEAD` | Git ref whose committed tree forms the preview. |
| `default-ref` | `origin/<base>`, else `origin/HEAD` | Default-branch ref for merge-base selection. |
| `pull-request` | event PR number | PR number or URL; `none` forces a manual preview. |
| `include` | empty | Newline-separated extra non-document resources. |
| `base-url` | config `publicBaseURL` | Public application origin for review URLs. |
| `config` | empty | Deployment config path or `github://` locator. |
| `github-token` | `github.token` | Token with `pull-requests: read` (and `write` for comments). |
| `dry-run` | `false` | Plan without writes. |
| `comment` | `false` | Create or update one PR comment per site with the preview links. |
| `summary` | `true` | Append the operation summary to the Job Summary. |
| `checkout` | `auto` | On `pull_request` the base ref is checked out, never the PR head. |
| `fetch-depth` | `1` | Depth of that checkout. |

## Outputs

`operation`, `outcome`, `site`, `group-list-url`, `documents` (JSON array), `result`, `exit-code`, `error` and `comment-url`.

## Version and runners

The version of this Action is the version of the `artifact-pages` CLI it runs. The Action downloads `artifact-pages_v<version>_<os>_<arch>` from the matching [release of artifact-pages/artifact-pages](https://github.com/artifact-pages/artifact-pages/releases), verifies it against the release checksums and fails if it cannot. This also holds when you pin the Action to a full commit SHA. Pin an exact release tag (`@v0.1.0`) or a full commit SHA with the tag in a comment; no moving major tag is published while the product is `0.x`.

Supported runners: Linux and macOS, x64 and arm64. Windows runners are not supported.

Full documentation: <https://artifact-pages.dev/guide/en/>. Inputs, outputs and the Job Summary format are specified in the [specification](https://github.com/artifact-pages/artifact-pages/blob/main/docs/specification.md).
