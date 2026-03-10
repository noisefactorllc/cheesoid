FROM node:22-slim

RUN apt-get update && apt-get install -y git curl && rm -rf /var/lib/apt/lists/*

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
