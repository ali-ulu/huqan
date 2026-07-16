FROM node:20-bookworm-slim AS dependencies

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund


FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV AXIOM_HOST=0.0.0.0
ENV AXIOM_MEMORY_PATH=/app/data/memory.json
ENV AXIOM_DB_PATH=/app/data/memory.db
ENV AXIOM_BACKUP_DIR=/app/data/backups

COPY package*.json ./
COPY --from=dependencies /app/node_modules ./node_modules
RUN node -e "require('better-sqlite3')"
RUN ! command -v python3 && ! command -v g++
COPY . .

RUN mkdir -p /app/data/backups

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',res=>{process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1);});"

CMD ["node", "server.js"]
