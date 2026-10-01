# 小剧场灯光 Cue 排演应用
FROM node:20-bookworm-slim

# better-sqlite3 为原生模块；bookworm-slim 附带预编译包下载失败时所需的编译工具链
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先拷贝依赖清单，尽量利用构建缓存
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# 拷贝应用代码
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/app.db

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/versions').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
