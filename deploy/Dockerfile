FROM node:22-alpine

WORKDIR /app
COPY . .

ENV NOA_HOST=0.0.0.0 \
    NOA_PORT=8787 \
    NOA_DB_PATH=/app/deploy/data/noa.sqlite \
    NODE_NO_WARNINGS=1

EXPOSE 8787
VOLUME ["/app/deploy/data"]
CMD ["node", "packages/server/index.ts"]
