FROM node:22-alpine

WORKDIR /app

COPY package.json ./package.json
COPY src ./src

ENV NODE_ENV=production
ENV EMBEDDER_PORT=8080

EXPOSE 8080

CMD ["node", "src/server.mjs"]
