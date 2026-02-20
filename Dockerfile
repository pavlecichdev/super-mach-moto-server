# Stage 1: Build the TypeScript code
FROM node:24-alpine AS builder
WORKDIR /usr/src/app

# Copy package files and install ALL dependencies (including dev)
COPY package*.json ./
RUN npm install

# Copy source code and config, then compile to JS
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production Image
FROM node:24-alpine
WORKDIR /usr/src/app

# Copy package files and install ONLY production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the compiled Javascript from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 3333
CMD ["node", "dist/server.js"]