FROM node:20-alpine

# PDF 변환(poppler), Python(CAD 변환용)
RUN apk add --no-cache poppler-utils python3 py3-pip py3-pillow

# ezdxf 설치 (CAD DXF 파일 처리)
RUN pip3 install ezdxf --break-system-packages

WORKDIR /app

COPY package*.json ./
RUN npm install --production --ignore-scripts

COPY server.js ./
COPY public/ ./public/

VOLUME ["/app/data"]

ENV PORT=3000
ENV DB_PATH=/app/data/construction.db

EXPOSE 3000

CMD ["node", "server.js"]
