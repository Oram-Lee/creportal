/**
 * mreport-data.js — 오피스 마켓 리포트 데이터 계층
 *
 * 역할:
 *   1. buildings + vacancies 로드 → window.state.allBuildings 주입
 *      (portal-stats.js 의 srGetNormBuildings() 가 이 경로를 읽음)
 *   2. 공실률 계산 — portal-stats.js 의 srComputeQuarterStandalone() "그대로" 재사용
 *      → 통계 대시보드/비교 모달과 수치 100% 일치 보장
 *   3. 리포트 모델 생성 / Firebase 저장·로드 (marketReports/{quarter})
 *   4. AI 문구 초안 (BACKEND /api/claude-proxy)
 *
 * ⚠️ 사전 조건: portal-stats.js 에 아래 1줄 export 가 추가되어 있어야 함.
 *    export { _srComputeQuarterStandalone as srComputeQuarterStandalone };
 */

import { state } from './portal-state.js';
import { srComputeQuarterStandalone } from './portal-stats.js';

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
export function quarterLabel(q, style = 'dot') {  // '2026Q1' → '26.1Q' | '2026년 1분기'
  const y = q.slice(0, 4), n = q.slice(5);
  return style === 'dot' ? `${y.slice(2)}.${n}Q` : `${y}년 ${n}분기`;
}

/**
 * 당분기·전분기 공실률 계산 (통계 모듈 함수 재사용)
 * statsFilter 세션이 없으면 rate 가 전부 0/미존재 → null 처리해 수동 입력 유도
 * @returns {{cur, prev, curRaw, prevRaw}}  cur/prev: {total, regions:{CBD..}, buildingCount, status} | null
 */
export async function computeVacancy(quarter) {
  await ensureBuildingsLoaded();
  const prevQ = prevQuarterOf(quarter);

  const [curRaw, prevRaw] = await Promise.all([
    srComputeQuarterStandalone(quarter).catch(() => null),
    srComputeQuarterStandalone(prevQ).catch(() => null),
  ]);

  const pack = (raw) => {
    if (!raw || !raw.summary || raw.summary.totalBuildings === 0) return null;
    const regions = {};
    MR_REGIONS.forEach(r => { regions[r] = raw.byRegion?.[r]?.rate ?? null; });
    return {
      total: raw.summary.overallRate,
      regions,
      buildingCount: raw.summary.totalBuildings,
      status: raw.status || 'draft',
    };
  };
  return { cur: pack(curRaw), prev: pack(prevRaw), curRaw, prevRaw };
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
      subRegion: '',                                          // crecons 에 세부권역 없음 → 수동 보완
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
  const { cur, prev } = await computeVacancy(quarter);

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
  });
}

/* ═══════════════ 5. Firebase 저장/로드 (marketReports/{quarter}) ═══════════════ */

export async function saveModel(model, userEmail) {
  const { db, ref, get, set } = await import('./portal-firebase.js');
  const path = `marketReports/${model.quarter}`;

  // 낙관적 락 (statsFilter 와 동일 패턴)
  const vSnap = await get(ref(db, `${path}/version`));
  const latest = vSnap.exists() ? (vSnap.val() || 0) : 0;
  if (latest !== (model.version || 0)) {
    return { ok: false, reason: `다른 사용자가 먼저 저장했습니다 (v${latest}). 저장본을 다시 불러와주세요.` };
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

/* ═══════════════ 6. AI 문구 초안 ═══════════════ */

/**
 * 공실률 수치 + 임대차/매입매각 입력값을 근거로 리포트 문구 초안 생성.
 * 반환: 부분 모델 { keypoints?, leasePoints?, regionPoints?: {CBD:{points,leaseInsight,dealInsight}} }
 */
export async function generateAiDraft(model) {
  const v = model.vacancy;
  const lines = [];
  lines.push(`분기: ${quarterLabel(model.quarter,'kr')} (전분기 ${quarterLabel(model.prevQuarter,'kr')})`);
  lines.push(`서울 전체 공실률: ${fmtRate(v.total.prev)} → ${fmtRate(v.total.cur)} (${v.buildingCount}동 기준)`);
  MR_REGIONS.forEach(r => {
    const rv = v.regions[r];
    lines.push(`${MR_REGION_SHORT[r]}: ${fmtRate(rv.prev) || '?'} → ${fmtRate(rv.cur) || '?'}`);
  });
  MR_REGIONS.forEach(r => {
    const b = model.regions[r];
    if (b.leases.length) lines.push(`${MR_REGION_SHORT[r]} 임대차 계약: ` + b.leases.map(l => `${l.building}(${l.areaPy}평, ${l.tenant})`).join(', '));
    if (b.deals.length)  lines.push(`${MR_REGION_SHORT[r]} 매입매각: ` + b.deals.map(d => `${d.asset}(${d.price}억, ${d.sellerBuyer})`).join(', '));
  });

  const prompt = [
    '너는 상업용 부동산(서울 오피스) 시장 리포트 작성 전문가다.',
    '아래 데이터만 근거로 오피스 마켓 리포트 초안 문구를 작성하라. 데이터에 없는 사실을 지어내지 마라.',
    '문체: 개조식 종결("~함", "~됨", "~임"), 각 body 는 1~3문장.',
    '',
    '## 데이터', ...lines, '',
    '## 출력 (JSON만, 코드블록 금지)',
    '{',
    ' "keypoints":[{"title":"줄바꿈은 \\n","body":""} ×4],',
    ' "leasePoints":[{"title":"","body":""} ×3],',
    ' "regionPoints":{ "CBD":{"points":[{"title":"","body":""} ×3],',
    '   "leaseInsight":{"title":"","body":""}, "dealInsight":{"title":"","body":""}},',
    '   "GBD":{...}, "YBD":{...}, "BBD":{...}, "Others":{...} }',
    '}',
    '데이터가 없는 항목(임대차/매입매각 미입력 권역의 insight 등)은 빈 문자열로 두어라.',
  ].join('\n');

  const res = await fetch(`${BACKEND}/api/claude-proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`claude-proxy ${res.status}`);
  const data = await res.json();
  const raw  = (data.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
  const m    = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('AI 응답 파싱 실패');
  return JSON.parse(m[0]);
}

/** AI 결과를 모델에 병합 (빈 문자열은 기존 값 유지) */
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
  MR_REGIONS.forEach(r => {
    const src = ai.regionPoints?.[r];
    if (!src) return;
    put(model.regions[r].points, src.points);
    ['leaseInsight', 'dealInsight'].forEach(k => {
      if (src[k]?.title) model.regions[r][k].title = src[k].title;
      if (src[k]?.body)  model.regions[r][k].body  = src[k].body;
    });
  });
}
