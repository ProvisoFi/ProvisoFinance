# Shared image for the Phala CVMs. Build from the repo root:
#   docker build -f services/Dockerfile --build-arg SERVICE=core -t ghcr.io/<org>/proviso-core .
FROM oven/bun:1.3.13
ARG SERVICE
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --filter "@proviso/${SERVICE}"
ENV SERVICE=${SERVICE}
USER bun
CMD ["sh", "-c", "exec bun services/${SERVICE}/src/index.ts"]
