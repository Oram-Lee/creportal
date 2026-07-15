/**
 * mreport-pptx.js — 오피스 마켓 리포트 PPTX 내보내기 (v1.3.1)
 *
 * 사용: mreport-main.js › MR.exportPptx() 에서 동적 import 후 exportReportPPTX(model) 호출
 * 전제: market-report.html 에 pptxgenjs CDN(전역 PptxGenJS) 로드됨
 *
 * v1.3.1 캘리브레이션:
 *  - 서체 Pretendard (웹과 동일). ⚠ PPTX 는 폰트 임베드 불가 → 여는 PC에 프리텐다드가
 *    없으면 PowerPoint 가 대체 서체(보통 맑은 고딕)로 표시함.
 *  - 크기 기준: 웹 CSS px × 0.75 = pt (A4 물리 동일 크기) + 가독 바이어스 ≈ +15%
 *  - 여백 개선: 요약 페이지를 표 대신 웹과 동일한 "공실률 카드 6장(2×3)" 그리드로 복원,
 *    행 높이·카드 높이 상향으로 페이지 충전율을 웹 수준으로 맞춤
 *
 * 설계 노트(유지):
 *  - A4 세로(8.27×11.69in) 커스텀 레이아웃 — 웹 리포트와 동일 판형
 *  - 모델 → 슬라이드 재구성이므로 [자동] 배지 등 편집 전용 UI 는 포함되지 않음
 *  - 차트는 화면 canvas(#mrLeaseChart) PNG 캡처 삽입 (datalabels 포함)
 *  - 표지/백커버 배경은 동일 출처 fetch → dataURL, 실패 시 단색 폴백
 */

import {
  MR_REGIONS, MR_REGION_LABEL, MR_REGION_SHORT,
  quarterLabel, deltaText, fmtRate,
} from './mreport-data.js?v=1.3.1';

/* ── 팔레트 (market-report.html :root 동일) ── */
const C = {
  red: 'E8135C', redDk: 'C41042', pinkBg: 'FDEDF3', greyBg: 'F0F0F2',
  dark: '1B1418', navy: '2E4057', navyLt: 'C3CDD9',
  text: '222222', muted: '9A9AA2', line: 'E3E3E8', thead: 'F5F7FA',
  white: 'FFFFFF', insBg: 'F4F4F6',
};
const FONT = 'Pretendard';
const W = 8.27, H = 11.69, MG = 0.55;           // A4 세로(in), 좌우 여백(웹 14mm)
const CW = W - MG * 2;

/* ── 타이포 스케일 (웹 px×0.75 + 바이어스) ── */
const FS = {
  headerNo: 18, headerNoLbl: 8.5, headerTitle: 20,
  centerTitle: 15,
  kpBadge: 11, kpTitle: 12, kpBody: 11,
  cardLabel: 10, cardDelta: 9, cardValue: 22, cardSub: 8.5,
  kwBig: 20, kwLabel: 11, kwSub: 9,
  tblTitle: 13, tblMeta: 8.5, tbl: 11,
  insLabel: 11, insTitle: 11.5, insBody: 10.5,
  note: 8.5,
};

const T = (s) => String(s ?? '');

/* 동일 출처 이미지 → dataURL (실패 시 null) */
async function imgData(url) {
  try {
    const blob = await (await fetch(url)).blob();
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

/* ── 공통 조각 ── */
function addHeader(s, no, noLabel, title) {
  s.addText(no, { x: MG, y: 0.42, w: 0.66, h: 0.44, fontFace: FONT, fontSize: FS.headerNo, bold: true, color: C.redDk });
  s.addText(noLabel, { x: MG, y: 0.84, w: 1.3, h: 0.24, fontFace: FONT, fontSize: FS.headerNoLbl, color: C.muted });
  s.addText(title, { x: MG + 0.82, y: 0.42, w: CW - 0.82, h: 0.52, fontFace: FONT, fontSize: FS.headerTitle, bold: true, color: C.text });
  s.addShape('rect', { x: MG, y: 1.14, w: CW, h: 0.018, fill: { color: C.red } });
}
function addCenterTitle(s, y, text) {
  s.addText(text, { x: MG, y, w: CW, h: 0.36, align: 'center', fontFace: FONT, fontSize: FS.centerTitle, bold: true, color: C.text });
  return y + 0.44;
}
/* 키포인트 행: 원형 번호 배지 + 좌 제목 / 세로 구분선 / 우 본문 (웹 .kp-row 재현) */
function addKpRow(s, y, i, p, pink = false) {
  const h = 1.06;
  s.addShape('rect', { x: MG, y, w: CW, h, fill: { color: pink ? C.pinkBg : C.greyBg } });
  s.addShape('ellipse', { x: MG + 0.16, y: y + h / 2 - 0.15, w: 0.3, h: 0.3, fill: { color: C.redDk } });
  s.addText(String(i + 1).padStart(2, '0'), { x: MG + 0.16, y: y + h / 2 - 0.15, w: 0.3, h: 0.3, align: 'center', valign: 'middle', fontFace: FONT, fontSize: FS.kpBadge, bold: true, color: C.white });
  s.addText(T(p.title).replace(/\n/g, ' '), { x: MG + 0.58, y: y + 0.08, w: 1.85, h: h - 0.16, fontFace: FONT, fontSize: FS.kpTitle, bold: true, color: C.text, valign: 'middle' });
  s.addShape('rect', { x: MG + 2.5, y: y + 0.18, w: 0.014, h: h - 0.36, fill: { color: 'C9C9CF' } });
  s.addText(T(p.body), { x: MG + 2.66, y: y + 0.08, w: CW - 2.82, h: h - 0.16, fontFace: FONT, fontSize: FS.kpBody, color: C.text, valign: 'middle', lineSpacingMultiple: 1.15 });
  return y + h + 0.14;
}
/* 공실률 스탯 카드 (웹 .stat-card 재현: 라벨+델타 / 큰 값 / 부연) */
function addStatCard(s, x, y, w, h, label, cell, prevQ, q, total = false) {
  const d = deltaText(cell.cur, cell.prev);
  s.addShape('rect', { x, y, w, h, fill: { color: total ? C.pinkBg : C.white }, line: { color: C.line, width: 0.75 } });
  s.addShape('rect', { x, y, w, h: 0.03, fill: { color: total ? '7C7C84' : C.red } });   // 상단 컬러 바
  s.addText(label, { x: x + 0.1, y: y + 0.08, w: w * 0.55, h: 0.24, fontFace: FONT, fontSize: FS.cardLabel, bold: true, color: C.text });
  s.addText(d.text ? `${d.arrow} ${d.text}` : '', { x: x + w * 0.45, y: y + 0.08, w: w * 0.5 - 0.1, h: 0.24, align: 'right', fontFace: FONT, fontSize: FS.cardDelta, bold: true, color: d.dir === 'up' ? C.red : C.text });
  s.addText(fmtRate(cell.cur) || '–', { x: x + 0.1, y: y + 0.34, w: w - 0.2, h: 0.46, fontFace: FONT, fontSize: FS.cardValue, bold: true, color: C.red });
  const sub = `${quarterLabel(prevQ)} ${fmtRate(cell.prev) || '–'} → ${quarterLabel(q)} ${fmtRate(cell.cur) || '–'}`;
  s.addText(sub, { x: x + 0.1, y: y + 0.84, w: w - 0.2, h: 0.26, fontFace: FONT, fontSize: FS.cardSub, color: C.muted });
}
/* 키워드/딜스탯 카드 (웹 .kw-card 재현) */
function addKwCard(s, x, y, w, h, big, label, sub) {
  s.addShape('rect', { x, y, w, h, fill: { color: C.pinkBg } });
  s.addText(T(big), { x, y: y + 0.14, w, h: 0.56, align: 'center', fontFace: FONT, fontSize: FS.kwBig, bold: true, color: C.red });
  s.addText(T(label), { x, y: y + 0.74, w, h: 0.3, align: 'center', fontFace: FONT, fontSize: FS.kwLabel, bold: true, color: C.text });
  s.addText(T(sub), { x, y: y + 1.06, w, h: 0.34, align: 'center', fontFace: FONT, fontSize: FS.kwSub, color: C.muted });
}
/* 테이블 타이틀 (센터 + 우측 메타) */
function addTblTitle(s, y, text, meta = '') {
  s.addText(text, { x: MG, y, w: CW, h: 0.3, align: 'center', fontFace: FONT, fontSize: FS.tblTitle, bold: true, color: C.text });
  if (meta) s.addText(meta, { x: MG, y: y + 0.06, w: CW, h: 0.24, align: 'right', fontFace: FONT, fontSize: FS.tblMeta, italic: true, color: C.muted });
  return y + 0.38;
}
/* 인사이트 박스 (웹 .insight-box: 좌측 레드 바) */
function addInsight(s, y, label, obj) {
  const h = 1.16;
  s.addShape('rect', { x: MG, y, w: CW, h, fill: { color: C.insBg } });
  s.addShape('rect', { x: MG, y, w: 0.055, h, fill: { color: C.red } });
  s.addText(label, { x: MG + 0.18, y: y + 0.08, w: CW - 0.36, h: 0.26, fontFace: FONT, fontSize: FS.insLabel, bold: true, color: C.red });
  s.addText(T(obj.title), { x: MG + 0.18, y: y + 0.36, w: CW - 0.36, h: 0.28, fontFace: FONT, fontSize: FS.insTitle, bold: true, color: C.text });
  s.addText(T(obj.body), { x: MG + 0.18, y: y + 0.66, w: CW - 0.36, h: 0.44, fontFace: FONT, fontSize: FS.insBody, color: C.text, lineSpacingMultiple: 1.15 });
  return y + h + 0.16;
}
const ROW_H = 0.36;
const tblOpts = (y, colW) => ({
  x: MG, y, w: CW, colW, fontFace: FONT, fontSize: FS.tbl, color: C.text,
  border: { type: 'solid', color: C.line, pt: 0.5 }, valign: 'middle', rowH: ROW_H, margin: 0.05,
});
const th = t => ({ text: t, options: { bold: true, fill: { color: C.thead }, fontSize: FS.tbl } });

/* ═══════════════ 메인 ═══════════════ */
export async function exportReportPPTX(model) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'A4P', width: W, height: H });
  pptx.layout = 'A4P';

  const q = model.quarter, prevQ = model.prevQuarter;
  const qDot = quarterLabel(q), prevDot = quarterLabel(prevQ);
  const v = model.vacancy;

  /* ── 1. 표지 ── */
  {
    const s = pptx.addSlide();
    const bg = await imgData('./mreport-cover-bg.jpg');
    if (bg) s.addImage({ data: bg, x: 0, y: 0, w: W, h: H });
    else s.background = { color: C.dark };
    // 웹 오버레이 실측: left 54.3% / top 37.6%, 연호 7.2mm(≈20.4pt) / 제목 8.7mm(≈24.7pt)
    s.addText(`${q.slice(5)}Q ${q.slice(0, 4)}`, { x: W * 0.543, y: H * 0.376, w: 3.4, h: 0.42, fontFace: FONT, fontSize: 20, bold: true, color: C.white });
    s.addText('OFFICE MARKET\nREPORT', { x: W * 0.543, y: H * 0.376 + 0.44, w: 3.6, h: 1.05, fontFace: FONT, fontSize: 25, bold: true, color: C.white, lineSpacingMultiple: 1.135 });
  }

  /* ── 2. 주요 내용 요약 (키포인트 4 + 공실 카드 6장 그리드 — 웹 동일 구조) ── */
  {
    const s = pptx.addSlide();
    addHeader(s, '01', '시장 동향', '주요 내용 요약');
    let y = addCenterTitle(s, 1.34, `${quarterLabel(q, 'kr')} 서울 오피스 시장 주요 동향`);
    model.keypoints.forEach((p, i) => { y = addKpRow(s, y, i, p, true); });

    y = addCenterTitle(s, y + 0.08, '서울 전체 오피스 시장 공실률 추이');
    const gap = 0.18, cw3 = (CW - gap * 2) / 3, ch = 1.42;
    const cells = [
      ['전체 공실률', v.total, true],
      ...MR_REGIONS.map(r => [`${MR_REGION_SHORT[r]} 공실률`, v.regions[r], false]),
    ];
    cells.forEach(([label, cell, total], i) => {
      const x = MG + (i % 3) * (cw3 + gap);
      const cy = y + Math.floor(i / 3) * (ch + 0.18);
      addStatCard(s, x, cy, cw3, ch, label, cell, prevQ, q, total);
    });
    y += 2 * (ch + 0.18);
    if (v.buildingCount) s.addText(`* ${v.buildingCount}개 동 기준 집계`, { x: MG, y, w: CW, h: 0.24, fontFace: FONT, fontSize: FS.note, color: C.muted });
  }

  /* ── 3. 임대차 시장 요약 (차트 캡처 + 키포인트) ── */
  {
    const s = pptx.addSlide();
    addHeader(s, '01', '시장 동향', '임대차 시장 요약');
    let y = addCenterTitle(s, 1.34, `권역별 공실률 비교 (${quarterLabel(prevQ, 'kr')} → ${quarterLabel(q, 'kr')}, 단위: %)`);
    const cv = document.getElementById('mrLeaseChart');
    if (cv && cv.width > 10) {
      const ch = Math.min(CW * (cv.height / cv.width), 4.0);       // 비율 유지, 과대 방지
      s.addImage({ data: cv.toDataURL('image/png'), x: MG, y, w: CW, h: ch });
      y += ch + 0.3;
    } else {
      s.addText('(차트 미생성 — 웹 화면에서 초안 생성 후 내보내기)', { x: MG, y, w: CW, h: 0.4, fontFace: FONT, fontSize: 11, color: C.muted, align: 'center' });
      y += 0.6;
    }
    model.leasePoints.forEach((p, i) => { y = addKpRow(s, y, i, p); });
  }

  /* ── 4. 매입매각 시장 요약 ── */
  {
    const s = pptx.addSlide();
    addHeader(s, '01', '시장 동향', '매입매각 시장 요약');
    let y = addCenterTitle(s, 1.34, '매입매각 시장 (Deal Market)');
    const gap = 0.18, bw = (CW - gap * 2) / 3, bh = 1.52;
    model.dealStats.forEach((st, i) => addKwCard(s, MG + i * (bw + gap), y, bw, bh, st.value, st.label, st.sub));
    y += bh + 0.28;
    model.dealPoints.forEach((p, i) => { y = addKpRow(s, y, i, p); });
  }

  /* ── 5~14. 권역별 A/B ── */
  for (const r of MR_REGIONS) {
    const b = model.regions[r];

    // A: 키워드 & 시장 분석
    {
      const s = pptx.addSlide();
      addHeader(s, '02', '권역별 리뷰', MR_REGION_LABEL[r]);
      let y = addCenterTitle(s, 1.34, '권역별 키워드 & 시장 분석');
      const gap = 0.18, bw = (CW - gap * 2) / 3, bh = 1.52;
      b.keywords.forEach((k, i) => addKwCard(s, MG + i * (bw + gap), y, bw, bh, k.big, k.label, k.sub));
      y += bh + 0.28;
      b.points.forEach((p, i) => { y = addKpRow(s, y, i, p); });
    }

    // B: 계약사례 & 거래 상세
    {
      const s = pptx.addSlide();
      addHeader(s, '02', '권역별 리뷰', MR_REGION_LABEL[r]);
      let y = 1.34;

      y = addTblTitle(s, y, '주요 임대차 계약 사례', `${b.leases.length}건 · ${qDot}`);
      const lRows = [[th('세부권역'), th('빌딩명'), th('임대면적'), th('임차인')]];
      (b.leases.length ? b.leases : [{}]).forEach(l => lRows.push([T(l.subRegion), { text: T(l.building), options: { bold: true } }, T(l.areaPy), T(l.tenant)]));
      s.addTable(lRows, tblOpts(y, [1.35, 2.55, 1.85, CW - 5.75]));
      y += ROW_H * lRows.length + 0.24;
      y = addInsight(s, y, '주요 임대차 인사이트', b.leaseInsight);

      y = addTblTitle(s, y, '주요 매입매각 거래', '단위: 억원 · 만원(평당)');
      const dRows = [[th('자산명'), th('매매가(억원)'), th('평당가(만원)'), th('매도→매수')]];
      (b.deals.length ? b.deals : [{}]).forEach(d => dRows.push([{ text: T(d.asset), options: { bold: true } }, T(d.price), T(d.pricePy), T(d.sellerBuyer)]));
      s.addTable(dRows, tblOpts(y, [2.55, 1.35, 1.35, CW - 5.25]));
      y += ROW_H * dRows.length + 0.24;
      addInsight(s, y, '주요 매입매각 인사이트', b.dealInsight);
    }
  }

  /* ── 15. 백커버 ── */
  {
    const s = pptx.addSlide();
    const bg = await imgData('./mreport-back-bg.jpg');
    if (bg) s.addImage({ data: bg, x: 0, y: 0, w: W, h: H });
    else {
      s.background = { color: 'ECECEE' };
      s.addText('S&I Corp.', { x: MG, y: H * 0.42, w: CW, h: 0.7, fontFace: FONT, fontSize: 32, bold: true, color: C.text });
    }
  }

  const fileName = `오피스마켓리포트_${qDot}.pptx`;
  await pptx.writeFile({ fileName });
  return fileName;
}
