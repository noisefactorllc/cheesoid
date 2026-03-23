FROM node:22-slim

RUN apt-get update && apt-get install -y git curl jq python3 python3-pip && rm -rf /var/lib/apt/lists/*

# Install Python dependencies for plugins
RUN pip3 install --break-system-packages 'textstat>=0.7.3,<1.0.0' 'beautifulsoup4>=4.12.0,<5.0.0'

# Install GitHub CLI (not in default Debian repos)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI for headless mode
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

ENV PERSONA=example
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
