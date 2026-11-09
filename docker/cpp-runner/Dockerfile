FROM gcc:14-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /runner
USER 65534:65534
# Use env as entrypoint so the host-supplied `python3 -I -S -c ...`
# command is executed exactly once (without duplicating the interpreter).
ENTRYPOINT ["/usr/bin/env"]
