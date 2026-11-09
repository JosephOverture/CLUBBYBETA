FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/mobile/package.json ./apps/mobile/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY scripts ./scripts
COPY tsconfig.json tsup.config.ts ./
RUN pnpm build
COPY database ./database
RUN pnpm --filter clubby-platform deploy --legacy --prod /runtime
RUN mkdir -p /runtime/certs && node --input-type=module -e "const r=await fetch('https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem');if(!r.ok)throw Error('CA download failed');const t=await r.text();if(!t.includes('BEGIN CERTIFICATE'))throw Error('Invalid CA');await (await import('node:fs/promises')).writeFile('/runtime/certs/rds-ca.pem',t)"

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /runtime ./
USER node
EXPOSE 4100 4101
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
ENTRYPOINT ["node", "scripts/container-entry.mjs"]
CMD ["api"]
