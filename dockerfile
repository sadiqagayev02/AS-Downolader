FROM node:18-slim

# Install Python, pip, ffmpeg and curl
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --no-cache-dir yt-dlp

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm install

# Copy app code
COPY . .

# Expose port
EXPOSE 10000

# Start app
CMD ["node", "index.js"]
