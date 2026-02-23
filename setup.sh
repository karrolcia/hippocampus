#!/bin/sh
# Hippocampus setup — generates .env and Caddyfile from user input.
# No Node.js required. Works on any POSIX system with openssl.

set -e

printf "Hippocampus setup\n\n"

# Check prerequisites
if ! command -v openssl >/dev/null 2>&1; then
    printf "Error: openssl is required but not found.\n" >&2
    exit 1
fi

if [ ! -f .env.example ]; then
    printf "Error: .env.example not found. Run this from the hippocampus directory.\n" >&2
    exit 1
fi

# Check for existing files
if [ -f .env ]; then
    printf ".env already exists. Overwrite? [y/N]: "
    read -r confirm
    case "$confirm" in y|Y) ;; *) printf "Aborted.\n"; exit 0 ;; esac
fi

# --- Gather input ---

printf "Domain (e.g., hippo.example.com): "
read -r domain

if [ -z "$domain" ]; then
    printf "Error: domain is required.\n" >&2
    exit 1
fi

printf "OAuth username [admin]: "
read -r username
username="${username:-admin}"

# Read password (hidden)
printf "OAuth password: "
stty -echo 2>/dev/null || true
read -r password
stty echo 2>/dev/null || true
printf "\n"

if [ -z "$password" ]; then
    printf "Error: password is required.\n" >&2
    exit 1
fi

# --- Generate values ---

passphrase=$(openssl rand -base64 32)

password_hash=$(printf '%s' "$password" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# --- Write .env ---

cp .env.example .env

# Fill in values using sed
sed -i.bak "s|^HIPPO_PASSPHRASE=.*|HIPPO_PASSPHRASE=${passphrase}|" .env
sed -i.bak "s|^# HIPPO_OAUTH_ISSUER=.*|HIPPO_OAUTH_ISSUER=https://${domain}|" .env
sed -i.bak "s|^# HIPPO_OAUTH_USER=.*|HIPPO_OAUTH_USER=${username}|" .env
sed -i.bak "s|^# HIPPO_OAUTH_PASSWORD_HASH=.*|HIPPO_OAUTH_PASSWORD_HASH=${password_hash}|" .env
rm -f .env.bak

# --- Write Caddyfile ---

sed -i.bak "s|^memory\.yourdomain\.com {|${domain} {|" Caddyfile
rm -f Caddyfile.bak

# --- Summary ---

printf "\nDone. Files updated:\n\n"
printf "  .env        — passphrase, OAuth issuer/user/hash\n"
printf "  Caddyfile   — domain set to %s\n\n" "$domain"
printf "Save your passphrase in a password manager:\n"
printf "  %s\n\n" "$passphrase"
printf "Next steps:\n"
printf "  docker compose up -d\n"
printf "  curl https://%s/health\n" "$domain"
