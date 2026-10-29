FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# The server has no runtime dependencies, so there is nothing to npm install.
COPY package.json ./
COPY server ./server
COPY public ./public
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:${PORT:-8000}/healthz || exit 1
CMD ["node", "server/server.mjs"]
