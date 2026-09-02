# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine

FROM ${NODE_IMAGE} AS build-base
WORKDIR /workspace
ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --strict-peer-dependencies=false

FROM build-base AS api-build
RUN pnpm --filter @awesome-workflow/api... build

FROM build-base AS worker-build
RUN pnpm --filter @awesome-workflow/worker... build

FROM build-base AS web-shell-build
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_CONTROL_PLANE_MANIFEST_URL=/control-plane/mf-manifest.json
ARG VITE_DEMO_IFRAME_URL=
ARG VITE_TRUSTED_FEDERATION_ORIGINS=
ARG VITE_WORKSPACE_ID=
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_CONTROL_PLANE_MANIFEST_URL=${VITE_CONTROL_PLANE_MANIFEST_URL} \
    VITE_DEMO_IFRAME_URL=${VITE_DEMO_IFRAME_URL} \
    VITE_TRUSTED_FEDERATION_ORIGINS=${VITE_TRUSTED_FEDERATION_ORIGINS} \
    VITE_WORKSPACE_ID=${VITE_WORKSPACE_ID}
RUN pnpm --filter @awesome-workflow/web-shell... build

FROM build-base AS control-plane-build
ARG VITE_API_BASE_URL=/api/v1
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN pnpm --filter @awesome-workflow/control-plane... build

FROM ${NODE_IMAGE} AS api
WORKDIR /workspace
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    API_PORT=4100
COPY --from=api-build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=api-build --chown=node:node /workspace/apps/api ./apps/api
COPY --from=api-build --chown=node:node /workspace/packages ./packages
USER node
EXPOSE 4100
CMD ["node", "apps/api/dist/server.js"]

FROM ${NODE_IMAGE} AS worker
WORKDIR /workspace
ENV NODE_ENV=production
COPY --from=worker-build --chown=node:node /workspace/node_modules ./node_modules
COPY --from=worker-build --chown=node:node /workspace/apps/worker ./apps/worker
COPY --from=worker-build --chown=node:node /workspace/packages ./packages
USER node
CMD ["node", "apps/worker/dist/main.js"]

FROM ${NGINX_IMAGE} AS web-shell
COPY infra/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=web-shell-build --chown=101:101 /workspace/apps/web-shell/dist /usr/share/nginx/html
EXPOSE 8080

FROM ${NGINX_IMAGE} AS control-plane
COPY infra/docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=control-plane-build --chown=101:101 /workspace/apps/control-plane/dist /usr/share/nginx/html
EXPOSE 8080
