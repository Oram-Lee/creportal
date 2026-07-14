/**
 * mreport-render.js — 오피스 마켓 리포트 렌더 계층
 *
 * 페이지 구성 (S&I 1Q 2026 PDF 재현):
 *   1  표지                          2  목차(CONTENT)
 *   3  주요 내용 요약 (키포인트4 + 공실률 카드6)
 *   4  임대차 시장 요약 (권역별 비교 차트 + 키포인트3)
 *   5  매입매각 시장 요약 (스탯3 + 키포인트2)
 *   6~15  권역별 리뷰 ×5 (키워드/분석 + 계약사례/거래 상세)
 *   16 Appendix (소개/조사개요)      17 백커버
 *
 * 편집 바인딩: data-p="모델경로" 를 가진 contenteditable → collectModel() 이 DOM에서 회수
 * 테이블: data-tbl="regions.CBD.leases" + 행별 data-row
 */

import {
  MR_REGIONS, MR_REGION_LABEL, MR_REGION_SHORT,
  quarterLabel, deltaText, fmtRate,
} from './mreport-data.js';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const nl2br = s => esc(s).replace(/\n/g, '<br>');

let _chart = null;

/* ═══════════════ 페이지 조립 ═══════════════ */

export function renderReport(model) {
  const el = $('#mrPages');
  const q = model.quarter, prevQ = model.prevQuarter;
  const year = q.slice(0, 4);
  const qKey = q.slice(4);              // 'Q1' — Appendix 조사기간 매핑 키
  const qLabel = `${q.slice(5)}Q`;      // '1Q' — 표지 표기 (PDF 동일)

  el.innerHTML = [
    pageCover(qLabel, year),
    pageToc(),
    pageSummary(model),
    pageLease(model, q, prevQ),
    pageDeal(model),
    ...MR_REGIONS.flatMap(r => [pageRegionA(model, r), pageRegionB(model, r, q)]),
    pageAppendix(model, year, qKey),
    pageBackCover(),
  ].join('');

  renderLeaseChart(model);
  bindTableButtons(model);
}

/* ── 1. 표지 ── */
function pageCover(qLabel, year) {
  // 그리드 라인 좌표 (PDF 표지 패턴 근사)
  const H = [[24,58],[24,105],[24,152],[24,199],[24,246],[68,58],[68,152],[68,199],[112,58],[112,105],[112,152],[156,105],[156,199],[156,246]];
  const V = [[46,22],[46,115],[46,205],[90,22],[90,70],[90,160],[134,115],[134,205],[178,22],[178,160]];
  const reds = new Set([3, 11]);
  const grid =
    H.map(([x,y],i)=>`<div class="h ${reds.has(i)?'red':''}" style="left:${x}mm;top:${y}mm"></div>`).join('') +
    V.map(([x,y],i)=>`<div class="v ${i===1||i===8?'red':''}" style="left:${x}mm;top:${y}mm"></div>`).join('') +
    `<div class="diag" style="left:60mm;top:100mm;transform:rotate(-45deg)"></div>
     <div class="diag" style="left:104mm;top:158mm;transform:rotate(45deg)"></div>
     <div class="diag" style="left:20mm;top:238mm;transform:rotate(-45deg)"></div>`;
  return `
  <div class="mr-page cover">
    <div class="cover-grid">${grid}</div>
    <div class="cover-brand">SPACE &amp;<br>INNOVATION</div>
    <div class="cover-title">
      <div class="period" contenteditable="true" data-p="_coverPeriod">${qLabel} ${year}</div>
      <h1>OFFICE MARKET<br>REPORT</h1>
    </div>
    <div class="cover-logo"><span class="si-logo-red">S&amp;I</span><small> Corp.</small></div>
  </div>`;
}

/* ── 2. 목차 ── */
function pageToc() {
  return `
  <div class="mr-page toc">
    <div class="toc-head"><div class="toc-badge">C</div><div class="word">O N T E N T</div></div>
    <div class="toc-list">
      <div class="toc-part"><div class="pageno">03</div><div>
        <div class="part-title"><b>Part 01.</b>시장 동향</div>
        <ol><li data-n="1">주요 내용 요약</li><li data-n="2">임대차 시장 요약</li><li data-n="3">매입매각 시장 요약</li></ol>
      </div></div>
      <div class="toc-part"><div class="pageno">06</div><div>
        <div class="part-title"><b>Part 02.</b>권역별 리뷰</div>
        <ol><li data-n="1">CBD (도심 권역)</li><li data-n="2">GBD (강남 권역)</li><li data-n="3">YBD (여의도 권역)</li><li data-n="4">BBD (분당·판교 권역)</li><li data-n="5">기타 권역</li></ol>
      </div></div>
      <div class="toc-part"><div class="pageno">16</div><div>
        <div class="part-title"><b>Part 03.</b>S&amp;I Corp. 소개 &amp; 조사 개요</div>
      </div></div>
    </div>
  </div>`;
}

/* ── 공통 조각 ── */
const secHeader = (no, noLabel, title, sub = '') => `
  <div class="sec-header">
    <div class="no-block"><b>${no}</b><span>${noLabel}</span></div>
    <h2>${title}${sub ? `<small>${esc(sub)}</small>` : ''}</h2>
    <div class="si-mark"><span class="si-logo-red">S&amp;I</span><small> Corp.</small></div>
  </div>`;
const checkDivider = `<div class="check-divider"><div class="dot">✓</div></div>`;

const kpRow = (i, p, path, pink = false) => `
  <div class="kp-row ${pink ? 'pink' : ''}">
    <div class="kp-badge">${String(i + 1).padStart(2, '0')}</div>
    <div class="kp-title" contenteditable="true" data-p="${path}[${i}].title">${nl2br(p.title)}</div>
    <div class="kp-body"  contenteditable="true" data-p="${path}[${i}].body">${nl2br(p.body)}</div>
  </div>`;

/* ── 3. 주요 내용 요약 ── */
function pageSummary(model) {
  const v = model.vacancy;
  const q = model.quarter, prevQ = model.prevQuarter;
  const warn = !v.auto
    ? `<span class="warn-badge">⚠ 확정 통계 없음 — 수치를 직접 입력하세요</span>`
    : (v.statsStatus !== 'finalized' ? `<span class="warn-badge">⚠ ${quarterLabel(q)} 세션이 작업중(draft) 상태입니다</span>` : '');

  const card = (label, cur, prev, total = false, idx = -1) => {
    const d = deltaText(cur, prev);
    const pathBase = idx < 0 ? 'vacancy.total' : `vacancy.regions.${MR_REGIONS[idx]}`;
    const subLine = d.text
      ? `전분기 대비 ${d.abs}% ${d.dir==='up'?'상승':d.dir==='flat'?'보합':'하락'}`
      : '전분기 대비 –';
    return `
    <div class="stat-card ${total ? 'total' : ''}">
      ${v.auto ? '<span class="auto-badge">자동</span>' : ''}
      <div class="row1"><span>${label}</span><span class="delta ${d.dir || ''}">${d.arrow} ${esc(d.text)}</span></div>
      <div class="value" contenteditable="true" data-p="${pathBase}.cur" data-num="1">${fmtRate(cur) || '–'}</div>
      <div class="sub">${subLine}<br>
        (${quarterLabel(prevQ)} <span contenteditable="true" data-p="${pathBase}.prev" data-num="1">${fmtRate(prev) || '–'}</span> → ${quarterLabel(q)} ${fmtRate(cur) || '–'})</div>
    </div>`;
  };

  return `
  <div class="mr-page">
    ${secHeader('01', '시장 동향', '주요 내용 요약')}
    <div class="center-title">${quarterLabel(q,'kr')} 서울 오피스 시장 주요 동향 ${warn}</div>
    ${model.keypoints.map((p, i) => kpRow(i, p, 'keypoints', true)).join('')}
    ${checkDivider}
    <div class="center-title">서울 전체 오피스 시장 공실률 추이</div>
    <div class="stat-grid">
      ${card('전체 공실률', v.total.cur, v.total.prev, true)}
      ${MR_REGIONS.map((r, i) => card(`${MR_REGION_SHORT[r]} 공실률`, v.regions[r].cur, v.regions[r].prev, false, i)).join('')}
    </div>
  </div>`;
}

/* ── 4. 임대차 시장 요약 ── */
function pageLease(model, q, prevQ) {
  return `
  <div class="mr-page">
    ${secHeader('01', '시장 동향', '임대차 시장 요약')}
    <div class="center-title">임대차 시장 (Lease Market)</div>
    ${checkDivider}
    <div class="center-title" style="font-size:15px">권역별 공실률 비교 (${quarterLabel(prevQ,'kr')} → ${quarterLabel(q,'kr')}, 단위: %)</div>
    <div class="chart-box"><canvas id="mrLeaseChart"></canvas></div>
    ${model.leasePoints.map((p, i) => kpRow(i, p, 'leasePoints')).join('')}
  </div>`;
}

function renderLeaseChart(model) {
  const cv = $('#mrLeaseChart');
  if (!cv || typeof Chart === 'undefined') return;
  if (_chart) { _chart.destroy(); _chart = null; }

  const v = model.vacancy;
  const labels = [...MR_REGIONS.map(r => r === 'Others' ? 'Others' : r), 'ALL'];
  const prevData = [...MR_REGIONS.map(r => v.regions[r].prev), v.total.prev];
  const curData  = [...MR_REGIONS.map(r => v.regions[r].cur),  v.total.cur];

  _chart = new Chart(cv, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: quarterLabel(model.prevQuarter), data: prevData, backgroundColor: '#c3cdd9' },
        { label: quarterLabel(model.quarter),     data: curData,  backgroundColor: '#2e4057' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { enabled: true },
      },
      scales: {
        y: { beginAtZero: true, ticks: { font: { size: 10 } } },
        x: { ticks: { font: { size: 11, weight: 700 } }, grid: { display: false } },
      },
    },
  });
}

/* ── 5. 매입매각 시장 요약 ── */
function pageDeal(model) {
  const stat = (s, i) => `
    <div class="kw-card">
      <div class="big"   contenteditable="true" data-p="dealStats[${i}].value">${nl2br(s.value)}</div>
      <div class="label" contenteditable="true" data-p="dealStats[${i}].label">${nl2br(s.label)}</div>
      <div class="sub"   contenteditable="true" data-p="dealStats[${i}].sub">${nl2br(s.sub)}</div>
    </div>`;
  return `
  <div class="mr-page">
    ${secHeader('01', '시장 동향', '매입매각 시장 요약')}
    <div class="center-title">매입매각 시장 (Deal Market)</div>
    ${checkDivider}
    <div class="deal-stat-grid">${model.dealStats.map(stat).join('')}</div>
    ${model.dealPoints.map((p, i) => kpRow(i, p, 'dealPoints')).join('')}
    <p class="edit-only" style="font-size:11px;color:#999;margin-top:4mm">
      💡 매입매각 데이터는 아직 DB화되지 않아 직접 입력합니다. 카드/문단을 클릭해 편집하세요.</p>
  </div>`;
}

/* ── 6~15. 권역별 A(키워드&분석) ── */
function pageRegionA(model, r) {
  const b = model.regions[r];
  const kw = (k, i) => `
    <div class="kw-card">
      <div class="big"   contenteditable="true" data-p="regions.${r}.keywords[${i}].big">${nl2br(k.big)}</div>
      <div class="label" contenteditable="true" data-p="regions.${r}.keywords[${i}].label">${nl2br(k.label)}</div>
      <div class="sub"   contenteditable="true" data-p="regions.${r}.keywords[${i}].sub">${nl2br(k.sub)}</div>
    </div>`;
  const sub = r === 'Others' ? '(마포·공덕·DMC·잠실·송파·구로·가산·용산·마곡·영등포)' : '';
  return `
  <div class="mr-page">
    ${secHeader('02', '권역별 리뷰', MR_REGION_LABEL[r], sub)}
    <div class="center-title">권역별 키워드 &amp; 시장 분석</div>
    <div class="kw-grid">${b.keywords.map(kw).join('')}</div>
    ${b.points.map((p, i) => kpRow(i, p, `regions.${r}.points`)).join('')}
  </div>`;
}

/* ── 권역별 B(계약사례·거래 상세) ── */
function pageRegionB(model, r, q) {
  const b = model.regions[r];
  const qTag = `${b.leases.length}건 · ${q.slice(0,4)} ${q.slice(4)}`;

  const leaseRows = b.leases.map((l, i) => `
    <tr data-row="${i}">
      <td contenteditable="true" data-c="subRegion">${esc(l.subRegion)}</td>
      <td class="b" contenteditable="true" data-c="building">${esc(l.building)}</td>
      <td contenteditable="true" data-c="areaPy">${esc(l.areaPy)}</td>
      <td contenteditable="true" data-c="tenant">${esc(l.tenant)}</td>
      <td class="edit-only"><button class="row-del" data-del>✕</button></td>
    </tr>`).join('');

  const dealRows = b.deals.map((d, i) => `
    <tr data-row="${i}">
      <td class="b" contenteditable="true" data-c="asset">${esc(d.asset)}</td>
      <td contenteditable="true" data-c="price">${esc(d.price)}</td>
      <td contenteditable="true" data-c="pricePy">${esc(d.pricePy)}</td>
      <td contenteditable="true" data-c="sellerBuyer">${esc(d.sellerBuyer)}</td>
      <td class="edit-only"><button class="row-del" data-del>✕</button></td>
    </tr>`).join('');

  const insight = (key, obj) => `
    <div class="insight-box">
      <h4>주요 ${key === 'leaseInsight' ? '임대차' : '매입매각'} 인사이트</h4>
      <div class="ins-title" contenteditable="true" data-p="regions.${r}.${key}.title">${nl2br(obj.title)}</div>
      <div class="ins-body"  contenteditable="true" data-p="regions.${r}.${key}.body">${nl2br(obj.body)}</div>
    </div>`;

  return `
  <div class="mr-page">
    ${secHeader('02', '권역별 리뷰', MR_REGION_LABEL[r])}
    <div class="mr-table-wrap">
      <div class="mr-table-title">주요 임대차 계약 사례 <span class="meta">${qTag}</span></div>
      <table class="mr-table" data-tbl="regions.${r}.leases">
        <thead><tr><th style="width:18%">세부권역</th><th style="width:32%">빌딩명</th><th style="width:24%">임대면적</th><th style="width:22%">임차인</th><th class="edit-only" style="width:4%"></th></tr></thead>
        <tbody>${leaseRows}</tbody>
      </table>
      <button class="tbl-add-btn" data-add="lease" data-region="${r}">＋ 계약 사례 행 추가</button>
    </div>
    ${insight('leaseInsight', b.leaseInsight)}
    <div class="mr-table-wrap">
      <div class="mr-table-title">주요 매입매각 거래 <span class="meta">단위: 억원 · 만원(평당)</span></div>
      <table class="mr-table" data-tbl="regions.${r}.deals">
        <thead><tr><th style="width:32%">자산명</th><th style="width:16%">매매가(억원)</th><th style="width:16%">평당가(만원)</th><th style="width:32%">매도→매수</th><th class="edit-only" style="width:4%"></th></tr></thead>
        <tbody>${dealRows}</tbody>
      </table>
      <button class="tbl-add-btn" data-add="deal" data-region="${r}">＋ 매입매각 행 추가 (수동 입력)</button>
    </div>
    ${insight('dealInsight', b.dealInsight)}
  </div>`;
}

/* ── 16. Appendix ── */
function pageAppendix(model, year, qKey) {
  const qMonths = { Q1:['1월 1일','3월 31일'], Q2:['4월 1일','6월 30일'], Q3:['7월 1일','9월 30일'], Q4:['10월 1일','12월 31일'] }[qKey] || ['1월 1일','3월 31일'];   // 방어적 폴백
  return `
  <div class="mr-page">
    ${secHeader('03', 'APPENDIX', 'S&amp;I Corp. 소개 / 조사 개요')}
    <div class="center-title">S&amp;I Corp. 소개</div>
    <div class="apx-card">
      <h3><span class="si-logo-red">S&amp;I</span> Corp.<small>Commercial Real Estate Advisory</small></h3>
      <p>에스앤아이 코퍼레이션은 서울 오피스 임대차 자문(TR · LR), 매입매각 자문, 자산관리 및 시장 조사를
      종합적으로 제공하는 상업용 부동산 전문 회사입니다. CRE1 팀과 CRE2 팀이 임대차와 매입매각
      전 과정의 자문 서비스를 수행하고 있습니다.</p>
      <p style="margin-top:2.5mm;font-size:11.5px">홈페이지&nbsp;&nbsp;<b style="text-decoration:underline">www.sni.co.kr</b></p>
    </div>
    ${checkDivider}
    <div class="center-title">조사 개요</div>
    <div class="apx-2col">
      <div>
        <div class="apx-h">조사 대상</div>
        <ul class="apx-list">
          <li>서울 및 분당 소재 연면적 33,058㎡(약 10,000평) 이상의 Prime · A급 오피스 빌딩</li>
          <li>주 용도가 업무용인 빌딩에 한정 (오피스텔 및 층별 분양빌딩은 제외)</li>
          <li>리모델링·신축 진행 중인 미완공 자산은 표본에서 제외</li>
        </ul>
        <div class="apx-h">조사 기간</div>
        <ul class="apx-list"><li>${year}년 ${qMonths[0]} ~ ${year}년 ${qMonths[1]}</li></ul>
        <div class="apx-h">조사 권역</div>
        <div class="region-tags">
          <div class="rt"><span class="tag">CBD</span>종로구, 중구 및 서대문구(충정로) 일대</div>
          <div class="rt"><span class="tag">GBD</span>서초구, 강남구 일대</div>
          <div class="rt"><span class="tag">YBD</span>여의도 일대</div>
          <div class="rt"><span class="tag">BBD</span>성남시 분당구 및 수정구 일대</div>
          <div class="rt"><span class="tag">OTHERS</span>4대 업무권역 외 서울 일대</div>
        </div>
      </div>
      <div>
        <div class="apx-h">빌딩 등급 정보</div>
        <table class="grade-table">
          <thead><tr><th>분류 기준</th><th>등급 기준</th><th>조사 대상</th></tr></thead>
          <tbody>
            <tr class="hl"><td>프라임 (Prime)</td><td>연면적 66,116㎡ 이상</td><td>●</td></tr>
            <tr class="hl"><td>A급 (대형)</td><td>33,058㎡ 이상 ~ 66,116㎡ 미만</td><td>●</td></tr>
            <tr><td>B급 (중형)</td><td>16,529㎡ 이상 ~ 33,058㎡ 미만</td><td>—</td></tr>
            <tr><td>C급 (중소형)</td><td>9,917㎡ 이상 ~ 16,529㎡ 미만</td><td>—</td></tr>
            <tr><td>D급 (소형)</td><td>연면적 9,917㎡ 미만</td><td>—</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <div class="disclaimer">
      <b>DISCLAIMER · 면책 조항</b><br>
      본 리포트는 S&amp;I Corp.의 내부 리서치 자료로 작성됨. 공실률·임대료·매매가 정보는 본사 자체 조사 및 시장 자료를 기반으로
      산출되었으며, 실제 거래 또는 의사결정 시 별도 확인이 필요함. <i>본 보고서의 무단 복제·배포·인용은 금지되며, 데이터 사용 시 사전 협의가 필요함.</i>
    </div>
  </div>`;
}

/* ── 17. 백커버 ── */
function pageBackCover() {
  return `
  <div class="mr-page backcover">
    <div class="back-logo"><span class="si-logo-red">S&amp;I</span><small> Corp.</small></div>
  </div>`;
}

/* ═══════════════ 테이블 행 CRUD ═══════════════ */

function bindTableButtons(model) {
  document.querySelectorAll('.tbl-add-btn').forEach(btn => {
    btn.onclick = () => {
      const r = btn.dataset.region;
      if (btn.dataset.add === 'lease') model.regions[r].leases.push({ subRegion:'', building:'', areaPy:'', areaM2:'', tenant:'' });
      else                             model.regions[r].deals.push({ asset:'', price:'', pricePy:'', sellerBuyer:'' });
      collectModel(model);             // 편집 중이던 값 보존
      renderReport(model);
    };
  });
  document.querySelectorAll('button[data-del]').forEach(btn => {
    btn.onclick = () => {
      const tr = btn.closest('tr');
      const tbl = btn.closest('table');
      const path = tbl.dataset.tbl.split('.');       // ['regions','CBD','leases']
      collectModel(model);
      model[path[0]][path[1]][path[2]].splice(+tr.dataset.row, 1);
      renderReport(model);
    };
  });
}

/* ═══════════════ DOM → 모델 수집 ═══════════════ */

/** data-p 경로 문자열로 모델에 값 대입: "regions.CBD.points[1].body" */
function setByPath(model, path, value) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let obj = model;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] == null) obj[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
}

/** 화면의 모든 편집 값을 모델로 회수 */
export function collectModel(model) {
  // 1) data-p 단일 필드
  document.querySelectorAll('[data-p]').forEach(el => {
    const raw = el.innerText.replace(/\u00a0/g, ' ').trim();
    if (el.dataset.p === '_coverPeriod') return;       // 표지 기간은 quarter에서 파생, 저장 불필요
    let val = raw;
    if (el.dataset.num) {                              // 공실률 숫자 필드: "2.94%" → 2.94
      const n = parseFloat(raw.replace(/[%\s]/g, ''));
      val = Number.isFinite(n) ? n : null;
    }
    setByPath(model, el.dataset.p, val);
  });
  // 2) 테이블
  document.querySelectorAll('table[data-tbl]').forEach(tbl => {
    const path = tbl.dataset.tbl.split('.');
    const rows = [];
    tbl.querySelectorAll('tbody tr').forEach(tr => {
      const row = {};
      tr.querySelectorAll('[data-c]').forEach(td => { row[td.dataset.c] = td.innerText.trim(); });
      rows.push(row);
    });
    model[path[0]][path[1]][path[2]] = rows;
  });
  return model;
}
