FROM node:20-alpine

WORKDIR /app

# 의존성 먼저 복사 (캐시 효율화)
COPY package*.json ./
RUN npm install --production

# 소스 복사
COPY server.js ./
COPY public/ ./public/

# DB 저장용 디렉토리
VOLUME ["/app/data"]

ENV PORT=3000
ENV DB_PATH=/app/data/construction.db

EXPOSE 3000

CMD ["node", "server.js"]
