FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY index.js ./
COPY src ./src

ENV NODE_ENV=production
# Cloud Run injects PORT at runtime (default 8080); config.js already reads process.env.PORT.
EXPOSE 8080

CMD ["node", "index.js"]
