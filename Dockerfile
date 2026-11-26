# Multi-stage Dockerfile for CoastRide
# Builder stage
FROM node:22-slim AS builder
WORKDIR /app

# Install openssl for Prisma
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Copy package files and install all dependencies (including dev)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source files
COPY . .

# Generate Prisma client and build
RUN npx prisma generate
RUN npm run build

# Do not ship development tooling in the production image.
RUN npm prune --omit=dev

# Runner stage
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# Install openssl for runtime migrations
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nodejs

# Copy built artifacts from builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /app/package-lock.json ./package-lock.json

USER nodejs

EXPOSE 3000

# Run migrations then start server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/http/server.js"]