FROM node:22-bookworm-slim

# git + certifikati: за теглене/обновяване от GitHub
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=48081

# Кодът се тегли директно от GitHub при build (винаги последното от клона).
ARG GIT_REPO=https://github.com/niangoto/Helious.git
ARG GIT_REF=main

RUN REPO="${GIT_REPO:-https://github.com/niangoto/Helious.git}"; \
    REF="${GIT_REF:-main}"; \
    git clone --depth 1 --branch "$REF" "$REPO" /app \
 && rm -rf /app/.git/hooks/*

# Prod зависимости
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Entrypoint-ът стои извън /app, за да не се презаписва при git reset
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /app/data

EXPOSE 48081

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server.js"]
