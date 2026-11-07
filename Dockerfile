FROM node:24-alpine

RUN apk add --no-cache tzdata
# TZ decides when "today" starts for purchase dates and the nightly backup; set it in .env
ENV TZ=UTC \
    NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY app/package.json app/package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY app/ ./

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/api/config > /dev/null || exit 1
CMD ["node", "server.js"]
