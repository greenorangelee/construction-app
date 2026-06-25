const express = require('express');
const initSqlJs = require('sql.js');
const snmp = require('net-snmp');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const upload = multer({ storage: multer.memoryStorage() });
const { execSync } = require('child_process');
const https = require('https');

const JWT_SECRET = process.env.JWT_SECRET || 'ksm-nw-secret-2024-xkf92mz';

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'construction.db');

const FLOOR_IMG_DIR = path.join(path.dirname(DB_PATH), 'floorplans');
const FILES_DIR = path.join(path.dirname(DB_PATH), 'construction_files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });
const NAC_HOST = process.env.NAC_HOST || 'https://172.16.1.11:8443';
const NAC_API_KEY = process.env.NAC_API_KEY || '';
if (!fs.existsSync(FLOOR_IMG_DIR)) fs.mkdirSync(FLOOR_IMG_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── 인증 미들웨어 ──────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch(e) {
    return res.status(401).json({ error: '세션이 만료됐습니다. 다시 로그인하세요' });
  }
}

function requireWrite(req, res, next) {
  if (!['write','admin'].includes(req.user?.role))
    return res.status(403).json({ error: '쓰기 권한이 없습니다' });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin')
    return res.status(403).json({ error: '관리자 권한이 필요합니다' });
  next();
}

let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'read',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  const userCount = queryOne('SELECT COUNT(*) as cnt FROM users');
  if (userCount.cnt === 0) {
    const hash = bcrypt.hashSync('zpdldptmdpa2@', 10);
    db.run("INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)",
      ['ksm00', hash, '관리자', 'admin']);
    saveDB();
  }

  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    construction_id INTEGER, action TEXT, changed_by TEXT,
    changed_at TEXT DEFAULT (datetime('now','localtime')), diff TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS networks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, color TEXT NOT NULL, shape TEXT DEFAULT 'circle',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  const netCount = queryOne('SELECT COUNT(*) as cnt FROM networks');
  if (netCount.cnt === 0) {
    db.run("INSERT INTO networks (name, color, shape) VALUES ('DA', '#FF0000', 'circle')");
    db.run("INSERT INTO networks (name, color, shape) VALUES ('VP', '#FFD700', 'circle')");
    saveDB();
  }

  db.run(`CREATE TABLE IF NOT EXISTS floorplans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_id INTEGER, region TEXT, dong TEXT, floor TEXT, filename TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS cables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    floorplan_id INTEGER, cable_no TEXT, construction_no TEXT,
    x REAL, y REAL, color TEXT DEFAULT '#e74c3c', shape TEXT DEFAULT 'circle', memo TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  try { db.run('ALTER TABLE cables ADD COLUMN x REAL'); } catch(e) {}
  try { db.run('ALTER TABLE cables ADD COLUMN y REAL'); } catch(e) {}
  try { db.run('ALTER TABLE cables ADD COLUMN shape TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE constructions ADD COLUMN group_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE construction_files ADD COLUMN group_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE cables ADD COLUMN dxf_x REAL'); } catch(e) {}
  try { db.run('ALTER TABLE cables ADD COLUMN dxf_y REAL'); } catch(e) {}
  try { db.run('ALTER TABLE floorplans ADD COLUMN dxf_minx REAL'); } catch(e) {}
  try { db.run('ALTER TABLE floorplans ADD COLUMN dxf_miny REAL'); } catch(e) {}
  try { db.run('ALTER TABLE floorplans ADD COLUMN dxf_maxx REAL'); } catch(e) {}
  try { db.run('ALTER TABLE floorplans ADD COLUMN dxf_maxy REAL'); } catch(e) {}
  try { db.run('ALTER TABLE floorplans ADD COLUMN dxf_labels TEXT'); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT NOT NULL, dong TEXT NOT NULL, floors TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  const locCount = queryOne('SELECT COUNT(*) as cnt FROM locations');
  if (locCount.cnt === 0) {
    const defaultLocs = [
      ['대곶', 'HO동', JSON.stringify(['1F','2F','3F','4F'])],
      ['대곶', 'B1동', JSON.stringify(['1F','2F'])],
      ['대곶', 'S1동', JSON.stringify(['1F','2F','3F'])],
      ['대곶', 'R&D1동', JSON.stringify(['1F','2F','3F','4F'])],
      ['하성', 'A1동', JSON.stringify(['1F','2F','3F'])],
      ['대포', '본관', JSON.stringify(['1F','2F','3F'])],
    ];
    for (const [region, dong, floors] of defaultLocs) {
      db.run('INSERT INTO locations (region, dong, floors) VALUES (?,?,?)', [region, dong, floors]);
    }
    saveDB();
  }

  db.run(`CREATE TABLE IF NOT EXISTS ip_subnets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,          -- 예) 사무망, 생산망
    network TEXT NOT NULL,       -- 예) 10.100.100.0
    prefix INTEGER NOT NULL,     -- 예) 24
    gateway TEXT,
    dns TEXT,
    vlan TEXT,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ip_assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subnet_id INTEGER,
    ip TEXT NOT NULL UNIQUE,
    mac TEXT,
    hostname TEXT,
    user_name TEXT,
    dept TEXT,
    device_type TEXT,    -- PC, 서버, 프린터, AP, 기타
    os TEXT,
    status TEXT DEFAULT 'unused',  -- used, unused, reserved
    nac_status TEXT,     -- NAC에서 가져온 상태
    last_seen TEXT,      -- NAC 마지막 접속
    location TEXT,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  try { db.run('ALTER TABLE ip_assets ADD COLUMN nac_status TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE ip_assets ADD COLUMN last_seen TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE ip_assets ADD COLUMN tag_id INTEGER'); } catch(e) {}

  db.run(`CREATE TABLE IF NOT EXISTS ip_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subnet_id INTEGER,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#3b82f6',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ip_tag_ranges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL,
    subnet_id INTEGER NOT NULL,
    ip_start TEXT NOT NULL,   -- 시작 IP
    ip_end TEXT NOT NULL,     -- 끝 IP
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS constructions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, no INTEGER, gubun TEXT, req_date TEXT,
    corp TEXT, dept TEXT, requester TEXT, work_name TEXT,
    loc_region TEXT, loc_dong TEXT, loc_floor TEXT, loc_detail TEXT,
    move_region TEXT, move_dong TEXT, move_floor TEXT, move_detail TEXT,
    demolish_region TEXT, demolish_dong TEXT, demolish_floor TEXT, demolish_detail TEXT,
    status TEXT, deadline TEXT, complete_date TEXT,
    purchase_doc TEXT, payment_doc TEXT, related_doc TEXT,
    it_manager TEXT, worker TEXT, memo TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS construction_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    construction_id INTEGER NOT NULL,
    file_type TEXT NOT NULL,   -- 'estimate'(견적서), 'transaction'(거래명세서), 'layout'(레이아웃), 'other'(기타)
    original_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS net_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    snmp_community TEXT NOT NULL DEFAULT 'public',
    snmp_port INTEGER NOT NULL DEFAULT 161,
    location TEXT DEFAULT '',
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  saveDB();
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

const FIELD_LABELS = {
  'gubun':'구분','req_date':'요청일','corp':'법인','dept':'부서','requester':'요청자','work_name':'공사명',
  'loc_region':'작업지역','loc_dong':'작업동','loc_floor':'작업층','loc_detail':'작업 상세위치',
  'move_region':'공사위치지역','move_dong':'공사위치동','move_floor':'공사위치층','move_detail':'공사위치 상세',
  'demolish_region':'철거지역','demolish_dong':'철거동','demolish_floor':'철거층','demolish_detail':'철거 상세',
  'status':'상태','deadline':'기한일','complete_date':'완료일',
  'purchase_doc':'구매품의서','payment_doc':'지출품의서','related_doc':'연관품의서',
  'it_manager':'IT담당자','worker':'작업자','memo':'메모'
};

function recordHistory(constructionId, action, changedBy, diff) {
  db.run(`INSERT INTO history (construction_id, action, changed_by, diff) VALUES (?,?,?,?)`,
    [constructionId, action, changedBy || '시스템', JSON.stringify(diff)]);
}

function diffRecords(before, after) {
  const changes = [];
  for (const k of Object.keys(FIELD_LABELS)) {
    const bv = (before[k] ?? '').toString().trim();
    const av = (after[k] ?? '').toString().trim();
    if (bv !== av) changes.push({ field: k, label: FIELD_LABELS[k], before: bv, after: av });
  }
  return changes;
}

function s(v) { return (v === undefined || v === null) ? '' : String(v).trim(); }

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) { return queryAll(sql, params)[0] || null; }

// IP 범위 유틸
function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
}

function isIpInRange(ip, start, end) {
  const i = ipToInt(ip), s = ipToInt(start), e = ipToInt(end);
  return i >= s && i <= e;
}



// DXF 좌표 기반 핀 재매핑
function remapCablesToNewDxf(floorplanId, oldFp, newCoords) {
  const cables = queryAll('SELECT * FROM cables WHERE floorplan_id=?', [floorplanId]);
  if (!cables.length) return;

  const oldW = (oldFp.dxf_maxx || 1) - (oldFp.dxf_minx || 0);
  const oldH = (oldFp.dxf_maxy || 1) - (oldFp.dxf_miny || 0);
  const newW = newCoords.maxx - newCoords.minx;
  const newH = newCoords.maxy - newCoords.miny;

  let remapped = 0;
  for (const cable of cables) {
    if (cable.dxf_x !== null && cable.dxf_x !== undefined) {
      // DXF 실제 좌표로 새 도면에서 비율 재계산
      const newX = (cable.dxf_x - newCoords.minx) / newW;
      const newY = 1 - ((cable.dxf_y - newCoords.miny) / newH); // Y축 반전
      db.run('UPDATE cables SET x=?, y=? WHERE id=?', [newX, newY, cable.id]);
      remapped++;
    }
  }
  console.log(`핀 재매핑 완료: ${remapped}/${cables.length}개`);
}



// ── 공사 이력 API ──────────────────────────────────────────

app.get('/api/constructions', authMiddleware, (req, res) => {
  const { search, gubun, status, corp } = req.query;
  let sql = 'SELECT * FROM constructions WHERE 1=1';
  const params = [];
  if (search) {
    const keywords = search.trim().split(/\s+/).filter(Boolean);
    for (const kw of keywords) {
      sql += ' AND (work_name LIKE ? OR requester LIKE ? OR dept LIKE ? OR loc_region LIKE ? OR loc_dong LIKE ? OR loc_floor LIKE ? OR loc_detail LIKE ? OR worker LIKE ? OR it_manager LIKE ? OR TRIM(purchase_doc) LIKE ? OR TRIM(payment_doc) LIKE ? OR TRIM(related_doc) LIKE ?)';
      params.push(`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`);
    }
  }
  if (gubun && gubun !== '전체') { sql += ' AND gubun = ?'; params.push(gubun); }
  if (status && status !== '전체') { sql += ' AND status = ?'; params.push(status); }
  if (corp && corp !== '전체') { sql += ' AND corp = ?'; params.push(corp); }
  sql += ' ORDER BY id DESC';
  const raw = queryAll(sql, params);
  // group_id별로 자동 색상 부여 (이름/색 설정 없이)
  const GROUP_COLORS = ['#6366f1','#10b981','#f59e0b','#ec4899','#06b6d4','#84cc16','#f97316','#8b5cf6'];
  const gids = [...new Set(raw.filter(r => r.group_id).map(r => r.group_id))];
  const gColorMap = {};
  gids.forEach((gid, i) => { gColorMap[gid] = GROUP_COLORS[i % GROUP_COLORS.length]; });
  res.json(raw.map(r => ({
    ...r,
    group_color: r.group_id ? gColorMap[r.group_id] : null
  })));
});

// ── 인증 API ──────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요' });
  const user = queryOne('SELECT * FROM users WHERE username=?', [username]);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다' });
  const token = jwt.sign({ id: user.id, username: user.username, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// ── 사용자 관리 API (관리자 전용) ──────────────────────────────────────────
app.get('/api/users', authMiddleware, requireAdmin, (req, res) => {
  const users = queryAll('SELECT id, username, name, role, created_at, updated_at FROM users ORDER BY id');
  res.json(users);
});

app.post('/api/users', authMiddleware, requireAdmin, (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name || !role) return res.status(400).json({ error: '모든 필드를 입력하세요' });
  if (!['read','write','admin'].includes(role)) return res.status(400).json({ error: '올바른 권한을 선택하세요' });
  const exists = queryOne('SELECT id FROM users WHERE username=?', [username]);
  if (exists) return res.status(409).json({ error: '이미 존재하는 아이디입니다' });
  const hash = bcrypt.hashSync(password, 10);
  db.run('INSERT INTO users (username, password, name, role) VALUES (?,?,?,?)', [username, hash, name, role]);
  const newUser = queryOne('SELECT id, username, name, role, created_at FROM users WHERE username=?', [username]);
  saveDB();
  res.json(newUser);
});

app.put('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  const { name, role, password } = req.body;
  if (!name || !role) return res.status(400).json({ error: '이름과 권한은 필수입니다' });
  if (!['read','write','admin'].includes(role)) return res.status(400).json({ error: '올바른 권한을 선택하세요' });
  // 마지막 관리자 보호
  if (role !== 'admin') {
    const adminCount = queryOne("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND id!=?", [req.params.id]);
    if (adminCount.cnt === 0) return res.status(400).json({ error: '관리자 계정이 최소 1개는 있어야 합니다' });
  }
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.run("UPDATE users SET name=?, role=?, password=?, updated_at=datetime('now','localtime') WHERE id=?", [name, role, hash, req.params.id]);
  } else {
    db.run("UPDATE users SET name=?, role=?, updated_at=datetime('now','localtime') WHERE id=?", [name, role, req.params.id]);
  }
  saveDB();
  res.json({ success: true });
});

app.delete('/api/users/:id', authMiddleware, requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: '자신의 계정은 삭제할 수 없습니다' });
  const adminCount = queryOne("SELECT COUNT(*) as cnt FROM users WHERE role='admin' AND id!=?", [req.params.id]);
  if (adminCount.cnt === 0) return res.status(400).json({ error: '관리자 계정이 최소 1개는 있어야 합니다' });
  db.run('DELETE FROM users WHERE id=?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});


app.get('/api/stats', authMiddleware, (req, res) => {
  const g = q => queryOne(`SELECT COUNT(*) as cnt FROM constructions WHERE ${q}`).cnt;
  res.json({
    total: g('1=1'), done: g("status='완료'"), inprogress: g("status='진행중'"), holding: g("status='Holding'"),
    self: g("gubun='자체공사'"), outsource: g("gubun='외주공사'"), payment: g("gubun='지급'"), purchase: g("gubun='구매'"), temp: g("gubun='임시포설'"), received: g("gubun='접수'"),
    corp_ksm: g("corp='KSM'"), corp_fksm: g("corp='FKSM'"), corp_ksmc: g("corp='KSMC'"),
    corp_yhe: g("corp='YHE'"), corp_ksmf: g("corp='KSMF'")
  });
});

app.get('/api/constructions/:id', authMiddleware, (req, res) => {
  const row = queryOne('SELECT * FROM constructions WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/constructions', authMiddleware, requireWrite, (req, res) => {
  try {
    const d = req.body;
    const lastNo = (queryOne('SELECT MAX(no) as m FROM constructions').m || 0);
    db.run(`INSERT INTO constructions (no,gubun,req_date,corp,dept,requester,work_name,loc_region,loc_dong,loc_floor,loc_detail,move_region,move_dong,move_floor,move_detail,demolish_region,demolish_dong,demolish_floor,demolish_detail,status,deadline,complete_date,purchase_doc,payment_doc,related_doc,it_manager,worker,memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lastNo+1,s(d.gubun),s(d.req_date),s(d.corp),s(d.dept),s(d.requester),s(d.work_name),
       s(d.loc_region),s(d.loc_dong),s(d.loc_floor),s(d.loc_detail),
       s(d.move_region),s(d.move_dong),s(d.move_floor),s(d.move_detail),
       s(d.demolish_region),s(d.demolish_dong),s(d.demolish_floor),s(d.demolish_detail),
       s(d.status),s(d.deadline),s(d.complete_date),
       s(d.purchase_doc),s(d.payment_doc),s(d.related_doc),s(d.it_manager),s(d.worker),s(d.memo)]);
    saveDB();
    const newId = queryOne('SELECT last_insert_rowid() as id').id;
    recordHistory(newId, 'create', d.changed_by, [{ field: 'work_name', label: '공사명', before: '', after: d.work_name }]);
    saveDB();
    res.json({ id: newId, no: lastNo+1 });
  } catch(e) { console.error('POST error:', e); res.status(500).json({ error: e.message }); }
});

app.put('/api/constructions/:id', authMiddleware, requireWrite, (req, res) => {
  try {
    const d = req.body;
    const before = queryOne('SELECT * FROM constructions WHERE id = ?', [req.params.id]);
    const gid = d.group_id ? parseInt(d.group_id) : null;
    db.run(`UPDATE constructions SET gubun=?,req_date=?,corp=?,dept=?,requester=?,work_name=?,loc_region=?,loc_dong=?,loc_floor=?,loc_detail=?,move_region=?,move_dong=?,move_floor=?,move_detail=?,demolish_region=?,demolish_dong=?,demolish_floor=?,demolish_detail=?,status=?,deadline=?,complete_date=?,purchase_doc=?,payment_doc=?,related_doc=?,it_manager=?,worker=?,memo=?,group_id=? WHERE id=?`,
      [s(d.gubun),s(d.req_date),s(d.corp),s(d.dept),s(d.requester),s(d.work_name),
       s(d.loc_region),s(d.loc_dong),s(d.loc_floor),s(d.loc_detail),
       s(d.move_region),s(d.move_dong),s(d.move_floor),s(d.move_detail),
       s(d.demolish_region),s(d.demolish_dong),s(d.demolish_floor),s(d.demolish_detail),
       s(d.status),s(d.deadline),s(d.complete_date),
       s(d.purchase_doc),s(d.payment_doc),s(d.related_doc),s(d.it_manager),s(d.worker),s(d.memo),gid,req.params.id]);
    const diff = diffRecords(before, d);
    if (diff.length > 0) recordHistory(req.params.id, 'update', d.changed_by, diff);
    saveDB();
    res.json({ success: true });
  } catch(e) { console.error('PUT error:', e); res.status(500).json({ error: e.message }); }
});

app.delete('/api/constructions/:id', authMiddleware, requireWrite, (req, res) => {
  const row = queryOne('SELECT * FROM constructions WHERE id = ?', [req.params.id]);
  if (row) {
    const groupId = row.group_id;
    recordHistory(req.params.id, 'delete', null, [{ field: 'work_name', label: '공사명', before: row.work_name, after: '' }]);
    db.run('DELETE FROM constructions WHERE id = ?', [req.params.id]);
    // 삭제 후 같은 그룹에 1개만 남으면 자동 해제
    if (groupId) {
      const cnt = queryOne('SELECT COUNT(*) as cnt FROM constructions WHERE group_id=?', [groupId]);
      if (cnt && cnt.cnt === 1) {
        db.run('UPDATE constructions SET group_id=NULL WHERE group_id=?', [groupId]);
      }
    }
  }
  saveDB();
  res.json({ success: true });
});

app.get('/api/history/:id', authMiddleware, (req, res) => {
  const rows = queryAll('SELECT * FROM history WHERE construction_id = ? ORDER BY id DESC', [req.params.id]);
  res.json(rows.map(r => ({ ...r, diff: JSON.parse(r.diff || '[]') })));
});


// ── NAC API 헬퍼 ──────────────────────────────────────────

function nacFetch(path) {
  return new Promise((resolve, reject) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${NAC_HOST}${path}${sep}apiKey=${NAC_API_KEY}`;
    const agent = new https.Agent({ rejectUnauthorized: false });
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 8443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'Content-Type': 'application/json'
      },
      agent
    };
    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        console.log('[NAC] status:', res.statusCode, 'path:', path.split('?')[0]);
        console.log('[NAC] response preview:', raw.slice(0, 200));
        // XML 응답이면 에러 처리
        if (raw.trim().startsWith('<')) {
          reject(new Error('NAC가 XML을 반환했습니다. API 경로나 인증을 확인하세요. 응답: ' + raw.slice(0, 150)));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('JSON 파싱 실패: ' + raw.slice(0, 150))); }
      });
    });
    req.on('error', e => reject(new Error('NAC 연결 오류: ' + e.message)));
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('NAC 응답 시간 초과 (8초)')); });
    req.end();
  });
}

// NAC API 경로 테스트 (여러 경로 시도)
async function nacFetchAuto(endpoint) {
  const paths = [
    `/mc2/rest/${endpoint}`,
    `/rest/${endpoint}`,
    `/api/rest/${endpoint}`,
  ];
  for (const p of paths) {
    try {
      const result = await nacFetch(p);
      console.log('[NAC] 성공한 경로:', p);
      return result;
    } catch(e) {
      console.log('[NAC] 실패:', p, e.message.slice(0, 80));
    }
  }
  throw new Error('모든 NAC API 경로 실패');
}

// ── IP 대장 API ──────────────────────────────────────────

// 서브넷 목록
app.get('/api/ip/subnets', authMiddleware, (req, res) => {
  const subnets = queryAll('SELECT * FROM ip_subnets ORDER BY network');
  res.json(subnets.map(s => ({
    ...s,
    total: Math.pow(2, 32 - s.prefix) - 2,
    used: queryOne('SELECT COUNT(*) as cnt FROM ip_assets WHERE subnet_id=? AND status="used"', [s.id]).cnt,
    unused: queryOne('SELECT COUNT(*) as cnt FROM ip_assets WHERE subnet_id=? AND status="unused"', [s.id]).cnt,
    reserved: queryOne('SELECT COUNT(*) as cnt FROM ip_assets WHERE subnet_id=? AND status="reserved"', [s.id]).cnt,
  })));
});

app.post('/api/ip/subnets', authMiddleware, requireWrite, (req, res) => {
  const { name, network, prefix, gateway, dns, vlan, description } = req.body;
  if (!name || !network || !prefix) return res.status(400).json({ error: '필수값 누락' });
  db.run('INSERT INTO ip_subnets (name,network,prefix,gateway,dns,vlan,description) VALUES (?,?,?,?,?,?,?)',
    [name, network, parseInt(prefix), gateway||'', dns||'', vlan||'', description||'']);
  saveDB();
  res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
});

app.put('/api/ip/subnets/:id', authMiddleware, requireWrite, (req, res) => {
  const { name, network, prefix, gateway, dns, vlan, description } = req.body;
  db.run('UPDATE ip_subnets SET name=?,network=?,prefix=?,gateway=?,dns=?,vlan=?,description=? WHERE id=?',
    [name, network, parseInt(prefix), gateway||'', dns||'', vlan||'', description||'', req.params.id]);
  saveDB(); res.json({ success: true });
});

app.delete('/api/ip/subnets/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('DELETE FROM ip_subnets WHERE id=?', [req.params.id]);
  db.run('DELETE FROM ip_assets WHERE subnet_id=?', [req.params.id]);
  saveDB(); res.json({ success: true });
});

// IP 목록
app.get('/api/ip/assets', authMiddleware, (req, res) => {
  const { subnet_id, status, search } = req.query;
  let sql = 'SELECT a.*, t.name as tag_name, t.color as tag_color FROM ip_assets a LEFT JOIN ip_tags t ON a.tag_id=t.id WHERE 1=1';
  const params = [];
  if (subnet_id) { sql += ' AND subnet_id=?'; params.push(subnet_id); }
  if (status && status !== '전체') { sql += ' AND status=?'; params.push(status); }
  if (search) { sql += ' AND (ip LIKE ? OR hostname LIKE ? OR user_name LIKE ? OR dept LIKE ? OR mac LIKE ?)'; const kw = `%${search}%`; params.push(kw,kw,kw,kw,kw); }
  const ipToInt = ip => { const p=(ip||'').split('.').map(Number); return ((p[0]||0)<<24)|((p[1]||0)<<16)|((p[2]||0)<<8)|(p[3]||0); };
  const rows = queryAll(sql, params);
  rows.sort((a,b) => ipToInt(a.ip) - ipToInt(b.ip));
  res.json(rows);
});

// IP 개별 등록/수정/삭제
app.post('/api/ip/assets', authMiddleware, requireWrite, (req, res) => {
  const { subnet_id, ip, mac, hostname, user_name, dept, device_type, os, status, location, description } = req.body;
  const tag_id = req.body.tag_id || null;
  if (!ip) return res.status(400).json({ error: 'IP 필수' });
  try {
    db.run('INSERT INTO ip_assets (subnet_id,ip,mac,hostname,user_name,dept,device_type,os,status,tag_id,location,description) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [subnet_id||null, s(ip), s(mac), s(hostname), s(user_name), s(dept), s(device_type)||'PC', s(os), status||'used', tag_id, s(location), s(description)]);
    saveDB();
    res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
  } catch(e) { res.status(400).json({ error: 'IP 중복 또는 오류: ' + e.message }); }
});

app.put('/api/ip/assets/:id', authMiddleware, requireWrite, (req, res) => {
  const { mac, hostname, user_name, dept, device_type, os, status, tag_id, location, description } = req.body;
  db.run('UPDATE ip_assets SET mac=?,hostname=?,user_name=?,dept=?,device_type=?,os=?,status=?,tag_id=?,location=?,description=?,updated_at=datetime("now","localtime") WHERE id=?',
    [s(mac),s(hostname),s(user_name),s(dept),s(device_type),s(os),status||'used',tag_id||null,s(location),s(description),req.params.id]);
  saveDB(); res.json({ success: true });
});

app.delete('/api/ip/assets/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('DELETE FROM ip_assets WHERE id=?', [req.params.id]);
  saveDB(); res.json({ success: true });
});

// 서브넷 전체 IP 자동 생성
app.post('/api/ip/subnets/:id/generate', authMiddleware, requireWrite, (req, res) => {
  const subnet = queryOne('SELECT * FROM ip_subnets WHERE id=?', [req.params.id]);
  if (!subnet) return res.status(404).json({ error: '서브넷 없음' });
  const parts = subnet.network.split('.').map(Number);
  const total = Math.pow(2, 32 - subnet.prefix) - 2;
  let added = 0;
  for (let i = 1; i <= total; i++) {
    const ip = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3] + i}`;
    try {
      db.run('INSERT OR IGNORE INTO ip_assets (subnet_id,ip,status) VALUES (?,?,?)', [subnet.id, ip, 'unused']);
      added++;
    } catch(e) {}
  }
  saveDB();
  res.json({ success: true, added });
});


// NAC API 디버그 - 실제 응답 확인용
app.get('/api/nac/debug', authMiddleware, async (req, res) => {
  const results = {};
  const testPaths = [
    '/mc2/rest/nodes?page=1&pageSize=1&view=node',
    '/mc2/rest/tags?page=1&pageSize=1',
    '/mc2/rest/users?page=1&pageSize=1',
  ];
  for (const p of testPaths) {
    try {
      const data = await nacFetch(p);
      results[p] = { ok: true, sample: JSON.stringify(data).slice(0, 200) };
    } catch(e) {
      results[p] = { ok: false, error: e.message.slice(0, 200) };
    }
  }
  res.json({ nacHost: NAC_HOST, results });
});

// NAC 단말 조회 (IP로 검색)
app.get('/api/nac/node', authMiddleware, async (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.status(400).json({ error: 'IP 필수' });
  if (!NAC_API_KEY) return res.status(503).json({ error: 'NAC API Key 미설정' });
  try {
    const data = await nacFetch(`/mc2/rest/nodes?page=1&pageSize=10&view=node&ip=${ip}`);
    res.json(data);
  } catch(e) {
    res.status(503).json({ error: 'NAC 연결 실패: ' + e.message });
  }
});

// NAC 전체 단말 목록 (페이지)
app.get('/api/nac/nodes', authMiddleware, async (req, res) => {
  const { page = 1, pageSize = 100 } = req.query;
  if (!NAC_API_KEY) return res.status(503).json({ error: 'NAC API Key 미설정' });
  try {
    const data = await nacFetch(`/mc2/rest/nodes?page=${page}&pageSize=${pageSize}&view=node`);
    res.json(data);
  } catch(e) {
    res.status(503).json({ error: 'NAC 연결 실패: ' + e.message });
  }
});

// NAC 동기화 - NAC에서 단말 정보 가져와서 IP 대장 업데이트
app.post('/api/nac/sync', authMiddleware, requireWrite, async (req, res) => {
  if (!NAC_API_KEY) return res.status(503).json({ error: 'NAC API Key 미설정' });
  try {
    // 등록된 서브넷 목록
    const subnets = queryAll('SELECT * FROM ip_subnets');
    if (!subnets.length) return res.status(400).json({ error: '먼저 서브넷을 등록해주세요' });

    // IP가 등록된 서브넷 대역에 속하는지 확인
    function findSubnet(ip) {
      if (!ip) return null;
      const ipParts = ip.split('.').map(Number);
      if (ipParts.length !== 4) return null;
      const ipInt = ((ipParts[0]<<24)|(ipParts[1]<<16)|(ipParts[2]<<8)|ipParts[3]) >>> 0;
      for (const sn of subnets) {
        const snParts = sn.network.split('.').map(Number);
        const snInt = ((snParts[0]<<24)|(snParts[1]<<16)|(snParts[2]<<8)|snParts[3]) >>> 0;
        const mask = (0xFFFFFFFF << (32 - sn.prefix)) >>> 0;
        if ((ipInt & mask) === (snInt & mask)) return sn.id;
      }
      return null;
    }

    let page = 1, total = 0, synced = 0, skipped = 0;
    while (true) {
      const data = await nacFetch(`/mc2/rest/nodes?page=${page}&pageSize=100&view=node`);
      const nodes = Array.isArray(data) ? data : (data.result || []);
      if (!nodes.length) break;

    for (const node of nodes) {
        const ip = node.NL_IPSTR;
        const mac = node.NL_MAC || '';
        const hostname = node.NL_FQDN || '';
        const user_name = node.NL_AUTHUSERNAME || node.DL_AUTHUSERNAME || '';
        const dept = node.NL_AUTHUSERDEPTNAME || node.DL_AUTHUSERDEPTNAME || '';
        const os = node.NL_OSNAME || '';
        const nacStatus = node.NL_ACTIVE === 1 ? 'UP' : node.NL_ACTIVE === 0 ? 'DOWN' : '';
        const lastSeen = node.NL_LASTACTIVE ? new Date(node.NL_LASTACTIVE).toISOString().slice(0,19).replace('T',' ') : '';

        // 등록된 서브넷 대역에 속하지 않으면 skip
        const matched_subnet_id = findSubnet(ip);
        if (!matched_subnet_id) { skipped++; continue; }
        if (!ip) continue;
        const existing = queryOne('SELECT id FROM ip_assets WHERE ip=?', [ip]);
        if (existing) {
          db.run('UPDATE ip_assets SET subnet_id=COALESCE(subnet_id,?),mac=?,hostname=?,user_name=?,dept=?,os=?,nac_status=?,last_seen=?,status="used",updated_at=datetime("now","localtime") WHERE ip=?',
            [matched_subnet_id, mac, hostname, user_name, dept, os, nacStatus, lastSeen, ip]);
        } else {
          db.run('INSERT OR IGNORE INTO ip_assets (subnet_id,ip,mac,hostname,user_name,dept,os,nac_status,last_seen,status) VALUES (?,?,?,?,?,?,?,?,?,"used")',
            [matched_subnet_id, ip, mac, hostname, user_name, dept, os, nacStatus, lastSeen]);
        }
        synced++;
      }
      total += nodes.length;
      if (nodes.length < 100) break;
      page++;
    }
    saveDB();
    res.json({ success: true, total, synced, skipped });
  } catch(e) {
    res.status(503).json({ error: 'NAC 동기화 실패: ' + e.message });
  }
});

// 빈 IP 추천
app.get('/api/ip/available', authMiddleware, (req, res) => {
  const { subnet_id, count = 5 } = req.query;
  let sql = 'SELECT ip FROM ip_assets WHERE status="unused"';
  const params = [];
  if (subnet_id) { sql += ' AND subnet_id=?'; params.push(subnet_id); }
  sql += " ORDER BY CAST(SUBSTR(ip,1,INSTR(ip,'.')-1) AS INT), CAST(SUBSTR(ip,INSTR(ip,'.')+1,INSTR(ip,'.',INSTR(ip,'.')+1)-INSTR(ip,'.')-1) AS INT), CAST(SUBSTR(ip,INSTR(ip,'.',INSTR(ip,'.')+1)+1,INSTR(ip,'.',INSTR(ip,'.',INSTR(ip,'.')+1)+1)-INSTR(ip,'.',INSTR(ip,'.')+1)-1) AS INT), CAST(SUBSTR(ip,INSTR(ip,'.',INSTR(ip,'.',INSTR(ip,'.')+1)+1)+1) AS INT) LIMIT ?";
  params.push(parseInt(count));
  res.json(queryAll(sql, params).map(r => r.ip));
});


// IP 태그 관리
app.get('/api/ip/tags', authMiddleware, (req, res) => {
  const { subnet_id } = req.query;
  let sql = 'SELECT * FROM ip_tags';
  const params = [];
  if (subnet_id) { sql += ' WHERE subnet_id=?'; params.push(subnet_id); }
  res.json(queryAll(sql + ' ORDER BY id', params));
});

app.post('/api/ip/tags', authMiddleware, requireWrite, (req, res) => {
  const { subnet_id, name, color } = req.body;
  if (!name) return res.status(400).json({ error: '이름 필수' });
  db.run('INSERT INTO ip_tags (subnet_id,name,color) VALUES (?,?,?)', [subnet_id||null, name, color||'#3b82f6']);
  saveDB();
  res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
});

app.put('/api/ip/tags/:id', authMiddleware, requireWrite, (req, res) => {
  const { name, color } = req.body;
  db.run('UPDATE ip_tags SET name=?,color=? WHERE id=?', [name, color, req.params.id]);
  saveDB(); res.json({ success: true });
});

app.delete('/api/ip/tags/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('UPDATE ip_assets SET tag_id=NULL WHERE tag_id=?', [req.params.id]);
  db.run('DELETE FROM ip_tags WHERE id=?', [req.params.id]);
  saveDB(); res.json({ success: true });
});

// IP에 태그 지정
app.put('/api/ip/assets/:id/tag', authMiddleware, requireWrite, (req, res) => {
  const { tag_id } = req.body;
  db.run('UPDATE ip_assets SET tag_id=? WHERE id=?', [tag_id||null, req.params.id]);
  saveDB(); res.json({ success: true });
});


// IP 태그 범위 관리
app.get('/api/ip/tag-ranges', authMiddleware, (req, res) => {
  const { subnet_id } = req.query;
  res.json(queryAll(
    `SELECT r.*, t.name as tag_name, t.color as tag_color
     FROM ip_tag_ranges r JOIN ip_tags t ON r.tag_id=t.id
     WHERE r.subnet_id=? ORDER BY r.ip_start`,
    [subnet_id]
  ));
});

app.post('/api/ip/tag-ranges', authMiddleware, requireWrite, (req, res) => {
  const { tag_id, subnet_id, ip_start, ip_end } = req.body;
  if (!tag_id || !ip_start || !ip_end) return res.status(400).json({ error: '필수값 누락' });
  db.run('INSERT INTO ip_tag_ranges (tag_id,subnet_id,ip_start,ip_end) VALUES (?,?,?,?)',
    [tag_id, subnet_id, ip_start, ip_end]);
  saveDB();
  res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
});

app.delete('/api/ip/tag-ranges/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('DELETE FROM ip_tag_ranges WHERE id=?', [req.params.id]);
  saveDB(); res.json({ success: true });
});

// IP 자산 조회 시 범위 태그 자동 반영
app.get('/api/ip/assets-with-tags', authMiddleware, async (req, res) => {
  const { subnet_id, status, search } = req.query;
  let sql = `SELECT a.id, a.subnet_id, a.ip, a.mac, a.hostname, a.user_name, a.dept, a.device_type, a.os, a.status, a.tag_id, a.nac_status, a.last_seen, a.location, a.description, a.created_at, a.updated_at, t.name as tag_name, t.color as tag_color
    FROM ip_assets a LEFT JOIN ip_tags t ON a.tag_id=t.id WHERE 1=1`;
  const params = [];
  if (subnet_id) { sql += ' AND a.subnet_id=?'; params.push(subnet_id); }
  if (status && status !== '전체') { sql += ' AND a.status=?'; params.push(status); }
  if (search) { sql += ' AND (a.ip LIKE ? OR a.hostname LIKE ? OR a.user_name LIKE ? OR a.dept LIKE ? OR a.mac LIKE ?)'; const kw='%'+search+'%'; params.push(kw,kw,kw,kw,kw); }
  const ipToIntA = ip => { const p=(ip||'').split('.').map(Number); return ((p[0]||0)<<24)|((p[1]||0)<<16)|((p[2]||0)<<8)|(p[3]||0); };
  let assets = queryAll(sql, params);
  assets.sort((a,b) => ipToIntA(a.ip) - ipToIntA(b.ip));

  // 범위 태그 적용 (개별 tag_id 없는 IP에 범위 태그 적용)
  const ranges = queryAll('SELECT r.*,t.name as tag_name,t.color as tag_color FROM ip_tag_ranges r JOIN ip_tags t ON r.tag_id=t.id WHERE r.subnet_id=?', [subnet_id]);
  assets = assets.map(a => {
    if (a.tag_id) return a; // 개별 태그 우선
    const matched = ranges.find(r => isIpInRange(a.ip, r.ip_start, r.ip_end));
    if (matched) return { ...a, tag_name: matched.tag_name, tag_color: matched.tag_color, range_tag: true };
    return a;
  });
  res.json(assets);
});


// subnet_id null인 IP 자산을 서브넷 대역 기준으로 재매핑
app.post('/api/ip/remap-subnets', authMiddleware, requireWrite, (req, res) => {
  const subnets = queryAll('SELECT * FROM ip_subnets');
  const assets = queryAll('SELECT id, ip FROM ip_assets WHERE subnet_id IS NULL');
  let updated = 0;
  for (const asset of assets) {
    const ipParts = (asset.ip||'').split('.').map(Number);
    if (ipParts.length !== 4) continue;
    const ipInt = ((ipParts[0]<<24)|(ipParts[1]<<16)|(ipParts[2]<<8)|ipParts[3]) >>> 0;
    for (const sn of subnets) {
      const snParts = sn.network.split('.').map(Number);
      const snInt = ((snParts[0]<<24)|(snParts[1]<<16)|(snParts[2]<<8)|snParts[3]) >>> 0;
      const mask = (0xFFFFFFFF << (32 - sn.prefix)) >>> 0;
      if ((ipInt & mask) === (snInt & mask)) {
        db.run('UPDATE ip_assets SET subnet_id=? WHERE id=?', [sn.id, asset.id]);
        updated++;
        break;
      }
    }
  }
  saveDB();
  res.json({ success: true, updated });
});


// 서브넷에 속하지 않는 IP 자산 삭제
app.delete('/api/ip/cleanup-unmatched', authMiddleware, requireWrite, (req, res) => {
  const subnets = queryAll('SELECT * FROM ip_subnets');
  const assets = queryAll('SELECT id, ip FROM ip_assets WHERE subnet_id IS NULL');
  let deleted = 0;
  for (const asset of assets) {
    db.run('DELETE FROM ip_assets WHERE id=?', [asset.id]);
    deleted++;
  }
  saveDB();
  res.json({ success: true, deleted });
});




// ── 공사 그룹 묶기 API ──────────────────────────────────────────

// 새 group_id 발급 (MAX+1)
app.post('/api/groups/new', authMiddleware, requireWrite, (req, res) => {
  const row = queryOne('SELECT MAX(group_id) as m FROM constructions');
  const newGid = (row.m || 0) + 1;
  res.json({ group_id: newGid });
});

// 공사에 group_id 지정
app.put('/api/constructions/:id/group', authMiddleware, requireWrite, (req, res) => {
  const { group_id } = req.body;
  const oldRow = queryOne('SELECT group_id FROM constructions WHERE id=?', [req.params.id]);
  const oldGid = oldRow?.group_id;

  db.run('UPDATE constructions SET group_id=? WHERE id=?', [group_id || null, req.params.id]);

  // 이전 그룹에서 빠졌을 때 남은 멤버가 1명이면 자동 해제
  if (oldGid && oldGid !== group_id) {
    const cnt = queryOne('SELECT COUNT(*) as cnt FROM constructions WHERE group_id=?', [oldGid]);
    if (cnt && cnt.cnt === 1) {
      db.run('UPDATE constructions SET group_id=NULL WHERE group_id=?', [oldGid]);
    }
  }

  saveDB();
  res.json({ success: true });
});

// 현재 존재하는 그룹 목록 (공사 선택용)
app.get('/api/groups/list', authMiddleware, (req, res) => {
  const rows = queryAll('SELECT DISTINCT group_id FROM constructions WHERE group_id IS NOT NULL ORDER BY group_id');
  const GROUP_COLORS = ['#6366f1','#10b981','#f59e0b','#ec4899','#06b6d4','#84cc16','#f97316','#8b5cf6'];
  res.json(rows.map((r, i) => ({
    group_id: r.group_id,
    color: GROUP_COLORS[i % GROUP_COLORS.length],
    members: queryAll('SELECT id, work_name FROM constructions WHERE group_id=?', [r.group_id])
  })));
});

// ── 공사 파일 첨부 API ──────────────────────────────────────────

app.get('/api/constructions/:id/files', authMiddleware, (req, res) => {
  const constr = queryOne('SELECT group_id FROM constructions WHERE id=?', [req.params.id]);
  const gid = constr?.group_id;

  // 내 파일
  const myFiles = queryAll('SELECT *, 0 as shared FROM construction_files WHERE construction_id=? ORDER BY file_type, created_at', [req.params.id]);

  // 같은 그룹의 다른 공사 파일 (group_id 있을 때만)
  let sharedFiles = [];
  if (gid) {
    sharedFiles = queryAll(
      `SELECT f.*, 1 as shared, c.work_name as from_work_name
       FROM construction_files f
       JOIN constructions c ON f.construction_id = c.id
       WHERE c.group_id=? AND f.construction_id!=? AND f.group_id IS NOT NULL
       ORDER BY f.file_type, f.created_at`,
      [gid, req.params.id]
    );
  }

  // 중복 제거 (같은 file_type + filename)
  const seen = new Set(myFiles.map(f => f.filename));
  const deduped = sharedFiles.filter(f => !seen.has(f.filename));

  res.json([...myFiles, ...deduped]);
});

app.post('/api/constructions/:id/files', upload.single('file'), authMiddleware, requireWrite, (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  const { file_type } = req.body;
  // multer는 파일명을 latin1으로 받으므로 utf8로 변환
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(originalName);
  const filename = `${req.params.id}_${file_type}_${Date.now()}${ext}`;
  const dest = path.join(FILES_DIR, filename);
  fs.writeFileSync(dest, req.file.buffer);
  const constr = queryOne('SELECT group_id FROM constructions WHERE id=?', [req.params.id]);
  db.run('INSERT INTO construction_files (construction_id,file_type,original_name,filename,file_size,group_id) VALUES (?,?,?,?,?,?)',
    [req.params.id, file_type, originalName, filename, req.file.size, constr?.group_id || null]);
  saveDB();
  res.json({ id: queryOne('SELECT last_insert_rowid() as id').id, filename, original_name: originalName });
});

app.get('/api/constructions/files/:filename', authMiddleware, (req, res) => {
  const filepath = path.join(FILES_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '파일 없음' });
  const file = queryOne('SELECT original_name FROM construction_files WHERE filename=?', [req.params.filename]);
  const originalName = file?.original_name || req.params.filename;
  // RFC 5987 방식으로 한글 파일명 인코딩
  const encodedName = encodeURIComponent(originalName).replace(/'/g, '%27');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${Buffer.from(originalName, 'utf8').toString('latin1')}"; filename*=UTF-8''${encodedName}`);
  res.sendFile(filepath);
});

app.delete('/api/constructions/files/:id', authMiddleware, requireWrite, (req, res) => {
  const file = queryOne('SELECT * FROM construction_files WHERE id=?', [req.params.id]);
  if (!file) return res.status(404).json({ error: '파일 없음' });
  const filepath = path.join(FILES_DIR, file.filename);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  db.run('DELETE FROM construction_files WHERE id=?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});

// ── 망 관리 API ──────────────────────────────────────────

app.get('/api/networks', authMiddleware, (req, res) => res.json(queryAll('SELECT * FROM networks ORDER BY id')));

app.post('/api/networks', authMiddleware, requireWrite, (req, res) => {
  const { name, color, shape } = req.body;
  if (!name || !color) return res.status(400).json({ error: '필수값 누락' });
  db.run('INSERT INTO networks (name, color, shape) VALUES (?,?,?)', [name.trim().toUpperCase(), color, shape||'circle']);
  saveDB();
  res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
});

app.put('/api/networks/:id', authMiddleware, requireWrite, (req, res) => {
  const { name, color, shape } = req.body;
  db.run('UPDATE networks SET name=?,color=?,shape=? WHERE id=?', [name.trim().toUpperCase(), color, shape||'circle', req.params.id]);
  saveDB(); res.json({ success: true });
});

app.delete('/api/networks/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('DELETE FROM networks WHERE id=?', [req.params.id]);
  saveDB(); res.json({ success: true });
});

// ── 선번 관리 API ──────────────────────────────────────────

app.post('/api/floorplan/upload', upload.single('image'), authMiddleware, requireWrite, (req, res) => {
  try {
    const { region, dong, floor } = req.body;
    if (!req.file) return res.status(400).json({ error: '파일 없음' });
    const origName = req.file.originalname.toLowerCase();
    const base = `${region}_${dong}_${floor}_${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    let finalFilename;
    let dxfCoords = null;
    if (origName.endsWith('.pdf')) {
      const tmpPdf = path.join(FLOOR_IMG_DIR, base + '.pdf');
      fs.writeFileSync(tmpPdf, req.file.buffer);
      execSync(`pdftoppm -r 150 -f 1 -l 1 -png "${tmpPdf}" "${path.join(FLOOR_IMG_DIR, base)}"`);
      fs.unlinkSync(tmpPdf);
      const candidates = fs.readdirSync(FLOOR_IMG_DIR).filter(f => f.startsWith(base) && f.endsWith('.png'));
      if (!candidates.length) throw new Error('PDF 변환 실패');
      finalFilename = base + '.png';
      fs.renameSync(path.join(FLOOR_IMG_DIR, candidates[0]), path.join(FLOOR_IMG_DIR, finalFilename));
    } else if (origName.endsWith('.dxf') || origName.endsWith('.dwg')) {
      const tmpDxf = path.join(FLOOR_IMG_DIR, base + '.dxf');
      const outPng = path.join(FLOOR_IMG_DIR, base + '.png');
      const outJson = path.join(FLOOR_IMG_DIR, base + '_coords.json');
      const pyFile = path.join(FLOOR_IMG_DIR, base + '_convert.py');
      fs.writeFileSync(tmpDxf, req.file.buffer);
      fs.writeFileSync(pyFile, [
        'import ezdxf, json, sys',
        'from ezdxf.addons.drawing import RenderContext, Frontend',
        'from ezdxf.addons.drawing.matplotlib import MatplotlibBackend',
        'import matplotlib','matplotlib.use("Agg")','import matplotlib.pyplot as plt',
        `doc = ezdxf.readfile(r"${tmpDxf}")`,
        'msp = doc.modelspace()',
        '# 좌표 범위 및 텍스트 레이블 추출',
        'pts = []',
        'labels = []',
        'for e in msp:',
        '    try:',
        '        if hasattr(e.dxf,"start"): pts.append(e.dxf.start)',
        '        if hasattr(e.dxf,"end"): pts.append(e.dxf.end)',
        '        if hasattr(e.dxf,"insert"): pts.append(e.dxf.insert)',
        '        if e.dxftype() in ("TEXT","MTEXT"):',
        '            ins = e.dxf.insert',
        '            txt = e.dxf.text if e.dxftype()=="TEXT" else e.text',
        '            txt = txt.strip().replace("\\n"," ")',
        '            if txt: labels.append({"text":txt,"x":float(ins[0]),"y":float(ins[1])})',
        '    except: pass',
        'if pts:',
        '    xs=[p[0] for p in pts]; ys=[p[1] for p in pts]',
        '    coords={"minx":min(xs),"miny":min(ys),"maxx":max(xs),"maxy":max(ys),"labels":labels}',
        'else:',
        '    coords={"minx":0,"miny":0,"maxx":1,"maxy":1,"labels":[]}',
        `with open(r"${outJson}","w",encoding="utf-8") as f: json.dump(coords,f,ensure_ascii=False)`,
        '# PNG 렌더링',
        'fig = plt.figure(figsize=(20,15), dpi=100)',
        'ax = fig.add_axes([0,0,1,1])',
        'ctx = RenderContext(doc)',
        'out = MatplotlibBackend(ax)',
        'Frontend(ctx, out).draw_layout(msp)',
        `fig.savefig(r"${outPng}", dpi=150, bbox_inches="tight", facecolor="white")`,
        'plt.close()',
      ].join('\n'));
      execSync(`python3 "${pyFile}"`);
      fs.unlinkSync(tmpDxf); fs.unlinkSync(pyFile);
      finalFilename = base + '.png';

      // DXF 좌표 데이터 읽기
      if (fs.existsSync(outJson)) {
        try {
          dxfCoords = JSON.parse(fs.readFileSync(outJson, 'utf-8'));
          fs.unlinkSync(outJson);
        } catch(e) { console.error('DXF coords parse error:', e); }
      }
    } else {
      const ext = origName.endsWith('.jpg') || origName.endsWith('.jpeg') ? 'jpg' : 'png';
      finalFilename = base + '.' + ext;
      fs.writeFileSync(path.join(FLOOR_IMG_DIR, finalFilename), req.file.buffer);
    }
    const existing = queryOne('SELECT id FROM floorplans WHERE region=? AND dong=? AND floor=?', [region, dong, floor]);
    const dxfMin = dxfCoords?.minx, dxfMax = dxfCoords?.maxx;
    const labelsJson = dxfCoords ? JSON.stringify(dxfCoords.labels) : null;

    if (existing) {
      // 신 도면 업로드 시 기존 핀 DXF 좌표로 재매핑
      if (dxfCoords) {
        const oldFp = queryOne('SELECT * FROM floorplans WHERE id=?', [existing.id]);
        if (oldFp?.dxf_minx !== null && oldFp?.dxf_minx !== undefined) {
          remapCablesToNewDxf(existing.id, oldFp, dxfCoords);
        }
      }
      const dxVals = [
        dxfCoords?.minx ?? null, dxfCoords?.miny ?? null,
        dxfCoords?.maxx ?? null, dxfCoords?.maxy ?? null,
        labelsJson ?? null
      ];
      db.run('UPDATE floorplans SET filename=?,dxf_minx=?,dxf_miny=?,dxf_maxx=?,dxf_maxy=?,dxf_labels=? WHERE id=?',
        [finalFilename, ...dxVals, existing.id]);
      res.json({ id: existing.id, filename: finalFilename, dxfCoords: dxfCoords || null });
    } else {
      const dxVals2 = [
        dxfCoords?.minx ?? null, dxfCoords?.miny ?? null,
        dxfCoords?.maxx ?? null, dxfCoords?.maxy ?? null,
        labelsJson ?? null
      ];
      db.run('INSERT INTO floorplans (region,dong,floor,filename,dxf_minx,dxf_miny,dxf_maxx,dxf_maxy,dxf_labels) VALUES (?,?,?,?,?,?,?,?,?)',
        [region, dong, floor, finalFilename, ...dxVals2]);
      res.json({ id: queryOne('SELECT last_insert_rowid() as id').id, filename: finalFilename, dxfCoords: dxfCoords || null });
    }
    saveDB();
  } catch(e) { console.error('Upload error:', e); res.status(500).json({ error: e.message }); }
});

app.get('/api/floorplan', authMiddleware, (req, res) => {
  const { region, dong, floor } = req.query;
  res.json(queryOne('SELECT * FROM floorplans WHERE region=? AND dong=? AND floor=?', [region, dong, floor]) || null);
});

app.get('/api/floorplan/image/:filename', authMiddleware, (req, res) => {
  const filepath = path.join(FLOOR_IMG_DIR, req.params.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: '없음' });
  res.sendFile(filepath);
});


// 재매핑 후 신 도면을 실제 위치에 저장
app.post('/api/floorplan/remap-finalize', authMiddleware, requireWrite, (req, res) => {
  try {
    const { tmpId, region, dong, floor } = req.body;
    const tmpFp = queryOne('SELECT * FROM floorplans WHERE id=?', [tmpId]);
    if (!tmpFp) return res.status(404).json({ error: '임시 도면 없음' });

    // 기존 도면 교체
    const existing = queryOne('SELECT id FROM floorplans WHERE region=? AND dong=? AND floor=?', [region, dong, floor]);
    if (existing) {
      db.run('UPDATE floorplans SET filename=? WHERE id=?', [tmpFp.filename, existing.id]);
      db.run('DELETE FROM floorplans WHERE id=?', [tmpId]);
    } else {
      db.run('UPDATE floorplans SET region=?,dong=?,floor=? WHERE id=?', [region, dong, floor, tmpId]);
    }
    saveDB();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cables', authMiddleware, (req, res) => {
  res.json(queryAll('SELECT * FROM cables WHERE floorplan_id=? ORDER BY id DESC', [req.query.floorplan_id]));
});

app.post('/api/cables', authMiddleware, requireWrite, (req, res) => {
  const { floorplan_id, cable_no, construction_no, x, y, color, shape, memo } = req.body;

  // DXF 좌표 역산 (픽셀 비율 → DXF 실좌표)
  let dxf_x = null, dxf_y = null;
  const fp = queryOne('SELECT * FROM floorplans WHERE id=?', [floorplan_id]);
  if (fp?.dxf_minx !== null && fp?.dxf_minx !== undefined) {
    const w = fp.dxf_maxx - fp.dxf_minx;
    const h = fp.dxf_maxy - fp.dxf_miny;
    dxf_x = fp.dxf_minx + x * w;
    dxf_y = fp.dxf_miny + (1 - y) * h; // Y축 반전
  }

  db.run('INSERT INTO cables (floorplan_id,cable_no,construction_no,x,y,dxf_x,dxf_y,color,shape,memo) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [floorplan_id, s(cable_no), s(construction_no), x, y, dxf_x, dxf_y, color||'#e74c3c', shape||'circle', s(memo)]);
  saveDB();
  res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
});

app.put('/api/cables/:id', authMiddleware, requireWrite, (req, res) => {
  const { cable_no, construction_no, color, shape, memo, x, y } = req.body;
  if (x !== undefined && y !== undefined) {
    db.run('UPDATE cables SET cable_no=?,construction_no=?,color=?,shape=?,memo=?,x=?,y=? WHERE id=?',
      [s(cable_no), s(construction_no), color||'#e74c3c', shape||'circle', s(memo), x, y, req.params.id]);
  } else {
    db.run('UPDATE cables SET cable_no=?,construction_no=?,color=?,shape=?,memo=? WHERE id=?',
      [s(cable_no), s(construction_no), color||'#e74c3c', shape||'circle', s(memo), req.params.id]);
  }
  saveDB(); res.json({ success: true });
});

app.delete('/api/cables/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('DELETE FROM cables WHERE id=?', [req.params.id]);
  saveDB(); res.json({ success: true });
});

// ── 위치 관리 API ──────────────────────────────────────────

app.get('/api/locations', authMiddleware, (req, res) => res.json(queryAll('SELECT * FROM locations ORDER BY region, dong')));

app.post('/api/locations', authMiddleware, requireWrite, (req, res) => {
  const { region, dong, floors } = req.body;
  if (!region || !dong || !floors) return res.status(400).json({ error: '필수값 누락' });
  db.run('INSERT INTO locations (region, dong, floors) VALUES (?,?,?)', [region.trim(), dong.trim(), JSON.stringify(floors)]);
  saveDB(); res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
});

app.put('/api/locations/:id', authMiddleware, requireWrite, (req, res) => {
  const { region, dong, floors } = req.body;
  db.run('UPDATE locations SET region=?,dong=?,floors=? WHERE id=?', [region.trim(), dong.trim(), JSON.stringify(floors), req.params.id]);
  saveDB(); res.json({ success: true });
});

app.delete('/api/locations/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('DELETE FROM locations WHERE id = ?', [req.params.id]);
  saveDB(); res.json({ success: true });
});

// ── 엑셀 ──────────────────────────────────────────

app.get('/api/template', authMiddleware, (req, res) => {
  const h1 = ['No.','구분','요청일','법인','요청자','','공사명','작업 위치','','','','작업 위치 (이동 전)','','','','완료','','','품의','','','IT관리팀 담당자','작업자','비고'];
  const h2 = ['','','','','부서','이름','','지역','동','층','상세위치','지역','동','층','상세위치','상태','기한일','작업 완료일','구매품의서','지출품의서','연관품의서','','',''];
  const ex = ['','자체공사','26.03.01','KSM','IT관리팀','김준기','HO동 3층 서버실 케이블 포설','대곶','HO','3F','서버실','','','','','완료','26.03.10','26.03.09','경영-구품-26-0001','경영-지품-26-0001','','이준성','김준기, 이준성','특이사항 없음'];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([h1, h2, ex]);
  ws['!cols'] = h1.map((h,i) => ({ wch: i===6?45:i===23?40:i<7?12:16 }));
  XLSX.utils.book_append_sheet(wb, ws, '공사이력 입력양식');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('공사이력_입력양식.xlsx')}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.post('/api/import', upload.single('file'), authMiddleware, requireWrite, (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    if (rows.length < 2) return res.json({ success: true, inserted: 0, updated: 0 });

    const dataRows = rows.slice(2).filter(r => r.some(c => c !== undefined && c !== '') && (r[1] || r[6]));
    const g = (row, i) => (row[i] !== undefined && row[i] !== null) ? String(row[i]).trim().replace(/^\t+/, '') : '';

    let inserted = 0, updated = 0;

    for (const row of dataRows) {
      if (!g(row, 1) && !g(row, 6)) continue;

      const no = g(row, 0) ? parseInt(g(row, 0)) : null;
      const fields = {
        gubun:          g(row, 1),
        req_date:       g(row, 2),
        corp:           g(row, 3),
        dept:           g(row, 4),
        requester:      g(row, 5),
        work_name:      g(row, 6),
        loc_region:     g(row, 7),
        loc_dong:       g(row, 8),
        loc_floor:      g(row, 9),
        loc_detail:     g(row, 10),
        demolish_region: g(row, 11),
        demolish_dong:  g(row, 12),
        demolish_floor: g(row, 13),
        demolish_detail: g(row, 14),
        status:         g(row, 15),
        deadline:       g(row, 16),
        complete_date:  g(row, 17),
        purchase_doc:   g(row, 18),
        payment_doc:    g(row, 19),
        related_doc:    g(row, 20),
        it_manager:     g(row, 21),
        worker:         g(row, 22),
        memo:           g(row, 23),
      };

      // No. 값이 있으면 기존 레코드 존재 여부 확인 후 upsert
      if (no) {
        const existing = queryOne('SELECT id FROM constructions WHERE no = ?', [no]);
        if (existing) {
          // 기존 레코드 업데이트
          const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
          db.run(`UPDATE constructions SET ${sets} WHERE no = ?`, [...Object.values(fields), no]);
          updated++;
        } else {
          // 신규 삽입 (no 포함)
          const cols = ['no', ...Object.keys(fields)].join(', ');
          const placeholders = Array(Object.keys(fields).length + 1).fill('?').join(', ');
          db.run(`INSERT INTO constructions (${cols}) VALUES (${placeholders})`, [no, ...Object.values(fields)]);
          inserted++;
        }
      } else {
        // No. 없는 행 → 공사명으로 중복 체크
        const existing = fields.work_name
          ? queryOne('SELECT id FROM constructions WHERE work_name = ? AND req_date = ?', [fields.work_name, fields.req_date])
          : null;
        if (existing) {
          const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
          db.run(`UPDATE constructions SET ${sets} WHERE id = ?`, [...Object.values(fields), existing.id]);
          updated++;
        } else {
          const lastNo = (queryOne('SELECT MAX(no) as m FROM constructions').m || 0) + 1;
          const cols = ['no', ...Object.keys(fields)].join(', ');
          const placeholders = Array(Object.keys(fields).length + 1).fill('?').join(', ');
          db.run(`INSERT INTO constructions (${cols}) VALUES (${placeholders})`, [lastNo, ...Object.values(fields)]);
          inserted++;
        }
      }
    }

    saveDB();
    res.json({ success: true, inserted, updated, count: inserted + updated });
  } catch(e) { res.status(500).json({ error: '파일 처리 중 오류: ' + e.message }); }
});

app.get('/api/export', authMiddleware, (req, res) => {
  const rows = queryAll('SELECT * FROM constructions ORDER BY no ASC');
  const now = new Date();
  const dateStr = `${now.getFullYear()}_${String(now.getMonth()+1).padStart(2,'0')}_${String(now.getDate()).padStart(2,'0')}`;
  const h1 = ['No.','구분','요청일','법인','요청자','','공사명','작업 위치','','','','작업 위치 (이동 전)','','','','완료','','','품의','','','IT관리팀 담당자','작업자','비고'];
  const h2 = ['','','','','부서','이름','','지역','동','층','상세위치','지역','동','층','상세위치','상태','기한일','작업 완료일','구매품의서','지출품의서','연관품의서','','',''];
  const data = [h1, h2, ...rows.map(r => [r.no,r.gubun,r.req_date,r.corp,r.dept,r.requester,r.work_name,r.loc_region,r.loc_dong,r.loc_floor,r.loc_detail,r.demolish_region,r.demolish_dong,r.demolish_floor,r.demolish_detail,r.status,r.deadline,r.complete_date,r.purchase_doc,r.payment_doc,r.related_doc,r.it_manager,r.worker,r.memo])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = h1.map((h,i) => ({ wch: i===6?45:i===23?40:i<7?12:16 }));
  XLSX.utils.book_append_sheet(wb, ws, '공사이력_전체');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${dateStr}_네트워크공사이력.xlsx`)}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── 네트워크 장비 관리 API ──────────────────────────────────────────

app.get('/api/net-devices', authMiddleware, (req, res) => {
  res.json(queryAll('SELECT * FROM net_devices ORDER BY id'));
});

app.post('/api/net-devices', authMiddleware, requireWrite, (req, res) => {
  const { name, ip, snmp_community, snmp_port, location, description } = req.body;
  if (!name || !ip) return res.status(400).json({ error: '장비명과 IP는 필수입니다' });
  db.run(
    'INSERT INTO net_devices (name,ip,snmp_community,snmp_port,location,description) VALUES (?,?,?,?,?,?)',
    [name.trim(), ip.trim(), snmp_community||'public', parseInt(snmp_port)||161, location||'', description||'']
  );
  saveDB();
  res.json({ id: queryOne('SELECT last_insert_rowid() as id').id });
});

app.put('/api/net-devices/:id', authMiddleware, requireWrite, (req, res) => {
  const { name, ip, snmp_community, snmp_port, location, description } = req.body;
  if (!name || !ip) return res.status(400).json({ error: '장비명과 IP는 필수입니다' });
  db.run(
    'UPDATE net_devices SET name=?,ip=?,snmp_community=?,snmp_port=?,location=?,description=? WHERE id=?',
    [name.trim(), ip.trim(), snmp_community||'public', parseInt(snmp_port)||161, location||'', description||'', req.params.id]
  );
  saveDB();
  res.json({ success: true });
});

app.delete('/api/net-devices/:id', authMiddleware, requireWrite, (req, res) => {
  db.run('DELETE FROM net_devices WHERE id=?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});

// SNMP 조회 API
app.get('/api/net-devices/:id/snmp', authMiddleware, (req, res) => {
  const device = queryOne('SELECT * FROM net_devices WHERE id=?', [req.params.id]);
  if (!device) return res.status(404).json({ error: '장비를 찾을 수 없습니다' });

  const session = snmp.createSession(device.ip, device.snmp_community, {
    port: device.snmp_port,
    retries: 1,
    timeout: 5000,
    version: snmp.Version2c,
  });

  const result = {
    device: { id: device.id, name: device.name, ip: device.ip },
    system: {},
    interfaces: [],
    error: null,
  };

  // OIDs
  const SYS_DESCR  = '1.3.6.1.2.1.1.1.0';
  const SYS_UPTIME = '1.3.6.1.2.1.1.3.0';
  const SYS_NAME   = '1.3.6.1.2.1.1.5.0';

  // ifTable OID bases
  const IF_DESCR_BASE  = '1.3.6.1.2.1.2.2.1.2';
  const IF_OPER_BASE   = '1.3.6.1.2.1.2.2.1.8';
  const IF_ADMIN_BASE  = '1.3.6.1.2.1.2.2.1.7';
  const IF_SPEED_BASE  = '1.3.6.1.2.1.2.2.1.5';
  const IF_IN_BASE     = '1.3.6.1.2.1.2.2.1.10';
  const IF_OUT_BASE    = '1.3.6.1.2.1.2.2.1.16';

  function uptimeToString(ticks) {
    const totalSec = Math.floor(ticks / 100);
    const days  = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins  = Math.floor((totalSec % 3600) / 60);
    const secs  = totalSec % 60;
    return `${days}일 ${hours}시간 ${mins}분 ${secs}초`;
  }

  // 1단계: 시스템 정보 GET
  session.get([SYS_DESCR, SYS_UPTIME, SYS_NAME], (err, varbinds) => {
    if (err) {
      session.close();
      return res.status(200).json({ ...result, error: `SNMP 연결 실패: ${err.message}` });
    }
    if (!snmp.isVarbindError(varbinds[0])) result.system.sysDescr  = varbinds[0].value.toString();
    if (!snmp.isVarbindError(varbinds[1])) result.system.sysUptime = uptimeToString(varbinds[1].value);
    if (!snmp.isVarbindError(varbinds[2])) result.system.sysName   = varbinds[2].value.toString();

    // 2단계: ifDescr 테이블 walk → 인덱스 수집
    const ifMap = {}; // index → {descr, operStatus, adminStatus, speed, inOctets, outOctets}

    session.subtree(IF_DESCR_BASE, 20, (vb) => {
      if (!snmp.isVarbindError(vb)) {
        const idx = vb.oid.split('.').pop();
        if (!ifMap[idx]) ifMap[idx] = {};
        ifMap[idx].descr = vb.value.toString();
      }
    }, (err2) => {
      if (err2) {
        session.close();
        return res.json({ ...result, error: `인터페이스 조회 실패: ${err2.message}` });
      }

      const indices = Object.keys(ifMap);
      if (indices.length === 0) {
        session.close();
        return res.json(result);
      }

      // 3단계: 각 인터페이스의 OperStatus / AdminStatus / Speed / Octets GET
      const oids = [];
      indices.forEach(idx => {
        oids.push(`${IF_OPER_BASE}.${idx}`);
        oids.push(`${IF_ADMIN_BASE}.${idx}`);
        oids.push(`${IF_SPEED_BASE}.${idx}`);
        oids.push(`${IF_IN_BASE}.${idx}`);
        oids.push(`${IF_OUT_BASE}.${idx}`);
      });

      // net-snmp GET는 한번에 최대 ~60 OID 처리 가능; 분할
      const chunkSize = 50;
      const chunks = [];
      for (let i = 0; i < oids.length; i += chunkSize) chunks.push(oids.slice(i, i + chunkSize));

      let chunkIdx = 0;
      function processChunk() {
        if (chunkIdx >= chunks.length) {
          // 최종 결과 조립
          const STATUS_MAP = { 1: 'up', 2: 'down', 3: 'testing', 4: 'unknown', 5: 'dormant', 6: 'notPresent', 7: 'lowerLayerDown' };
          indices.forEach(idx => {
            const iface = ifMap[idx];
            result.interfaces.push({
              index: parseInt(idx),
              descr: iface.descr || '',
              operStatus: STATUS_MAP[iface.operStatus] || String(iface.operStatus || ''),
              adminStatus: STATUS_MAP[iface.adminStatus] || String(iface.adminStatus || ''),
              speedMbps: iface.speed ? Math.round(iface.speed / 1000000) : 0,
              inOctets: iface.inOctets || 0,
              outOctets: iface.outOctets || 0,
            });
          });
          result.interfaces.sort((a, b) => a.index - b.index);
          session.close();
          return res.json(result);
        }

        session.get(chunks[chunkIdx], (err3, vbs) => {
          if (!err3) {
            vbs.forEach(vb => {
              if (snmp.isVarbindError(vb)) return;
              const parts = vb.oid.split('.');
              const idx = parts.pop();
              const base = parts.join('.');
              if (!ifMap[idx]) ifMap[idx] = {};
              const val = typeof vb.value === 'object' ? vb.value.toNumber ? vb.value.toNumber() : parseInt(vb.value.toString()) : vb.value;
              if (base === IF_OPER_BASE)  ifMap[idx].operStatus  = val;
              if (base === IF_ADMIN_BASE) ifMap[idx].adminStatus = val;
              if (base === IF_SPEED_BASE) ifMap[idx].speed       = val;
              if (base === IF_IN_BASE)    ifMap[idx].inOctets    = val;
              if (base === IF_OUT_BASE)   ifMap[idx].outOctets   = val;
            });
          }
          chunkIdx++;
          processChunk();
        });
      }
      processChunk();
    });
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => app.listen(PORT, () => console.log(`✅ 서버 실행 중: http://localhost:${PORT}`)));
