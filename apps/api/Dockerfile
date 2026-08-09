# Shipbot control plane — a persistent, always-on Node service (NOT serverless).
# Runs TypeScript directly via tsx; no build step. Railway sets $PORT at runtime.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# Install runtime deps only (tsx + pg are dependencies; typescript/@types are dev).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8787
CMD ["npm", "start"]
