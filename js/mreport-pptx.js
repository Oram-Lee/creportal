/**
 * mreport-pptx.js — 오피스 마켓 리포트 PPTX 내보내기 (v1.2.0 신규)
 *
 * 사용: mreport-main.js › MR.exportPptx() 에서 동적 import 후 exportReportPPTX(model) 호출
 * 전제: market-report.html 에 pptxgenjs CDN(전역 PptxGenJS) 로드됨
 *
 * 설계 노트:
 *  - A4 세로(8.27×11.69in) 커스텀 레이아웃 — 웹 리포트(A4)와 동일 판형으로 위화감 최소화
 *  - HTML/CSS 픽셀 재현이 아니라 "모델 → 슬라이드" 재구성. 따라서 [자동] 배지 등
 *    편집 전용 UI 는 애초에 포함되지 않음 (v1.2.0 요구사항 5)
 *  - 차트는 화면의 canvas(#mrLeaseChart)를 PNG 로 캡처해 삽입 (datalabels 포함 그대로)
 *  - 표지/백커버 배경 이미지는 동일 출처 fetch → dataURL. 실패 시 단색 폴백
 *  - 슬라이드 구성(15장): 표지 / 요약 / 임대차 / 매입매각 / 권역별 A·B ×5 / 백커버
 *    (목차·Appendix 는 발행 PDF 로 대체 — 필요 시 추후 추가)
 */

import {
  MR_REGIONS, MR_REGION_LABEL, MR_REGION_SHORT,
  quarterLabel, deltaText, fmtRate,
} from './mreport-data.js?v=1.2.1';

/* ── 팔레트/서체 (market-report.html :root 와 동일 톤) ── */
const C = {
  red: 'E8135C', redDk: 'C41042', pinkBg: 'FDEDF3', greyBg: 'F0F0F2',
  dark: '1B1418', navy: '2E4057', navyLt: 'C3CDD9',
  text: '222222', muted: '9A9AA2', line: 'E3E3E8', thead: 'F5F7FA', white: 'FFFFFF',
};
const FONT = 'Malgun Gothic';
const W = 8.27, H = 11.69, MG = 0.55;           // A4 세로(in), 좌우 여백
const CW = W - MG * 2;                           // 콘텐츠 폭

const T = (s) => String(s ?? '');                // null 방어

/* 동일 출처 이미지 → dataURL (실패 시 null — 폴백 렌더) */
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
  s.addText(no, { x: MG, y: 0.45, w: 0.62, h: 0.5, fontFace: FONT, fontSize: 22, bold: true, color: C.redDk });
  s.addText(noLabel, { x: MG, y: 0.92, w: 1.2, h: 0.26, fontFace: FONT, fontSize: 9, color: C.muted });
  s.addText(title, { x: MG + 0.85, y: 0.45, w: CW - 0.85, h: 0.55, fontFace: FONT, fontSize: 19, bold: true, color: C.text });
  s.addShape('rect', { x: MG, y: 1.24, w: CW, h: 0.016, fill: { color: C.red } });
}
function addCenterTitle(s, y, text) {
  s.addText(text, { x: MG, y, w: CW, h: 0.34, align: 'center', fontFace: FONT, fontSize: 13, bold: true, color: C.text });
}
/* 번호 배지 + 제목 + 본문 키포인트 행 */
function addKpRow(s, y, i, p, pink = false) {
  const h = 0.92;
  s.addShape('rect', { x: MG, y, w: CW, h, fill: { color: pink ? C.pinkBg : C.greyBg } });
  s.addText(String(i + 1).padStart(2, '0'), { x: MG + 0.12, y: y + 0.24, w: 0.5, h: 0.44, fontFace: FONT, fontSize: 16, bold: true, color: C.redDk });
  s.addText(T(p.title).replace(/\n/g, ' '), { x: MG + 0.72, y: y + 0.08, w: 1.85, h: h - 0.16, fontFace: FONT, fontSize: 10.5, bold: true, color: C.text, valign: 'middle' });
  s.addText(T(p.body), { x: MG + 2.68, y: y + 0.08, w: CW - 2.8, h: h - 0.16, fontFace: FONT, fontSize: 9.5, color: C.text, valign: 'middle' });
  return y + h + 0.12;
}
/* 인사이트 박스 */
function addInsight(s, y, label, obj) {
  const h = 1.0;
  s.addShape('rect', { x: MG, y, w: CW, h, fill: { color: C.pinkBg } });
  s.addText(label, { x: MG + 0.14, y: y + 0.07, w: CW - 0.28, h: 0.24, fontFace: FONT, fontSize: 9, bold: true, color: C.redDk });
  s.addText(T(obj.title), { x: MG + 0.14, y: y + 0.3, w: CW - 0.28, h: 0.26, fontFace: FONT, fontSize: 10.5, bold: true, color: C.text });
  s.addText(T(obj.body), { x: MG + 0.14, y: y + 0.56, w: CW - 0.28, h: 0.4, fontFace: FONT, fontSize: 9, color: C.text });
  return y + h + 0.14;
}
/* pptxgenjs 테이블 공통 스타일 */
const tblOpts = (y, colW) => ({
  x: MG, y, w: CW, colW, fontFace: FONT, fontSize: 9, color: C.text,
  border: { type: 'solid', color: C.line, pt: 0.5 }, valign: 'middle', rowH: 0.3, margin: 0.04,
});
const th = t => ({ text: t, options: { bold: true, fill: { color: C.thead }, fontSize: 9 } });

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
    // HTML 오버레이(left 54.3% / top 37.6%)와 동일 지점
    s.addText(`${q.slice(5)}Q ${q.slice(0, 4)}`, { x: W * 0.543, y: H * 0.376, w: 3.2, h: 0.4, fontFace: FONT, fontSize: 17, bold: true, color: C.white });
    s.addText('OFFICE MARKET\nREPORT', { x: W * 0.543, y: H * 0.376 + 0.42, w: 3.4, h: 0.95, fontFace: FONT, fontSize: 21, bold: true, color: C.white, lineSpacingMultiple: 1.1 });
  }

  /* ── 2. 주요 내용 요약 ── */
  {
    const s = pptx.addSlide();
    addHeader(s, '01', '시장 동향', '주요 내용 요약');
    addCenterTitle(s, 1.45, `${quarterLabel(q, 'kr')} 서울 오피스 시장 주요 동향`);
    let y = 1.9;
    model.keypoints.forEach((p, i) => { y = addKpRow(s, y, i, p, true); });

    addCenterTitle(s, y + 0.1, '서울 전체 오피스 시장 공실률 추이');
    const rows = [[th('구분'), th(`${prevDot} 공실률`), th(`${qDot} 공실률`), th('전분기 대비')]];
    const push = (label, cell) => {
      const d = deltaText(cell.cur, cell.prev);
      rows.push([label, fmtRate(cell.prev) || '–', { text: fmtRate(cell.cur) || '–', options: { bold: true, color: C.red } },
                 d.text ? `${d.arrow} ${d.text}` : '–']);
    };
    push('전체', v.total);
    MR_REGIONS.forEach(r => push(MR_REGION_SHORT[r], v.regions[r]));
    s.addTable(rows, tblOpts(y + 0.55, [1.9, 1.8, 1.8, CW - 5.5]));
    if (v.buildingCount) s.addText(`* ${v.buildingCount}개 동 기준 집계`, { x: MG, y: y + 0.55 + 0.3 * 7 + 0.1, w: CW, h: 0.24, fontFace: FONT, fontSize: 8, color: C.muted });
  }

  /* ── 3. 임대차 시장 요약 (차트 캡처 + 키포인트) ── */
  {
    const s = pptx.addSlide();
    addHeader(s, '01', '시장 동향', '임대차 시장 요약');
    addCenterTitle(s, 1.45, `권역별 공실률 비교 (${quarterLabel(prevQ, 'kr')} → ${quarterLabel(q, 'kr')}, 단위: %)`);
    let y = 1.9;
    const cv = document.getElementById('mrLeaseChart');
    if (cv && cv.width > 10) {
      const h = CW * (cv.height / cv.width);              // 캔버스 비율 유지
      s.addImage({ data: cv.toDataURL('image/png'), x: MG, y, w: CW, h });
      y += h + 0.25;
    } else {
      s.addText('(차트 미생성 — 웹 화면에서 초안 생성 후 내보내기)', { x: MG, y, w: CW, h: 0.4, fontFace: FONT, fontSize: 10, color: C.muted, align: 'center' });
      y += 0.6;
    }
    model.leasePoints.forEach((p, i) => { y = addKpRow(s, y, i, p); });
  }

  /* ── 4. 매입매각 시장 요약 ── */
  {
    const s = pptx.addSlide();
    addHeader(s, '01', '시장 동향', '매입매각 시장 요약');
    let y = 1.6;
    const bw = (CW - 0.3) / 3;
    model.dealStats.forEach((st, i) => {
      const x = MG + i * (bw + 0.15);
      s.addShape('rect', { x, y, w: bw, h: 1.35, fill: { color: C.pinkBg } });
      s.addText(T(st.value), { x, y: y + 0.12, w: bw, h: 0.5, align: 'center', fontFace: FONT, fontSize: 19, bold: true, color: C.red });
      s.addText(T(st.label), { x, y: y + 0.64, w: bw, h: 0.3, align: 'center', fontFace: FONT, fontSize: 10, bold: true, color: C.text });
      s.addText(T(st.sub), { x, y: y + 0.95, w: bw, h: 0.32, align: 'center', fontFace: FONT, fontSize: 8.5, color: C.muted });
    });
    y += 1.55;
    model.dealPoints.forEach((p, i) => { y = addKpRow(s, y, i, p); });
  }

  /* ── 5~14. 권역별 A/B ── */
  for (const r of MR_REGIONS) {
    const b = model.regions[r];

    // A: 키워드 & 시장 분석
    {
      const s = pptx.addSlide();
      addHeader(s, '02', '권역별 리뷰', MR_REGION_LABEL[r]);
      addCenterTitle(s, 1.45, '권역별 키워드 & 시장 분석');
      let y = 1.9;
      const bw = (CW - 0.3) / 3;
      b.keywords.forEach((k, i) => {
        const x = MG + i * (bw + 0.15);
        s.addShape('rect', { x, y, w: bw, h: 1.35, fill: { color: C.pinkBg } });
        s.addText(T(k.big), { x, y: y + 0.12, w: bw, h: 0.5, align: 'center', fontFace: FONT, fontSize: 18, bold: true, color: C.red });
        s.addText(T(k.label), { x, y: y + 0.64, w: bw, h: 0.3, align: 'center', fontFace: FONT, fontSize: 10, bold: true, color: C.text });
        s.addText(T(k.sub), { x, y: y + 0.95, w: bw, h: 0.32, align: 'center', fontFace: FONT, fontSize: 8.5, color: C.muted });
      });
      y += 1.55;
      b.points.forEach((p, i) => { y = addKpRow(s, y, i, p); });
    }

    // B: 계약사례 & 거래 상세
    {
      const s = pptx.addSlide();
      addHeader(s, '02', '권역별 리뷰', MR_REGION_LABEL[r]);
      let y = 1.5;

      s.addText(`주요 임대차 계약 사례 (${b.leases.length}건 · ${qDot})`, { x: MG, y, w: CW, h: 0.28, fontFace: FONT, fontSize: 11, bold: true, color: C.navy });
      y += 0.34;
      const lRows = [[th('세부권역'), th('빌딩명'), th('임대면적'), th('임차인')]];
      (b.leases.length ? b.leases : [{}]).forEach(l => lRows.push([T(l.subRegion), { text: T(l.building), options: { bold: true } }, T(l.areaPy), T(l.tenant)]));
      s.addTable(lRows, tblOpts(y, [1.3, 2.5, 1.9, CW - 5.7]));
      y += 0.3 * lRows.length + 0.22;
      y = addInsight(s, y, '주요 임대차 인사이트', b.leaseInsight);

      s.addText('주요 매입매각 거래 (단위: 억원 · 만원/평)', { x: MG, y, w: CW, h: 0.28, fontFace: FONT, fontSize: 11, bold: true, color: C.navy });
      y += 0.34;
      const dRows = [[th('자산명'), th('매매가(억원)'), th('평당가(만원)'), th('매도→매수')]];
      (b.deals.length ? b.deals : [{}]).forEach(d => dRows.push([{ text: T(d.asset), options: { bold: true } }, T(d.price), T(d.pricePy), T(d.sellerBuyer)]));
      s.addTable(dRows, tblOpts(y, [2.5, 1.3, 1.3, CW - 5.1]));
      y += 0.3 * dRows.length + 0.22;
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
      s.addText('S&I Corp.', { x: MG, y: H * 0.42, w: CW, h: 0.7, fontFace: FONT, fontSize: 30, bold: true, color: C.text });
    }
  }

  const fileName = `오피스마켓리포트_${qDot}.pptx`;
  await pptx.writeFile({ fileName });
  return fileName;
}
