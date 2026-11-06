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
  // 조회할 결재함 (전체문서함 권한이 없어서 부서함 기준)
  //   AppBoxDpDone=부서처리함, AppBoxDpWait=부서수신함, AppBoxCircul=사전참조함, AppBoxDpSp=부서문서함, AppBoxAll=전체문서함
  gwBoxes:     env('GW_BOXES', env('GW_BOX', 'AppBoxDpDone,AppBoxDpWait,AppBoxCircul')).split(',').map(s => s.trim()).filter(Boolean),
  // 결재 추적용 문서번호 검색 시 차례로 찾아볼 결재함 (부서처리함·부서발신함에서 대부분 찾음)
  trackBoxes:  env('TRACK_BOXES', 'AppBoxDpDone,AppBoxDpUp,AppBoxCircul,AppBoxDpSp,AppBoxDpWait,AppBoxUp,AppBoxDone,AppBoxIng,AppBoxWait').split(',').map(s => s.trim()).filter(Boolean),
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
  constructor(creds) { this.creds = creds; }
  async open() {
    this.browser = await chromium.launch({ headless: true });
    this.ctx = await this.browser.newContext({ ignoreHTTPSErrors: CFG.ignoreTls, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    await this.login();
  }
  async close() { try { await this.browser?.close(); } catch {} }

  // 로그인: 네트워크 오류만 재시도. 로그인 화면에서 넘어가지 않으면(비밀번호 오류·만료, 안내창 등)
  // 계정 잠김을 막기 위해 재시도하지 않고, 원인 파악용 정보(알림창 문구·화면 글자·스크린샷)를 남김
  async login(tries = 3) {
    for (let i = 1; ; i++) {
      const page = await this.ctx.newPage();
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.accept().catch(() => {}); });
      try {
        await page.goto(`${CFG.gwBase}/ubiWare/frame/auth/login.html`, { waitUntil: 'domcontentloaded' });
      } catch (e) {
        await page.close().catch(() => {});
        if (i >= tries) throw e;
        log(`[GW] 로그인 페이지 접속 재시도 ${i}/${tries - 1}: ${e.message.split('\n')[0]}`);
        await new Promise(r => setTimeout(r, 10000 * i));
        continue;
      }
      try {
        await page.fill('#loginId', this.creds.id);
        await page.fill('#loginPw', this.creds.pw);
        await Promise.all([
          page.waitForURL(u => !/\/auth\/login/.test(u.toString()), { timeout: 30000 }),
          page.press('#loginPw', 'Enter'),
        ]);
        log('[GW] 로그인 완료' + (dialogs.length ? ` (안내창: ${dialogs.join(' / ')})` : ''));
        return;
      } catch (e) {
        // 원인 정보 수집
        let bodyText = '';
        try {
          bodyText = await page.evaluate(() => {
            const vis = el => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null; };
            return [...document.querySelectorAll('div,span,p,td,label,font,b')]
              .filter(el => vis(el) && el.children.length === 0 && el.textContent.trim().length > 1)
              .map(el => el.textContent.trim()).filter(t => !/^\(\+\d\d:\d\d\)/.test(t))
              .join(' | ').slice(0, 400);
          });
        } catch {}
        const shot = path.join(path.dirname(CFG.stateFile), 'login-fail.png');
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        const err = new Error(`그룹웨어 로그인 실패 — 로그인 화면에서 넘어가지 않음. URL: ${page.url()}`
          + (dialogs.length ? ` | 알림창: ${dialogs.join(' / ')}` : ' | 알림창 없음')
          + (bodyText ? ` | 화면: ${bodyText}` : '')
          + ` | 스크린샷: ${shot}`);
        err.loginRejected = true;
        throw err;
      } finally {
        await page.close().catch(() => {});
      }
    }
  }

  // 결재 문서 목록 (grid.json)
  // 여러 결재함을 합쳐서 조회 (같은 문서는 한 번만)
  async listBoxes(boxes, formId, dateStart, docNo = '') {
    const seen = new Map();
    for (const box of boxes) {
      try {
        for (const d of await this.list(formId, dateStart, docNo, box)) if (!seen.has(d.docId)) seen.set(d.docId, d);
      } catch (e) {
        if (!this.boxErr?.has(box)) { (this.boxErr ||= new Set()).add(box); log(`[GW] ${box} 조회 실패(권한 없음?) — 건너뜀: ${e.message.slice(0, 120)}`); }
      }
    }
    return [...seen.values()];
  }

  async list(formId, dateStart, docNo = '', box = CFG.gwBoxes[0]) {
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
        `${CFG.gwBase}/ubiWare/ware/approval/apprDoc.html/grid.json?_mid=${box}`,
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
    // 결재함을 차례로 보며 처음 찾은 곳에서 멈춤
    for (const box of CFG.trackBoxes) {
      if (this.boxErr?.has(box)) continue;
      let list = [];
      try { list = await this.list('', '', docNo, box); }
      catch (e) { (this.boxErr ||= new Set()).add(box); log(`[GW] ${box} 조회 실패(권한 없음?) — 건너뜀`); continue; }
      const hit = list.find(d => (d.docNo || '').trim() === docNo);
      if (hit) return hit;
    }
    return null;
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

// 결재 현황에서 뺄 결재자 유형 (사전참조 / 사후참조 / 열람)
const SKIP_SIGNER_RE = new RegExp(env('SKIP_SIGNER_TYPES', 'Circul|Refer|Reader|Read'), 'i');
const seenSignerTypes = new Set();

function summarize(doc, signers) {
  for (const s of signers) {
    const k = `${s.signerType}/${s.signType}`;
    if (!seenSignerTypes.has(k)) { seenSignerTypes.add(k); log(`[TRACK] 결재자 유형 발견: ${k} (예: ${s.staffName})${SKIP_SIGNER_RE.test(s.signerType || '') ? ' → 제외' : ''}`); }
  }
  signers = signers.filter(s => !SKIP_SIGNER_RE.test(s.signerType || ''));
  const list = signers.map(s => ({
    name: s.staffName, level: s.levelName || '', dept: s.departName || '', type: s.signerType, signType: s.signType,
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
async function trackProgress(sessions, app) {
  const rows = await app.all();
  const docNos = new Set();
  const addDocs = v => { for (const m of String(v || '').match(DOC_NO_RE) || []) docNos.add(m); };
  for (const r of rows) for (const f of ['purchase_doc', 'payment_doc', 'related_doc']) addDocs(r[f]);
  // GW 접수함(검토 대기)과 방화벽 정책요청 문서도 결재선 추적
  for (const kind of ['construction', 'firewall'])
    for (const r of await app.call('GET', `/api/gw-inbox?kind=${kind}&status=pending`).catch(() => [])) addDocs(r.doc_no);
  for (const r of await app.call('GET', '/api/firewall').catch(() => [])) addDocs(r.doc);
  const known = Object.fromEntries((await app.gwStatus()).map(x => [x.doc_no, x]));
  // 최종 상태(승인/반려 등)는 다시 조회하지 않음
  // 최종 상태는 제외, 못 찾은 문서는 하루에 한 번만 다시 찾아봄
  const dayAgo = Date.now() - 864e5;
  const targets = [...docNos].filter(d => {
    const k = known[d];
    if (!k) return true;
    if (!k.found) return !k.checked_at || new Date(k.checked_at).getTime() < dayAgo;
    return !FINAL.includes(k.status);
  });
  const items = [];
  for (const docNo of targets) {
    try {
      // 계정별로 차례로 찾아봄 (계정마다 볼 수 있는 결재함이 다름)
      let doc = null, gw = null;
      for (const s of sessions) { doc = await s.findByDocNo(docNo); if (doc) { gw = s; break; } }
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
  if (CFG.fwFormIds.length) for (const f of CFG.fwFormIds) docs.push(...await gw.listBoxes(CFG.gwBoxes, f, since));
  else docs = (await gw.listBoxes(CFG.gwBoxes, '', since)).filter(d => CFG.fwFormRegex.test(d.formName || ''));
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
  return created;
}

// ── 그룹웨어 계정: 앱 설정 화면에 등록된 계정들 우선, 없으면 .env ──────────
let lastCredVersion = '';
async function getGwAccounts(app) {
  if (CFG.appUser) {
    try {
      const c = await app.call('GET', '/api/gw-settings/credentials');
      lastCredVersion = c.version || '';
      const list = (c.accounts || []).filter(a => a.gw_id && a.gw_pw).map(a => ({ id: a.gw_id, pw: a.gw_pw, source: '앱 설정' }));
      if (list.length) return list;
    } catch (e) { log(`[GW] 앱에서 계정 정보를 못 가져옴 (.env 사용): ${e.message}`); }
  }
  if (CFG.gwId && CFG.gwPw) return [{ id: CFG.gwId, pw: CFG.gwPw, source: '.env' }];
  throw Object.assign(new Error('그룹웨어 계정이 없습니다. 앱 설정 > 그룹웨어 수집 계정에서 등록하세요'), { loginRejected: true });
}
async function credVersionNow(app) {
  try { return (await app.call('GET', '/api/gw-settings/credentials')).version || ''; } catch { return lastCredVersion; }
}
async function reportLogin(app, gwId, ok, message) {
  if (!CFG.appUser || (CFG.dryRun && !CFG.appPw)) return;
  await app.call('POST', '/api/gw-settings/status', { gw_id: gwId, ok, message }).catch(() => {});
}

// 로그인이 거부된 계정은 계정 잠김을 막기 위해 60분(또는 계정 정보가 바뀔 때)까지 정기 실행에서 건너뜀
const rejected = new Map();   // gwId → { at, version }

// 로그인 후 수집 함수 (계정 하나 기준)
async function collectConstruction(gw, app, st, since) {
  let found = 0, created = 0;
  const docs = [];
  for (const f of CFG.formIds) docs.push(...await gw.listBoxes(CFG.gwBoxes, f, since));
  const fresh = docs.filter(d => !st.seen[d.docId]);
  log(`[GW:${gw.creds.id}] 구매품의서 ${docs.length}건 (신규 확인 대상 ${fresh.length}건, ${since}~, 결재함: ${CFG.gwBoxes.join('+')})`);
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
    if (CFG.dryRun) { log('[DRY] 등록 대상', JSON.stringify(rec)); continue; }   // dry-run은 상태 저장 안 함
    if (await app.exists(docNo)) log(`[APP] 이미 공사 이력에 있음: ${docNo}`);
    else {
      const r = await app.toInbox(d.docId, docNo, rec, hits);
      if (r.created) { created++; log(`[APP] GW 접수함에 추가: ${docNo} ${rec.work_name}`); }
      else log(`[APP] 이미 GW 접수함에 있음: ${docNo}`);
    }
    st.seen[d.docId] = { at: Date.now(), match: true, docNo };
  }
  log(`[GW:${gw.creds.id}] 신규 품의: 대상 ${found}건, GW 접수함 추가 ${created}건`);
  return created;
}

// ── 1회 실행: onlyId를 주면 그 계정만, manual이면 거부된 계정도 시도 ────────
async function runOnce({ onlyId = 'all', manual = false } = {}) {
  const st = loadState();
  const app = new App();
  let accounts = await getGwAccounts(app);
  if (onlyId && onlyId !== 'all') accounts = accounts.filter(a => a.id === onlyId);
  if (!accounts.length) throw new Error(`실행할 계정이 없습니다 (${onlyId})`);

  const sessions = [];
  let added = 0;
  const loginErrors = [];
  try {
    for (const acc of accounts) {
      const rj = rejected.get(acc.id);
      if (!manual && rj && rj.version === lastCredVersion && Date.now() - rj.at < 60 * 60e3) {
        log(`[GW:${acc.id}] 최근 로그인 거부 → 계정 잠김 방지를 위해 이번 회차 건너뜀`);
        loginErrors.push({ id: acc.id, rejected: true, message: '최근 로그인 거부로 건너뜀' });
        continue;
      }
      const gw = new Groupware(acc);
      try {
        await gw.open();
        rejected.delete(acc.id);
        await reportLogin(app, acc.id, true, `${acc.source}`);
        sessions.push(gw);
      } catch (e) {
        await gw.close();
        if (e.loginRejected) rejected.set(acc.id, { at: Date.now(), version: lastCredVersion });
        await reportLogin(app, acc.id, false, e.message.split(' | 스크린샷')[0].slice(0, 400));
        log(`[GW:${acc.id}] 로그인 실패: ${e.message.split('\n')[0]}`);
        loginErrors.push({ id: acc.id, rejected: !!e.loginRejected, message: e.message.split(' | ')[0] });
      }
    }
    if (!sessions.length) {
      const err = new Error(`모든 계정 로그인 실패: ${loginErrors.map(x => `${x.id} — ${x.message}`).join(' / ')}`);
      err.loginRejected = loginErrors.every(x => x.rejected);
      throw err;
    }

    const since = ymdSlash(new Date(Date.now() - CFG.lookbackDays * 864e5));
    for (const gw of sessions) {
      added += await collectConstruction(gw, app, st, since);
      if (CFG.fwEnabled) added += await collectFirewall(gw, app, st, since);
    }
    if (CFG.track && CFG.appUser) await trackProgress(sessions, app);
    return { added, accounts: sessions.map(s => s.creds.id), loginErrors };
  } finally {
    for (const s of sessions) await s.close();
    if (!CFG.dryRun) saveState(st);
  }
}

// ── 앱의 '지금 검색' 요청 확인 ──────────────────────────────
let handledRunId = '';
async function checkRunRequest(app) {
  if (!CFG.appUser) return null;
  try {
    const r = await app.call('GET', '/api/gw-run');
    if (r && r.id && r.state === 'requested' && r.id !== handledRunId) return r;
  } catch {}
  return null;
}
async function handleRunRequest(app, req) {
  handledRunId = req.id;
  const report = (state, message, added) => app.call('POST', `/api/gw-run/${req.id}/status`, { state, message, added }).catch(() => {});
  log(`[RUN] 지금 검색 요청 (${req.by || '-'}, 계정: ${req.gw_id})`);
  await report('running', '검색 중…');
  try {
    const r = await runOnce({ onlyId: req.gw_id, manual: true });
    const warn = r.loginErrors.length ? ` · 로그인 실패: ${r.loginErrors.map(x => x.id).join(', ')}` : '';
    await report('done', `완료 — 계정 ${r.accounts.join(', ')}, GW 접수함 추가 ${r.added}건${warn}`, r.added);
  } catch (e) {
    await report('error', e.message.split('\n')[0].slice(0, 400), 0);
    log('[RUN] 실패:', e.message.split('\n')[0]);
  }
}

// 다음 정기 실행까지 기다리는 동안: 15초마다 '지금 검색' 요청 확인, 5분마다 계정 변경 확인
async function waitWithPolling(minutes, { breakOnCredChange = false } = {}) {
  const app = new App(), until = Date.now() + minutes * 60e3, before = lastCredVersion;
  let nextCredCheck = Date.now() + 5 * 60e3;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, Math.min(15e3, Math.max(0, until - Date.now()))));
    const req = await checkRunRequest(app);
    if (req) await handleRunRequest(app, req);
    if (breakOnCredChange && Date.now() >= nextCredCheck) {
      nextCredCheck = Date.now() + 5 * 60e3;
      const v = await credVersionNow(app);
      if (v && v !== before) { log('[GW] 앱 설정에서 계정이 변경됨 → 바로 다시 시도'); return; }
    }
  }
}

async function main() {
  // 그룹웨어 계정은 앱 설정 화면 또는 .env(GW_ID/GW_PW) 중 하나만 있으면 됨
  for (const k of CFG.dryRun ? [] : ['APP_USER', 'APP_PW'])
    if (!process.env[k]) { console.error(`환경변수 ${k} 필요`); process.exit(1); }
  if (!CFG.appUser && !(CFG.gwId && CFG.gwPw)) { console.error('GW_ID/GW_PW 또는 APP_USER/APP_PW 필요'); process.exit(1); }
  // docker stop 시 바로 종료 (기본 동작이면 10초 기다렸다 강제 종료 → exit 137)
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log(`${sig} 수신, 종료`); process.exit(0); });
  do {
    let failed = false, loginRejected = false;
    try { await runOnce(); }
    catch (e) {
      failed = true; loginRejected = !!e.loginRejected;
      log('[ERR]', e.message.split('\n')[0], e.cause ? `(${e.cause.code || ''} ${e.cause.message || e.cause})` : '');
    }
    if (CFG.runOnce) break;
    // 네트워크 등 일시 오류는 5분 뒤, 모든 계정 로그인 거부는 60분 뒤(계정 변경 시 즉시), 정상이면 설정 주기대로
    const wait = loginRejected ? Math.max(60, CFG.intervalMin) : failed ? Math.min(5, CFG.intervalMin) : CFG.intervalMin;
    if (loginRejected) log('[ERR] 그룹웨어 계정·비밀번호를 확인하세요 (비밀번호 만료/변경, 계정 잠김 등). 앱 설정 > 그룹웨어 수집 계정에서 수정하면 5분 안에 다시 시도합니다');
    if (failed) log(`[ERR] ${wait}분 뒤 다시 시도`);
    await waitWithPolling(wait, { breakOnCredChange: loginRejected });
  } while (true);
}

if (require.main === module) main();
module.exports = { parseView, isTarget, corpOf, regionOf, yymmdd, summarize };
