# Builds the whole workspace and one example app. EXAMPLE picks which: isr-app or usecache-app.
FROM node:22-alpine AS build
ARG EXAMPLE=isr-app
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples
COPY scripts ./scripts
RUN npm ci
RUN npm run build
# next build instantiates the cache handler; point it at nothing so the image never depends on a live Redis.
RUN cd examples/${EXAMPLE} && REDIS_URL=redis://127.0.0.1:1 npx next build

FROM node:22-alpine
ARG EXAMPLE=isr-app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/examples/${EXAMPLE}
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
