const express = require('express');
const initSqlJs = require('sql.js');
const XLSX = require('xlsx');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'construction.db');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let db;

async function initDB() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }

  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    construction_id INTEGER,
    action TEXT,        -- 'create' | 'update' | 'delete'
    changed_by TEXT,
    changed_at TEXT DEFAULT (datetime('now','localtime')),
    diff TEXT           -- JSON string of changed fields
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    region TEXT NOT NULL,
    dong TEXT NOT NULL,
    floors TEXT NOT NULL,   -- JSON array e.g. ["1F","2F","3F"]
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // 기본 위치 샘플 데이터
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
  saveDB();


}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}


const FIELD_LABELS = {'gubun': '구분', 'req_date': '요청일', 'corp': '법인', 'dept': '부서', 'requester': '요청자', 'work_name': '공사명', 'loc_region': '작업지역', 'loc_dong': '작업동', 'loc_floor': '작업층', 'loc_detail': '작업 상세위치', 'move_region': '공사위치지역', 'move_dong': '공사위치동', 'move_floor': '공사위치층', 'move_detail': '공사위치 상세', 'demolish_region': '철거지역', 'demolish_dong': '철거동', 'demolish_floor': '철거층', 'demolish_detail': '철거 상세', 'status': '상태', 'deadline': '기한일', 'complete_date': '완료일', 'purchase_doc': '구매품의서', 'payment_doc': '지출품의서', 'related_doc': '연관품의서', 'it_manager': 'IT담당자', 'worker': '작업자', 'memo': '메모'};

function recordHistory(constructionId, action, changedBy, diff) {
  db.run(
    `INSERT INTO history (construction_id, action, changed_by, diff) VALUES (?, ?, ?, ?)`,
    [constructionId, action, changedBy || '시스템', JSON.stringify(diff)]
  );
}

function diffRecords(before, after) {
  const changes = [];
  const keys = Object.keys(FIELD_LABELS);
  for (const k of keys) {
    const bv = (before[k] ?? '').toString().trim();
    const av = (after[k] ?? '').toString().trim();
    if (bv !== av) {
      changes.push({ field: k, label: FIELD_LABELS[k], before: bv, after: av });
    }
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

function queryOne(sql, params = []) {
  return queryAll(sql, params)[0] || null;
}

app.get('/api/constructions', (req, res) => {
  const { search, gubun, status, corp } = req.query;
  let sql = 'SELECT * FROM constructions WHERE 1=1';
  const params = [];
  if (search) {
    const keywords = search.trim().split(/\s+/).filter(Boolean);
    for (const kw of keywords) {
      sql += ' AND (work_name LIKE ? OR requester LIKE ? OR dept LIKE ? OR loc_region LIKE ? OR loc_dong LIKE ? OR loc_floor LIKE ? OR loc_detail LIKE ? OR worker LIKE ? OR it_manager LIKE ?)';
      params.push(`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`,`%${kw}%`);
    }
  }
  if (gubun && gubun !== '전체') { sql += ' AND gubun = ?'; params.push(gubun); }
  if (status && status !== '전체') { sql += ' AND status = ?'; params.push(status); }
  if (corp && corp !== '전체') { sql += ' AND corp = ?'; params.push(corp); }
  sql += ' ORDER BY id DESC';
  res.json(queryAll(sql, params));
});

app.get('/api/stats', (req, res) => {
  const g = s => queryOne(`SELECT COUNT(*) as cnt FROM constructions WHERE ${s}`).cnt;
  res.json({
    total: g('1=1'), done: g("status='완료'"), inprogress: g("status='진행중'"), holding: g("status='Holding'"),
    self: g("gubun='자체공사'"), outsource: g("gubun='외주공사'"), payment: g("gubun='지급'"), purchase: g("gubun='구매'"),
    corp_ksm: g("corp='KSM'"), corp_fksm: g("corp='FKSM'"), corp_ksmc: g("corp='KSMC'"),
    corp_yhe: g("corp='YHE'"), corp_ksmf: g("corp='KSMF'")
  });
});

app.get('/api/constructions/:id', (req, res) => {
  const row = queryOne('SELECT * FROM constructions WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/constructions', (req, res) => {
  try {
    const d = req.body;
    const lastNo = (queryOne('SELECT MAX(no) as m FROM constructions').m || 0);
    db.run(`INSERT INTO constructions (no,gubun,req_date,corp,dept,requester,work_name,loc_region,loc_dong,loc_floor,loc_detail,move_region,move_dong,move_floor,move_detail,demolish_region,demolish_dong,demolish_floor,demolish_detail,status,deadline,complete_date,purchase_doc,payment_doc,related_doc,it_manager,worker,memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [lastNo+1,
       s(d.gubun),s(d.req_date),s(d.corp),s(d.dept),s(d.requester),s(d.work_name),
       s(d.loc_region),s(d.loc_dong),s(d.loc_floor),s(d.loc_detail),
       s(d.move_region),s(d.move_dong),s(d.move_floor),s(d.move_detail),
       s(d.demolish_region),s(d.demolish_dong),s(d.demolish_floor),s(d.demolish_detail),
       s(d.status),s(d.deadline),s(d.complete_date),
       s(d.purchase_doc),s(d.payment_doc),s(d.related_doc),
       s(d.it_manager),s(d.worker),s(d.memo)]);
    saveDB();
    const newId = queryOne('SELECT last_insert_rowid() as id').id;
    recordHistory(newId, 'create', d.changed_by, [{ field: 'work_name', label: '공사명', before: '', after: d.work_name }]);
    saveDB();
    res.json({ id: newId, no: lastNo+1 });
  } catch(e) {
    console.error('POST error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/constructions/:id', (req, res) => {
  try {
    const d = req.body;
    const before = queryOne('SELECT * FROM constructions WHERE id = ?', [req.params.id]);
    db.run(`UPDATE constructions SET gubun=?,req_date=?,corp=?,dept=?,requester=?,work_name=?,loc_region=?,loc_dong=?,loc_floor=?,loc_detail=?,move_region=?,move_dong=?,move_floor=?,move_detail=?,demolish_region=?,demolish_dong=?,demolish_floor=?,demolish_detail=?,status=?,deadline=?,complete_date=?,purchase_doc=?,payment_doc=?,related_doc=?,it_manager=?,worker=?,memo=? WHERE id=?`,
      [s(d.gubun),s(d.req_date),s(d.corp),s(d.dept),s(d.requester),s(d.work_name),
       s(d.loc_region),s(d.loc_dong),s(d.loc_floor),s(d.loc_detail),
       s(d.move_region),s(d.move_dong),s(d.move_floor),s(d.move_detail),
       s(d.demolish_region),s(d.demolish_dong),s(d.demolish_floor),s(d.demolish_detail),
       s(d.status),s(d.deadline),s(d.complete_date),
       s(d.purchase_doc),s(d.payment_doc),s(d.related_doc),
       s(d.it_manager),s(d.worker),s(d.memo),req.params.id]);
    const diff = diffRecords(before, d);
    if (diff.length > 0) recordHistory(req.params.id, 'update', d.changed_by, diff);
    saveDB();
    res.json({ success: true });
  } catch(e) {
    console.error('PUT error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/constructions/:id', (req, res) => {
  const row = queryOne('SELECT * FROM constructions WHERE id = ?', [req.params.id]);
  if (row) recordHistory(req.params.id, 'delete', null, [{ field: 'work_name', label: '공사명', before: row.work_name, after: '' }]);
  db.run('DELETE FROM constructions WHERE id = ?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});

app.get('/api/history/:id', (req, res) => {
  const rows = queryAll(
    'SELECT * FROM history WHERE construction_id = ? ORDER BY id DESC',
    [req.params.id]
  );
  res.json(rows.map(r => ({ ...r, diff: JSON.parse(r.diff || '[]') })));
});


// ── 위치 관리 API ──────────────────────────────────────────

app.get('/api/locations', (req, res) => {
  res.json(queryAll('SELECT * FROM locations ORDER BY region, dong'));
});

app.post('/api/locations', (req, res) => {
  const { region, dong, floors } = req.body;
  if (!region || !dong || !floors) return res.status(400).json({ error: '필수값 누락' });
  db.run('INSERT INTO locations (region, dong, floors) VALUES (?,?,?)',
    [region.trim(), dong.trim(), JSON.stringify(floors)]);
  saveDB();
  const newId = queryOne('SELECT last_insert_rowid() as id').id;
  res.json({ id: newId });
});

app.put('/api/locations/:id', (req, res) => {
  const { region, dong, floors } = req.body;
  db.run('UPDATE locations SET region=?, dong=?, floors=? WHERE id=?',
    [region.trim(), dong.trim(), JSON.stringify(floors), req.params.id]);
  saveDB();
  res.json({ success: true });
});

app.delete('/api/locations/:id', (req, res) => {
  db.run('DELETE FROM locations WHERE id = ?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});


// ── 엑셀 양식 다운로드 ──────────────────────────────────────────
app.get('/api/template', (req, res) => {
  // 실제 엑셀 양식과 동일한 헤더 (2행 구조)
  const header1 = ['No.','구분','요청일','법인','요청자','','공사명','작업 위치','','','','작업 위치 (이동 전)','','','','완료','','','품의','','','IT관리팀 담당자','작업자','비고'];
  const header2 = ['','','','','부서','이름','','지역','동','층','상세위치','지역','동','층','상세위치','상태','기한일','작업 완료일','구매품의서','지출품의서','연관품의서','','',''];
  const example = ['','자체공사','26.03.01','KSM','IT관리팀','김준기','HO동 3층 서버실 케이블 포설','대곶','HO','3F','서버실','','','','','완료','26.03.10','26.03.09','경영-구품-26-0001','경영-지품-26-0001','','이준성','김준기, 이준성','특이사항 없음'];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([header1, header2, example]);

  // 컬럼 너비
  ws['!cols'] = header1.map((h, i) => ({ wch: i === 6 ? 45 : i === 23 ? 40 : i < 7 ? 12 : 16 }));

  // 헤더 행 스타일
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let C = range.s.c; C <= range.e.c; C++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: C })];
    if (cell) {
      cell.s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: 'C0392B' } },
        alignment: { horizontal: 'center' }
      };
    }
  }

  XLSX.utils.book_append_sheet(wb, ws, '공사이력 입력양식');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('공사이력_입력양식.xlsx')}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── 엑셀 업로드 (밀어넣기) ──────────────────────────────────────────
app.post('/api/import', upload.single('file'), (req, res) => {
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

    if (rows.length < 2) return res.json({ success: true, count: 0 });

    // 실제 엑셀 양식: 1행=대분류헤더, 2행=소분류헤더, 3행부터=데이터
    // 컬럼 인덱스 (0-based):
    // 0:No, 1:구분, 2:요청일, 3:법인, 4:부서, 5:요청자이름, 6:공사명,
    // 7:작업지역, 8:작업동, 9:작업층, 10:작업상세,
    // 11:이동전지역, 12:이동전동, 13:이동전층, 14:이동전상세,
    // 15:상태, 16:기한일, 17:완료일, 18:구매품의, 19:지출품의, 20:연관품의,
    // 21:IT담당자, 22:작업자, 23:비고(메모)

    // 헤더 행 건너뛰기 (1행, 2행이 헤더)
    const dataRows = rows.slice(2).filter(r => r.some(c => c !== undefined && c !== '') && r[1]); // 구분 있는 행만

    const g = (row, i) => (row[i] !== undefined && row[i] !== null) ? String(row[i]).trim() : '';

    let count = 0;
    let lastNo = (queryOne('SELECT MAX(no) as m FROM constructions').m || 0);

    for (const row of dataRows) {
      if (!g(row, 1)) continue; // 구분 없으면 스킵
      lastNo++;
      db.run(`INSERT INTO constructions (no,gubun,req_date,corp,dept,requester,work_name,
        loc_region,loc_dong,loc_floor,loc_detail,
        move_region,move_dong,move_floor,move_detail,
        demolish_region,demolish_dong,demolish_floor,demolish_detail,
        status,deadline,complete_date,
        purchase_doc,payment_doc,related_doc,it_manager,worker,memo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [lastNo,
         g(row,1), g(row,2), g(row,3), g(row,4), g(row,5), g(row,6),
         g(row,7), g(row,8), g(row,9), g(row,10),
         g(row,11), g(row,12), g(row,13), g(row,14),
         '','','','',
         g(row,15), g(row,16), g(row,17),
         g(row,18), g(row,19), g(row,20),
         g(row,21), g(row,22), g(row,23)
        ]);
      count++;
    }

    saveDB();
    res.json({ success: true, count });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '파일 처리 중 오류가 발생했습니다: ' + e.message });
  }
});

app.get('/api/export', (req, res) => {
  const rows = queryAll('SELECT * FROM constructions ORDER BY no ASC');
  const now = new Date();
  const dateStr = `${now.getFullYear()}_${String(now.getMonth()+1).padStart(2,'0')}_${String(now.getDate()).padStart(2,'0')}`;
  // 실제 엑셀 양식과 동일한 2행 헤더 구조
  const header1 = ['No.','구분','요청일','법인','요청자','','공사명','작업 위치','','','','작업 위치 (이동 전)','','','','완료','','','품의','','','IT관리팀 담당자','작업자','비고'];
  const header2 = ['','','','','부서','이름','','지역','동','층','상세위치','지역','동','층','상세위치','상태','기한일','작업 완료일','구매품의서','지출품의서','연관품의서','','',''];
  const data = [header1, header2, ...rows.map(r => [
    r.no, r.gubun, r.req_date, r.corp, r.dept, r.requester, r.work_name,
    r.loc_region, r.loc_dong, r.loc_floor, r.loc_detail,
    r.demolish_region, r.demolish_dong, r.demolish_floor, r.demolish_detail,
    r.status, r.deadline, r.complete_date,
    r.purchase_doc, r.payment_doc, r.related_doc,
    r.it_manager, r.worker, r.memo
  ])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = header1.map((h,i) => ({ wch: i===6?45:i===23?40:i<7?12:16 }));
  XLSX.utils.book_append_sheet(wb, ws, '2026_공사이력_전체');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${dateStr}_네트워크공사이력.xlsx`)}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => app.listen(PORT, () => console.log(`✅ 서버 실행 중: http://localhost:${PORT}`)));
