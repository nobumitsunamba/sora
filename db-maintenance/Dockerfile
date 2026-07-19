# マルチステージビルド: フロントエンド(React)をビルドし、API(Express)が静的配信する
# 基盤のスキャフォールドが web / api の2コンテナ構成の場合は、
# ステージを分割してそれぞれのイメージとして利用すること(README参照)。

FROM node:22-alpine AS webbuild
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
# vite.config.js の outDir は ../api/public
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY api/package*.json ./
RUN npm ci --omit=dev
COPY api/src ./src
COPY --from=webbuild /app/api/public ./public
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://localhost:3000/api/health || exit 1
CMD ["node", "src/server.js"]
