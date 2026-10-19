FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3480 LUMEN_WATCH_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p /data && chown node:node /data
COPY --chown=node:node server.mjs ./
COPY --chown=node:node public ./public
USER node
EXPOSE 3480
VOLUME ["/data"]
CMD ["node", "server.mjs"]
