# Hippocampus

Universal memory for AI. One server, every platform.

Your AI shouldn't forget who you are just because you switched apps.

---

Hippocampus is an open-source, self-hosted MCP memory server. Deploy it once. Connect it to Claude, ChatGPT, Gemini, Cursor, Perplexity — anything that speaks MCP. Tell one AI about a project decision, and every other AI already knows.

## The problem

Every AI platform silos your context:

- Claude.ai memory doesn't work in Claude Code
- Claude Code's CLAUDE.md files don't work in ChatGPT
- ChatGPT's memory doesn't work in Gemini
- None of them talk to each other

You repeat yourself constantly. Context gets lost. Continuity breaks every time you switch tools.

## How it works

```
Claude.ai ────────────┐
Claude Code ──────────┤
Claude Desktop ───────┤
ChatGPT ──────────────┼── MCP ──▶  Hippocampus
Gemini CLI ───────────┤            (your server)
Cursor / Windsurf ────┤
Perplexity ───────────┘
```

[MCP](https://modelcontextprotocol.io/) (Model Context Protocol) is the open standard every major AI platform has adopted. Hippocampus is a remote MCP server that exposes memory tools over Streamable HTTP — `remember`, `recall`, `forget`, and eight more. Any AI client that supports MCP can connect.

Data model: knowledge graph with entities, observations, and relationships. Semantic search via local embeddings. Entire database encrypted at rest with SQLCipher (AES-256) — including embedding vectors, which [leak original text](https://arxiv.org/abs/2305.03010).

## Try it in 5 minutes

You need Node.js 18+ installed.

**1. Clone and install**

```bash
git clone https://github.com/karrolcia/hippocampus.git
cd hippocampus
npm install
```

**2. Create your `.env` file**

```bash
cp .env.example .env
```

Open `.env` and set your passphrase (this encrypts the database):

```env
HIPPO_PASSPHRASE=any-secret-phrase-you-want
```

That's the only required value. Everything else has defaults.

**3. Start the server**

```bash
npm run dev
```

You should see:

```
Hippocampus starting on http://0.0.0.0:3000
MCP endpoint: http://0.0.0.0:3000/mcp
```

The embedding model (~80MB) downloads automatically on first run — this takes a minute the first time.

**4. Verify it's alive**

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"status":"ok","version":"0.3.1"}
```

**5. Connect Claude Code**

```bash
claude mcp add hippocampus --transport http http://localhost:3000/mcp
```

**6. Try it**

Open a Claude Code session and say:

> Remember that my preferred language is TypeScript and I use Hono as my web framework.

Then in a new session:

> What do you know about my tech preferences?

If it comes back with TypeScript and Hono, it's working. Your AI now has persistent memory.

## Deploy to a server

Local is great for trying it out. To use Hippocampus across all your AI tools — Claude.ai, ChatGPT, Gemini, mobile — you need it running on a public URL with HTTPS.

### What you need

- A VPS (Hetzner CX22 at ~4 EUR/month is plenty — EU jurisdiction, GDPR)
- A domain (or subdomain) pointed at the VPS
- ~20 minutes

### Step 1: Set up the server

SSH into your VPS and install Docker:

```bash
# Firewall
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable

# Install Docker
curl -fsSL https://get.docker.com | sh
```

### Step 2: Point your domain

Add an A record in your DNS provider:

```
Type: A
Name: hippo            (or whatever subdomain you want)
Value: <your VPS IP>
```

DNS propagation usually takes a few minutes. Verify it resolves before continuing:

```bash
dig hippo.yourdomain.com +short
# Should return your VPS IP
```

### Step 3: Configure

```bash
git clone https://github.com/karrolcia/hippocampus.git
cd hippocampus
chmod +x setup.sh
./setup.sh
```

The script asks for your domain, username, and password, then writes `.env` and `Caddyfile` for you. No Node.js required.

Caddy handles TLS certificates automatically via Let's Encrypt.

<details>
<summary>Manual setup (if you prefer)</summary>

```bash
cp .env.example .env
```

Generate a passphrase and an OAuth password hash:

```bash
# Generate a random passphrase — save this in your password manager
openssl rand -base64 32

# Generate a hash of the password you'll use to log in
# Replace 'your-password' with your actual password
echo -n 'your-password' | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

Edit `.env` with all required values:

```env
HIPPO_PASSPHRASE=<output of openssl rand -base64 32>

HIPPO_OAUTH_ISSUER=https://hippo.yourdomain.com
HIPPO_OAUTH_USER=admin
HIPPO_OAUTH_PASSWORD_HASH=<output of the hash command above>
```

Edit `Caddyfile` — replace the domain on the first line:

```caddy
hippo.yourdomain.com {
```

</details>

### Step 4: Start and verify

```bash
docker compose up -d
```

Wait ~30 seconds for the containers to start and Caddy to get a certificate, then:

```bash
curl https://hippo.yourdomain.com/health
```

Expected response:

```json
{"status":"ok","version":"0.3.1"}
```

If you get a certificate error, DNS might not have propagated yet. Wait a few minutes and retry.

### Step 5: Connect your AI tools

Now that your server is live, connect each platform you use.

**Claude Code:**

```bash
claude mcp add hippocampus --transport http https://hippo.yourdomain.com/mcp
```

**Claude.ai (browser + mobile):**

Settings > Integrations > Add custom integration > Enter your server URL:

```
https://hippo.yourdomain.com/mcp
```

You'll be redirected to log in with the username and password you configured in Step 3.

**Claude Desktop:**

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "hippocampus": {
      "url": "https://hippo.yourdomain.com/mcp"
    }
  }
}
```

**ChatGPT (web + mobile):**

Settings > Apps > Developer Mode > Create a new app > Set server URL to `https://hippo.yourdomain.com/mcp`

**Gemini CLI:**

Add to `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "hippocampus": {
      "uri": "https://hippo.yourdomain.com/mcp"
    }
  }
}
```

**Cursor / Windsurf / VS Code:**

Add to your MCP configuration file:

```json
{
  "mcpServers": {
    "hippocampus": {
      "url": "https://hippo.yourdomain.com/mcp"
    }
  }
}
```

**Verify:** Open any connected platform and ask your AI to remember something. Switch to a different platform and ask it to recall. If it works across platforms, you're done.

### Alternative: Fly.io

If you don't want to manage a VPS. ~$5/month.

```bash
git clone https://github.com/karrolcia/hippocampus.git
cd hippocampus

fly launch                # Creates app + Dockerfile detected automatically
fly volumes create hippo_data --size 1
```

Edit the generated `fly.toml` — add a volume mount so the database persists across deploys:

```toml
[mounts]
  source = "hippo_data"
  destination = "/data"
```

Generate your secrets — save both values in your password manager:

```bash
# Generate passphrase (save this — you lose your database without it)
openssl rand -base64 32

# Generate hash of your login password (replace 'your-password')
echo -n 'your-password' | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='
```

Set them as Fly secrets and deploy:

```bash
fly secrets set HIPPO_PASSPHRASE=<generated passphrase>
fly secrets set HIPPO_OAUTH_ISSUER=https://<your-app>.fly.dev
fly secrets set HIPPO_OAUTH_USER=admin
fly secrets set HIPPO_OAUTH_PASSWORD_HASH=<generated hash>

fly deploy
```

Verify:

```bash
curl https://<your-app>.fly.dev/health
```

Fly handles HTTPS automatically. Connect your AI tools using `https://<your-app>.fly.dev/mcp` as the server URL.

### Alternative: Home server + Cloudflare Tunnel

Free, maximum control. Run Hippocampus on any machine at home and expose it via [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) — no port forwarding, no static IP needed.

```bash
# On your home machine
git clone https://github.com/karrolcia/hippocampus.git
cd hippocampus
cp .env.example .env
```

Edit `.env` — set passphrase and OAuth variables (skip `setup.sh` here — it configures Caddy, which you don't need with Cloudflare Tunnel):

```bash
# Generate values
openssl rand -base64 32                # → HIPPO_PASSPHRASE
echo -n 'your-password' | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '='  # → HIPPO_OAUTH_PASSWORD_HASH
```

```env
HIPPO_PASSPHRASE=<generated passphrase>
HIPPO_OAUTH_ISSUER=https://hippo.yourdomain.com
HIPPO_OAUTH_USER=admin
HIPPO_OAUTH_PASSWORD_HASH=<generated hash>
```

```bash
docker compose up -d hippocampus   # only hippocampus — Caddy not needed

# Install cloudflared and create a tunnel
cloudflared tunnel create hippocampus
cloudflared tunnel route dns hippocampus hippo.yourdomain.com
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: hippocampus
ingress:
  - hostname: hippo.yourdomain.com
    service: http://localhost:3000
  - service: http_status:404
```

Start the tunnel:

```bash
cloudflared tunnel run hippocampus
```

You're responsible for uptime and physical security. See [SECURITY.md](SECURITY.md) for trade-offs.

## Tools

| Tool | Description |
|------|-------------|
| `remember` | Store a fact, preference, or piece of context. Optional `kind` classification (fact, decision, question, preference, or custom) and `importance` weighting. Reports overlapping observations so the AI can consolidate incrementally. Returns `version_hash` for cache invalidation. |
| `recall` | Search memories by semantic similarity + keyword match. Filter by `type`, `kind`, `since`. Use `spread: true` to follow relationships and discover connected memories. Includes `version_hash` per entity in all formats. |
| `context` | Get everything about a topic — observations, relationships, related entities. Includes `version_hash`. |
| `update` | Replace an existing observation with new content. Returns `version_hash`. |
| `forget` | Permanently delete a memory or entity (secure deletion) |
| `merge` | Merge multiple observations into one (atomic consolidation). Returns `version_hash`. |
| `merge_entities` | Merge multiple entities into one — moves all data, deletes sources. Returns `version_hash`. |
| `consolidate` | Find clusters of similar/duplicate memories, detect near-duplicate entities, surface contradictions, or run sleep mode for batch lifecycle analysis (compress/prune/refresh) |
| `export` | Export as CLAUDE.md context file, readable markdown, JSON, wire format, or Obsidian vault |
| `check_version` | "Did anything change?" — pass an entity name + cached hash, get back yes/no. No embedding computation, pure metadata. |
| `onboard` | Bootstrap memory from a new AI session. Returns structured extraction instructions the AI follows to capture user context. |

The AI calls these tools naturally. You don't manage memory manually — you just talk to your AI and it remembers.

### Spreading activation

When you `recall` with `spread: true`, Hippocampus doesn't just return direct matches — it follows relationships one hop out from matched entities and scores their observations against your query. Related observations get a dampened score (0.5x decay), so they surface when relevant but don't drown out direct hits. Useful for questions that span multiple related topics.

### Contradiction detection

`consolidate` with `mode: "contradictions"` finds observation pairs that talk about the same thing (high embedding similarity) but say different things (low word overlap). No LLM required — pure embedding math plus Jaccard comparison. Review the flagged pairs and decide what to keep.

### Novelty scoring

Every `remember` call returns a `novelty` score (0–1) computed via SVD subspace projection. Pairwise cosine checks miss aggregate redundancy — five observations with moderate individual overlap can collectively explain a new observation entirely. Subspace projection compares against all existing observations simultaneously. When novelty drops below 0.1, the response warns that the information may already be captured.

### Near-match detection

When `remember` stores a new observation, it reports existing observations that overlap (cosine similarity 0.5–0.85) — the zone between "clearly different" and "near-duplicate." The AI sees these in the response and can consolidate immediately instead of waiting for a batch `consolidate` pass. No extra computation: the dedup scan already compares against all entity embeddings.

### Sleep mode

`consolidate` with `mode: "sleep"` runs batch lifecycle analysis — the overnight defrag for your knowledge graph. Uses SVD leverage scores combined with temporal signals to classify old observations into three categories:

- **Compress**: redundant + old + recalled. Information captured elsewhere, safe to merge down.
- **Prune**: never recalled + old. The synapse never fired — delete candidates.
- **Refresh**: actively used + unique + old. The AI keeps serving these, but newer information exists on the entity. Reconsolidation candidates.

Returns `information_rank` and `redundancy_ratio` per entity for structural diagnosis. The AI acts on results using existing tools — `merge` for compress, `forget` for prune, `update` for refresh.

### Reconsolidation hints

When `recall` returns observations older than 30 days on an entity that has received newer information since, they're flagged `stale: true`. Lightweight date comparison on every retrieval — no embedding computation. The AI sees the flag and can decide whether to update or leave the observation as-is.

### Cross-platform staleness detection

You told Claude about your project stack on Monday. On Wednesday you switched to Gemini. Is Gemini's cached context still current? Every entity carries a `version_hash` — SHA-256 of its observation content. The AI caches this hash, and later calls `check_version` to ask "did anything change?" without re-fetching everything. One lightweight metadata call instead of re-reading the entire entity.

All mutation tools return the new hash after writing. All read tools include it in the response. The AI always has a fresh hash to cache — no extra round trip.

### Onboarding

New databases start cold — the `hippocampus://context` resource shows guidance prompting the AI to capture what it already knows about you (identity, projects, preferences). Once 5+ observations exist, the guidance disappears and the full knowledge graph takes over.

For systematic first-session extraction, the `onboard` tool returns a structured prompt the AI follows — what to look for, what's already stored, what format to use. The tool stores nothing itself; it hands the AI a checklist and lets it do what it's good at. Each platform uses its own context for extraction.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HIPPO_PASSPHRASE` | Yes | — | Database encryption passphrase |
| `HIPPO_DB_PATH` | No | `./data/hippocampus.db` | Database file location |
| `PORT` | No | `3000` | Server port |
| `HOST` | No | `0.0.0.0` | Bind address |
| `HIPPO_TOKEN` | No | — | Bearer token for local dev (skip OAuth) |
| `HIPPO_OAUTH_ISSUER` | No | — | Your server URL — enables OAuth |
| `HIPPO_OAUTH_USER` | No | — | OAuth login username |
| `HIPPO_OAUTH_PASSWORD_HASH` | No | — | SHA-256 hash of OAuth password |
| `RATE_LIMIT_REMEMBER` | No | `20` | Write rate limit per minute |
| `RATE_LIMIT_RECALL` | No | `60` | Read rate limit per minute |
| `HIPPO_CONTEXT_MAX_OBSERVATIONS` | No | `100` | Max observations in `hippocampus://context` resource |
| `TRANSFORMERS_CACHE` | No | System default | Embedding model cache directory |

## Security

- AES-256 database encryption via SQLCipher (text, embeddings, indexes — everything)
- OAuth 2.1 with PKCE for remote access
- Input validation: 50,000 char/memory, 200 char/entity name
- Rate limiting on all endpoints
- `PRAGMA secure_delete = ON` — forgotten memories are zeroed, not just unlinked
- Non-root Docker, `cap_drop: ALL`, read-only filesystem
- CORS restricted to known AI platform origins
- No external API calls — embeddings run locally via Transformers.js

See [SECURITY.md](SECURITY.md) for the full threat model and architecture.

## OAuth — what's happening under the hood

When you connect Claude.ai, ChatGPT, or other browser-based platforms, they use OAuth 2.1 to authenticate with your server. Hippocampus includes a self-contained OAuth server — no external auth provider needed.

Here's what happens when you click "Connect" in Claude.ai:

1. Claude.ai auto-registers as a client with your server (Dynamic Client Registration, RFC 7591)
2. You're redirected to a login page on your server
3. You enter the username and password from your `.env`
4. Your server issues a short-lived access token (1 hour) and a refresh token (30 days)
5. Claude.ai uses the access token for MCP requests, refreshes automatically when it expires

The three `.env` variables that enable this:

- `HIPPO_OAUTH_ISSUER` — your server's public URL (tells Hippocampus to turn on OAuth)
- `HIPPO_OAUTH_USER` — your login username
- `HIPPO_OAUTH_PASSWORD_HASH` — SHA-256 hash of your password (the server never stores your plaintext password)

For local development, you can skip OAuth entirely by setting `HIPPO_TOKEN` in `.env` and passing it as a Bearer token.

## Contributing

### Architecture

```
src/
├── index.ts              # Hono server, MCP Streamable HTTP transport
├── config.ts             # Environment config with Zod validation
├── mcp/
│   ├── server.ts         # MCP tool registration (11 tools)
│   └── tools/            # remember, recall, forget, update, merge, merge_entities, context, consolidate, export, check_version, onboard
├── db/
│   ├── index.ts          # SQLCipher initialization
│   ├── schema.ts         # Schema + migrations
│   ├── entities.ts       # Entity CRUD
│   ├── observations.ts   # Observation CRUD + keyword search
│   └── relationships.ts  # Relationship CRUD + BFS graph traversal
├── embeddings/
│   ├── embedder.ts       # Local embeddings (all-MiniLM-L6-v2) + semantic search
│   └── subspace.ts       # SVD novelty scoring + redundancy analysis
└── auth/
    └── oauth.ts          # Self-contained OAuth 2.1 server
```

**Stack:** Node.js, TypeScript, Hono, MCP SDK, SQLCipher, Transformers.js

### Running tests

```bash
# Unit + integration tests
npm test

# Full end-to-end smoke test (real embeddings, temp encrypted DB)
HIPPO_PASSPHRASE=test HIPPO_DB_PATH=/tmp/hippo-test.db npx tsx test-all-tools.ts
```

## Platform compatibility

| Platform | Remote MCP | How to connect |
|----------|-----------|----------------|
| Claude.ai (browser + mobile) | Yes | Custom integration |
| Claude Code | Yes | `claude mcp add` |
| Claude Desktop | Yes | Config file |
| ChatGPT (web + mobile) | Yes | Developer Mode > Apps |
| ChatGPT API | Yes | `server_url` in tools |
| Gemini CLI | Yes | Settings file |
| Gemini in Android Studio | Yes | Settings > MCP Servers |
| Cursor / Windsurf / VS Code | Yes | MCP config file |
| Perplexity Mac | Partial | Local MCP support, remote coming |

## License

AGPL-3.0 — free to use, modify, and self-host. If you run a modified version as a network service, you must open-source your changes under the same license.

## Support

If Hippocampus is useful to you, [buy me a coffee](https://buy.stripe.com/5kQ9AT4IydTz7h1apHb7y00).

Open source. Free forever. No hosted version. No SaaS.
