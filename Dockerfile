# syntax=docker/dockerfile:1

# ---- Build stage -----------------------------------------------------------
# Compiles the TypeScript + Vite production bundle.
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first to leverage Docker layer caching. The project-local
# npm cache lives in the workspace (see .npmrc) and is not writable by a normal
# user in CI, so override it with a writable dir here.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --cache /tmp/.npm-cache

# Copy the rest of the source and build the static bundle into dist/.
COPY . .
RUN npm run build

# ---- Serve stage -----------------------------------------------------------
# Serves the static bundle with nginx and supports SPA client-side routing.
FROM nginx:1.27-alpine AS serve

# SPA routing: fall back to index.html for any non-file route.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html
# Some bundle artifacts (e.g. favicon.svg) keep restrictive 600 perms from the
# build stage; make the static tree readable by nginx's worker user.
RUN chmod -R a+rX /usr/share/nginx/html

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
