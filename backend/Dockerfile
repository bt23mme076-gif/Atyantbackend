# Use the official Node.js image as the base image
FROM node:20-alpine AS builder
WORKDIR /app

# Install dependencies (use npm ci if package-lock exists)
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy application
COPY . .

FROM node:20-alpine
WORKDIR /app

# Create app user for security
RUN addgroup -S app && adduser -S app -G app

# Copy only production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Set non-root user
USER app

EXPOSE 3000

CMD ["node", "server.js"]