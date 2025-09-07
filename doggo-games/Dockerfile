# syntax=docker/dockerfile:1

FROM node:20-alpine AS build
WORKDIR /app

# A projekt a doggo-games mappában van
ARG APP_DIR=doggo-games

# Csak a csomagfájlok – gyorsabb cache
COPY ${APP_DIR}/package.json ${APP_DIR}/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm ci || npm install

# A teljes forrás
COPY ${APP_DIR}/ ./

# Build Vite-tel -> dist/
RUN npm run build

# ---- Runtime (statikus fájlok Nginx-szel) ----
FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
