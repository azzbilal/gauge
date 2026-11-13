# Gauge API: NestJS + Prisma on node:20-alpine.
#
#   default command   prisma migrate deploy, then node dist/main.js
#   one-off seed      docker run ... <image> node dist-seed/prisma/seed.js
#                     (the entrypoint migrates first, then runs the given command)

# ---- build ----------------------------------------------------------------
FROM node:20-alpine AS build
# Prisma's engines link against OpenSSL.
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# prisma generate, then nest build (npm run build runs prebuild = prisma generate).
RUN npm run build
# The run image has no ts-node, so compile the seed ahead of time. It imports
# ../src/intake/posting, so tsc writes a tree: dist-seed/prisma/seed.js and
# dist-seed/src/... . Compiled outside dist because nest build empties dist.
RUN npx tsc prisma/seed.ts --outDir dist-seed --rootDir . \
      --module commonjs --target ES2021 --esModuleInterop --skipLibCheck
# Production dependencies only. The generated client in node_modules/.prisma stays.
RUN npm prune --omit=dev

# ---- run ------------------------------------------------------------------
FROM node:20-alpine AS run
RUN apk add --no-cache openssl
# Pin the Prisma CLI to @prisma/client's version. The prune keeps the lockfile's prisma
# 6.19.3 (it is @prisma/client's peer), and `npx prisma` runs that local copy first.
# The global install is the pinned fallback, so npx never fetches another version.
RUN npm install -g prisma@6.19.3 && npm cache clean --force
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-seed ./dist-seed
# The schema plus migrations/ (with migration_lock.toml) for migrate deploy.
COPY --from=build /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=build /app/prisma/migrations ./prisma/migrations

USER node
EXPOSE 3000

# Apply pending migrations, then run the given command (default: start the API).
# Inline, so there is no script file whose line endings a Windows checkout could break.
ENTRYPOINT ["sh", "-c", "npx prisma migrate deploy && exec \"$@\"", "--"]
CMD ["node", "dist/main.js"]
