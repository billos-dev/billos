# BillOS for coding agents

Everything a coding agent needs to integrate [BillOS](https://billos.co.il), the Israeli invoicing and bookkeeping API, correctly on the first try: the MCP server, a skill, an `AGENTS.md` block, a Cursor rule and a Claude Code plugin.

| Path | What it is |
|---|---|
| `skills/billos/` | An [Agent Skill](https://agentskills.io): how to integrate BillOS, with reference files loaded on demand |
| `AGENTS.md` | The short block of rules an agent gets wrong (under 40 lines) |
| `cursor/billos.mdc` | The same rules as a Cursor project rule |
| `plugins/billos/` + `.claude-plugin/marketplace.json` | A Claude Code plugin: the skill and the MCP server |
| `examples/` | Runnable integrations |

The MCP server is `https://api.billos.co.il/mcp` (Streamable HTTP). It takes a BillOS API key as `X-Api-Key`, or as `Authorization: Bearer bk_…`.

## 0. Get a key (a person approves it once)

```bash
npx billos sandbox            # at a terminal: opens the approval link, waits, saves the key for the CLI
```

An agent cannot approve anything, so for an agent it is two runs of one command:

```bash
npx billos sandbox --json     # → { "status": "authorization_required", "verifyUrl": "…", "userCode": "…", "expiresAt": "…", "next": "…" }
#   Show verifyUrl to the user exactly as returned and wait. They open it, sign in to BillOS and approve.
#   The agent never opens the link and never tries to complete it.
npx billos sandbox --json     # → { "status": "approved", "apiKey": "bk_test_…", … }   (the same command, after the approval)
export BILLOS_API_KEY=bk_test_…   # that apiKey, in the shell your agent starts from
```

Run early, the second call prints the first answer again and exits 0. With no tooling it is `POST https://api.billos.co.il/v1/sandboxes` (no credentials), then `POST` the returned `tokenUrl` with the `deviceCode` until it answers `approved`; `createSandbox` + `waitForSandbox` in `billos-sdk` and `create_sandbox` + `wait_for_sandbox` in the Python `billos` package do the same. The key is a `bk_test_` key on the approver's developer account: a separate database where nothing is signed and nothing reaches the tax authority, with no expiry.

A server whose operator enabled anonymous sandboxes may answer `"status": "ready"` with a key at once. That key is temporary (7 days, smaller limits, no webhooks or Connect apps), and claiming it gives the person a new key while this one stops.

Every snippet below reads the key from `BILLOS_API_KEY`. Nothing here asks you to paste a key into a file you commit.

## 1. One command for a whole project

```bash
npx billos init                          # Claude Code, Cursor and Codex
npx billos init --agents claude,cursor   # or only some
```

It writes `.mcp.json`, `.cursor/mcp.json`, `.cursor/rules/billos.mdc`, `.codex/config.toml`, a BillOS block in `AGENTS.md` and `BILLOS_API_KEY=` in `.env.example`. Existing files are merged into or left alone, never overwritten (`--force` replaces only what `init` wrote before). The rest of this page is the same thing by hand, per agent.

## Claude Code

The MCP server, for you in the current project:

```bash
claude mcp add --transport http billos https://api.billos.co.il/mcp --header "X-Api-Key: $BILLOS_API_KEY"
```

Shared with the team, with no key in the file: `.mcp.json` at the project root. Claude Code expands `${BILLOS_API_KEY}` from the environment it starts in.

```json
{
  "mcpServers": {
    "billos": {
      "type": "http",
      "url": "https://api.billos.co.il/mcp",
      "headers": { "X-Api-Key": "${BILLOS_API_KEY}" }
    }
  }
}
```

The plugin (the skill and the MCP server together):

```
/plugin marketplace add billos-dev/billos
/plugin install billos@billos
```

`/plugin install` asks for the API key and keeps it in the system's credential store. From a shell:

```bash
claude plugin marketplace add billos-dev/billos
claude plugin install billos@billos --config api_key="$BILLOS_API_KEY"
```

The skill then runs as `/billos:billos`, and Claude loads it by itself when a task is about invoices or receipts.

Instructions: Claude Code reads `AGENTS.md` when the project has no `CLAUDE.md`. If it has one, add the line `@AGENTS.md` to it.

## Cursor

One click (the key is read from `BILLOS_API_KEY` in Cursor's environment, so the link carries none):

```
cursor://anysphere.cursor-deeplink/mcp/install?name=billos&config=eyJ1cmwiOiJodHRwczovL2FwaS5iaWxsb3MuY28uaWwvbWNwIiwiaGVhZGVycyI6eyJYLUFwaS1LZXkiOiIke2VudjpCSUxMT1NfQVBJX0tFWX0ifX0=
```

By hand, `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project):

```json
{
  "mcpServers": {
    "billos": {
      "url": "https://api.billos.co.il/mcp",
      "headers": { "X-Api-Key": "${env:BILLOS_API_KEY}" }
    }
  }
}
```

The rule: copy `cursor/billos.mdc` to `.cursor/rules/billos.mdc`. Cursor also reads `AGENTS.md` at the project root.

## VS Code (GitHub Copilot)

From a shell (the key is expanded by the shell and stored in your VS Code profile):

```bash
code --add-mcp "{\"name\":\"billos\",\"type\":\"http\",\"url\":\"https://api.billos.co.il/mcp\",\"headers\":{\"X-Api-Key\":\"$BILLOS_API_KEY\"}}"
```

With no key in a file, `.vscode/mcp.json` with an input variable; VS Code asks for the key once and stores it:

```json
{
  "inputs": [
    { "type": "promptString", "id": "billos-api-key", "description": "BillOS API key (bk_test_… or bk_live_…)", "password": true }
  ],
  "servers": {
    "billos": {
      "type": "http",
      "url": "https://api.billos.co.il/mcp",
      "headers": { "X-Api-Key": "${input:billos-api-key}" }
    }
  }
}
```

VS Code also reads the portable `.mcp.json` at the project root, the file shown for Claude Code above. Its documentation does not say whether `${BILLOS_API_KEY}` is expanded there, so the input variable is the documented way to keep the key out of a file.

An install link for the same server (it carries the `${input:billos-api-key}` placeholder, not a key; if VS Code does not ask for the key, add the `inputs` entry above):

```
vscode:mcp/install?%7B%22name%22%3A%22billos%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fapi.billos.co.il%2Fmcp%22%2C%22headers%22%3A%7B%22X-Api-Key%22%3A%22%24%7Binput%3Abillos-api-key%7D%22%7D%7D
```

## Codex CLI

`~/.codex/config.toml`, or `.codex/config.toml` in a project you trust. Codex sends the variable as `Authorization: Bearer …`, which BillOS accepts beside `X-Api-Key`.

```toml
[mcp_servers.billos]
url = "https://api.billos.co.il/mcp"
bearer_token_env_var = "BILLOS_API_KEY"
```

Codex reads `AGENTS.md` for instructions.

## The skill, in any agent

```bash
npx skills add billos-dev/billos --skill billos            # asks which agents to install it for
npx skills add billos-dev/billos --skill billos -a claude-code -a cursor -a codex
```

Or copy `skills/billos/` into the agent's skills directory (`.claude/skills/` for Claude Code, `.agents/skills/` for Cursor and Codex).

## Any other MCP client

A client that speaks Streamable HTTP takes the URL and the header above. One that only launches local processes:

```bash
npx mcp-remote https://api.billos.co.il/mcp --header "X-Api-Key: $BILLOS_API_KEY"
```

## Test webhooks on localhost

```bash
npx billos listen --forward-to http://localhost:3000/webhooks
```

It forwards each new event to the local URL in the shape of a real delivery, signed with the secret it prints. No tunnel.

## Keeping the copies identical

Three things in this repository exist twice, because each reader needs its own file:

| Source | Copy | Why |
|---|---|---|
| `AGENTS.md` | the block `npx billos init` writes | the npm package embeds it |
| the CLI's Cursor rule | `cursor/billos.mdc` | it is the same block with Cursor's frontmatter |
| `skills/billos/` | `plugins/billos/skills/billos/` | a Claude Code plugin is installed by copying its own directory, so it cannot point outside it |

In the BillOS monorepo, `node packages/billos-cli/scripts/sync-kit.mjs` makes the copies after an edit to a source, and `packages/billos-cli/test/kit.test.js` fails when one is stale. Edit the source, never the copy.

## Links

- Docs: <https://docs.billos.co.il> · for agents: <https://docs.billos.co.il/llms.txt> · OpenAPI: <https://docs.billos.co.il/openapi.json>
- SDKs: [`billos-sdk`](https://www.npmjs.com/package/billos-sdk) (npm), [`billos`](https://pypi.org/project/billos/) (PyPI) · CLI: [`billos`](https://www.npmjs.com/package/billos) (npm)
- Source of this kit: <https://github.com/billos-dev/billos>
