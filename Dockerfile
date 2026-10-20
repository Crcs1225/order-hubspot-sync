FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && mkdir -p /app/data && chown -R node:node /app
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/server.ts"]
