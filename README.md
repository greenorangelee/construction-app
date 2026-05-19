# 네트워크 공사 이력 관리 시스템

## 🚀 빠른 시작 (로컬)

```bash
# 1. 의존성 설치
npm install

# 2. 서버 실행
node server.js

# 3. 브라우저에서 접속
http://localhost:3000
```

---

## ☁️ 배포 방법 (3가지 옵션)

---

### 옵션 1: Railway (추천 - 무료, 가장 쉬움)

1. [railway.app](https://railway.app) 회원가입 (GitHub 로그인)
2. **New Project → Deploy from GitHub repo** 선택
3. 이 폴더를 GitHub에 push:
   ```bash
   git init
   git add .
   git commit -m "초기 배포"
   git remote add origin https://github.com/YOUR/repo.git
   git push -u origin main
   ```
4. Railway에서 해당 repo 선택 → 자동 배포
5. **Settings → Networking → Generate Domain** 클릭 → URL 생성 완료

> ✅ 무료 플랜: 월 $5 크레딧 제공 (소규모 사내 툴은 무료로 충분)

---

### 옵션 2: Render (무료 플랜 있음)

1. [render.com](https://render.com) 회원가입
2. **New → Web Service → Connect GitHub repo**
3. 설정:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment**: `Node`
4. **Create Web Service** 클릭 → 자동 배포

> ⚠️ 무료 플랜은 15분 비활성시 슬립 모드 진입 (첫 요청 시 ~30초 대기)

---

### 옵션 3: 사내 서버 직접 운영 (Node.js 설치된 Ubuntu/Linux)

```bash
# 서버에 파일 업로드 후:

# PM2로 백그라운드 실행 (서버 재시작시에도 자동 시작)
npm install -g pm2
pm2 start server.js --name "공사이력"
pm2 startup    # 부팅시 자동시작 설정
pm2 save

# 포트 변경 (예: 80포트로 변경)
PORT=80 pm2 start server.js --name "공사이력"

# nginx 리버스 프록시 사용시 (80 → 3000)
# /etc/nginx/sites-available/default 에 추가:
# location / {
#     proxy_pass http://localhost:3000;
# }
```

---

## 📁 파일 구조

```
construction-app/
├── server.js          # Express 서버 + API
├── package.json       # 의존성
├── construction.db    # SQLite DB (자동 생성)
└── public/
    └── index.html     # 프론트엔드 (SPA)
```

## 🔧 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3000` | 서버 포트 |

## 📦 사용 기술
- **Backend**: Node.js, Express
- **Database**: SQLite (sql.js - 설치 불필요)
- **Excel**: xlsx 라이브러리
- **Frontend**: Vanilla JS (프레임워크 없음)
