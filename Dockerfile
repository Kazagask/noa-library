FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
ENV NOA_DB_PATH=/app/deploy/data/local.sqlite
ENV NOA_PORT=8787
EXPOSE 8787
# Node 22 built-in node:sqlite; no external runtime dependency.
CMD ["node", "packages/local/http.ts"]
