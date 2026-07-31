FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src

ENV NODE_ENV=production
# Cloud Run inyecta PORT en runtime (default 8080); config.js ya lee process.env.PORT.
EXPOSE 8080

CMD ["node", "index.js"]
