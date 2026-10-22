# Shared image for the Phala CVMs. Build from the repo root:
#   docker build -f services/Dockerfile --build-arg SERVICE=core -t ghcr.io/<org>/proviso-core .
# Alpine (musl): the Debian 1.3.x tags carry fixable CRITICAL OS CVEs; all prod deps are pure JS.
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0
ARG SERVICE
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --filter "@proviso/${SERVICE}"
ENV SERVICE=${SERVICE}
USER bun
CMD ["sh", "-c", "exec bun services/${SERVICE}/src/index.ts"]
