# Shared image for the Phala CVMs. Build from the repo root:
#   docker build -f services/Dockerfile --build-arg SERVICE=core -t ghcr.io/<org>/proviso-core .
FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e
ARG SERVICE
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile --production --filter "@proviso/${SERVICE}"
ENV SERVICE=${SERVICE}
USER bun
CMD ["sh", "-c", "exec bun services/${SERVICE}/src/index.ts"]
