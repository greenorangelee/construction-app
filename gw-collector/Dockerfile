# Playwright 공식 이미지 (Chromium 포함) — package.json의 playwright 버전과 맞출 것
FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
ENV TZ=Asia/Seoul PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY index.js ./
VOLUME ["/data"]
CMD ["node", "index.js"]
