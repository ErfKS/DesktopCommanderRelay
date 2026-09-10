FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8787
CMD ["node", "dist/server/index.js"]
