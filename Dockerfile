# LSDM server engine — runs the headless download engine (Express + WebSocket + aria2 RPC)
# in a Linux container. This is the proof that the engine is portable: the same
# server.js that powers the Windows desktop app runs unchanged inside Docker.
#   Build:      docker build -t lsdm-server .
#   Run:        docker run --rm -p 3000:3000 -p 6800:6800 lsdm-server
#   Connect:    open http://localhost:3000 (the Electron shell or a plain browser both work)

FROM node:20-bookworm-slim

# aria2 engine (Debian package) — Debian's build is fine for the container.
RUN apt-get update && apt-get install -y --no-install-recommends aria2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for a cached layer.
COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

# Bind to all interfaces inside the container (the HOST/host binding is overridden).
ENV HOST=0.0.0.0 PORT=3000

EXPOSE 3000 6800

# Standalone mode: the server auto-spawns aria2 on Linux via `command -v aria2c`.
CMD ["npm", "start", "--", "--standalone"]