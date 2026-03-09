FROM node:22-bookworm-slim

ENV BUN_INSTALL=/root/.bun
ENV PATH=/root/.bun/bin:$PATH

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://bun.sh/install | bash \
  && bun add -g opencode-ai \
  && ln -sf /root/.bun/bin/bun /usr/local/bin/bun \
  && ln -sf /root/.bun/bin/bunx /usr/local/bin/bunx \
  && ln -sf /root/.bun/bin/opencode /usr/local/bin/opencode

WORKDIR /workspace

EXPOSE 4096

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=10 \
  CMD curl -fsS http://127.0.0.1:4096/global/health >/dev/null || exit 1

CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
