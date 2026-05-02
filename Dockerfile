# Self-contained bee-bench image. Builds all three runners against
# pinned sibling-repo refs from upstream, so the container needs no
# host mounts to run the CPU subset.
#
# Build:
#   docker build -t bee-bench .
#
# CPU-only (no Bee node needed):
#   docker run --rm -v "$PWD/out:/workspace/bee-bench/results" bee-bench
#
# Full suite against a Bee node on the host (Linux: --network=host;
# macOS/Windows: BEE_URL=http://host.docker.internal:1633):
#   docker run --rm --network=host \
#     -e BEE_URL=http://localhost:1633 \
#     -e BEE_BATCH_ID=<hex> \
#     -v "$PWD/out:/workspace/bee-bench/results" \
#     bee-bench
#
# Pin a specific upstream client version:
#   docker build --build-arg BEE_GO_REF=v1.1.0 \
#                --build-arg BEE_RS_REF=v1.1.0 \
#                --build-arg BEE_JS_REF=v12.1.0 \
#                -t bee-bench .

ARG RUST_VERSION=1.85
FROM rust:${RUST_VERSION}-bookworm

# Pinned upstream refs. Override with --build-arg.
ARG BEE_GO_REF=main
ARG BEE_RS_REF=main
ARG BEE_JS_REF=master
ARG GO_VERSION=1.25.0
ARG NODE_MAJOR=20

# --- Go + Node on top of the rust base (which already has cargo, git, build-essential) ---
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) goarch=amd64 ;; \
      arm64) goarch=arm64 ;; \
      *) echo "unsupported arch: $arch" && exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${goarch}.tar.gz" | tar -C /usr/local -xz; \
    ln -s /usr/local/go/bin/go /usr/local/bin/go; \
    ln -s /usr/local/go/bin/gofmt /usr/local/bin/gofmt; \
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -; \
    apt-get install -y --no-install-recommends nodejs jq; \
    rm -rf /var/lib/apt/lists/*

ENV GOPATH=/go GOCACHE=/root/.cache/go-build PATH=$PATH:/usr/local/go/bin:/go/bin

# --- Sibling client repos. The runners' path/replace deps assume ../../<sibling>, so
# bee-bench sits inside /workspace alongside its three siblings. ---
WORKDIR /workspace
RUN git clone --depth 1 --branch ${BEE_GO_REF} https://github.com/ethswarm-tools/bee-go.git \
 && git clone --depth 1 --branch ${BEE_RS_REF} https://github.com/ethswarm-tools/bee-rs.git \
 && git clone --depth 1 --branch ${BEE_JS_REF} https://github.com/ethersphere/bee-js.git \
 && (cd bee-go && git fetch --depth=1 --tags origin 2>/dev/null || true)

# bee-js needs to be built before runner-js can import it
WORKDIR /workspace/bee-js
RUN npm install --no-audit --no-fund --silent && npm run build:node

# Copy the bench source last so changes here don't bust the dep layers
COPY . /workspace/bee-bench

# Build runner-rs (release)
WORKDIR /workspace/bee-bench/runner-rs
RUN cargo build --release && cp target/release/bench /usr/local/bin/bench-rs

# Build runner-go
WORKDIR /workspace/bee-bench/runner-go
RUN go build -o bench . && cp bench /usr/local/bin/bench-go

# Install runner-js deps
WORKDIR /workspace/bee-bench/runner-js
RUN npm install --no-audit --no-fund --silent

WORKDIR /workspace/bee-bench

# Default Bee URL — Linux users with --network=host can override to localhost,
# macOS/Windows users get host.docker.internal automatically.
ENV BEE_URL=http://host.docker.internal:1633

# Default: run the full pipeline. With no BEE_BATCH_ID, all net.* cases
# skip cleanly and only the CPU subset runs.
ENTRYPOINT ["./scripts/run-all.sh"]
