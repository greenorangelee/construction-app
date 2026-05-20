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

  const count = queryOne('SELECT COUNT(*) as cnt FROM constructions');
  if (count.cnt === 0) {
    const samples = [
      [1,'자체공사','25.12.31','FKSM','IT관리팀','허충범','HO를 서버실 온습도, 누수, 가스 센서 펜선 포설','대국','HO','3F','서버실','','','','','완료','26.01.03','26.01.03','경영-자유-26-0007','N/A','경영-품의-26-0008','김문기','이운성·이윤지',''],
      [2,'외주공사','25.12.19','KSMC','중무팀','김성진','대포공장 2층 회의실 AP 추가 설치','대포','1층','2F','자율좌석','','','','','완료','26.01.20','26.01.20','경영-구품-26-0024','경영-구품-26-0620','경영-품의-25-1152','이운성','대열정보기술',''],
      [3,'자체공사','25.12.19','KSMC','중무팀','김성진','대포공장 2층 회의실 추가 설치 (펜선포설)','대포','1층','2F','YHE회의실','','','','','완료','26.01.20','26.01.19','N/A','N/A','경영-품의-25-1152','이운성','이운성·이윤지',''],
      [4,'외주공사','25.12.19','KSM','중무팀','김성진','대국 구내식당 네트워크 설비 공사 (AP설치, 스위치교체)','대국','R&D1','3F','식당','','','','','완료','26.01.20','26.01.20','경영-구품-26-0001','경영-지품-26-0623','경영-품의-25-1015','이운성','대열정보기술',''],
      [5,'자체공사','26.01.26','KSM','생산담당','김진만','HO동 B1층 간 자리 이동 포설 진행','대국','B1','2F','생산사무실','대국','HO','4F','경기기술부','완료','26.02.02','26.01.28','N/A','N/A','경영-자유-26-0007','이운성','이운성·이윤지',''],
      [6,'자체공사','26.02.03','KSM','기술기획팀','김기환','HO동 4층 연구소 내 자리 이동','대국','HO','4F','연구소','','','','','완료','26.02.07','26.02.07','기술-구품-26-0203','N/A','N/A','이운성','이운성·이윤지',''],
      [7,'자체공사','26.02.05','KSM','중무팀','-','하성 신규 입원실 조성','하성','A1','2F','회의실1','','','','','완료','26.03.21','26.03.23','N/A','N/A','경영-지품-26-1576','김문기','이운성·성두룡',''],
      [8,'외주공사','26.02.05','KSM','운영관리팀','이현우','HO동 1층 워크스테이션 VINA 신규 PC 요청','대국','HO','1F','현장','','','','','완료','26.02.21','26.02.19','생산-구품-26-1143','경영-지품-26-1306','','이운성','대열정보기술',''],
      [9,'외주공사','26.02.06','KSM','가공기술팀','김상민','B1동 1층 KSM 가공기술팀 설비 및 사무공간 이전','대국','B1','1F','현장','','','','','완료','26.02.21','26.02.19','생산-구품-26-1109','경영-지품-26-1306','','이운성','대열정보기술',''],
      [10,'지급','26.02.06','KSM','생산기술팀','강준현','HO 2F 수명검사실 내 펜선 포설','대국','HO','2F','수명검사실','','','','','진행중','26.02.06','26.02.06','생산-구품-26-1002','N/A','N/A','이운성','이운성·이윤지',''],
      [11,'자체공사','26.02.10','FKSM','생산기술팀','서홍수','S1동 1층 사무실 플로우서버 펜선 포설','대국','S1','1F','사무실','','','','','완료','기함업술','26.02.19','생산-구품-26-0927','경영-지품-26-1306','','이운성','대열정보기술',''],
      [12,'구매','-','FKSM','자재관리팀','이상흡(퇴사) > 박준희','QRC WMS 구축 (AP구매) - 대영','N/A','N/A','N/A','N/A','','','','','진행중','26.02.05','26.02.05','자재-구품-25-0050','경영-지품-26-1032','','김문기','대열정보기술',''],
      [13,'외주공사','-','FKSM','자재관리팀','이상흡(퇴사) > 박준희','QRC WMS 구축 (영남QRC) - 서현','영남','','','영남QRC','','','','','완료','26.02.06','26.02.06','자재-구품-25-0050','경영-지품-26-1117','','김문기','서현텔레콤',''],
      [14,'자체공사','-','FKSM','자재관리팀','이상흡(퇴사) > 박준희','QRC WMS 구축 (여수QRC)','여수','','','여수QRC','','','','','Holding','7월중','','자재-구품-25-0050','','','김문기','',''],
    ];
    for (const s of samples) {
      db.run(`INSERT INTO constructions (no,gubun,req_date,corp,dept,requester,work_name,loc_region,loc_dong,loc_floor,loc_detail,move_region,move_dong,move_floor,move_detail,demolish_region,demolish_dong,demolish_floor,demolish_detail,status,deadline,complete_date,purchase_doc,payment_doc,related_doc,it_manager,worker,memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...s, '','','',''  ]);
    }
    saveDB();
  }
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
  const d = req.body;
  const lastNo = (queryOne('SELECT MAX(no) as m FROM constructions').m || 0);
  db.run(`INSERT INTO constructions (no,gubun,req_date,corp,dept,requester,work_name,loc_region,loc_dong,loc_floor,loc_detail,move_region,move_dong,move_floor,move_detail,demolish_region,demolish_dong,demolish_floor,demolish_detail,status,deadline,complete_date,purchase_doc,payment_doc,related_doc,it_manager,worker,memo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [lastNo+1,d.gubun,d.req_date,d.corp,d.dept,d.requester,d.work_name,d.loc_region,d.loc_dong,d.loc_floor,d.loc_detail,d.move_region,d.move_dong,d.move_floor,d.move_detail,d.demolish_region,d.demolish_dong,d.demolish_floor,d.demolish_detail,d.status,d.deadline,d.complete_date,d.purchase_doc,d.payment_doc,d.related_doc,d.it_manager,d.worker,d.memo]);
  saveDB();
  const newId = queryOne('SELECT last_insert_rowid() as id').id;
  recordHistory(newId, 'create', d.changed_by, [{ field: 'work_name', label: '공사명', before: '', after: d.work_name }]);
  saveDB();
  res.json({ id: newId, no: lastNo+1 });
});

app.put('/api/constructions/:id', (req, res) => {
  const d = req.body;
  const before = queryOne('SELECT * FROM constructions WHERE id = ?', [req.params.id]);
  db.run(`UPDATE constructions SET gubun=?,req_date=?,corp=?,dept=?,requester=?,work_name=?,loc_region=?,loc_dong=?,loc_floor=?,loc_detail=?,move_region=?,move_dong=?,move_floor=?,move_detail=?,demolish_region=?,demolish_dong=?,demolish_floor=?,demolish_detail=?,status=?,deadline=?,complete_date=?,purchase_doc=?,payment_doc=?,related_doc=?,it_manager=?,worker=?,memo=? WHERE id=?`,
    [d.gubun,d.req_date,d.corp,d.dept,d.requester,d.work_name,d.loc_region,d.loc_dong,d.loc_floor,d.loc_detail,d.move_region,d.move_dong,d.move_floor,d.move_detail,d.demolish_region,d.demolish_dong,d.demolish_floor,d.demolish_detail,d.status,d.deadline,d.complete_date,d.purchase_doc,d.payment_doc,d.related_doc,d.it_manager,d.worker,d.memo,req.params.id]);
  const diff = diffRecords(before, d);
  if (diff.length > 0) recordHistory(req.params.id, 'update', d.changed_by, diff);
  saveDB();
  res.json({ success: true });
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
  const headers = ['구분','요청일','법인','부서','요청자','공사명',
    '작업지역','작업동','작업층','작업상세위치',
    '철거지역','철거동','철거층','철거상세위치',
    '상태','기한일','작업완료일',
    '구매품의서','지출품의서','연관품의서',
    'IT관리팀 담당자','작업자','메모'];

  const example = ['자체공사','26.03.01','KSM','IT관리팀','김준기','HO동 3층 서버실 케이블 포설',
    '대곶','HO동','3F','서버실',
    '','','','',
    '완료','26.03.10','26.03.09',
    '경영-구품-26-0001','경영-지품-26-0001','',
    '이준성','김준기, 이준성','특이사항 없음'];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);

  // 컬럼 너비
  ws['!cols'] = headers.map((h, i) => ({ wch: i === 5 ? 40 : i < 6 ? 12 : 18 }));

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

    const headers = rows[0];
    const dataRows = rows.slice(1).filter(r => r.some(c => c !== undefined && c !== ''));

    const colIdx = (name) => headers.indexOf(name);

    let count = 0;
    let lastNo = (queryOne('SELECT MAX(no) as m FROM constructions').m || 0);

    for (const row of dataRows) {
      const get = (name) => {
        const i = colIdx(name);
        return i >= 0 ? (row[i] !== undefined ? String(row[i]).trim() : '') : '';
      };

      lastNo++;
      db.run(`INSERT INTO constructions (no,gubun,req_date,corp,dept,requester,work_name,
        loc_region,loc_dong,loc_floor,loc_detail,
        move_region,move_dong,move_floor,move_detail,
        demolish_region,demolish_dong,demolish_floor,demolish_detail,
        status,deadline,complete_date,
        purchase_doc,payment_doc,related_doc,it_manager,worker,memo)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [lastNo,
         get('구분'), get('요청일'), get('법인'), get('부서'), get('요청자'), get('공사명'),
         get('작업지역'), get('작업동'), get('작업층'), get('작업상세위치'),
         '','','','',
         get('철거지역'), get('철거동'), get('철거층'), get('철거상세위치'),
         get('상태'), get('기한일'), get('작업완료일'),
         get('구매품의서'), get('지출품의서'), get('연관품의서'),
         get('IT관리팀 담당자'), get('작업자'), get('메모')
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
  const headers = ['No','구분','요청일','법인','부서','요청자','공사명','작업지역','작업동','작업층','상세위치(작업전)','공사위치지역','공사위치동','공사위치층','상세위치(공사)','철거위치지역','철거위치동','철거위치층','상세위치(철거)','상태','기한일','작업완료일','구매품의서','지출품의서','연관품의서','IT관리팀 담당자','작업자','메모'];
  const data = [headers, ...rows.map(r => [r.no,r.gubun,r.req_date,r.corp,r.dept,r.requester,r.work_name,r.loc_region,r.loc_dong,r.loc_floor,r.loc_detail,r.move_region,r.move_dong,r.move_floor,r.move_detail,r.demolish_region,r.demolish_dong,r.demolish_floor,r.demolish_detail,r.status,r.deadline,r.complete_date,r.purchase_doc,r.payment_doc,r.related_doc,r.it_manager,r.worker,r.memo])];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = headers.map((h,i) => ({ wch: i===6?48:i<2?6:i<7?12:18 }));
  XLSX.utils.book_append_sheet(wb, ws, '2026 네트워크 공사 이력');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('2026_네트워크공사이력.xlsx')}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => app.listen(PORT, () => console.log(`✅ 서버 실행 중: http://localhost:${PORT}`)));
