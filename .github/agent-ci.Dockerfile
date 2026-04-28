FROM ghcr.io/actions/actions-runner:latest

RUN sudo apt-get update \
 && sudo apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      docker.io \
      docker-compose-v2 \
      git \
      jq \
      locales \
      python3 \
      python3-pip \
      python3-venv \
      unzip \
      xz-utils \
 && sudo rm -rf /var/lib/apt/lists/*

RUN printf '%s\n' '#!/usr/bin/env bash' 'exec sudo -E /usr/bin/docker "$@"' \
    | sudo tee /usr/local/bin/docker >/dev/null \
 && sudo chmod +x /usr/local/bin/docker

RUN sudo locale-gen C.UTF-8 || true \
 && sudo update-locale LANG=C.UTF-8 || true

ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
