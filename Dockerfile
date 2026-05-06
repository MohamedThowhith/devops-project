# Use lightweight Node image
FROM node:18-alpine

# Install build tools required for better-sqlite3
RUN apk add --no-cache python3 make g++

# Set working directory
WORKDIR /app

# Copy only package files first (for caching)
COPY package*.json ./

# Install dependencies (production only)
RUN npm ci --only=production

# Copy remaining project files
COPY . .

# Set environment variable
ENV PORT=3000

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]