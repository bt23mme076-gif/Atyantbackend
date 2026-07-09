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

# ffmpeg is needed to split large audio recordings (sessions >~2h) into
# 20-min chunks before sending to Groq Whisper (25 MB per-file limit).
RUN apk add --no-cache ffmpeg

# Create app user for security
RUN addgroup -S app && adduser -S app -G app

# Copy only production node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Set non-root user
USER app

EXPOSE 3000

CMD ["node", "server.js"]