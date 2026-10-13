# The four doors: MCP, the SDKs, REST, the CLI

They open onto the same ledger with the same key, the same limits and the same error codes. Choose by who is calling.

- **An SDK or REST** when you are writing an integration: the user's code calls BillOS. This is what ends up in the repository.
- **MCP** when an assistant acts for a person in a conversation ("issue a receipt to Dana for 350"), and as the quickest way for a coding agent to try the API while it writes the integration. Never make application code depend on an MCP server.
- **The CLI** for scripts, CI and local webhook testing.

## MCP

Endpoint: `https://api.billos.co.il/mcp`, Streamable HTTP, stateless. It takes the normal API key: `X-Api-Key`, or `Authorization: Bearer bk_…` for clients that only speak Bearer. A `bk_test_` key talks to the sandbox.

Claude Code:

```bash
claude mcp add --transport http billos https://api.billos.co.il/mcp --header "X-Api-Key: $BILLOS_API_KEY"
```

A project file that holds no key (`npx billos init` writes it). Claude Code, `.mcp.json`:

```json
{ "mcpServers": { "billos": { "type": "http", "url": "https://api.billos.co.il/mcp", "headers": { "X-Api-Key": "${BILLOS_API_KEY}" } } } }
```

Cursor, `.cursor/mcp.json`:

```json
{ "mcpServers": { "billos": { "url": "https://api.billos.co.il/mcp", "headers": { "X-Api-Key": "${env:BILLOS_API_KEY}" } } } }
```

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.billos]
url = "https://api.billos.co.il/mcp"
bearer_token_env_var = "BILLOS_API_KEY"
```

A desktop client that only launches local processes: `npx mcp-remote https://api.billos.co.il/mcp --header "X-Api-Key: bk_test_…"`.

### Tools

| Tool | What it does |
|---|---|
| `list_businesses` | The businesses this key can act on. Call it first: every other tool takes a `businessId` from here |
| `create_business` | Opens a business under the key. Free in the sandbox; with a live key it opens a real ledger |
| `seed_sandbox` | Sandbox keys only: one demo business with customers, issued documents and expenses |
| `create_document` | Creates **and issues** a receipt, tax invoice, invoice-receipt or proforma, and returns the number and a public PDF link. `dryRun: true` checks everything and issues nothing; `idempotencyKey` makes a retry return the same document |
| `cancel_document` | Issues the credit note that corrects an issued document: the only lawful undo |
| `list_documents` | Issued documents (or drafts), newest first |
| `find_or_create_customer` | Matches a customer by phone then name, creating one only when nothing matches |
| `list_customers` | The business's customers |
| `list_open_items` | Who owes the business money: every invoice with a balance, aged, each with the `documentId` a receipt names in `settles` |
| `record_expense` | Records an expense. On a pending account it lands as a draft and says so |
| `list_expenses` | Recorded expenses (or drafts), newest first |
| `financial_summary` | Income, expenses, profit and the VAT position for a date range |
| `search_docs` | Searches the documentation and returns matching sections with their URLs |

Rules that hold here as everywhere:

- Money is agorot: `priceIncVatAgorot: 35400` is ₪354.00. The MCP tools take prices **including** VAT.
- `create_document` is permanent. Confirm the customer, the type and the total with the user first, or call it once with `dryRun: true`. Pass `idempotencyKey` on the real call.
- A failed tool call carries the REST error fields (`reason`, `hint`, `param`, `retryable`). Read `hint`.
- A business the key does not hold is invisible ("business not found under this credential").
- Give an agent a `bk_test_` key first.

The REST surface is larger than the tool set (drafts, previews, quotes, recurring plans, webhooks, exports). What a tool does not cover is one REST call away.

## SDKs

- Node / TypeScript: `npm install billos-sdk`. `createClient({ apiKey })`, then `billos.documents.create(bid, body, { idempotencyKey })`, `.validate(bid, id)`, `.issue`, `.print`, `.share`. `createSandbox({ name })` and `waitForSandbox(pending)` are standalone exports that need no key: the first asks for a sandbox key, the second resolves once a person approved it. Types are generated from the OpenAPI spec.
- Python: `pip install billos`. `BillOS(api_key=…)`, then `billos.documents.create(bid, body, idempotency_key=…)`, `.validate(bid, doc_id)`, `.issue`. `create_sandbox(name=…)` and `wait_for_sandbox(pending)` need no key.

Both: no dependencies, the `{ ok, … }` envelope returned as it is, automatic retry only where it is safe, a webhook signature check, and a `BillOSError` carrying the API's own fields: `reason`, `hint`, `param`, `retryable`, and the docs link (`docUrl` in Node, `doc_url` in Python). Examples: [quickstart.md](quickstart.md).

## CLI

`npm install -g billos`, or `npx billos …`. Zero dependencies, Node 20 or later.

| Command | |
|---|---|
| `billos sandbox [--name x] [--no-wait] [--no-save] [--force]` | A free sandbox key that a person approves once in the browser. At a terminal it waits; with `--json` (or in a pipe) it prints `verifyUrl` and exits 0, and the same command run again after the approval collects and saves the key |
| `billos seed` | A demo business in the sandbox |
| `billos init [--dir .] [--agents claude,cursor,codex]` | Writes the agent files into a project: MCP config, an `AGENTS.md` block, a Cursor rule, `BILLOS_API_KEY=` in `.env.example`. No file holds a key |
| `billos listen --forward-to <url> [--events a,b] [--business <id>]` | Forwards new events to a local URL, signed like a real webhook delivery |
| `billos login [--key bk_…]` | Sign in through the console, or paste a key |
| `billos whoami`, `billos businesses`, `billos use <businessId>` | Which key, which businesses, the default one |
| `billos invoice --customer "…" --amount 350 [--type receipt\|invoice\|invoice-receipt\|proforma] [--dry-run] [--idempotency-key …]` | Issues a document (permanent) and prints the customer's link. `--dry-run` validates and issues nothing |
| `billos cancel <documentId> [--amount … --reason "…" --refund]` | The credit note |
| `billos docs`, `billos customers`, `billos receivables` | Lists |
| `billos expense --supplier "…" --amount 118 [--vat 18]`, `billos expenses` | Record and list expenses |
| `billos vat [--period 2026-08] [--file PCN874.TXT]` | The periodic VAT figures and file |

- `--json` on any command prints the raw API shape on stdout. On failure the API's error body goes to stderr and the exit code is 1.
- `--amount` is **shekels** on the CLI (`350.50` is ₪350.50). Every other surface is agorot.
- `BILLOS_API_KEY` overrides the stored key and `BILLOS_API_ORIGIN` the host. The key is stored at `~/.config/billos/config.json` (0600).
- Output is English by default; `BILLOS_LANG=he` or `--lang he` switches to Hebrew.
