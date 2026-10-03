#!/bin/sh
# Стартов скрипт на контейнера:
#   1) тегли последното от GitHub (AUTO_UPDATE=1)
#   2) изчиства npm кеша
#   3) преинсталира зависимостите, ако package.json се е променил
#   4) стартира приложението (миграциите се пускат при старта на server.js)
set -e

cd /app
BRANCH="${GIT_REF:-main}"

if [ "${AUTO_UPDATE:-1}" = "1" ] && [ -d .git ]; then
  echo "[entry] Проверка за обновления от GitHub (клон ${BRANCH})..."
  if git fetch --depth 1 origin "${BRANCH}" 2>/dev/null; then
    git reset --hard FETCH_HEAD
    echo "[entry] Обновено до $(git rev-parse --short HEAD) — $(git log -1 --format=%s)"
  else
    echo "[entry] WARN: fetch неуспешен — продължавам с вградената версия."
  fi
else
  echo "[entry] AUTO_UPDATE изключен — ползвам вградената версия."
fi

# Изчистване на npm кеша при всяко стартиране
npm cache clean --force >/dev/null 2>&1 || true

# Преинсталиране само ако package-lock.json/package.json са се променили спрямо
# последно инсталираното (херметизира stamp файл в node_modules).
STAMP="node_modules/.helious_stamp"
DEPS_HASH="$(git rev-parse "HEAD:package-lock.json" 2>/dev/null || git rev-parse "HEAD:package.json" 2>/dev/null || echo none)"
if [ ! -d node_modules ] || [ "$(cat "$STAMP" 2>/dev/null)" != "$DEPS_HASH" ]; then
  echo "[entry] Инсталиране на зависимости (hash $DEPS_HASH)..."
  if npm install --omit=dev --no-audit --no-fund; then
    echo "$DEPS_HASH" > "$STAMP"
  else
    echo "[entry] WARN: npm install неуспешен — продължавам."
  fi
fi

echo "[entry] Стартиране на приложението..."
exec "$@"
