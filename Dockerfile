# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++ git

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies for better-sqlite3-multiple-ciphers
RUN apk add --no-cache openssl

# Create non-root user
RUN addgroup -g 1001 -S hippo && \
    adduser -u 1001 -S hippo -G hippo

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
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
