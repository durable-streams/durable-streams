# Claude Code Web - Sandbox Container
# Based on Ubuntu 24.04 with comprehensive development tooling

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TERM=xterm-256color
ENV COLORTERM=truecolor
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV SHELL=/bin/bash

# Install system dependencies and development tools
RUN apt-get update && apt-get install -y \
    # Locales and shell essentials
    locales \
    bash-completion \
    # Editors and tools
    nano \
    # Git and version control
    git \
    git-lfs \
    # Network tools
    curl \
    wget \
    openssh-client \
    ca-certificates \
    # Process and system monitoring
    htop \
    procps \
    # File utilities
    tree \
    less \
    unzip \
    zip \
    # JSON/text processing
    jq \
    # Modern CLI replacements
    ripgrep \
    fd-find \
    bat \
    fzf \
    # Build tools
    build-essential \
    cmake \
    # Documentation
    man-db \
    # Security
    sudo \
    gnupg \
    # Python
    python3 \
    python3-pip \
    python3-venv \
    # Networking
    dnsutils \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && locale-gen en_US.UTF-8

# Install Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install gh -y \
    && rm -rf /var/lib/apt/lists/*

# Install Neovim 0.11 (build from source for ARM64 compatibility)
RUN apt-get update && apt-get install -y \
    ninja-build gettext \
    && git clone --depth 1 --branch v0.11.0 https://github.com/neovim/neovim.git /tmp/neovim \
    && cd /tmp/neovim \
    && make CMAKE_BUILD_TYPE=Release \
    && make install \
    && rm -rf /tmp/neovim \
    && apt-get remove -y ninja-build gettext \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/local/bin/nvim /usr/local/bin/vim

# Install tmux
RUN apt-get update && apt-get install -y tmux \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create a non-root developer user
RUN useradd -m -s /bin/bash dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
    && mkdir -p /home/dev/.config/nvim \
    && mkdir -p /etc/claude-code/hooks

# Copy configuration files
COPY --chown=dev:dev nvim-init.lua /home/dev/.config/nvim/init.lua
COPY --chown=root:root hooks/ /etc/claude-code/hooks/
COPY --chown=root:root spawn-instance /usr/local/bin/spawn-instance
COPY --chown=root:root claude-settings.json /etc/claude-code/settings.json

# Make hooks and spawn-instance executable
RUN chmod +x /etc/claude-code/hooks/*.sh /usr/local/bin/spawn-instance

# Copy the Claude Code skills directory
COPY --chown=dev:dev skills/ /home/dev/.claude/skills/

# Switch to dev user
USER dev
WORKDIR /workspace

# Pre-install nvim plugins
RUN nvim --headless "+Lazy! sync" +qa 2>/dev/null || true

# Configure shell
RUN echo 'export TERM=xterm-256color' >> ~/.bashrc \
    && echo 'export COLORTERM=truecolor' >> ~/.bashrc \
    && echo 'stty sane 2>/dev/null || true' >> ~/.bashrc \
    && echo 'alias vim=nvim' >> ~/.bashrc \
    && echo 'alias ll="ls -la"' >> ~/.bashrc \
    && echo 'alias rg="rg --smart-case"' >> ~/.bashrc

# Set up git configuration
RUN git config --global init.defaultBranch main \
    && git config --global core.editor nvim \
    && git config --global pull.rebase false

CMD ["/bin/bash"]
