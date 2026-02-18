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
- Token audience scoped per instance (RFC 8707)
- Self-contained auth server (single user, no external IdP dependency)

**Endpoints:**
```
GET  /.well-known/oauth-protected-resource
GET  /.well-known/oauth-authorization-server
GET  /authorize
POST /token
POST /register
```

### 3. Encryption at Rest: SQLCipher (AES-256)
- `better-sqlite3-multiple-ciphers` package
- Entire database file encrypted: tables, indexes, metadata, WAL, embeddings
- 256,000 PBKDF2 iterations
- Passphrase via `HIPPO_PASSPHRASE` env var, never written to disk
- Without passphrase, .db file is indistinguishable from random bytes

### 4. Input Validation & Prompt Injection Defense
Memories get injected into LLM context. This is a prompt injection vector.

- Max content length: 2,000 chars per memory
- Max entity name: 200 chars
- Strip null bytes, control characters
- Memories wrapped in clear delimiters when returned:
  ```xml
  <hippocampus_memory id="abc" created="2026-02-11" source="phone">
    [content — treated as untrusted input by the LLM]
  </hippocampus_memory>
  ```
- Rate limit writes: 20/minute
- Total memory cap: 10,000 observations (configurable)

### 5. Rate Limiting

| Endpoint | Limit | Window |
|----------|-------|--------|
| All endpoints | 120 req | /minute |
| `remember` | 20 | /minute |
| `recall` | 60 | /minute |
| `export` | 5 | /minute |
| `/token` | 10 | /minute |

Request body: 10KB max.

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
HIPPO_OAUTH_PASSWORD_HASH=<bcrypt hash>
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
