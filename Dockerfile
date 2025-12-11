FROM node:22-slim AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/writer/package.json ./packages/writer/
COPY packages/client/package.json ./packages/client/
COPY packages/test-ui/package.json ./packages/test-ui/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/server/ ./packages/server/
COPY packages/writer/ ./packages/writer/
COPY packages/client/ ./packages/client/
COPY packages/test-ui/ ./packages/test-ui/
COPY tsconfig.json ./

# Build packages
RUN pnpm --filter @durable-streams/writer build
RUN pnpm --filter @durable-streams/client build
RUN pnpm --filter @durable-streams/server build
RUN pnpm --filter @durable-streams/test-ui build

# Production stage
FROM node:22-slim

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate

WORKDIR /app

# Copy package files for production dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/writer/package.json ./packages/writer/
COPY packages/client/package.json ./packages/client/

# Install only production dependencies (ignore scripts like husky)
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy built artifacts from builder
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/writer/dist ./packages/writer/dist
COPY --from=builder /app/packages/client/dist ./packages/client/dist
COPY --from=builder /app/packages/test-ui/dist ./packages/test-ui/dist

# Copy startup script
COPY docker-server.mjs ./

# Expose port
EXPOSE 8787

# Start the combined server
CMD ["node", "docker-server.mjs"]
