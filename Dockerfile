# Base image pinned by digest (#753). The tag alone can resolve to different
# image bytes over time, so the same commit could produce materially different
# runtime images on different dates -- weakening release provenance and
# incident response even though the repository has explicit supply-chain gates.
# Both stages deliberately share one reviewed digest; update it as a
# reviewable diff, keeping the tag comment for readability.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS dependencies

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund


FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# node:20-bookworm-slim already ships an unprivileged `node` user (uid/gid 1000).
# Everything the runtime touches is copied in owned by that user so the final
# USER switch below does not need a costly `chown -R` over node_modules.
COPY --chown=node:node package*.json ./
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
RUN node -e "require('better-sqlite3')"
RUN ! command -v python3 && ! command -v g++
COPY --chown=node:node . .

# /app and /app/data are created by WORKDIR/mkdir as root. /app/data is the
# mount point for the axiom-data volume; Docker seeds a *newly created* named
# volume with the image directory's content and ownership, so chowning it here
# is what makes the volume writable by the node user.
RUN mkdir -p /app/data/backups \
  && chown node:node /app /app/data /app/data/backups

# Drop root before the process starts. An RCE in server.js now lands as an
# unprivileged user instead of container root.
USER node

# Make the security property build-verifiable: the active runtime user must be
# non-root and must be able to write the persistence mount point before the
# image can pass CI's Docker build gate.
RUN test "$(id -u)" -ne 0 \
  && test -w /app/data \
  && touch /app/data/.huqan-write-check \
  && rm /app/data/.huqan-write-check

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const http=require('http');const req=http.get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',res=>{process.exit(res.statusCode===200?0:1)});req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>{req.destroy();process.exit(1);});"

CMD ["node", "scripts/container-server.js"]
