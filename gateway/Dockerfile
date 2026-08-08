# Gateway image: the queue/orchestrator that fronts the GPU pods.
#
# bookworm-slim rather than alpine (which nidora-ai's backend uses) because
# better-sqlite3 ships glibc prebuilds; on musl every build would compile the
# native module from source.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Jobs, inputs and generated media all live here; mount a volume over it or a
# gateway restart loses the in-flight work it would otherwise have recovered.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

ENV PORT=8080 DATA_DIR=/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
