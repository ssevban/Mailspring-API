# Build stage: compiler toolchain only for better-sqlite3's native module
# (used if no prebuilt binary matches), never shipped.
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime stage: node + production node_modules + app files.
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json index.js manage.js ./
COPY static ./static
RUN mkdir /data && ln -s /data /app/data && chown 1000:1000 /data

ENV NODE_ENV=production
USER 1000:1000
EXPOSE 5101
VOLUME ["/data"]

ENTRYPOINT ["node", "index.js"]
