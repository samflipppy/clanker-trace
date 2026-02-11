FROM node:20-slim

WORKDIR /app

COPY package*.json ./
COPY server/package*.json ./server/
COPY sdk/node/package*.json ./sdk/node/

RUN npm install --workspace=server --workspace=sdk/node

COPY server/ ./server/
COPY sdk/node/ ./sdk/node/

RUN npm run build --workspace=server --workspace=sdk/node

ENV PORT=3100
ENV CLANKER_BILLING_MODE=free
ENV CLANKER_DB_PATH=/data/clanker-trace.db

VOLUME /data
EXPOSE 3100

CMD ["node", "server/dist/selfhost.js"]
