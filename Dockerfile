FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production BRIDGE_CONFIG=/app/config.local.json
WORKDIR /app
COPY --chown=1000:1000 --from=build /app/node_modules ./node_modules
COPY --chown=1000:1000 --from=build /app/dist ./dist
COPY --chown=1000:1000 package.json ./
COPY --chown=1000:1000 third_party ./third_party
RUN mkdir /app/state && chown 1000:1000 /app/state && chmod 700 /app/state
USER 1000:1000
VOLUME ["/app/state"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD ["node", "dist/src/main.js", "health"]
CMD ["node", "dist/src/main.js"]
