# Interfacer marketplace (Medusa v2 + the Interfacer commerce module).
# Runs as a pilot: INTERFACER_DEPLOYMENT=pilot plus the variables listed in
# docs/deploy-pilot.md; it refuses to start with a missing or fixture setting.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY medusa/package.json medusa/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY medusa/ ./
# The admin UI is built only on request (operators reach it over a tunnel).
ARG MEDUSA_ADMIN=false
ENV MEDUSA_ADMIN=$MEDUSA_ADMIN MEDUSA_DISABLE_TELEMETRY=true
RUN npx medusa build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production MEDUSA_DISABLE_TELEMETRY=true
COPY --from=build /app/.medusa/server ./
COPY medusa/package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY docker/entrypoint.sh /usr/local/bin/interfacer-medusa
USER node
EXPOSE 9000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s \
  CMD node -e "fetch('http://127.0.0.1:9000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["interfacer-medusa"]
CMD ["start"]
