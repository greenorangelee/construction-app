// 실제 품의서(docId 725516) 구조를 축약한 픽스처로 파서 검증
const assert = require('assert');
const { parseView, isTarget, corpOf, regionOf, yymmdd, summarize } = require('./index');
const html = `<html><body>
<table><tr><td><table><tr><th>문서번호</th><td>품질-구품-26-1031</td></tr>
<tr><th>기안부서</th><td>품질보증팀</td><th>기 안 자</th><td>김희/사원</td></tr>
<tr><th>기안일자</th><td>2026/10/21</td></tr>
<tr><th>제 목</th><td>검단공장 2층 크린룸 내 랜선 포설 요청 건</td></tr></table></td></tr></table>
<table><tr><td><table>
<tr><td class="ubi-grid-header-td">품명</td><td>규격/품목코드</td><td>단위</td><td>수량</td><td>단가</td><td>예상금액</td><td>요구납기일</td><td>비고(업체명)</td></tr>
<tr><td>전산용품 / (기타) 랜선포설</td><td>ZMXZ001081</td><td>EA</td><td>1</td><td>1 / KRW</td><td>1 / KRW</td><td>2026-10-21</td><td>랜선 포설 요청 / 검사</td></tr>
</table></td></tr></table>
<table><tr><th>기안부서<br>의견</th><td><span>1. 랜선 포설 위치&nbsp;<br>- 검단공장 2층 크린룸 내<br><br>2. 포설 요청 사유<br>- 공정 보고 PC 신규 설치로 인한 포설 요청<br><br><br><br>*레이아웃 첨부</span></td><th>수신부서 의견</th><td></td></tr></table>
</body></html>`;
const v = parseView(html);
console.log(v);
assert.equal(v.docNo, '품질-구품-26-1031');
assert.equal(v.writer, '김희');
assert.equal(v.title, '검단공장 2층 크린룸 내 랜선 포설 요청 건');
assert.equal(v.items.length, 1);
assert.equal(isTarget(v.items).length, 1);
assert.equal(isTarget([{ name: '전산용품 / 공정용 데스크탑', code: 'ZMXZ000090' }]).length, 0);
assert.ok(v.memo.startsWith('1. 랜선 포설 위치\n- 검단공장'));
assert.ok(!/\n{3,}/.test(v.memo));
assert.equal(corpOf('케이에스엠컴포넌트'), 'KSMC');
assert.equal(corpOf('케이에스엠'), 'KSM');
assert.equal(regionOf('하성공장 1층'), '하성');
assert.equal(regionOf('검단공장 2층'), '');
assert.equal(yymmdd('2026/10/21 13:58:00.233'), '26.10.21');
// 실제 loadSignStatus.json 응답(docId 725516) 형태
const sg = (n, l, d, type, proc, wait) => ({ staffName: n, levelName: l, departName: d, signerType: type, processTime: proc, wait, hidden: false });
const sum = summarize({ docNo: '품질-구품-26-1031', docId: 725516, title: 't', formName: '구매품의서(C)', status: 'Ing', decideTime: '1900/01/01 00:00:00.000' }, [
  sg('김희', '사원', '품질보증팀', 'Writer', '2026/10/21 13:58:00.233', false),
  sg('김경석', '과장', '품질보증팀', 'Signer', '2026/10/21 14:02:53.380', false),
  sg('김종성', '팀장', '품질보증팀', 'Signer', '2026/10/21 15:31:19.413', false),
  sg('이준성', '사원', 'IT관리팀', 'Added1', '1900/01/01 00:00:00.000', true),
]);
console.log(sum);
assert.equal(sum.step_done, 2); assert.equal(sum.step_total, 3);
assert.equal(sum.current_signer, '이준성(IT관리팀)'); assert.equal(sum.status_label, '진행 중');
assert.equal(sum.decided_at, '');
// 요청기간 파싱
// 실제 방화벽 정책 요청서(docId 725134) 구조
const fv = parseView(`<table><tr><th>문서번호</th><td>기술-보안-26-0166</td></tr><tr><th>제 목</th><td>PLM 인터페이스를 위한 중간 DB 접근 방화벽 해제 요청</td></tr></table>
<table><tr><th>요청기간</th><td>2026/10/19 ~ 2099/12/31</td><th>용도</th><td>PLM 인터페이스용 (시스템 사용 종료전까지 유지 필요)</td></tr>
<tr><th rowspan="11">요청내역</th><th>출발지</th><th>출발지 포트</th><th>목적지</th><th>목적지 포트</th><th>상세용도</th></tr>
<tr><td>172.16.2.188</td><td>80(HTTP), 443(HTTPS)</td><td>172.30.11.4</td><td>1433</td><td>SSMS, JDBC 연결 용도.</td></tr>
<tr><td>172.30.23.4</td><td>80(HTTP), 443(HTTPS)</td><td>172.30.11.4</td><td>1433</td><td>JDBC 연결 용도.</td></tr>
<tr><td></td><td></td><td></td><td></td><td></td></tr>
<tr><th>주의사항</th><td>■ 개인적인 용도...</td></tr></table>`);
assert.equal(fv.periodFrom, '2026/10/19'); assert.equal(fv.periodTo, '2099/12/31');
assert.equal(fv.purpose, 'PLM 인터페이스용 (시스템 사용 종료전까지 유지 필요)');
assert.equal(fv.fwRules.length, 2); assert.equal(fv.fwRules[0].dstPort, '1433');
console.log(fv.fwRules);
console.log('OK');
