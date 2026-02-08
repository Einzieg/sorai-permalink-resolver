FROM node:22-alpine

WORKDIR /app

# Runtime defaults (can be overridden at `docker run` / compose time)
ENV NODE_ENV=production
ENV PORT=3131
ENV HOST=0.0.0.0
ENV SPR_STRICT_PORT=1

COPY package.json ./package.json
COPY package-lock.json ./package-lock.json
COPY server.js ./server.js
COPY web ./web
COPY bin ./bin
COPY README.md ./README.md
COPY LICENSE ./LICENSE

EXPOSE 3131

USER node

CMD ["node", "server.js"]

