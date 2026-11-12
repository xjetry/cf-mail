FROM node:22-slim

# workerd 运行时需要系统 CA 证书（slim 镜像默认没有）
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用 docker 层缓存）
COPY worker/package.json worker/package-lock.json* ./worker/
RUN cd worker && npm install

# 拷贝源码
COPY worker ./worker
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ADMIN_TOKEN 通过环境变量注入（entrypoint 会写入 .dev.vars 供 wrangler dev 使用）
ENV ADMIN_TOKEN=dev-token

WORKDIR /app/worker

EXPOSE 8787

# wrangler dev --local 持续运行；DO 状态写在 /app/worker/.wrangler（挂 volume 持久化）
ENTRYPOINT ["/entrypoint.sh"]
