# Twin MCP Protocol

SkyTwin exposes itself as an MCP (Model Context Protocol) server, allowing Claude Desktop, Cursor, Cline, and any other MCP-compatible client to query your twin's memory, preferences, and signal stream — or propose actions for your review. This is the first twin product to implement the MCP server role, making your personal AI directly queryable by the agents you already use.

---

## Quick install

### 1. Generate a token

Open the SkyTwin web dashboard → **MCP Agent Tokens** (`#/twin-server-tokens`), generate a token for your client, and copy it.

### 2. Start the Twin MCP server

```bash
TWIN_MCP_SERVER_PORT=4444 pnpm --filter @skytwin/twin-mcp-server start
```

### 3. Configure your MCP client

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "skytwin": {
      "url": "http://localhost:4444/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}
```

**Cursor** — Settings → MCP → Add server:

```json
{
  "mcpServers": {
    "skytwin": {
      "url": "http://localhost:4444/mcp",
      "transport": "http",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  }
}
```

**Cline** — MCP settings → Add server → URL mode:

```json
{
  "servers": [
    {
      "name": "skytwin",
      "type": "http",
      "url": "http://localhost:4444/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN_HERE" }
    }
  ]
}
```

---

## Authentication

Tokens are issued per-agent via the web UI or `POST /api/external-agents/tokens`. Each token carries a scope:

| Scope | Tools available |
|-------|----------------|
| `read` | `whoami`, `query_memory`, `get_preferences` |
| `propose` | All read tools + `propose_action` |
| `subscribe` | All read tools + `subscribe_signals` |

Tokens are 32-byte random values. Only a SHA-256 hash is stored in the database — the plaintext is shown once at issuance. Revocation is immediate: the database record is marked `revoked_at = now()` and subsequent lookups return `null`.

---

## Tool reference

### `whoami`

**Scope:** none (any valid token)

Returns identity and trust-tier information for the authenticated user.

```json
{
  "userId": "...",
  "displayName": "Alice",
  "twinIdentity": { "email": "alice@example.com", "trustTier": "suggest" },
  "earnedTrustTiers": { "@modelcontextprotocol/server-filesystem": "low_autonomy" }
}
```

---

### `query_memory`

**Scope:** `read`

Semantically searches the user's MemoryPort for relevant information.

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `question` | string (required) | The query to search for |
| `limit` | number (optional, 1–50, default 10) | Max results |

**Output:** `{ results: SemanticHit[], question, limit }`

PII fields (`email`, `phone`, `password`, `token`, `secret`, `api_key`) are redacted from results before returning.

---

### `get_preferences`

**Scope:** `read`

Returns the user's preference vectors from their twin model.

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `domain` | string (optional) | Filter by domain (e.g. `"email"`, `"calendar"`) |

**Output:** `{ preferences: Preference[], domain?, domainHeuristics? }`

---

### `propose_action`

**Scope:** `propose`

Proposes an action for the user to review and approve. **This tool NEVER auto-executes.** The proposed action lands in the SkyTwin approvals queue with `requires_approval: true, auto_executed: false` — the user must explicitly approve it before any execution occurs.

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `action.type` | string (required) | Action type identifier |
| `action.parameters` | object | Action parameters |
| `action.reasoning` | string (required) | Why this action is being proposed |
| `sourceAgent` | string (required) | Identifier of the proposing agent |

**Output:** `{ decisionId: string, status: "pending_approval", message: string }`

---

### `subscribe_signals`

**Scope:** `subscribe`

Polls for recent signals matching a filter. v1 is a polling endpoint — call again with `since=<last_signal.timestamp>` for incremental updates.

**Input:**

| Field | Type | Description |
|-------|------|-------------|
| `type` | string (optional) | Filter by signal type (e.g. `"email"`, `"calendar"`) |
| `limit` | number (optional, 1–100, default 20) | Max signals |
| `since` | string (optional) | ISO 8601 timestamp; only signals after this date |

**Output:** `{ signals: SignalRow[], count: number, note: string }`

---

## Security invariants

1. **Tokens hashed at rest.** Only SHA-256(token) is stored. Plaintext is never logged or persisted.
2. **`propose_action` never auto-executes.** The DB row always has `auto_executed=false, requires_approval=true`.
3. **Every tool call writes a provenance node.** `capability_provenance_nodes` row with `node_type='external_agent'` is written after every successful invocation.
4. **Scope is strictly enforced.** A `read` token cannot call `propose_action` or `subscribe_signals`. Tools outside the token's scope are not registered on the per-request McpServer instance.
5. **Revocation is immediate.** `DELETE /api/external-agents/tokens/:id` sets `revoked_at` and subsequent `lookup()` calls return `null`.

---

## Running in development

```bash
# Terminal 1: API server
pnpm --filter @skytwin/api dev

# Terminal 2: Twin MCP server
TWIN_MCP_SERVER_PORT=4444 pnpm --filter @skytwin/twin-mcp-server dev
```

The web dashboard's **MCP Agent Tokens** page (`#/twin-server-tokens`) provides token management UI and copy-paste config snippets for Claude Desktop, Cursor, and Cline.
