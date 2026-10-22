// 그룹웨어(ubiWare) 구매품의서 → 공사 이력 자동 등록 수집기
// - 로그인만 Playwright(헤드리스 Chromium)로 처리하고, 이후 목록/본문은 같은 세션 쿠키로 직접 요청
// - 목록: /ubiWare/ware/approval/apprDoc.html/grid.json (JSON)
// - 본문: /ubiWare/ware/approval/apprViewForm.html?docId=... (HTML, 품명 표 파싱)
// - 품명이 '랜선포설'(또는 품목코드 ZMXZ001081)인 품의서를 construction-app의 'GW 접수' 탭에 넣음 (사람이 검토 후 공사 이력에 등록)

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { chromium } = require('playwright');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

const CFG = {
  gwBase:      env('GW_BASE', 'https://gw.ksm.co.kr'),
  gwId:        env('GW_ID'),
  gwPw:        env('GW_PW'),
  gwBox:       env('GW_BOX', 'AppBoxAll'),            // 전체문서함
  formIds:     env('GW_FORM_IDS', 'PHUCHASEDRAFT,PHUCHASEDRAFTC,PHUCHASEDRAFTCM,PHUCHASEDRAFTK').split(',').map(s => s.trim()).filter(Boolean),
  facilities:  env('GW_FACILITIES', 'KSM100|20170101,KSM200|20170101,KSM300|20170101,KSM400|20170101,KSM500|20170101,KSM2000|20200601,KSM701|20260211,KSM800|20170101,KSM1001|20260211,KSM1100|20211201').split(',').map(s => s.trim()).filter(Boolean),
  lookbackDays: parseInt(env('LOOKBACK_DAYS', '30'), 10),
  itemRegex:   new RegExp(env('ITEM_REGEX', '랜선\\s*포설')),
  itemCodes:   env('ITEM_CODES', 'ZMXZ001081').split(',').map(s => s.trim()).filter(Boolean),
  ignoreTls:   env('GW_IGNORE_TLS', '0') === '1',

  appBase:     env('APP_BASE', 'http://172.16.2.157:3001'),
  appUser:     env('APP_USER'),
  appPw:       env('APP_PW'),
  gubun:       env('DEFAULT_GUBUN', '접수'),
  status:      env('DEFAULT_STATUS', '진행중'),
  itManager:   env('DEFAULT_IT_MANAGER', ''),

  intervalMin: parseInt(env('INTERVAL_MIN', '30'), 10),
  runOnce:     env('RUN_ONCE', '0') === '1',
  track:       env('TRACK_PROGRESS', '1') === '1',
  // 방화벽 정책 요청서: 양식 ID를 알면 지정, 비우면 양식 이름에 '방화벽'이 들어간 문서를 찾음
  fwEnabled:   env('FW_ENABLED', '1') === '1',
  fwFormIds:   env('GW_FW_FORM_IDS', 'SCRTYFRWLPRQ').split(',').map(s => s.trim()).filter(Boolean),
  fwFormRegex: new RegExp(env('FW_FORM_REGEX', '방화벽')),
  dryRun:      env('DRY_RUN', '0') === '1',
  stateFile:   env('STATE_FILE', '/data/state.json'),
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── 상태(이미 확인한 docId) ─────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')); }
  catch { return { seen: {} }; }
}
function saveState(st) {
  // 60일 지난 기록 정리
  const cutoff = Date.now() - 60 * 864e5;
  for (const [id, v] of Object.entries(st.seen)) if (v.at < cutoff) delete st.seen[id];
  fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });
  fs.writeFileSync(CFG.stateFile, JSON.stringify(st, null, 1));
}

// ── 공통 매핑 ────────────────────────────────────────
const CORP_MAP = [
  [['케이에스엠컴포넌트', 'KSMC'], 'KSMC'],
  [['케이에스엠페로텍', 'KSMF'], 'KSMF'],
  [['한국씰마스타', 'FKSM'], 'FKSM'],
  [['와이에이치이', 'YHE'], 'YHE'],
  [['케이에스엠', '케이.에스.엠', 'KSM'], 'KSM'],
];
const corpOf = (s = '') => (CORP_MAP.find(([ks]) => ks.some(k => s.includes(k))) || [, ''])[1];

const REGION_MAP = [
  [/검단\s*1\s*공장/, '검단 1공장'], [/검단\s*2\s*공장/, '검단 2공장'],
  [/대곶/, '대곶'], [/대산/, '대산'], [/대포/, '대포'], [/동탄/, '동탄'],
  [/여수/, '여수'], [/영남/, '영남'], [/하성/, '하성'],
];
const regionOf = (s = '') => (REGION_MAP.find(([re]) => re.test(s)) || [, ''])[1];

// '2026/10/21 13:58:00.233' → '26.10.21'
const yymmdd = (s = '') => {
  const m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  return m ? `${m[1].slice(2)}.${m[2].padStart(2, '0')}.${m[3].padStart(2, '0')}` : '';
};
const ymdSlash = d => `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
const clean = s => (s || '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();

// ── 그룹웨어 ─────────────────────────────────────────
class Groupware {
  async open() {
    this.browser = await chromium.launch({ headless: true });
    this.ctx = await this.browser.newContext({ ignoreHTTPSErrors: CFG.ignoreTls, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    await this.login();
  }
  async close() { try { await this.browser?.close(); } catch {} }

  async login() {
    const page = await this.ctx.newPage();
    await page.goto(`${CFG.gwBase}/ubiWare/frame/auth/login.html`, { waitUntil: 'domcontentloaded' });
    await page.fill('#loginId', CFG.gwId);
    await page.fill('#loginPw', CFG.gwPw);
    await Promise.all([
      page.waitForURL(u => !/\/auth\/login/.test(u.toString()), { timeout: 30000 }),
      page.press('#loginPw', 'Enter'),
    ]);
    await page.close();
    log('[GW] 로그인 완료');
  }

  // 결재 문서 목록 (grid.json)
  async list(formId, dateStart, docNo = '') {
    const out = [];
    for (let start = 0; ; start += 100) {
      const p = new URLSearchParams();
      const fields = {
        start, sort: 'baseTime', dir: 'DESC', keyword: '', title: '', writer: '', signer: '', next: '',
        writerJob: '', impler: '', docNo, conductDepartName: '', formId, facility: '', status: '',
        readStatus: '', afterReadStatus: '', afterConfirmStatus: '', body: '', comment: '', fileName: '',
        dateStart, dateEnd: '', useNext: 'false', formIdList: '', statusList: '',
      };
      for (const [k, v] of Object.entries(fields)) p.append(k, String(v));
      for (const f of CFG.facilities) p.append('facilityList', f);
      p.append('useConductDepart', 'false');
      p.append('limit', '100');

      const res = await this.ctx.request.post(
        `${CFG.gwBase}/ubiWare/ware/approval/apprDoc.html/grid.json?_mid=${CFG.gwBox}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, data: p.toString() });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`grid.json 응답이 JSON이 아님(세션 만료?) status=${res.status()}`); }
      if (!Array.isArray(j.list)) throw new Error(`grid.json 오류: ${text.slice(0, 200)}`);
      out.push(...j.list);
      if (j.list.length < 100 || out.length >= (j.totalCount || 0)) break;
    }
    return out;
  }

  // 품의서 본문(HTML) 파싱
  async view(docId) {
    const url = `${CFG.gwBase}/ubiWare/ware/approval/apprViewForm.html?docId=${docId}&fId=DocList&from=DocList&folderId=&receivedDocId=&index=1`;
    const res = await this.ctx.request.get(url);
    const html = await res.text();
    if (res.status() !== 200) throw new Error(`본문 조회 실패 docId=${docId} status=${res.status()}`);
    return parseView(html);
  }

  // 문서번호로 문서 찾기 (정확히 일치하는 것만)
  async findByDocNo(docNo) {
    const list = await this.list('', '', docNo);
    return list.find(d => (d.docNo || '').trim() === docNo) || null;
  }

  // 결재선 진행 상황 (읽기 전용 API)
  async signStatus(docId) {
    const res = await this.ctx.request.post(`${CFG.gwBase}/ubiWare/ware/approval/apprView.html/loadSignStatus.json`,
      { headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }, data: JSON.stringify({ docId }) });
    const j = JSON.parse(await res.text());
    return (j.signers || []).filter(s => !s.hidden);
  }
}

const STATUS_LABEL = { Temp: '임시저장', Ready: '상신대기', Start: '상신', Ing: '진행 중', Appr: '승인', Return: '반려',
  Refusal: '거부', ApprEnd: '종결', ApprEnd2: '승인/종결', Cancel: '상신취소' };
const FINAL = ['Appr', 'ApprEnd', 'ApprEnd2', 'Return', 'Refusal', 'Cancel'];
const validTime = t => (t && !t.startsWith('1900') ? t.slice(0, 16) : '');

function summarize(doc, signers) {
  const list = signers.map(s => ({
    name: s.staffName, level: s.levelName || '', dept: s.departName || '', type: s.signerType,
    done: validTime(s.processTime), wait: !!s.wait,
  }));
  const steps = list.filter(s => s.type !== 'Writer');
  const waiting = list.filter(s => s.wait);
  return {
    doc_no: doc.docNo, doc_id: doc.docId, title: doc.title, form_name: doc.formName,
    status: doc.status, status_label: STATUS_LABEL[doc.status] || doc.status,
    step_done: steps.filter(s => s.done).length, step_total: steps.length,
    current_signer: waiting.map(s => `${s.name}(${s.dept})`).join(', '),
    signers: list, decided_at: validTime(doc.decideTime), found: true,
  };
}

function parseView(html) {
  const $ = cheerio.load(html);
  const field = label => {
    const th = $('th,td').filter((_, el) => clean($(el).text()).replace(/\s/g, '') === label && $(el).find('table').length === 0).first();
    return th.length ? th.next() : null;
  };
  const text = el => (el ? clean(el.text()) : '');

  // 품목 표: 첫 행이 '품명'으로 시작하고 중첩 표가 없는 table
  const items = [];
  $('table').each((_, t) => {
    const $t = $(t);
    if ($t.find('table').length) return;
    const rows = $t.find('tr');
    if (!/^\s*품명/.test(rows.first().text())) return;
    rows.slice(1).each((_, tr) => {
      const c = $(tr).find('td').map((_, td) => clean($(td).text())).get();
      if (c.length < 4 || !c[0]) return;
      items.push({ name: c[0], code: c[1], unit: c[2], qty: c[3], price: c[4], amount: c[5], due: c[6], note: c[7] });
    });
  });

  // 기안부서 의견 (<br> → 줄바꿈)
  let memo = '';
  const memoCell = field('기안부서의견');
  if (memoCell) {
    const h = memoCell.html() || '';
    memo = cheerio.load(h.replace(/<br\s*\/?>/gi, '\n')).text()
      .replace(/ /g, ' ').split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 요청기간 (라벨에 '기간'이 들어간 칸에서 날짜 2개)
  let periodFrom = '', periodTo = '';
  $('th,td').each((_, el) => {
    if (periodFrom) return;
    const lab = clean($(el).text()).replace(/\s/g, '');
    if (!/기간$/.test(lab) || $(el).find('table').length) return;
    const ds = clean($(el).next().text()).match(/\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/g) || [];
    if (ds.length) { periodFrom = ds[0]; periodTo = ds[1] || ''; }
  });

  // 방화벽 요청내역 표: 헤더 행(출발지/출발지 포트/목적지/목적지 포트/상세용도) 아래 행들
  const fwRules = [];
  const srcTh = $('th').filter((_, el) => clean($(el).text()) === '출발지').first();
  if (srcTh.length) {
    let tr = srcTh.closest('tr').next();
    while (tr.length) {
      const c = tr.children('td,th').map((_, td) => clean($(td).text())).get();
      if (tr.children('th').length) break;              // '주의사항' 등 다음 구역
      if (c.length >= 4 && c.some(Boolean)) fwRules.push({ src: c[0], srcPort: c[1], dst: c[2], dstPort: c[3], desc: c[4] || '' });
      tr = tr.next();
    }
  }

  return {
    periodFrom, periodTo, fwRules,
    purpose: text(field('용도')),
    docNo: text(field('문서번호')),
    writer: text(field('기안자')).split('/')[0].trim(),
    date: text(field('기안일자')),
    dept: text(field('기안부서')),
    title: text(field('제목')),
    items, memo,
  };
}

const isTarget = items => items.filter(it => CFG.itemRegex.test(it.name) || CFG.itemCodes.includes(it.code));

// ── construction-app ─────────────────────────────────
class App {
  async login() {
    const r = await fetch(`${CFG.appBase}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: CFG.appUser, password: CFG.appPw }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`앱 로그인 실패: ${j.error}`);
    this.token = j.token;
  }
  async call(method, p, body) {
    if (!this.token) await this.login();
    const go = () => fetch(`${CFG.appBase}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    let r = await go();
    if (r.status === 401) { await this.login(); r = await go(); }
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${j.error || ''}`);
    return j;
  }
  async exists(docNo) {
    const rows = await this.call('GET', `/api/constructions?search=${encodeURIComponent(docNo)}`);
    return rows.some(r => (r.purchase_doc || '').trim() === docNo);
  }
  toInbox(docId, docNo, data, items, kind = 'construction') { return this.call('POST', '/api/gw-inbox', { doc_id: docId, doc_no: docNo, data, items, kind }); }
  async fwExists(docNo) { return (await this.call('GET', `/api/firewall-doc-exists?doc=${encodeURIComponent(docNo)}`)).exists; }
  all() { return this.call('GET', '/api/constructions'); }
  gwStatus() { return this.call('GET', '/api/gw-status'); }
  putGwStatus(items) { return this.call('PUT', '/api/gw-status', { items }); }
}

// ── 결재 진행 추적: 공사 이력에 적힌 문서번호의 결재선을 갱신 ───────────
const DOC_NO_RE = /[가-힣A-Za-z]+-[가-힣A-Za-z]+-\d{2}-\d{3,5}/g;
async function trackProgress(gw, app) {
  const rows = await app.all();
  const docNos = new Set();
  for (const r of rows) for (const f of ['purchase_doc', 'payment_doc', 'related_doc'])
    for (const m of String(r[f] || '').match(DOC_NO_RE) || []) docNos.add(m);
  const known = Object.fromEntries((await app.gwStatus()).map(x => [x.doc_no, x]));
  // 최종 상태(승인/반려 등)는 다시 조회하지 않음
  const targets = [...docNos].filter(d => !known[d] || !FINAL.includes(known[d].status));
  const items = [];
  for (const docNo of targets) {
    try {
      const doc = await gw.findByDocNo(docNo);
      if (!doc) { items.push({ doc_no: docNo, found: false }); continue; }
      const it = summarize(doc, await gw.signStatus(doc.docId));
      const before = known[docNo];
      if (before && (before.status !== it.status || before.step_done !== it.step_done))
        log(`[TRACK] ${docNo} ${before.status_label}→${it.status_label} ${it.step_done}/${it.step_total} ${it.current_signer}`);
      items.push(it);
    } catch (e) { log(`[TRACK] ${docNo} 조회 실패: ${e.message}`); }
  }
  if (items.length && !CFG.dryRun) await app.putGwStatus(items);
  log(`[TRACK] 문서 ${docNos.size}개 중 ${targets.length}개 확인${CFG.dryRun ? ' (DRY_RUN: 저장 안 함)' : ''}`);
}

// ── 방화벽 정책 요청서 수집 ─────────────────────────────
async function collectFirewall(gw, app, st, since) {
  let docs = [];
  if (CFG.fwFormIds.length) for (const f of CFG.fwFormIds) docs.push(...await gw.list(f, since));
  else docs = (await gw.list('', since)).filter(d => CFG.fwFormRegex.test(d.formName || ''));
  const fresh = docs.filter(d => !st.seen['fw' + d.docId] && !['Return', 'Refusal', 'Cancel', 'Temp'].includes(d.status));
  const forms = [...new Set(docs.map(d => `${d.formName}(${d.formId})`))].join(', ');
  log(`[GW] 방화벽 정책 요청서 ${docs.length}건 (신규 ${fresh.length}건)${forms ? ' 양식: ' + forms : ''}`);
  let created = 0;
  for (const d of fresh) {
    const v = await gw.view(d.docId);
    const docNo = v.docNo || d.docNo;
    const url = `${CFG.gwBase}/ubiWare/ware/approval/apprView.html?docId=${d.docId}&fId=DocList&from=DocList&folderId=`;
    const rec = {
      req_date: yymmdd(v.date || d.startTime),
      corp: corpOf(d.conductFacilityName || ''),
      dept: v.dept || d.conductDepartName || '',
      requester: v.writer || d.writerName || '',
      title: v.title || d.title,
      doc: docNo,
      status: '결재 대기중',
      worker: CFG.itManager,
      period_from: yymmdd(v.periodFrom),
      period_to: yymmdd(v.periodTo),
      memo: [
        v.purpose ? `용도: ${v.purpose}` : '',
        v.fwRules.length ? '[요청내역]\n' + v.fwRules.map(r => `- ${r.src}${r.srcPort ? ':' + r.srcPort : ''} → ${r.dst}${r.dstPort ? ':' + r.dstPort : ''}${r.desc ? ' (' + r.desc + ')' : ''}`).join('\n') : '',
        v.memo,
        `품의서: ${url}`,
      ].filter(Boolean).join('\n\n'),
    };
    if (CFG.dryRun) { log('[DRY] 방화벽 접수 대상', JSON.stringify(rec)); continue; }
    if (await app.fwExists(docNo)) log(`[APP] 이미 방화벽 정책요청에 있음: ${docNo}`);
    else {
      const r = await app.toInbox(d.docId, docNo, rec, v.fwRules, 'firewall');
      if (r.created) { created++; log(`[APP] GW 접수함(방화벽)에 추가: ${docNo} ${rec.title}`); }
    }
    st.seen['fw' + d.docId] = { at: Date.now(), match: true, docNo };
  }
  log(`방화벽 정책: GW 접수함 추가 ${created}건`);
}

// ── 1회 실행 ─────────────────────────────────────────
async function runOnce() {
  const st = loadState();
  const gw = new Groupware();
  const app = new App();
  let found = 0, created = 0;
  try {
    await gw.open();
    const since = ymdSlash(new Date(Date.now() - CFG.lookbackDays * 864e5));
    const docs = [];
    for (const f of CFG.formIds) docs.push(...await gw.list(f, since));
    const fresh = docs.filter(d => !st.seen[d.docId]);
    log(`[GW] 구매품의서 ${docs.length}건 (신규 확인 대상 ${fresh.length}건, ${since}~)`);

    for (const d of fresh) {
      const v = await gw.view(d.docId);
      const hits = isTarget(v.items);
      if (!hits.length) { st.seen[d.docId] = { at: Date.now(), match: false }; continue; }
      found++;

      const docNo = v.docNo || d.docNo;
      const rec = {
        gubun: CFG.gubun,
        req_date: yymmdd(v.date || d.startTime),
        corp: corpOf(d.conductFacilityName || ''),
        dept: v.dept || d.conductDepartName || '',
        requester: v.writer || d.writerName || '',
        work_name: v.title || d.title,
        loc_region: regionOf(`${v.title} ${v.memo}`),
        status: CFG.status,
        purchase_doc: docNo,
        it_manager: CFG.itManager,
        memo: [v.memo, '', `[GW 자동등록] docId ${d.docId} / 품목: ${hits.map(h => `${h.name} x${h.qty}`).join(', ')}`].join('\n').trim(),
        doc_url: `${CFG.gwBase}/ubiWare/ware/approval/apprView.html?docId=${d.docId}&fId=DocList&from=DocList&folderId=`,
        changed_by: 'GW자동등록',
      };

      if (CFG.dryRun) {
        log('[DRY] 등록 대상', JSON.stringify(rec));
        continue;   // dry-run은 상태 저장 안 함
      }
      if (await app.exists(docNo)) {
        log(`[APP] 이미 공사 이력에 있음: ${docNo}`);
      } else {
        const r = await app.toInbox(d.docId, docNo, rec, hits);
        if (r.created) { created++; log(`[APP] GW 접수함에 추가: ${docNo} ${rec.work_name}`); }
        else log(`[APP] 이미 GW 접수함에 있음: ${docNo}`);
      }
      st.seen[d.docId] = { at: Date.now(), match: true, docNo };
    }
    log(`신규 품의: 대상 ${found}건, GW 접수함 추가 ${created}건`);
    if (CFG.fwEnabled) await collectFirewall(gw, app, st, since);
    if (CFG.track && CFG.appUser) await trackProgress(gw, app);
  } finally {
    await gw.close();
    if (!CFG.dryRun) saveState(st);
  }
}

async function main() {
  for (const k of ['GW_ID', 'GW_PW', ...(CFG.dryRun ? [] : ['APP_USER', 'APP_PW'])])
    if (!process.env[k]) { console.error(`환경변수 ${k} 필요`); process.exit(1); }
  do {
    try { await runOnce(); } catch (e) { log('[ERR]', e.message, e.cause ? `(${e.cause.code || ''} ${e.cause.message || e.cause})` : ''); }
    if (CFG.runOnce) break;
    await new Promise(r => setTimeout(r, CFG.intervalMin * 60e3));
  } while (true);
}

if (require.main === module) main();
module.exports = { parseView, isTarget, corpOf, regionOf, yymmdd, summarize };
