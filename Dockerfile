FROM node:20-slim

WORKDIR /app

# Install dependencies for both workspaces
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci

# Copy source
COPY server/ server/
COPY client/ client/
COPY postcss.config.js tailwind.config.js ./

# Build client
RUN cd client && npm run build

# SQLite data directory (mounted as Fly volume)
RUN mkdir -p /data
ENV DATABASE_PATH=/data/fantasy-baseball.db

EXPOSE 3001
CMD ["node", "server/src/index.js"]
