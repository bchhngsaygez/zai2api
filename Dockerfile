FROM node:22-bookworm-slim

# Set non-interactive debconf for container builds
ENV DEBIAN_FRONTEND=noninteractive

# Install required Linux dependencies for Firefox / Camoufox stealth browser and native build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-liberation \
    fonts-dejavu-core \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdbus-glib-1-2 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxshmfence1 \
    libxtst6 \
    xvfb \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests first to leverage Docker layer caching
COPY package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Pre-fetch Camoufox browser binary so container starts instantly without download delays
RUN npx camoufox-js fetch

# Copy the rest of the application files
COPY . .

# Set container environment variables & RAM optimizations
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV HEADLESS=true
ENV USER_DATA_DIR=/app/user-data-camoufox

# Memory optimization flags:
# - MALLOC_ARENA_MAX=2: Restricts glibc multi-threaded memory fragmentation (saves 100-200MB)
# - NODE_OPTIONS: Caps Node.js V8 heap and triggers early garbage collection
# - OPTIMIZE_RAM=true: Low-memory single-process Firefox profile, 16MB cache cap, zero-bfcache
# - BLOCK_IMAGES=true: Disables decoding and rendering of decorative images/avatars
ENV MALLOC_ARENA_MAX=2
ENV NODE_OPTIONS="--max-old-space-size=384"
ENV OPTIMIZE_RAM=true
ENV BLOCK_IMAGES=true

# Expose proxy server port
EXPOSE 3000

# Start zai2api
CMD ["npm", "start"]
