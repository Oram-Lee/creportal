/**
 * mreport-data.js — 오피스 마켓 리포트 데이터 계층
 *
 * 역할:
 *   1. buildings + vacancies 로드 → window.state.allBuildings 주입
 *      (portal-stats.js 의 srGetNormBuildings() 가 이 경로를 읽음)
 *   2. 공실률 계산 — portal-stats-compare.js 의 저장된 다시점 세션(statsTrend)을
 *      srTrendRegionRatesForReport() 로 재계산 → 다시점 추이 화면과 수치 100% 일치
 *      (분기의 대표월 = 분기말 월: 26.1Q → 2026-03)
 *   3. 리포트 모델 생성 / Firebase 저장·로드 (marketReports/{quarter})
 *   4. AI 문구 초안 (BACKEND /api/claude-proxy)
 *
 * ⚠️ 사전 조건: portal-stats-compare.js 에 srTrendRegionRatesForReport export 가
 *    추가된 버전이 배포되어 있어야 함 (2026-07 마켓리포트 연동 패치).
 */

import { state } from './portal-state.js';
import { srTrendRegionRatesForReport } from './portal-stats-compare.js';

export const BACKEND = 'https://portal-dsyl.onrender.com';

export const MR_REGIONS = ['CBD', 'GBD', 'YBD', 'BBD', 'Others'];
export const MR_REGION_LABEL = {
  CBD: '도심 권역 (CBD)', GBD: '강남 권역 (GBD)', YBD: '여의도 권역 (YBD)',
  BBD: '분당·판교 권역 (BBD)', Others: '기타 권역',
};
export const MR_REGION_SHORT = { CBD:'CBD', GBD:'GBD', YBD:'YBD', BBD:'BBD', Others:'기타' };

/* ═══════════════ 1. 빌딩/공실 로드 → state 주입 ═══════════════ */

let _dataLoaded = false;

/** buildings + vacancies 를 병합해 state.allBuildings 에 주입 (1회) */
export async function ensureBuildingsLoaded() {
  if (_dataLoaded && (window.state?.allBuildings || []).length) return;
  const { db, ref, get } = await import('./portal-firebase.js');

  const [bSnap, vSnap] = await Promise.all([
    get(ref(db, 'buildings')),
    get(ref(db, 'vacancies')),
  ]);
  const bMap = bSnap.val() || {};
  const vMap = vSnap.val() || {};

  const merged = [];
  for (const [id, b] of Object.entries(bMap)) {
    if (!b || b.status === 'deleted' || b.status === 'hidden') continue;
    const vacsObj = vMap[id] || {};
    const vacancies = Object.entries(vacsObj).map(([k, v]) => ({ ...(v || {}), _key: k }));
    merged.push({ ...b, id, vacancies });
  }

  window.state = window.state || state;         // portal-stats 가 window.state 를 읽음
  window.state.allBuildings = merged;
  _dataLoaded = true;
  console.log(`[mreport] buildings 로드 완료: ${merged.length}동`);
}

/* ═══════════════ 2. 분기 공실률 계산 ═══════════════ */

export function prevQuarterOf(q) {          // '2026Q1' → '2025Q4'
  const y = +q.slice(0, 4), n = +q.slice(5);
  return n === 1 ? `${y - 1}Q4` : `${y}Q${n - 1}`;
}
// 통계 모듈(statsFilter)의 세션 키 형식: '2026Q1' → '202601'
export const toStatsKey = q => `${q.slice(0, 4)}${String(q.slice(5)).padStart(2, '0')}`;
// 다시점(statsTrend)은 월 단위 — 분기의 대표월 = 분기말 월 ('2026Q1' → '2026-03')
export const quarterEndMonth = q =>
  `${q.slice(0, 4)}-${({ Q1: '03', Q2: '06', Q3: '09', Q4: '12' })[q.slice(4)]}`;

/**
 * 당분기·전분기 공실률 계산 — 저장된 다시점 세션(statsTrend) 기반.
 * 다시점 화면(공실률 계산 및 비교 → 다시점 추이)과 동일 파이프라인이므로 수치가 일치함.
 * 전분기는 당분기와 "같은 세션"으로 계산해 기준 일관성 보장.
 * @returns {{cur, prev, meta}}  cur/prev: {total, regions:{CBD..Others}, buildingCount, status} | null
 */
export async function computeVacancy(quarter) {
  await ensureBuildingsLoaded();
  const prevQ = prevQuarterOf(quarter);
  const curM = quarterEndMonth(quarter), prevM = quarterEndMonth(prevQ);

  const curRaw = await srTrendRegionRatesForReport(curM)
    .catch(e => { console.warn(`[mreport] ${curM} 다시점 집계 실패:`, e); return null; });
  const prevRaw = curRaw
    ? await srTrendRegionRatesForReport(prevM, curRaw.trendId)
        .catch(e => { console.warn(`[mreport] ${prevM} 다시점 집계 실패:`, e); return null; })
    : null;
  console.log(`[mreport] 다시점 집계 ${curM}:`, curRaw?.byRegion, `| 세션: ${curRaw?.title}(${curRaw?.trendId})`);

  const pack = (raw) => {
    const T = raw?.byRegion?.TOTAL;
    if (!T || !T.buildings) return null;
    // 리포트의 '기타' = Others + ETC 면적가중 병합
    const O = raw.byRegion.Others || { gross: 0, vacancyPy: 0 };
    const E = raw.byRegion.ETC    || { gross: 0, vacancyPy: 0 };
    const mg = (O.gross || 0) + (E.gross || 0);
    const mv = (O.vacancyPy || 0) + (E.vacancyPy || 0);
    return {
      total: T.rate,
      regions: {
        CBD: raw.byRegion.CBD?.rate ?? null,
        GBD: raw.byRegion.GBD?.rate ?? null,
        YBD: raw.byRegion.YBD?.rate ?? null,
        BBD: raw.byRegion.BBD?.rate ?? null,
        Others: mg > 0 ? +(mv / mg * 100).toFixed(2) : null,
      },
      buildingCount: T.buildings,
      status: raw.monthInSession ? 'finalized' : 'auto',   // auto = 세션에 없는 월 → 자동집계
    };
  };
  return {
    cur: pack(curRaw), prev: pack(prevRaw),
    meta: curRaw ? { trendId: curRaw.trendId, title: curRaw.title, months: curRaw.months, curM, prevM } : null,
  };
}
export function quarterLabel(q, style = 'dot') {  // '2026Q1' → '26.1Q' | '2026년 1분기'
  const y = q.slice(0, 4), n = q.slice(5);
  return style === 'dot' ? `${y.slice(2)}.${n}Q` : `${y}년 ${n}분기`;
}

/* ═══════════════ 3. 임대차 계약 자동채움 (crecons 계약사례 포털 연동) ═══════════════
 * GET https://crecons.onrender.com/api/report/lease-cases?year=&quarter=&key=
 * 응답: { regions: { CBD: { count, avgNoc, avgEnoc, cases:[{tenant,building,gla,nla,isFeatured}] } } }
 *   · cases = 대표사례(★) 우선, 없으면 임대면적 상위 5건
 *   · ETC 권역은 리포트의 Others 로 병합
 * 실패(콜드스타트/키오류/CORS) 시 빈 객체 반환 → 수동 입력 모드로 자연 강등
 */
export const CRECONS = 'https://crecons.onrender.com';
export const CRECONS_KEY = 'mrpt_7Kx2vQ9nWc4Tz8Lb5Hj3Rd6Fm1Pg';   // crecons Render 환경변수 REPORT_API_KEY 와 동일하게

const _py2m2 = py => Math.round((parseFloat(py) || 0) * 3.3058).toLocaleString();
const _fmtPy = py => Math.round(parseFloat(py) || 0).toLocaleString();
// 표기 정규화: 공백 제거 + 법인 접두어 제거 → "무신사 S1"="무신사S1", "(주)딥다이브"="딥다이브"
const _norm = s => String(s || '').replace(/\s+/g, '').replace(/^(㈜|\(주\)|주식회사)/, '').toLowerCase();

/** 포털 buildings 에서 빌딩명 매칭으로 세부권역(subRegion) 찾기.
 *  ① nameNormalized/name 정확 일치 → ② aliases 일치 → ③ 포함 관계(폴백) */
function findSubRegion(bldName) {
  const n = _norm(bldName);
  if (!n) return '';
  const list = window.state?.allBuildings || [];
  const bn = b => _norm(b.nameNormalized || b.name);
  const hit =
    list.find(b => bn(b) === n) ||
    list.find(b => (b.aliases || []).some(a => _norm(a) === n)) ||
    list.find(b => { const x = bn(b); return x.length >= 3 && (x.includes(n) || n.includes(x)); });
  return hit?.subRegion || '';
}

export async function fetchLeaseContracts(quarter) {
  const year = quarter.slice(0, 4);
  const qq   = `${quarter.slice(5)}Q`;             // '2026Q1' → '1Q'
  const url  = `${CRECONS}/api/report/lease-cases?year=${year}&quarter=${qq}&key=${encodeURIComponent(CRECONS_KEY)}`;
  try {
    // Render 무료 플랜 콜드스타트 대비 45초 타임아웃
    const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) throw new Error(`crecons ${res.status}`);
    const data = await res.json();
    const src = data.regions || {};

    const toRow = c => ({
      subRegion: findSubRegion(c.building),                   // 포털 buildings.subRegion 자동 매칭 (실패 시 빈칸 → 수동 보완)
      building:  c.building || '',
      areaPy:    c.gla ? `${_fmtPy(c.gla)}평 (${_py2m2(c.gla)}㎡)` : '',
      areaM2:    '',
      tenant:    c.tenant || '',
    });

    const out = {};
    MR_REGIONS.forEach(r => {
      let cases = [...(src[r]?.cases || [])];
      if (r === 'Others') cases.push(...(src.ETC?.cases || []));   // ETC → Others 병합
      // ① 대표사례(★) 우선 정렬 → ② 빌딩+임차인 정규화 키로 중복 제거 → ③ 최대 6건
      cases.sort((a, b) => (b.isFeatured === true) - (a.isFeatured === true));
      const seen = new Set();
      const uniq = cases.filter(c => {
        const k = `${_norm(c.building)}|${_norm(c.tenant)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 6);
      if (uniq.length) out[r] = uniq.map(toRow);
    });
    console.log('[mreport] 임대차 계약 자동채움:', Object.keys(out).map(r => `${r} ${out[r].length}건`).join(', ') || '0건');
    return out;
  } catch (err) {
    console.warn('[mreport] 계약사례 API 실패 — 수동 입력 모드:', err.message || err);
    return { _error: err.message || String(err) };
  }
}

/* ═══════════════ 4. 리포트 모델 ═══════════════ */

/** 빈 리포트 모델 생성 */
export function emptyModel(quarter) {
  const prevQ = prevQuarterOf(quarter);
  const regionBlock = () => ({
    keywords: [ {big:'', label:'', sub:''}, {big:'', label:'', sub:''}, {big:'', label:'', sub:''} ],
    points:   [ {title:'', body:''}, {title:'', body:''}, {title:'', body:''} ],
    leases:   [],                       // {subRegion, building, areaPy, areaM2, tenant}
    leaseInsight: { title:'', body:'' },
    deals:    [],                       // {asset, price, pricePy, sellerBuyer}
    dealInsight:  { title:'', body:'' },
  });
  const m = {
    quarter, prevQuarter: prevQ,
    version: 0, updatedAt: '', updatedBy: '',
    vacancy: {
      auto: false, statsStatus: null, buildingCount: 0,
      total: { cur: null, prev: null },
      regions: {},          // {CBD:{cur,prev}...}
    },
    keypoints:  [ {title:'',body:''},{title:'',body:''},{title:'',body:''},{title:'',body:''} ],
    leasePoints:[ {title:'',body:''},{title:'',body:''},{title:'',body:''} ],
    dealStats:  [ {value:'',label:'',sub:''},{value:'',label:'',sub:''},{value:'',label:'',sub:''} ],
    dealPoints: [ {title:'',body:''},{title:'',body:''} ],
    regions: {},
  };
  MR_REGIONS.forEach(r => {
    m.vacancy.regions[r] = { cur: null, prev: null };
    m.regions[r] = regionBlock();
  });
  return m;
}

/** 초안 생성: 공실률 자동 계산 + 임대차 어댑터 결과를 모델에 주입 */
export async function buildDraftModel(quarter) {
  const model = emptyModel(quarter);
  const { cur, prev, meta } = await computeVacancy(quarter);
  if (meta) model.vacancy.source = { trendId: meta.trendId, title: meta.title, curM: meta.curM, prevM: meta.prevM };

  if (cur) {
    model.vacancy.auto = true;
    model.vacancy.statsStatus = cur.status;
    model.vacancy.buildingCount = cur.buildingCount;
    model.vacancy.total = { cur: cur.total, prev: prev ? prev.total : null };
    MR_REGIONS.forEach(r => {
      model.vacancy.regions[r] = {
        cur:  cur.regions[r],
        prev: prev ? prev.regions[r] : null,
      };
    });
    // 수치 기반 규칙형 초안 (AI 이전 단계 — 항상 채워지는 안전 초안)
    seedRuleBasedTexts(model);
  }

  const leases = await fetchLeaseContracts(quarter);
  model._leaseApiError = leases._error || null;      // 실패 시 배너 안내용 (저장 시 무해)
  MR_REGIONS.forEach(r => { if (Array.isArray(leases[r])) model.regions[r].leases = leases[r]; });

  return model;
}

/** 델타 문자열: cur/prev 로 '▼ 0.5% 하락' 형태 반환 */
export function deltaText(cur, prev) {
  if (cur == null || prev == null) return { arrow: '', text: '' };
  const d = +(prev - cur).toFixed(2);
  if (d > 0)  return { arrow: '▼', text: `${d}% 하락`, dir: 'down', abs: d };
  if (d < 0)  return { arrow: '▲', text: `${-d}% 상승`, dir: 'up',  abs: -d };
  return { arrow: '─', text: '보합', dir: 'flat', abs: 0 };
}
export const fmtRate = v => (v == null ? '' : (+v).toFixed(2).replace(/\.?0+$/, '') + '%');

/** 수치 기반 규칙형 텍스트 시드 — AI 실패/미사용 시에도 초안이 비지 않도록 */
function seedRuleBasedTexts(model) {
  const v = model.vacancy;
  const qL = quarterLabel(model.quarter, 'kr');
  const dAll = deltaText(v.total.cur, v.total.prev);

  // 권역 델타 정렬 (개선 폭 큰 순)
  const deltas = MR_REGIONS
    .map(r => ({ r, cur: v.regions[r].cur, prev: v.regions[r].prev }))
    .filter(x => x.cur != null && x.prev != null)
    .map(x => ({ ...x, d: +(x.prev - x.cur).toFixed(2) }))
    .sort((a, b) => b.d - a.d);
  const best = deltas[0];
  const lowest = MR_REGIONS
    .map(r => ({ r, cur: v.regions[r].cur })).filter(x => x.cur != null)
    .sort((a, b) => a.cur - b.cur)[0];

  const dirWord = dAll.dir === 'down' ? '하락' : dAll.dir === 'up' ? '상승' : '보합';
  if (v.total.prev != null && v.total.cur != null) {
    model.keypoints[2] = {
      title: `전 권역 공실률\n일제 ${dirWord}`,
      body: `서울 평균 공실률이 ${fmtRate(v.total.prev)}→${fmtRate(v.total.cur)}(${dAll.abs}% ${dirWord}), `
          + `${v.buildingCount}동 기준 집계됨. `
          + (best ? `${MR_REGION_SHORT[best.r]}가 ${Math.abs(best.d)}%로 가장 큰 폭 변동함.` : ''),
    };
    model.leasePoints[0] = {
      title: `서울 오피스 공실률\n전권역 동향`,
      body: `서울 평균 공실률은 ${fmtRate(v.total.prev)} → ${fmtRate(v.total.cur)} (${dAll.abs}%, ${v.buildingCount}개 동 기준)로 ${dirWord}했으며, `
          + (best ? `특히 ${MR_REGION_SHORT[best.r]}(${Math.abs(best.d)}%) 변동 폭이 크고, ` : '')
          + (lowest ? `${MR_REGION_SHORT[lowest.r]}(${fmtRate(lowest.cur)})가 최저 기록함.` : ''),
    };
  }

  // 권역별 첫 포인트
  MR_REGIONS.forEach(r => {
    const rv = v.regions[r];
    if (rv.cur == null) return;
    const d = deltaText(rv.cur, rv.prev);
    const w = d.dir === 'down' ? '하락' : d.dir === 'up' ? '상승' : '보합';
    model.regions[r].points[0] = {
      title: `${MR_REGION_SHORT[r]} 공실률 동향`,
      body: `당 분기 ${MR_REGION_SHORT[r]} 공실률은 ${fmtRate(rv.cur)}로, `
          + (rv.prev != null ? `전 분기 대비 ${d.abs}% ${w}하며 ` : '')
          + `${qL} 기준 집계됨.`,
    };
    model.regions[r].keywords[0] = { big: fmtRate(rv.cur), label: `${MR_REGION_SHORT[r]} 공실률`, sub: rv.prev != null ? `전분기 ${fmtRate(rv.prev)}` : '' };
    if (rv.prev != null) {
      model.regions[r].keywords[1] = {
        big: d.dir === 'flat' ? '보합' : `${d.arrow}${d.abs}%p`,
        label: '전분기 대비',
        sub: `${quarterLabel(model.prevQuarter)} → ${quarterLabel(model.quarter)}`,
      };
    }
  });
}

/* ═══════════════ 5. Firebase 저장/로드 (marketReports/{quarter}) ═══════════════ */

export async function saveModel(model, userEmail, force = false) {
  const { db, ref, get, set } = await import('./portal-firebase.js');
  const path = `marketReports/${model.quarter}`;

  // 낙관적 락 (statsFilter 와 동일 패턴). force=true 면 버전 검사 없이 latest+1 로 덮어씀.
  const vSnap = await get(ref(db, `${path}/version`));
  const latest = vSnap.exists() ? (vSnap.val() || 0) : 0;
  if (!force && latest !== (model.version || 0)) {
    return { ok: false, conflict: true, latest,
             reason: `저장된 버전(v${latest})과 내 버전(v${model.version || 0})이 다릅니다.` };
  }
  const payload = {
    ...model,
    version: latest + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: userEmail || 'unknown',
  };
  await set(ref(db, path), payload);
  model.version = payload.version;
  return { ok: true, version: payload.version };
}

export async function loadModel(quarter) {
  const { db, ref, get } = await import('./portal-firebase.js');
  const snap = await get(ref(db, `marketReports/${quarter}`));
  return snap.exists() ? normalizeModel(quarter, snap.val()) : null;
}

/**
 * RTDB 는 null/빈 배열/빈 객체를 저장하지 않으므로,
 * 로드 시 emptyModel 골격 위에 저장값을 깊이 병합해 누락 키를 복원.
 */
export function normalizeModel(quarter, raw) {
  const base = emptyModel(quarter);
  const merge = (dst, src) => {
    if (src == null) return dst;
    if (Array.isArray(dst)) {
      // 배열: 저장본이 배열/객체(인덱스키) 어느 쪽이든 배열로 복원.
      // 길이는 max(골격, 저장본) — 골격 슬롯(예: points 3칸)이 유실되지 않도록.
      const arr = Array.isArray(src) ? src : Object.keys(src).sort((a,b)=>a-b).map(k => src[k]);
      const len = Math.max(dst.length, arr.length);
      const out = [];
      for (let i = 0; i < len; i++) {
        const item = arr[i];
        if (item === undefined)                 out.push(structuredClone(dst[i]));
        else if (item && typeof item === 'object') out.push(merge(structuredClone(dst[i] ?? {}), item));
        else                                     out.push(item);
      }
      return out;
    }
    if (typeof dst === 'object' && dst !== null) {
      const out = { ...dst };
      for (const k of Object.keys(src)) out[k] = merge(dst[k], src[k]);
      return out;
    }
    return src;
  };
  const m = merge(base, raw);
  m.quarter = quarter;                       // 키 정합성 보장
  m.prevQuarter = prevQuarterOf(quarter);
  return m;
}

/* ═══════════════ 6. 타사 리서치 참고 (researchDocs — portal-rmap 아카이브 공유) ═══════════════ */

// '2026Q2' → '2026-Q2' (researchDocs.period 형식 = getPeriodString() 규격)
const periodKeyOf = q => `${q.slice(0, 4)}-${q.slice(4)}`;

/**
 * 작성 분기와 동일 또는 직전 분기의 타사 리서치 문서 후보 목록.
 * @returns [{id, title, source, period, reportType, hasIntel, uploadedAt}]
 */
export async function loadResearchDocsForQuarter(quarter) {
  const { db, ref, get } = await import('./portal-firebase.js');
  const snap = await get(ref(db, 'researchDocs'));
  const val = snap.val() || {};
  const wanted = new Set([periodKeyOf(quarter), periodKeyOf(prevQuarterOf(quarter))]);
  return Object.entries(val)
    .filter(([, d]) => d && d.active !== false && wanted.has(d.period))
    .map(([id, d]) => ({
      id,
      title: d.title || '(제목 없음)',
      source: d.source || '출처미상',
      period: d.period,
      reportType: d.reportType || '',
      hasIntel: d.intelStatus === 'ready' && !!d.prebuiltIntel,
      uploadedAt: d.uploadedAt || 0,
    }))
    // 당분기 우선 → 같은 분기 내 최신 업로드 우선
    .sort((a, b) => b.period !== a.period ? b.period.localeCompare(a.period) : b.uploadedAt - a.uploadedAt);
}

/**
 * 선택 문서들로 AI 참고 컨텍스트 조립.
 * 우선순위: prebuiltIntel.ALL → 권역별 prebuiltIntel 연결 → summary 폴백.
 * 조립 후 회사명 마스킹(portal-rmap _FIRM_REPLACE_FRONT 와 동일 규칙) 적용.
 */
export async function buildResearchContext(docIds) {
  if (!Array.isArray(docIds) || !docIds.length) return '';
  const { db, ref, get } = await import('./portal-firebase.js');
  const PER_DOC = 2200, TOTAL = 9000;
  const parts = [];
  for (const id of docIds) {
    const snap = await get(ref(db, `researchDocs/${id}`)).catch(() => null);
    const d = snap && snap.exists() ? snap.val() : null;
    if (!d) continue;
    const intel = d.prebuiltIntel || {};
    let body = intel.ALL
      || MR_REGIONS.map(r => intel[r] ? `[${r}] ${intel[r]}` : '').filter(Boolean).join('\n')
      || d.summary || '';
    if (!body) continue;
    if (body.length > PER_DOC) body = body.slice(0, PER_DOC) + '…';
    parts.push(`■ ${d.title || id} (${d.period || ''}${d.reportType ? ' · ' + d.reportType : ''})\n${body}`);
  }
  let ctx = parts.join('\n\n');
  if (ctx.length > TOTAL) ctx = ctx.slice(0, TOTAL) + '…';
  return maskFirmNames(ctx);
}

/* 리서치 기관·중개법인명 원천 차단 — AI 가 본문에 옮겨 쓰지 못하도록 컨텍스트 단계에서 치환 */
function maskFirmNames(s) {
  const RULES = [
    [/젠스타메이트/g, '전문 리서치 자료'],
    [/알스퀘어/g, '전문 리서치 자료'],
    [/교보리얼코/g, '전문 리서치 자료'],
    [/메이트플러스/g, '전문 리서치 자료'],
    [/세빌스/g, '글로벌 리서치 자료'],
    [/쿠시먼[\s]*(앤드웨이크필드|&\s*웨이크필드|웨이크필드)?/g, '글로벌 리서치 자료'],
    [/나이트프랭크/g, '글로벌 리서치 자료'],
    [/컬리어스/g, '글로벌 리서치 자료'],
    [/에비슨영/g, '글로벌 리서치 자료'],
    [/\bCBRE\b/g, '글로벌 리서치 자료'],
    [/\bJLL\b/g, '글로벌 리서치 자료'],
    [/젠스타(?!메이트)/g, '전문 리서치 자료'],
  ];
  let out = String(s);
  for (const [pat, rep] of RULES) out = out.replace(pat, rep);
  return out;
}

/* ═══════════════ 7. AI 문구 초안 ═══════════════ */

/**
 * 공실률 수치 + 임대차/매입매각 입력값을 근거로 리포트 문구 초안 생성.
 * @param refText      지난 분기 리포트 원문 — 문체·구성 참고 (수치 이월 금지)
 * @param dealText     당분기 매입매각 거래 리스트 — 사실 데이터
 * @param researchText 타사 리서치 컨텍스트(buildResearchContext 결과) — 워딩·해석 참고 전용
 * 반환: 부분 모델 { keypoints?, leasePoints?, regionPoints?: {CBD:{points,leaseInsight,dealInsight}} }
 */
/**
 * 공실률 수치 + 임대차/매입매각 입력값을 근거로 리포트 문구 초안 생성.
 * v1.6.0: 단일 거대 호출 → 6분할 병렬 호출 (요약 1 + 권역 5)
 *  - 콜당 출력 3~6천 토큰으로 max_tokens 절단·프록시 상한·타임아웃에서 구조적으로 해방
 *  - 일부 콜 실패/절단 시에도 성공분은 반영 (window._mrAiFailed / _mrAiTruncated 로 안내)
 * @param refText      지난 분기 리포트 원문 — 문체·구성 참고 (수치 이월 금지)
 * @param dealText     당분기 매입매각 거래 리스트 — 사실 데이터
 * @param researchText 타사 리서치 컨텍스트(buildResearchContext 결과)
 * 반환: 부분 모델 { keypoints?, leasePoints?, dealStats?, dealPoints?, regionPoints? }
 */
export async function generateAiDraft(model, refText = '', dealText = '', researchText = '') {
  const v = model.vacancy;
  const dataLines = [];
  dataLines.push(`분기: ${quarterLabel(model.quarter,'kr')} (전분기 ${quarterLabel(model.prevQuarter,'kr')})`);
  dataLines.push(`서울 전체 공실률: ${fmtRate(v.total.prev)} → ${fmtRate(v.total.cur)} (${v.buildingCount}동 기준)`);
  MR_REGIONS.forEach(r => {
    const rv = v.regions[r];
    dataLines.push(`${MR_REGION_SHORT[r]}: ${fmtRate(rv.prev) || '?'} → ${fmtRate(rv.cur) || '?'}`);
  });
  MR_REGIONS.forEach(r => {
    const b = model.regions[r];
    if (b.leases.length) dataLines.push(`${MR_REGION_SHORT[r]} 임대차 계약: ` + b.leases.map(l => `${l.building}(${l.areaPy}평, ${l.tenant})`).join(', '));
    if (b.deals.length)  dataLines.push(`${MR_REGION_SHORT[r]} 매입매각: ` + b.deals.map(d => `${d.asset}(${d.price}억, ${d.sellerBuyer})`).join(', '));
  });

  // 지난 분기 리포트 참고자료 (📎 첨부 시) — 문체·구성 참고용, 수치·사실 이월 금지
  const refBlock = refText
    ? ['## 지난 분기 리포트 (참고자료)',
       '아래는 지난 분기 리포트 원문이다. 문체·문단 구성·표현 톤만 참고하고,',
       '여기에 나오는 수치·계약·거래 사실을 이번 리포트에 절대 옮겨 쓰지 마라. 근거는 "데이터" 섹션과 "매입매각 자료" 섹션만 사용하라.',
       '---', String(refText).slice(0, 9000), '---', '']
    : [];

  // 이번 분기 매입매각 거래 리스트 (🏢 첨부 시) — 사실 데이터로 사용
  const dealBlock = dealText
    ? ['## 이번 분기 매입매각 자료 (사실 데이터 — 이 자료의 거래만 사용)',
       '아래는 당 분기 매입매각 거래 리스트 원문이다. 활용 규칙:',
       '① 거래 규모·건수·평당가 등 집계 지표와 시장 요약의 근거로 사용하라.',
       '② 권역별 거래 표(deals)는 이 자료의 거래를 해당 권역으로 분류해 작성하라.',
       '   asset=자산명, price=매매가(억원, 숫자만), pricePy=평당가(만원, 숫자만), sellerBuyer="매도자→매수자".',
       '   권역 구분이 불명확한 거래는 Others 로 분류하라. 자료에 없는 값은 빈 문자열.',
       '③ "거래예정" 섹션이 있으면: 당분기 실적 거래가 1건 이상 있는 권역에서는 예정 사례를 쓰지 마라.',
       '   실적 거래가 아예 없는(0건) 권역만 예정 사례로 채우되 asset 은 "자산명 [예정]" 형식으로 쓰고,',
       '   세부 내용(우협 선정·실사·클로징 예정 등)은 해당 권역 dealInsight body 에 기술하라. 집계 지표에는 예정 사례를 포함하지 마라.',
       '④ 각 거래의 비고("Deal 관련 세부 내용")는 deals 표에 넣지 말고, 특기 사항(우선매수권·사옥 매입·Share deal 등)을 dealInsight 에 자연스럽게 녹여라.',
       '---', String(dealText).slice(0, 9000), '---', '']
    : ['(매입매각 자료 미첨부 — deals 표 행과 dealStats 의 value 는 빈 값으로 두어라.',
       ' 단 dealPoints 와 각 권역 dealInsight 는 타사 리서치 자료가 있으면 그 정성적 해석을 근거로 반드시 작성하라(수치·기관명 인용 금지). 리서치도 없으면 공실률 추이 등 가용 근거로 시장 분위기를 1~2문장 서술하라)', ''];

  // 타사 리서치 컨텍스트 (📚 선택 시)
  const researchBlock = researchText
    ? ['## 타사 리서치 자료 (참고)',
       '아래는 전문 리서치 기관의 동일·직전 분기 오피스 시장 자료 요약이다. 활용 규칙:',
       '① 시장 해석·용어·전망 표현(예: 임차 우위 전환, 공급 부담, Flight to Quality, 우량 자산 선호 등)의 워딩·관점을 참고하고,',
       '   수급 동향·업종별 임차 수요·공급 일정·투자 심리 같은 정성적 내용은 문구 작성의 근거로 적극 활용하라.',
       '   특히 자사 계약·거래 데이터가 없는 권역의 points·keywords·insight 를 채울 때 이 자료가 핵심 근거다.',
       '② 공실률·임대료·거래 수치는 "데이터" 및 "매입매각 자료" 섹션의 값만 사용하라. 아래 자료의 수치를 본문에 옮기거나 자사 수치와 병기하지 마라.',
       '③ 리서치 기관명·중개법인명을 본문에 절대 표기하지 마라. 필요 시 "전문 리서치 자료 기준" 등 포괄 표현만 사용하라.',
       '④ 아래 자료의 논조가 자사 데이터의 방향과 다르면 자사 데이터를 우선하라.',
       '---', String(researchText).slice(0, 9000), '---', '']
    : [];

  const style = [
    '너는 상업용 부동산(서울 오피스) 시장 리포트 작성 전문가다.',
    '아래 데이터만 근거로 리포트 문구를 작성하라. 데이터에 없는 사실(구체적 계약·거래·수치)을 지어내지 마라.',
    '문체: 개조식 종결("~함", "~됨", "~임"), 각 body 는 1~2문장으로 간결하게.',
  ];
  const fillRules = [
    '## 채움 원칙 (중요 — 반드시 준수)',
    '모든 title/body/big/label 은 빈 문자열 금지 — 전 항목을 채워라.',
    '근거 우선순위: ①자사 수치 데이터 ②매입매각 첨부자료 ③타사 리서치의 정성적 해석 ④공실률 추이 기반 자체 해석.',
    '상위 근거가 없으면 하위 근거로 서술하되, 사실은 지어내지 마라 — 해석·전망 톤으로 작성하라.',
    '빈 값 허용 예외(사실 데이터 필수 항목만): deals 표 행(근거 자료가 없으면 빈 배열), dealStats 의 value(집계 근거가 없으면 빈 문자열).',
  ];
  const ctx = ['', '## 데이터', ...dataLines, '', ...refBlock, ...dealBlock, ...researchBlock];

  // 콜 1: 요약부 (keypoints/leasePoints/dealStats/dealPoints)
  const summaryPrompt = [...style, ...ctx,
    '## 출력 (JSON만, 코드블록 금지)', '{',
    ' "keypoints":[{"title":"줄바꿈은 \\n","body":""} ×4],',
    ' "leasePoints":[{"title":"","body":""} ×3],',
    ' "dealStats":[{"value":"","label":"","sub":""} ×3],',
    ' "dealPoints":[{"title":"","body":""} ×2]', '}', '',
    'dealStats: 매입매각 자료에서 집계 가능한 핵심 지표 3개(총 거래규모·건수·평균 평당가 등). value=수치, label=지표명, sub=부연.',
    ...fillRules].join('\n');

  // 콜 2~6: 권역별 (병렬) — 한 권역 분량만 출력
  const regionPrompt = r => [...style, ...ctx,
    `## 출력 — ${MR_REGION_LABEL[r]} (${r}) 이 한 권역의 내용만 작성하라. (JSON만, 코드블록 금지)`, '{',
    ' "points":[{"title":"","body":""} ×3],',
    ' "keywords":[{"big":"","label":"","sub":""} ×3],',
    ' "leaseInsight":{"title":"","body":""}, "dealInsight":{"title":"","body":""},',
    ' "deals":[{"asset":"","price":"","pricePy":"","sellerBuyer":""}]', '}', '',
    `keywords 규칙: 3개. 1번은 ${MR_REGION_SHORT[r]} 공실률 수치(제공값 유지·보완 가능), 2·3번은 이 권역 핵심 트렌드.`,
    '  big=짧은 수치 또는 2~6자 핵심어(예: "임차우위", "공급부담", "▲수요회복"), label=키워드명, sub=한 줄 부연. 수치 근거가 없으면 big 에 핵심어를 써라.',
    `deals: 매입매각 자료에서 ${MR_REGION_SHORT[r]} 권역 거래만 표 행으로 작성. 근거 자료가 없으면 빈 배열.`,
    ...fillRules].join('\n');

  const [sumRes, ...regRes] = await Promise.allSettled([
    callClaudeJson(summaryPrompt, 6000, '요약'),
    ...MR_REGIONS.map(r => callClaudeJson(regionPrompt(r), 6000, r)),
  ]);

  const ai = { regionPoints: {} };
  let truncated = false;
  const failed = [];
  if (sumRes.status === 'fulfilled') { Object.assign(ai, sumRes.value.parsed); truncated ||= sumRes.value.truncated; }
  else { failed.push('요약'); console.warn('[mreport] 요약 AI 실패:', sumRes.reason); }
  MR_REGIONS.forEach((r, i) => {
    const res = regRes[i];
    if (res.status === 'fulfilled') { ai.regionPoints[r] = res.value.parsed; truncated ||= res.value.truncated; }
    else { failed.push(MR_REGION_SHORT[r]); console.warn(`[mreport] ${r} 권역 AI 실패:`, res.reason); }
  });
  window._mrAiTruncated = truncated;
  window._mrAiFailed = failed;
  if (failed.length >= 1 + MR_REGIONS.length) {
    throw new Error(`AI 호출 전체 실패 (${(sumRes.reason && sumRes.reason.message) || ''})`);
  }
  return ai;
}

/** 프록시 1회 호출 → JSON 파싱. 절단 여부를 호출 단위로 반환 (병렬 안전) */
async function callClaudeJson(prompt, maxTokens, tag) {
  const res = await fetch(`${BACKEND}/api/claude-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`claude-proxy ${res.status}`);
  const data = await res.json();
  if (data.stop_reason || data.usage) {
    console.log(`[mreport] AI ${tag}: stop=${data.stop_reason || '?'} · 출력 ${(data.usage && data.usage.output_tokens) ?? '?'}tok`);
  }
  const parsed = parseAiJson(data.content?.[0]?.text || '');
  return { parsed, truncated: window._mrAiTruncated === true };   // parseAiJson 직후 동기 판독 — 경쟁 없음
}

/* ── AI 응답 JSON 파서 (v1.2.1) ──
 * 실전 실패 사례: max_tokens 절단으로 배열이 닫히지 않은 JSON → SyntaxError.
 * ① 코드펜스 제거 → ② 문자열 내부 제어문자(개행 등) 이스케이프 → ③ 직접 파싱
 * → ④ 실패 시: 뒤에서부터 마지막 완결 지점(, { [)으로 역추적하며 괄호 밸런싱 후 재시도.
 * 부분 복구라도 성공하면 반환 — mergeAiDraft 가 빈 값은 기존 문구를 유지하므로 안전. */
function parseAiJson(text) {
  window._mrAiTruncated = false;                      // 부분 복구 여부 (main 배너 안내용)
  const raw = String(text).replace(/```json|```/g, '').trim();
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('AI 응답에 JSON이 없습니다');
  const s = _escCtrlInStrings(raw.slice(start));

  try { return JSON.parse(s); } catch { /* 복구 시도로 진행 */ }

  window._mrAiRaw = raw;                              // 진단용: 콘솔에서 원문 확인 가능
  for (let cut = s.length; cut > 50; ) {
    try {
      const parsed = JSON.parse(_closeJson(s.slice(0, cut)));
      window._mrAiTruncated = true;
      console.warn('[mreport] AI 응답 절단 — 부분 복구됨 (뒤 권역 항목이 비었을 수 있음)');
      return parsed;
    } catch { /* 더 뒤로 역추적 */ }
    const prev = Math.max(
      s.lastIndexOf(',', cut - 2), s.lastIndexOf('{', cut - 2), s.lastIndexOf('[', cut - 2));
    if (prev <= 0) break;
    cut = prev;
  }
  throw new Error('AI 응답 파싱 실패 (콘솔 window._mrAiRaw 로 원문 확인)');
}
/* 문자열 내부의 원시 개행/탭/제어문자를 JSON 이스케이프로 치환 (문자열 밖 공백은 유지) */
function _escCtrlInStrings(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr && ch.charCodeAt(0) < 0x20) {
      out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '' : ' ';
      continue;
    }
    out += ch;
  }
  return out;
}
/* 잘린 JSON 마무리: 미종결 문자열 닫기 → 꼬리 쉼표/매달린 키 제거 → 열린 괄호 역순 닫기 */
function _closeJson(s) {
  let inStr = false, esc = false;
  const stack = [];
  for (const ch of s) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '').replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, '');
  while (stack.length) out += stack.pop() === '{' ? '}' : ']';
  return out;
}

/** AI 결과를 모델에 병합 (빈 문자열은 기존 값 유지, deals 는 유효 행이 있을 때만 교체) */
export function mergeAiDraft(model, ai) {
  const put = (dst, src) => {
    if (!Array.isArray(src)) return;
    src.forEach((s, i) => {
      if (!dst[i]) dst[i] = { title:'', body:'' };
      if (s?.title) dst[i].title = s.title;
      if (s?.body)  dst[i].body  = s.body;
    });
  };
  put(model.keypoints,  ai.keypoints);
  put(model.leasePoints, ai.leasePoints);
  put(model.dealPoints,  ai.dealPoints);

  // 매입매각 스탯 카드 (value/label/sub 구조)
  if (Array.isArray(ai.dealStats)) {
    ai.dealStats.slice(0, 3).forEach((s, i) => {
      if (!model.dealStats[i]) model.dealStats[i] = { value:'', label:'', sub:'' };
      ['value', 'label', 'sub'].forEach(k => { if (s?.[k]) model.dealStats[i][k] = String(s[k]); });
    });
  }

  MR_REGIONS.forEach(r => {
    const src = ai.regionPoints?.[r];
    if (!src) return;
    put(model.regions[r].points, src.points);
    // 권역 키워드 (big/label/sub) — AI가 값을 준 필드만 교체, 빈 값은 기존(시드) 유지
    if (Array.isArray(src.keywords)) {
      src.keywords.slice(0, 3).forEach((k, i) => {
        if (!model.regions[r].keywords[i]) model.regions[r].keywords[i] = { big:'', label:'', sub:'' };
        ['big', 'label', 'sub'].forEach(f => { if (k?.[f]) model.regions[r].keywords[i][f] = String(k[f]); });
      });
    }
    ['leaseInsight', 'dealInsight'].forEach(k => {
      if (src[k]?.title) model.regions[r][k].title = src[k].title;
      if (src[k]?.body)  model.regions[r][k].body  = src[k].body;
    });
    // 매입매각 거래 표: 자산명이 있는 유효 행이 1건 이상일 때만 교체 (환각 빈 행 방지)
    if (Array.isArray(src.deals)) {
      const rows = src.deals
        .map(d => ({
          asset:       String(d?.asset ?? '').trim(),
          price:       String(d?.price ?? '').trim(),
          pricePy:     String(d?.pricePy ?? '').trim(),
          sellerBuyer: String(d?.sellerBuyer ?? '').trim(),
        }))
        .filter(d => d.asset);
      if (rows.length) model.regions[r].deals = rows;
    }
  });
}
