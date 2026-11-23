FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

FROM base AS deps
RUN apk add --no-cache python3 make g++ && npm install -g npm@latest
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

FROM base AS builder
COPY package.json ./
RUN npm install
COPY . .
RUN npx tsc
RUN npx prisma generate

FROM base AS runner
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nodejs
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
USER nodejs
EXPOSE 3000
CMD ["node", "dist/http/server.js"]
