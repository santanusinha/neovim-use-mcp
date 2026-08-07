FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install Neovim latest stable
RUN curl -LO https://github.com/neovim/neovim/releases/latest/download/nvim-linux-x86_64.tar.gz && \
    tar xzf nvim-linux-x86_64.tar.gz -C /opt && \
    ln -s /opt/nvim-linux-x86_64/bin/nvim /usr/local/bin/nvim && \
    rm nvim-linux-x86_64.tar.gz

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/ dist/
COPY README.md ./

ENTRYPOINT ["node", "dist/index.js"]
