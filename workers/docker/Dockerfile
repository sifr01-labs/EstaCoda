FROM node:22-bookworm-slim AS node
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash zsh git file ripgrep libstdc++6 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
LABEL io.estacoda.execution.version="1"
COPY python /opt/estacoda/python
WORKDIR /workspace
ENV HOME=/tmp/home PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000:1000
ENTRYPOINT ["python3", "-c", "import time; time.sleep(2147483647)"]
