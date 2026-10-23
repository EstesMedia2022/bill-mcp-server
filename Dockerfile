# Railway / root-level build of the AP/AR MCP server (HTTP transport).
# Build context is the repository root; see ap-ar/Dockerfile for building from ap-ar/.

# Build stage: compile TypeScript
FROM node:22-alpine AS build
WORKDIR /app
COPY ap-ar/package.json ap-ar/package-lock.json ./
RUN npm ci
COPY ap-ar/tsconfig.json ./
COPY ap-ar/src ./src
RUN npm run build

# Runtime stage: production dependencies and compiled output only
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY ap-ar/package.json ap-ar/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
