/**
 * CRE Portal — 분기 요약 대시보드
 * js/portal-stats-summary.js
 *
 * Issue 3: 데이터 집계 레이어 (분기 감지 + 권역×등급 집계)
 * Issue 4: 권역 카드 UI + 등급 필터 렌더
 * Issue 5: 미니 SVG 트렌드 차트 (분기별 추이 + 증감 배지)
 * Issue 6: 계산 방법론 설명 섹션
 *
 * ▸ 의존: window.srLib (portal-stats.js에서 노출)
 *   — srGetNormBuildings, srApplyFilter, srFilterVacByDate,
 *     srFilterPriceByDate, srGetBestRent, srGetQuarter,
 *     srNormalizeDate, srGetAllPublishDates, srVacancyAreaPy,
 *     SR_REGIONS, SR_GRADES, SR_REGION_COLOR, SR_GRADE_COLOR
 */

// ═══════════════════════════════════════════════════════════════
// ISSUE-3: 데이터 집계 레이어
// ═══════════════════════════════════════════════════════════════

/** 현재 선택된 등급 필터 ([] = 전체, 복수 선택 가능) */
let _sumGradeFilter = [];  // string[]

/** 비교 분기 오버라이드 ('YYYY-QN' 형식, '' = 자동) */
let _sumCmpQuarter = '';

/**
 * 오늘 날짜 기준 직전 완료 분기 레이블 반환
 * 예) 2026-03-31 → 진행 중 2026Q1 → 직전 완료 2025Q4
 * @returns {string} 'YYYYQN'
 */
function _sumPrevCompletedQuarter() {
    const now   = new Date();
    const year  = now.getFullYear();
    const month = now.getMonth() + 1; // 1~12
    const curQ  = Math.ceil(month / 3);
    const prevQ    = curQ > 1 ? curQ - 1 : 4;
    const prevYear = curQ > 1 ? year : year - 1;
    return `${prevYear}Q${prevQ}`;
}

/**
 * publishDate 분포에서 분기 목록을 구하고,
 * 오늘 기준 "직전 완료 분기"를 current로 설정한다.
 *
 * current 선정 규칙:
 *   1. 데이터에 직전 완료 분기가 있으면 그대로 사용
 *   2. 없으면 직전 완료 분기 이하의 가장 최신 분기 사용
 *   3. 그것도 없으면 데이터 최신 분기로 fallback
 *
 * @returns {{ current: string, quarters: string[] }}
 *   current:  'YYYYQN' 기준분기 레이블
 *   quarters: current 포함 전체 목록 (current 맨 앞, 나머지 내림차순)
 */
function _sumDetectQuarters() {
    const lib = window.srLib;
    if (!lib) return { current: '', quarters: [] };

    const buildings = window.state?.allBuildings || [];
    const dates = lib.srGetAllPublishDates(buildings); // 'YYYY-MM'[] 오름차순

    const qSet = new Set();
    dates.forEach(d => {
        const q = lib.srGetQuarter(d);
        if (q.label) qSet.add(q.label);
    });

    const quarters = [...qSet].sort().reverse(); // 최신 우선
    if (quarters.length === 0) return { current: '', quarters: [] };

    // 오늘 기준 직전 완료 분기 (e.g. 오늘 2026Q1 진행 중 → '2025Q4')
    const target = _sumPrevCompletedQuarter();

    let current;
    if (quarters.includes(target)) {
        current = target;                                    // 1. 정확히 존재
    } else {
        const below = quarters.filter(q => q <= target);
        current = below.length > 0 ? below[0] : quarters[0]; // 2. 이하 최신 or fallback
    }

    // current를 맨 앞에, 나머지는 내림차순으로 재정렬
    const reordered = [current, ...quarters.filter(q => q !== current)];
    return { current, quarters: reordered };
}

/**
 * 분기 레이블('YYYYQN') → 해당 분기의 'YYYY-MM' 범위
 * @returns {{ from: string, to: string }}
 */
function _sumQuarterRange(qLabel) {
    // e.g. '2025Q1' → year=2025, q=1 → 01~03
    const m = qLabel.match(/^(\d{4})Q(\d)$/);
    if (!m) return { from: '', to: '' };
    const year = m[1];
    const q    = parseInt(m[2]);
    const mStart = String((q - 1) * 3 + 1).padStart(2, '0');
    const mEnd   = String(q * 3).padStart(2, '0');
    return { from: `${year}-${mStart}`, to: `${year}-${mEnd}` };
}

/**
 * 특정 분기에 속하는 공실 데이터만 반환
 * (publishDate가 해당 분기 범위 내에 있는 것)
 */
function _sumFilterVacByQuarter(vacancies, qLabel) {
    const lib = window.srLib;
    const { from, to } = _sumQuarterRange(qLabel);
    return lib.srFilterVacByDate(vacancies, from, to);
}

/**
 * 특정 분기 기준으로 유효한 임대가를 가진 floorPricing 중 최신값 반환
 * — 해당 분기 이전 effectiveDate 중 가장 최근 것
 */
function _sumGetRentForQuarter(building, qLabel) {
    const lib  = window.srLib;
    const { to } = _sumQuarterRange(qLabel);
    const fps  = (building.floorPricing || []).slice()
        .map(fp => ({ ...fp, _d: lib.srNormalizeDate(fp.effectiveDate || fp.createdAt || '') }))
        .filter(fp => fp._d && (!to || fp._d <= to))
        .sort((a, b) => b._d.localeCompare(a._d));

    const pick = fps[0];
    if (pick) {
        return {
            rentPy:    lib.srParsePrice(pick.rentPy),
            depositPy: lib.srParsePrice(pick.depositPy),
            source:    'floorPricing',
        };
    }
    // fallback: building root
    return {
        rentPy:    lib.srParsePrice(building.rentPy),
        depositPy: lib.srParsePrice(building.depositPy),
        source:    'building',
    };
}

/**
 * 권역×분기 집계 결과 타입
 * @typedef {{ vacRate: number, vacPy: number, gross: number,
 *             avgRent: number, rentCount: number, bldgCount: number }} SumStat
 */

/**
 * 권역별 분기 집계 수행
 * @param {string} qLabel  'YYYYQN'
 * @param {string} grade   '' | 'Prime' | 'A' | ...
 * @returns {Object<string, SumStat>}  { CBD: {...}, GBD: {...}, ... }
 */
function _sumCalcRegionStats(qLabel, grade) {
    const lib = window.srLib;
    if (!lib || !qLabel) return {};

    const normBuildings = lib.srGetNormBuildings();
    // grade: string | string[] | [] 모두 수용
    const gradeArr = Array.isArray(grade) ? grade : (grade ? [grade] : []);
    const filtered = gradeArr.length > 0
        ? lib.srApplyFilter(normBuildings, { grade: gradeArr })
        : normBuildings;

    const result = {};
    lib.SR_REGIONS.forEach(r => {
        result[r] = { vacRate: 0, vacPy: 0, gross: 0, avgRent: 0, rentCount: 0, bldgCount: 0 };
    });

    filtered.forEach(b => {
        const r = b._region;
        if (!result[r]) return;

        const gross = parseFloat(b.grossFloorPy) || 0;
        result[r].gross     += gross;
        result[r].bldgCount += 1;

        // 공실: 해당 분기 publishDate 기준
        const vacs = _sumFilterVacByQuarter(b._activeVacs, qLabel);
        const vacPy = vacs.reduce((s, v) => s + lib.srVacancyAreaPy(v), 0);
        result[r].vacPy += vacPy;

        // 임대가: 해당 분기 이전 최신 floorPricing
        const rent = _sumGetRentForQuarter(b, qLabel);
        if (rent.rentPy && rent.rentPy > 0) {
            result[r].avgRent   += rent.rentPy;
            result[r].rentCount += 1;
        }
    });

    // 최종 비율 계산
    lib.SR_REGIONS.forEach(r => {
        const s = result[r];
        s.vacRate = s.gross > 0 ? s.vacPy / s.gross * 100 : 0;
        s.avgRent = s.rentCount > 0 ? s.avgRent / s.rentCount : 0;
    });

    return result;
}

/**
 * 여러 분기에 걸친 시계열 집계 (트렌드 차트용)
 * @param {string[]} quarters  'YYYYQN'[] 내림차순
 * @param {string}   grade
 * @returns {Array<{ q: string, regions: Object<string, SumStat> }>}  오름차순
 */
function _sumCalcTimeSeries(quarters, grade) {
    // 현재 진행 중인 분기는 미완성 데이터 → 차트에서 제외
    const completed = _sumPrevCompletedQuarter(); // e.g. '2025Q4'
    const qs = [...quarters]
        .filter(q => q <= completed)   // 완료 분기만
        .sort()                        // 오름차순 (왼쪽=과거, 오른쪽=최신)
        .slice(-8);                    // 최근 8분기
    return qs.map(q => ({ q, regions: _sumCalcRegionStats(q, grade) }));
}


// ═══════════════════════════════════════════════════════════════
// ISSUE-4: 권역 카드 UI + 등급 필터 렌더
// ═══════════════════════════════════════════════════════════════

/**
 * 증감 배지 HTML 생성
 * @param {number} cur  현재 값
 * @param {number} prev 이전 값
 * @param {'rate'|'price'} type  공실률이면 rate, 임대가면 price
 */
function _sumDeltaBadge(cur, prev, type) {
    if (!prev || prev === 0) return '<span style="font-size:10px;color:var(--text-muted);">-</span>';
    const diff  = cur - prev;
    const pct   = (diff / prev * 100).toFixed(1);
    const isVac = type === 'rate';

    // 공실률: 상승=나쁨(빨강), 하락=좋음(초록)
    // 임대가: 상승=좋음(파랑), 하락=나쁨(주황)
    let color, arrow;
    if (diff === 0) {
        color = '#6b7280'; arrow = '●';
    } else if (diff > 0) {
        color = isVac ? '#ef4444' : '#1a73e8';
        arrow = '▲';
    } else {
        color = isVac ? '#16a34a' : '#ea580c';
        arrow = '▼';
    }

    const absStr = type === 'rate'
        ? `${Math.abs(diff).toFixed(1)}%p`
        : `${Math.abs(Math.round(diff)).toLocaleString()}원`;

    return `<span style="font-size:10px; font-weight:700; color:${color}; white-space:nowrap;">
        ${arrow} ${absStr}
    </span>`;
}

/** 등급 필터 버튼 그룹 렌더 (복수 선택) */
function _sumRenderGradeFilter() {
    const el = document.getElementById('sr-sum-grade-filter');
    if (!el) return;

    const lib    = window.srLib;
    const grades = ['전체', ...lib.SR_GRADES.filter(g => g !== 'E')]; // E등급 제외 (데이터 희소)
    const colors = { ...lib.SR_GRADE_COLOR, '전체': '#374151' };

    el.innerHTML = grades.map(g => {
        const key = g === '전체' ? '__all__' : g;
        // 전체: _sumGradeFilter가 빈 배열이면 active
        const active = g === '전체'
            ? _sumGradeFilter.length === 0
            : _sumGradeFilter.includes(g);
        const color = colors[g] || '#374151';
        return `<button
            onclick="window._srSumToggleGrade('${key}')"
            style="padding:4px 10px; border-radius:14px; font-size:11px; font-weight:700;
                   cursor:pointer; white-space:nowrap; transition:all 0.15s;
                   border:2px solid ${color};
                   background:${active ? color : 'transparent'};
                   color:${active ? '#fff' : color};">
            ${g}${active && g !== '전체' ? ' ✓' : ''}
        </button>`;
    }).join('');
}

/** 분기 선택 콤보박스 렌더 */
function _sumRenderQuarterSelect(quarters, currentQ) {
    const el = document.getElementById('sr-sum-cmp-select');
    if (!el) return;

    // 기준 분기를 제외한 나머지가 비교 대상
    const opts = quarters.slice(1).map(q => {
        const sel = (_sumCmpQuarter === q) ? 'selected' : '';
        return `<option value="${q}" ${sel}>${q} 비교</option>`;
    }).join('');

    el.innerHTML = `<option value="">직전 분기 비교</option>${opts}`;
    if (_sumCmpQuarter) el.value = _sumCmpQuarter;
}

/**
 * 단일 권역 카드 HTML 생성
 */
function _sumCardHtml(region, curStat, prevStat, prevQLabel) {
    const lib   = window.srLib;
    const color = lib.SR_REGION_COLOR[region] || '#6b7280';

    const vacRate   = curStat.vacRate;
    const avgRent   = curStat.avgRent;
    const bldgCount = curStat.bldgCount;
    const vacPy     = curStat.vacPy;

    const vacDelta  = prevStat ? _sumDeltaBadge(vacRate,  prevStat.vacRate,  'rate')  : '';
    const rentDelta = prevStat ? _sumDeltaBadge(avgRent,  prevStat.avgRent,  'price') : '';

    // 임대가: 만원 단위
    const rentDisplay = avgRent > 0
        ? `${(avgRent / 10000).toFixed(1)}<span style="font-size:10px;font-weight:400;">만원</span>`
        : '<span style="font-size:11px;color:var(--text-muted);">-</span>';

    const prevStr = prevStat && prevQLabel
        ? `<div style="font-size:9px; color:var(--text-muted); margin-top:2px;">vs ${prevQLabel}</div>`
        : '';

    return `
    <div style="background:var(--bg-card); border-radius:12px; padding:14px;
                border:2px solid ${color}20; box-shadow:0 2px 8px rgba(0,0,0,0.07);
                display:flex; flex-direction:column; gap:6px; min-width:0;">

        <!-- 권역명 + 빌딩수 -->
        <div style="display:flex; align-items:center; justify-content:space-between;">
            <span style="font-size:15px; font-weight:800; color:${color};">${region}</span>
            <span style="font-size:10px; color:var(--text-muted); background:var(--bg-secondary);
                         border-radius:10px; padding:2px 7px;">${bldgCount}개동</span>
        </div>

        <!-- 공실률 -->
        <div style="background:var(--bg-secondary); border-radius:8px; padding:8px 10px;">
            <div style="font-size:10px; color:var(--text-muted); margin-bottom:3px;">공실률</div>
            <div style="display:flex; align-items:baseline; gap:6px; flex-wrap:wrap;">
                <span style="font-size:22px; font-weight:800; color:${color}; line-height:1;">
                    ${vacRate.toFixed(1)}<span style="font-size:12px; font-weight:400;">%</span>
                </span>
                <div>${vacDelta}${prevStr}</div>
            </div>
            <!-- 공실면적 -->
            <div style="font-size:10px; color:var(--text-muted); margin-top:4px;">
                공실 ${Math.round(vacPy).toLocaleString()}평
            </div>
            <!-- 공실률 바 -->
            <div style="margin-top:6px; height:4px; border-radius:3px;
                        background:var(--border-color); overflow:hidden;">
                <div style="height:100%; width:${Math.min(vacRate, 30) / 30 * 100}%;
                             background:${color}; border-radius:3px; transition:width 0.4s;"></div>
            </div>
        </div>

        <!-- 평균임대가 -->
        <div style="background:var(--bg-secondary); border-radius:8px; padding:8px 10px;">
            <div style="font-size:10px; color:var(--text-muted); margin-bottom:3px;">평균임대가 (원/평/月)</div>
            <div style="display:flex; align-items:baseline; gap:6px; flex-wrap:wrap;">
                <span style="font-size:18px; font-weight:800; color:var(--text-primary); line-height:1;">
                    ${rentDisplay}
                </span>
                <div>${rentDelta}${prevStr}</div>
            </div>
        </div>
    </div>`;
}

/** 권역 카드 그리드 전체 렌더 */
function _sumRenderCards(curStats, prevStats, prevQLabel) {
    const el  = document.getElementById('sr-sum-cards');
    if (!el) return;
    const lib = window.srLib;

    el.innerHTML = lib.SR_REGIONS.map(r =>
        _sumCardHtml(r, curStats[r] || {}, prevStats?.[r] || null, prevQLabel)
    ).join('');
}


// ═══════════════════════════════════════════════════════════════
// ISSUE-5: 미니 SVG 트렌드 차트
// ═══════════════════════════════════════════════════════════════

/**
 * SVG 폴리라인 경로 계산
 * @param {number[]} values
 * @param {number} W  전체 너비
 * @param {number} H  전체 높이
 * @param {number} pad 여백
 */
function _sumPolyPoints(values, W, H, pad = 10) {
    const n    = values.length;
    if (n < 2) return '';
    const min  = Math.min(...values);
    const max  = Math.max(...values);
    const span = max - min || 1;
    return values.map((v, i) => {
        const x = pad + (i / (n - 1)) * (W - pad * 2);
        const y = H - pad - ((v - min) / span) * (H - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
}

/**
 * 단일 지표에 대한 다권역 SVG 라인 차트 생성
 * @param {Array<{q:string, regions:Object}>} series  오름차순
 * @param {'vacRate'|'avgRent'} metric
 * @returns {string} SVG HTML
 */
function _sumMakeLineChart(series, metric) {
    const lib    = window.srLib;
    const W      = 860;
    const H      = 180;
    const PAD    = 20;
    const LABELS = series.map(s => s.q);

    // 각 권역의 값 배열
    const regionData = {};
    lib.SR_REGIONS.forEach(r => {
        regionData[r] = series.map(s => s.regions[r]?.[metric] || 0);
    });

    // Y 전체 min/max (전 권역 통합)
    const allVals = lib.SR_REGIONS.flatMap(r => regionData[r]);
    const gMin = Math.min(...allVals);
    const gMax = Math.max(...allVals);
    const span = gMax - gMin || 1;

    const toY = v => H - PAD - ((v - gMin) / span) * (H - PAD * 2);
    const toX = i => PAD + (i / (LABELS.length - 1)) * (W - PAD * 2);

    // 축 눈금 레이블 (Y: 3개)
    const yTicks = [gMin, (gMin + gMax) / 2, gMax];
    const yTickHtml = yTicks.map(v => {
        const y = toY(v);
        const label = metric === 'vacRate'
            ? `${v.toFixed(1)}%`
            : `${(v / 10000).toFixed(1)}만`;
        return `<text x="${PAD - 4}" y="${y + 4}" text-anchor="end"
            font-size="9" fill="var(--text-muted)">${label}</text>
            <line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}"
                stroke="var(--border-color)" stroke-width="0.5" stroke-dasharray="3,3"/>`;
    }).join('');

    // X 레이블
    const xLabelHtml = LABELS.map((l, i) =>
        `<text x="${toX(i)}" y="${H - 3}" text-anchor="middle"
            font-size="9" fill="var(--text-muted)">${l}</text>`
    ).join('');

    // 라인
    const linesHtml = lib.SR_REGIONS.map(r => {
        const color  = lib.SR_REGION_COLOR[r];
        const vals   = regionData[r];
        const points = vals.map((v, i) =>
            `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`
        ).join(' ');

        const dotsAndLabels = vals.map((v, i) => {
            const cx = parseFloat(toX(i).toFixed(1));
            const cy = parseFloat(toY(v).toFixed(1));
            const label = metric === 'vacRate'
                ? `${v.toFixed(1)}%`
                : `${(v / 10000).toFixed(1)}만`;

            // 레이블 위치: 위쪽으로 12px, 차트 상단 넘치면 아래로
            const labelY = cy > PAD + 14 ? cy - 8 : cy + 16;

            return `<circle cx="${cx}" cy="${cy}"
                r="4" fill="${color}" stroke="#fff" stroke-width="1.5">
                <title>${r} ${LABELS[i]}: ${label}</title>
            </circle>
            <text x="${cx}" y="${labelY}" text-anchor="middle"
                font-size="9" font-weight="700"
                fill="${color}"
                paint-order="stroke" stroke="#fff" stroke-width="2.5"
                stroke-linejoin="round">${label}</text>`;
        }).join('');

        return `<polyline points="${points}" fill="none"
            stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            ${dotsAndLabels}`;
    }).join('');

    // 범례
    const legendHtml = lib.SR_REGIONS.map(r =>
        `<g>
            <rect width="12" height="4" rx="2" fill="${lib.SR_REGION_COLOR[r]}" y="4"/>
            <text x="16" y="11" font-size="10" fill="var(--text-primary)" font-weight="600">${r}</text>
        </g>`
    ).reduce((acc, cur, i) => acc + `<g transform="translate(${i * 70}, 0)">${cur}</g>`, '');

    return `
    <svg viewBox="0 0 ${W} ${H + 24}" xmlns="http://www.w3.org/2000/svg"
        style="width:100%; max-width:${W}px; height:auto; display:block;">
        <!-- 격자 + 축 -->
        ${yTickHtml}
        ${xLabelHtml}
        <!-- 라인 -->
        ${linesHtml}
        <!-- 범례 -->
        <g transform="translate(${PAD}, ${H + 6})">${legendHtml}</g>
    </svg>`;
}

/** 공실률 + 임대가 트렌드 차트 렌더 */
function _sumRenderTrendCharts(series) {
    const vacEl  = document.getElementById('sr-sum-vac-chart');
    const rentEl = document.getElementById('sr-sum-rent-chart');

    if (series.length < 2) {
        const msg = `<div style="color:var(--text-muted);font-size:12px;padding:20px;">
            분기 데이터가 2개 이상이어야 추이 차트가 표시됩니다.</div>`;
        if (vacEl)  vacEl.innerHTML  = msg;
        if (rentEl) rentEl.innerHTML = msg;
        return;
    }

    if (vacEl)  vacEl.innerHTML  = _sumMakeLineChart(series, 'vacRate');
    if (rentEl) rentEl.innerHTML = _sumMakeLineChart(series, 'avgRent');
}


// ═══════════════════════════════════════════════════════════════
// ISSUE-7: 권역 × 등급 요약 교차 테이블
// ═══════════════════════════════════════════════════════════════

/**
 * 권역×등급별 상세 집계 (카드와 차트 사이에 표시되는 상세 테이블용)
 * @param {string}   qLabel    기준 분기
 * @param {string}   prevQ     비교 분기
 * @param {string[]} gradeArr  선택 등급 배열 ([] = 전체)
 * @returns {Object} { [region]: { [grade]: { bldgCount, vacRate, avgRent, prevVacRate, prevAvgRent } } }
 */
function _sumCalcCrossStats(qLabel, prevQ, gradeArr) {
    const lib = window.srLib;
    if (!lib || !qLabel) return {};

    const GRADES_SHOW = lib.SR_GRADES.filter(g => g !== 'E'); // E등급 제외
    const targetGrades = gradeArr.length > 0 ? gradeArr : GRADES_SHOW;

    const normBuildings = lib.srGetNormBuildings();

    // 초기화
    const result = {};
    lib.SR_REGIONS.forEach(r => {
        result[r] = {};
        GRADES_SHOW.forEach(g => {
            result[r][g] = { bldgCount: 0, gross: 0, vacPy: 0, rentSum: 0, rentCnt: 0,
                             prevGross: 0, prevVacPy: 0, prevRentSum: 0, prevRentCnt: 0 };
        });
    });

    normBuildings.forEach(b => {
        const r = b._region;
        const g = b._gradeAuto;
        if (!result[r] || !result[r][g]) return;

        const gross = parseFloat(b.grossFloorPy) || 0;
        result[r][g].bldgCount += 1;
        result[r][g].gross     += gross;

        // 기준 분기 공실
        const vacs  = _sumFilterVacByQuarter(b._activeVacs, qLabel);
        result[r][g].vacPy += vacs.reduce((s, v) => s + lib.srVacancyAreaPy(v), 0);

        // 기준 분기 임대가
        const rent = _sumGetRentForQuarter(b, qLabel);
        if (rent.rentPy > 0) { result[r][g].rentSum += rent.rentPy; result[r][g].rentCnt += 1; }

        // 비교 분기
        if (prevQ) {
            const pvacs = _sumFilterVacByQuarter(b._activeVacs, prevQ);
            result[r][g].prevGross  += gross;
            result[r][g].prevVacPy  += pvacs.reduce((s, v) => s + lib.srVacancyAreaPy(v), 0);
            const prent = _sumGetRentForQuarter(b, prevQ);
            if (prent.rentPy > 0) { result[r][g].prevRentSum += prent.rentPy; result[r][g].prevRentCnt += 1; }
        }
    });

    // 비율 계산 → 최종 구조
    const final = {};
    lib.SR_REGIONS.forEach(r => {
        final[r] = {};
        GRADES_SHOW.forEach(g => {
            const d = result[r][g];
            final[r][g] = {
                bldgCount:   d.bldgCount,
                vacRate:     d.gross > 0 ? d.vacPy / d.gross * 100 : null,
                avgRent:     d.rentCnt > 0 ? d.rentSum / d.rentCnt : null,
                prevVacRate: d.prevGross > 0 ? d.prevVacPy / d.prevGross * 100 : null,
                prevAvgRent: d.prevRentCnt > 0 ? d.prevRentSum / d.prevRentCnt : null,
            };
        });
    });

    return { data: final, grades: GRADES_SHOW, targetGrades };
}

/**
 * 권역×등급 교차 테이블 HTML 렌더
 */
function _sumRenderCrossTable(currentQ, prevQ, gradeArr) {
    const el = document.getElementById('sr-sum-cross-table');
    if (!el) return;

    const lib = window.srLib;
    const { data, grades, targetGrades } = _sumCalcCrossStats(currentQ, prevQ, gradeArr);

    // 필터 적용된 등급만 표시 (전체면 전부)
    const showGrades = targetGrades;

    // 셀 배경색 (공실률 히트맵용)
    const allVacRates = lib.SR_REGIONS.flatMap(r =>
        showGrades.map(g => data[r]?.[g]?.vacRate).filter(v => v !== null && v > 0)
    );
    const maxVac = Math.max(...allVacRates, 1);

    const vacHeat = (v) => {
        if (v === null || v === 0) return 'transparent';
        const t = Math.min(v / maxVac, 1);
        return `rgba(239,68,68,${(t * 0.18).toFixed(2)})`;
    };

    // 증감 표시 헬퍼
    const deltaVac = (cur, prev) => {
        if (cur === null || prev === null) return '';
        const d = cur - prev;
        if (Math.abs(d) < 0.01) return '<span style="color:#6b7280;font-size:9px;">●</span>';
        const color = d > 0 ? '#ef4444' : '#16a34a';
        const arrow = d > 0 ? '▲' : '▼';
        return `<span style="color:${color};font-size:9px;font-weight:700;">${arrow}${Math.abs(d).toFixed(1)}%p</span>`;
    };
    const deltaRent = (cur, prev) => {
        if (cur === null || prev === null) return '';
        const d = cur - prev;
        if (Math.abs(d) < 1) return '<span style="color:#6b7280;font-size:9px;">●</span>';
        const color = d > 0 ? '#1a73e8' : '#ea580c';
        const arrow = d > 0 ? '▲' : '▼';
        const abs = Math.abs(Math.round(d));
        return `<span style="color:${color};font-size:9px;font-weight:700;">${arrow}${abs >= 10000 ? (abs/10000).toFixed(1)+'만' : abs.toLocaleString()+'원'}</span>`;
    };

    const gradeCols = showGrades.map(g => {
        const gColor = lib.SR_GRADE_COLOR[g] || '#6b7280';
        return `<th colspan="1" style="padding:6px 8px; text-align:center; font-size:11px;
                    font-weight:800; color:${gColor}; white-space:nowrap;
                    border-bottom:2px solid ${gColor}30; min-width:72px;">
                ${g}등급
            </th>`;
    }).join('');

    const rows = lib.SR_REGIONS.map(r => {
        const rColor = lib.SR_REGION_COLOR[r] || '#6b7280';

        const cells = showGrades.map(g => {
            const d = data[r]?.[g];
            if (!d || d.bldgCount === 0) {
                return `<td style="padding:6px 8px; text-align:center; color:var(--text-muted);
                            font-size:11px; border-bottom:1px solid var(--border-color);">-</td>`;
            }
            const vacStr  = d.vacRate  !== null ? `${d.vacRate.toFixed(1)}%`  : '-';
            const rentStr = d.avgRent  !== null ? `${(d.avgRent/10000).toFixed(1)}만` : '-';
            const bg = vacHeat(d.vacRate);
            return `<td style="padding:6px 8px; background:${bg};
                        border-bottom:1px solid var(--border-color); min-width:72px;">
                <div style="font-size:10px; color:var(--text-muted); margin-bottom:1px;">
                    ${d.bldgCount}개동
                </div>
                <div style="display:flex; align-items:center; gap:3px; flex-wrap:wrap;">
                    <span style="font-size:12px; font-weight:700; color:${rColor};">${vacStr}</span>
                    ${deltaVac(d.vacRate, d.prevVacRate)}
                </div>
                <div style="display:flex; align-items:center; gap:3px; flex-wrap:wrap; margin-top:1px;">
                    <span style="font-size:11px; color:var(--text-primary);">${rentStr}</span>
                    ${deltaRent(d.avgRent, d.prevAvgRent)}
                </div>
            </td>`;
        }).join('');

        // 행 합계 (선택 등급 전체 합산)
        const rowBldg = showGrades.reduce((s, g) => s + (data[r]?.[g]?.bldgCount || 0), 0);
        const rowVacs = showGrades.reduce((s, g) => {
            const d = data[r]?.[g];
            if (!d || d.bldgCount === 0) return s;
            // gross × vacRate 역산으로 vacPy 복원 불가 → 카운트 기반 평균
            return s;
        }, 0);

        return `<tr>
            <td style="padding:6px 10px; font-weight:800; font-size:12px; color:${rColor};
                        white-space:nowrap; border-bottom:1px solid var(--border-color);
                        position:sticky; left:0; background:var(--bg-card); z-index:1;">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%;
                              background:${rColor}; margin-right:4px;"></span>${r}
                <span style="font-size:10px; font-weight:400; color:var(--text-muted); margin-left:4px;">${rowBldg}개동</span>
            </td>
            ${cells}
        </tr>`;
    }).join('');

    const prevLabel = prevQ ? `vs ${prevQ}` : '';

    el.innerHTML = `
    <div style="overflow-x:auto;">
        <div style="font-size:10px; color:var(--text-muted); margin-bottom:6px; text-align:right;">
            셀 구성: <b>빌딩수</b> / <b>공실률 ${prevLabel ? '· '+prevLabel+' 증감' : ''}</b> / <b>평균임대가 ${prevLabel ? '· '+prevLabel+' 증감' : ''}</b>
            &nbsp;|&nbsp; 배경색 농도 = 공실률 수준
        </div>
        <table style="width:100%; border-collapse:collapse; font-size:11px;">
            <thead>
                <tr style="background:var(--bg-secondary);">
                    <th style="padding:8px 10px; text-align:left; font-size:11px; font-weight:700;
                               color:var(--text-primary); border-bottom:2px solid var(--border-color);
                               position:sticky; left:0; background:var(--bg-secondary); z-index:2;
                               min-width:80px;">
                        권역 / 등급
                    </th>
                    ${gradeCols}
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

// ═══════════════════════════════════════════════════════════════
// ISSUE-6: 계산 방법론 설명 섹션
// ═══════════════════════════════════════════════════════════════

function _sumRenderMethodology(currentQ, prevQLabel, gradeFilter) {
    const el = document.getElementById('sr-sum-methodology');
    if (!el) return;

    const gradeArr = Array.isArray(gradeFilter) ? gradeFilter : (gradeFilter ? [gradeFilter] : []);
    const gradeStr = gradeArr.length > 0
        ? `<strong>${gradeArr.join(' · ')}등급</strong> 빌딩만 집계`
        : '전체 등급 통합 집계';

    el.innerHTML = `
    <div style="font-weight:700; font-size:12px; color:var(--text-primary); margin-bottom:8px;">
        📐 계산 방법론
    </div>
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div>
            <div style="font-weight:600; margin-bottom:4px; color:var(--text-primary);">🏢 공실률</div>
            <div style="line-height:1.6;">
                <code style="background:var(--bg-card); padding:2px 6px; border-radius:4px; font-size:11px;">
                    공실률 = 공실 전용면적 합계 ÷ 빌딩 연면적(평) × 100
                </code><br>
                • 공실 전용면적: <code>exclusiveArea</code> 우선, 없으면 <code>rentArea</code><br>
                • 기준월: <strong>${currentQ} 발행 공실 데이터</strong> 기준<br>
                • 제외: 삭제·숨김 처리 공실, _meta 레코드<br>
                • 비교: ${prevQLabel ? `<strong>${prevQLabel}</strong> 동일 기준` : '비교 분기 없음'}
            </div>
        </div>
        <div>
            <div style="font-weight:600; margin-bottom:4px; color:var(--text-primary);">💰 평균임대가</div>
            <div style="line-height:1.6;">
                <code style="background:var(--bg-card); padding:2px 6px; border-radius:4px; font-size:11px;">
                    평균임대가 = 빌딩별 대표임대가 단순 평균 (원/평/月)
                </code><br>
                • 대표임대가: <code>floorPricing</code> 중 해당 분기 이전 최신값<br>
                • floorPricing 없으면 빌딩 루트(<code>rentPy</code>) 사용<br>
                • 임대가 0 빌딩 제외 후 평균 산출<br>
                • 표시 단위: 만원/평/月 (1만원 = 10,000원)
            </div>
        </div>
    </div>
    <div style="margin-top:10px; padding-top:8px; border-top:1px solid var(--border-color);
                font-size:10px; color:var(--text-muted);">
        ⚙️ 등급 필터: ${gradeStr} &nbsp;|&nbsp;
        등급 기준: Prime ≥ 20,000평 / A 10,000~20,000 / B 5,000~10,000 / C 3,000~5,000 / D 1,000~3,000 / E &lt; 1,000평 (연면적 기준)
    </div>`;
}


// ═══════════════════════════════════════════════════════════════
// 메인 렌더 진입점
// ═══════════════════════════════════════════════════════════════

/**
 * 분기 요약 대시보드 전체 렌더
 * window._srRenderSummary() 로 노출 — switchSRTab('summary') 시 호출됨
 */
window._srRenderSummary = function() {
    const lib = window.srLib;
    if (!lib) {
        console.warn('[portal-stats-summary] srLib not ready');
        return;
    }

    // 1. 분기 목록 감지
    const { current, quarters } = _sumDetectQuarters();
    if (!current) {
        const el = document.getElementById('sr-sum-cards');
        if (el) el.innerHTML = `<div style="grid-column:1/-1;text-align:center;
            color:var(--text-muted);padding:40px;font-size:13px;">
            데이터가 없습니다. 빌딩 데이터를 먼저 로드해 주세요.</div>`;
        return;
    }

    // 2. 비교 분기 결정
    const cmpSelect = document.getElementById('sr-sum-cmp-select');
    if (cmpSelect && cmpSelect.value) {
        _sumCmpQuarter = cmpSelect.value;
    }
    const prevQ = _sumCmpQuarter || quarters[1] || '';

    // 3. 분기 선택 UI 렌더
    const labelEl = document.getElementById('sr-sum-quarter-label');
    if (labelEl) {
        labelEl.innerHTML = `
            <span style="background:linear-gradient(135deg,#0f4c81,#1a73e8);
                         color:#fff; border-radius:8px; padding:4px 12px; font-size:14px;">
                ${current}
            </span>
            <span style="font-size:12px; color:var(--text-muted); font-weight:400; margin-left:4px;">
                기준 요약
            </span>`;
    }
    _sumRenderQuarterSelect(quarters, current);
    _sumRenderGradeFilter();

    // 4. 집계
    const curStats  = _sumCalcRegionStats(current, _sumGradeFilter);
    const prevStats = prevQ ? _sumCalcRegionStats(prevQ, _sumGradeFilter) : null;

    // 5. 카드 렌더
    _sumRenderCards(curStats, prevStats, prevQ);

    // 5-1. 권역×등급 교차 테이블
    _sumRenderCrossTable(current, prevQ, _sumGradeFilter);

    // 6. 트렌드 차트 (시계열)
    const series = _sumCalcTimeSeries(quarters, _sumGradeFilter);
    _sumRenderTrendCharts(series);

    // 7. 방법론 설명
    _sumRenderMethodology(current, prevQ, _sumGradeFilter);
};

/** 등급 필터 토글 핸들러 (복수 선택) */
window._srSumSetGrade = function(grade) {
    // 하위 호환 유지 (단일 grade 호출 시 해당 등급만 선택)
    _sumGradeFilter = grade ? [grade] : [];
    window._srRenderSummary();
};

window._srSumToggleGrade = function(key) {
    if (key === '__all__') {
        // 전체 버튼: 모든 선택 해제
        _sumGradeFilter = [];
    } else {
        const idx = _sumGradeFilter.indexOf(key);
        if (idx === -1) {
            _sumGradeFilter = [..._sumGradeFilter, key]; // 추가
        } else {
            _sumGradeFilter = _sumGradeFilter.filter(g => g !== key); // 제거
        }
    }
    window._srRenderSummary();
};

console.log('[portal-stats-summary] 분기 요약 대시보드 모듈 로드 완료');
