# Hippocampus — Security Architecture

## This stores the map of your mind. Treat it that way.

This server holds how you think — decisions, doubts, relationships, business strategy, personal struggles. A breach here is worse than a financial data leak. Passwords are random strings. Bank balances are just numbers. This is *you*.

---

## Threat Model

**Threat actors:**
1. **Opportunistic scanner** — bots probing public IPs for exposed services
2. **Targeted attacker** — someone who wants your business strategy
3. **Infrastructure compromise** — VPS provider breach, cloud account takeover
4. **Supply chain attack** — malicious npm dependency update
5. **Physical access** — stolen laptop, decommissioned server
6. **Embedding inversion** — reconstructing original text from stolen vector embeddings

---

## Critical Finding: Embedding Vectors Leak Information

Research (Li et al., ACL 2023) shows original text can be substantially reconstructed from embedding vectors alone. Embeddings are NOT a privacy-safe representation.

**Implication:** The entire SQLite database — text AND embeddings — must be encrypted as one unit via SQLCipher. Embeddings are treated as equivalent to plaintext.

---

## Security Layers

### 1. Transport: HTTPS Only
- TLS 1.3 minimum, HSTS headers
- Caddy reverse proxy handles TLS + Let's Encrypt automatic certs
- No HTTP endpoints in production
- Local dev: HTTP on 127.0.0.1 only

### 2. Authentication: OAuth 2.1
MCP standard. Required for cross-platform compatibility.

- Authorization Code Flow with PKCE
- Protected Resource Metadata (RFC 9728)
- Dynamic Client Registration (so Claude/ChatGPT auto-register)
- Short-lived access tokens (1 hour), refresh tokens (30 days, single-use rotation)
- Tokens are opaque and valid only on the instance that issued them (no RFC 8707 resource indicators; no audience binding)
- Self-contained auth server (single user, no external IdP dependency)

**Endpoints:**
```
GET  /.well-known/oauth-protected-resource/mcp
GET  /.well-known/oauth-authorization-server
GET  /authorize
POST /authorize
POST /token
POST /register
```

**Agent token (optional, machine-to-machine):**
Scheduled agents running on the owner's own infrastructure (e.g. a launchd
job on the owner's laptop hitting their own server) can authenticate with
a static bearer token set via `HIPPO_AGENT_TOKEN` (min 32 chars per token).
`HIPPO_AGENT_TOKEN` may be a comma-separated list, so each agent (laptop,
server, …) can hold an independently-revocable token; the candidate is
timing-safe-compared against each entry. Keep the list SERVER-side only —
clients hold a single token, never the whole list.

- Independent from OAuth access tokens — set one, both, or neither
- `bearerAuth()` checks OAuth first, falls back to the agent token
- Constant-time comparison (`timingSafeEqual`) with a length gate
- Revocation: rotate the env var, redeploy
- Scope (D28): each entry may carry a prefix — `read:<token>`,
  `write:<token>`, `full:<token>`. A bare entry is `full`, so tokens minted
  before scopes existed keep working until rotated. The scope fixes which
  tools the session can list and call:
  - `read`: recall, context, export, check_version, get_observation,
    consolidate (detection only — it proposes, never deletes)
  - `write`: the above plus remember and onboard
  - `full`: the above plus forget, update, merge, merge_entities
  An out-of-scope tool is absent from `tools/list` and a call to it is
  refused in-band (`isError: true`) with a message naming the tool and both
  scopes. Resources are readable at every scope. A session is bound to the
  SCOPE it was created under, not to the credential: presenting its id with
  a token of another scope gets 403, while two tokens of the same scope can
  share a session (no privilege changes, and an OAuth client keeps its
  session across an access-token refresh). An entry with an unknown label (`admin:…`) never
  authenticates, and the server logs the label (never the token) at start.
- `write` is "no explicit-delete tools", not "no deletion": `remember` can
  still replace a near-duplicate written the same day, and
  `remember({replace_kind: true})` deletes every observation of that kind on
  the entity. Both report the evicted text (`replaced: true`).
- Backwards compatibility assumes no deployed token contains a colon (the
  mint scripts produce hex). One that does is read as `<label>:<token>` and
  fails closed: 401, plus a startup warning that never echoes it.
- OAuth access tokens and the legacy `HIPPO_TOKEN` are `full`. Agent tokens,
  and so scopes, are consulted only when OAuth is configured
  (`HIPPO_OAUTH_ISSUER` set); in legacy mode a scoped entry does nothing.
- OAuth clients are unaffected — they never reach the agent token path

This path is opt-in: if `HIPPO_AGENT_TOKEN` is not set, nothing changes.

### 3. Encryption at Rest: SQLCipher (AES-256)
- `better-sqlite3-multiple-ciphers` package
- Entire database file encrypted: tables, indexes, metadata, WAL, embeddings
- 256,000 PBKDF2 iterations
- Passphrase via `HIPPO_PASSPHRASE` env var, never written to disk
- Without passphrase, .db file is indistinguishable from random bytes

### 4. Input Validation & Prompt Injection Defense
Memories get injected into LLM context. This is a prompt injection vector.

- Max content length: 50,000 chars per memory
- Max entity name: 200 chars
- Strip null bytes, control characters
- Memories wrapped in clear delimiters when returned:
  ```xml
  <hippocampus_memory id="abc" created="2026-02-11" source="phone">
    [content — treated as untrusted input by the LLM]
  </hippocampus_memory>
  ```
- Not implemented: a separate rate limit for writes, or a total observation cap. Writes share the `/mcp` limit below.

### 5. Rate Limiting

Counted per client address, in fixed windows, in process memory (a restart resets them).

| Endpoint | Limit | Window |
|----------|-------|--------|
| `/mcp` (every tool, every method) | 60 (`RATE_LIMIT_RECALL`) | 1 minute |
| `POST /authorize` (the login form) | 10 | 15 minutes |
| `POST /token` | 30 | 15 minutes |
| `POST /register` | 10 | 1 hour |
| Failed logins, all addresses together | 20 | 1 hour |

The last row is one counter for the single account. Per-address limits alone are beaten by rotating addresses (an IPv6 /64 holds 2^64 of them). While it is tripped, `POST /authorize` refuses everyone, the owner included, until the window ends. Requests in flight together are re-checked just before the password comparison, so a burst cannot overrun it. The cost: an attacker can keep it tripped indefinitely, because one address's per-address budget (40 an hour) is already enough to re-trip it each window, and a restart clears it only until they send again. While it lasts, no NEW client can log in. `/token` is not affected, and each refresh issues a fresh 30-day refresh token, so connected clients in regular use never need the form. In exchange, nobody can try more than 20 passwords per fixed one-hour window (up to 40 straddling a window boundary).

**Client address.** `X-Forwarded-For` is read only when the TCP peer is a loopback or private address (a reverse proxy on the same host or network, such as Caddy behind Docker's port publish), and then only its rightmost entry, the one that proxy wrote. A request from a public peer is counted against that peer, whatever headers it sends. This holds only when the app sees the client's own address as its TCP peer. Some Docker setups (rootless Docker's default port driver, Docker Desktop) show a private gateway address for every incoming connection, and then a client-sent `X-Forwarded-For` is trusted. On those, keep a reverse proxy in front that overwrites the header (Caddy does by default). If your proxy is on a public address, every request counts against the proxy.

**Request body:** 16 KB max on `POST /authorize`, `/token` and `/register`, checked before the body is parsed. `/mcp` has no byte cap; its body is read only after the bearer token is verified.

### 6. Network Hardening
- CORS: restrict to known AI platform origins (claude.ai, chat.openai.com, etc.)
- Host header validation (DNS rebinding protection)
- Security headers: HSTS, X-Content-Type-Options, X-Frame-Options
- Only port 443 exposed

### 7. Docker Hardening
- Non-root user
- Read-only filesystem (except /data volume)
- `no-new-privileges`, `cap_drop: ALL`

### 8. Supply Chain Security
- Minimal dependencies: 5 core packages
- Pinned exact versions for security-critical deps
- `package-lock.json` committed
- `npm audit` in CI

### 9. Secure Deletion
`SQL DELETE` doesn't zero data. For a memory system with `forget`, actual deletion matters.
- `PRAGMA secure_delete = ON` (zeros freed pages)
- Periodic `VACUUM` to reclaim + re-encrypt space
- Full wipe: delete database file entirely

### 10. Backup Security
- Backups inherit SQLCipher encryption — safe to store anywhere
- Store in different location than server
- Backup rotation: 7 daily, 4 weekly

### 11. Privacy-Aware Logging
- **Log:** auth events, tool calls (tool name + timestamp + entity name only), errors
- **Never log:** memory content, observation text, embeddings, tokens, passphrase

---

## Self-Hosting Guide

### Recommended: Hetzner VPS (€4-5/month)

German company, GDPR-compliant, EU datacenters (Helsinki or Nuremberg). Your database is encrypted — even if someone stole the disk, they get nothing.

```bash
# 1. Provision Hetzner Cloud VPS (CX22 — 2 vCPU, 4GB RAM)
# Choose Ubuntu 24.04, Helsinki datacenter

# 2. SSH in, set up firewall
ufw default deny incoming && ufw default allow outgoing
ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
ufw enable

# 3. Install Docker
curl -fsSL https://get.docker.com | sh

# 4. Install Caddy (automatic HTTPS)
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
  gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
  tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install caddy

# 5. Configure Caddy
cat > /etc/caddy/Caddyfile << 'EOF'
hippo.yourdomain.com {
    reverse_proxy localhost:3000
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
    header X-Content-Type-Options "nosniff"
    header X-Frame-Options "DENY"
}
EOF
systemctl restart caddy

# 6. Clone and deploy Hippocampus
git clone https://github.com/yourusername/hippocampus.git
cd hippocampus

# 7. Generate passphrase (SAVE THIS IN YOUR PASSWORD MANAGER)
openssl rand -base64 32

# 8. Create .env (never commit)
cat > .env << 'EOF'
HIPPO_PASSPHRASE=your-generated-passphrase
HIPPO_PORT=3000
HIPPO_OAUTH_USER=your-email@example.com
HIPPO_OAUTH_PASSWORD_HASH=<SHA-256, base64url: see README for the one-liner>
EOF

# 9. Start
docker compose up -d
```

### Alternative: Fly.io (~$5/month, easiest)

```bash
git clone https://github.com/yourusername/hippocampus.git && cd hippocampus
fly launch
fly secrets set HIPPO_PASSPHRASE=$(openssl rand -base64 32)
fly volumes create hippo_data --size 1
fly deploy
```

### Alternative: Home Server + Cloudflare Tunnel (free)

Maximum hardware control, no open ports. But you're responsible for uptime, updates, and physical security. A properly configured Hetzner VPS with SQLCipher is more secure than most home setups — datacenters have 24/7 monitoring, redundant power, and physical access controls that your apartment doesn't.

### Connecting to AI Platforms

**Claude.ai:** Settings → Connectors → Add custom connector → `https://hippo.yourdomain.com/mcp`

**Claude Code:** `claude mcp add hippocampus --transport http https://hippo.yourdomain.com/mcp`

**ChatGPT:** Settings → Apps → Developer Mode → Create → `https://hippo.yourdomain.com/mcp`

**Gemini CLI:** Add to `~/.gemini/settings.json` mcpServers config

---

## The RAM Question

The one theoretical vulnerability in any cloud deployment: while the app runs, the decryption passphrase lives in process memory. A hosting provider with root access could theoretically extract it.

**Honest assessment:** This requires a rogue datacenter employee or a sophisticated targeted attack. Hetzner is a German company under GDPR, needs a court order. Your encrypted database protects against every realistic threat — disk theft, decommissioned hardware, backup leaks, infrastructure breach.

**What you can do:**
- Use a dedicated VPS (not shared) to eliminate other-tenant attacks
- SQLCipher uses 256,000 PBKDF2 iterations — brute force is infeasible
- Minimize connection lifetime (close/reopen DB on idle timeout)
- Accept the trade-off and focus on detection (integrity checks, access logging)

If a state-level actor targets your process memory specifically, neither a home server nor any cloud deployment will save you. At that point, your threat model needs more than a memory server.

---

## What We Don't Protect Against

1. **Compromised AI account** — if someone hijacks your Claude/ChatGPT account, they can read memories through the AI
2. **Root access on running server** — passphrase in process memory
3. **Social engineering** — you sharing your passphrase
4. **Malicious Hippocampus update** — verify releases, pin versions, audit code

---

## Security Checklist

### Must ship (Day 1)
- [ ] HTTPS via Caddy
- [ ] OAuth 2.1 + PKCE + PRM + Dynamic Registration
- [ ] SQLCipher encryption (DB + embeddings)
- [ ] Input validation + length limits
- [ ] Rate limiting
- [ ] Non-root Docker, cap_drop ALL
- [ ] Structured logging (no secrets in logs)
- [ ] Host header validation + CORS
- [ ] Secure deletion (PRAGMA secure_delete)
- [ ] Self-hosting guide in README

### Week 1
- [ ] Automated backup script
- [ ] npm audit in CI
- [ ] Security headers
- [ ] Docker Compose hardening

### Month 1
- [ ] Community security review
- [ ] Dependency pinning
- [ ] Backup restore procedure tested
- [ ] security.txt
