FROM node:24-alpine

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server.mjs admin-system.mjs admin-db.mjs apple-account-admin.mjs apple-account-lease.mjs browser-account-sync.mjs cos-signing.mjs scheduler-policy.mjs workflow-progress.mjs ./
COPY --chown=node:node apps.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node data/account.example.json ./data/account.example.json
RUN mkdir -p /app/data/artifacts && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=8090
ENV PLATFORM_CONFIG=/app/config.json
ENV PLATFORM_DATABASE=/app/data/platform.sqlite

USER node
EXPOSE 8090
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8090)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
