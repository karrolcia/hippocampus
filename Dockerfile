# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Install runtime dependencies for better-sqlite3-multiple-ciphers
RUN apt-get update && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 hippo && \
    useradd -u 1001 -g hippo -s /bin/false hippo

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

# Create data directory
RUN mkdir -p /data && chown hippo:hippo /data

USER hippo

ENV NODE_ENV=production
ENV HIPPO_DB_PATH=/data/hippocampus.db
ENV TRANSFORMERS_CACHE=/data/.models
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
