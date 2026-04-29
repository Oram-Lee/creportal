/**
 * portal-stats-compare.js  v1.7.12  (저장 안정화 — 키 검증 + 신규ID 폴백)
 * ═══════════════════════════════════════════════════════════════
 * 두 시점(월 단위) 공실률·평균임대가·평균보증금·평균관리비 비교 모듈
 *
 * 진입점:
 *   window.openCompareModal()   — 모달 오픈
 *   window.closeCompareModal()  — 모달 닫기
 *
 * 의존성:
 *   - portal-stats.js (srLib)         — 정규화·필터·날짜 유틸 import
 *   - window.state.allBuildings        — 빌딩 마스터
 *   - window.state.currentUser         — 사용자 (Step 6 Firebase 저장 시)
 *   - window.XLSX (SheetJS)            — RAW 엑셀 파싱 (portal.html 에 이미 로드됨)
 *
 * 결정사항 (2026-04 합의):
 *   · 시점 단위:                       월 단위 (YYYY-MM)
 *   · 두 시점 다른 회사 자료:           제한 없음
 *   · 평균 계산:                        연면적 가중평균
 *   · 한쪽만 자료 있는 빌딩:            경고만 + 사용자 수동 제외
 *   · Firebase 저장:                    /statsCompare/{compareId}
 *   · 모집단:                           RAW 엑셀 매번 업로드 (옵션 B)
 *
 * 작업 단계:
 *   Step 1  : 골격 — 모달, 두 시점 month 셀렉트, 필터 UI                       ✅ 완료
 *   Step 2A (현재): RAW 엑셀 업로드 + portal 빌딩 매칭 + 모집단 정의
 *   Step 2B : 권역/등급/규모 필터 멀티픽커 + 시점별 OCR 매칭 빌딩 리스트
 *   Step 3  : 빌딩별 회사·공실 선택
 *   Step 4  : 공통 빌딩 셋 검출
 *   Step 5  : 계산 + 결과 카드
 *   Step 6  : Firebase 저장 + 엑셀
 *
 * 자료구조 / Firebase 스키마는 STATS_COMPARE_HANDOFF.md 참조.
 * ═══════════════════════════════════════════════════════════════
 */

import {
    srGetNormBuildings,
    srGetAllPublishDates,
    srNormalizeDate,
    srActiveVacancies,
    srGradeFromPy,
    srSizeBand,
    srGetRegion,
    srParsePrice,
    SR_REGIONS,
    SR_GRADES,
    SR_REGION_COLOR,
    SR_GRADE_COLOR,
} from './portal-stats.js';

// ═══════════════════════════════════════════════════════════════
// 1. 전역 상태
// ═══════════════════════════════════════════════════════════════

const _scState = {
    // ── 모집단 (RAW 엑셀 업로드 결과) ─────────────────────────
    // Step 2A: RAW 엑셀의 빌딩 리스트 + portal 빌딩 매칭 결과
    researchMaster: {
        loaded:       false,                 // 업로드 완료 여부
        fileName:     '',                    // 업로드한 파일명
        rawRows:      [],                    // RAW 엑셀 원본 행 배열
        matched:      [],                    // [{ raw, building, matchedBy, score }]
        unmatched:    [],                    // [{ raw, reason }]
        showUnmatch:  false,                 // 미매칭 목록 펼침 토글
        showMatched:  false,                 // 매칭 목록 펼침 토글 (v1.4)
        matchSearch:  '',                    // 매칭 테이블 검색어 (v1.4)
        expandMode:   false,                 // v1.7.7: portal 확장 모드 (양시점 OCR 빌딩 자동 포함)
    },

    // 수동 매칭 모달의 현재 타겟 (v1.4)
    _mmTarget: null,                          // {type:'unmatched'|'matched', index}

    // 시점 A·B 각각 독립 (월 단위 YYYY-MM)
    pointA: {
        yyyymm:     '',
        filters:    { grades: [], regions: [], sizeBands: [], subRegions: [] },
        // Map<buildingId, { chosenSource, selectedVacKeys: Set<string> }>
        selections: new Map(),
    },
    pointB: {
        yyyymm:     '',
        filters:    { grades: [], regions: [], sizeBands: [], subRegions: [] },
        selections: new Map(),
    },

    // UI 상태
    selectedBuildingId: null,   // Step 3에서 사용

    // v1.7.9: 빌딩 단위 exclude (페어 행 좌측 체크박스, 기본은 모두 포함=빈 셋)
    excludedBuildingIds: new Set(),

    // Firebase
    compareId: '',              // 새 세션이면 ''
    version:   0,
    title:     '',
    dirty:     false,
};

// 규모 구간 (필터용 — portal-stats.js srSizeBand 와 동일 정의)
const SR_SIZE_BANDS = ['대형', '중대형', '중형', '소형'];

// ═══════════════════════════════════════════════════════════════
// 2. 유틸리티
// ═══════════════════════════════════════════════════════════════

/** 안전한 querySelector */
function _scQS(id) { return document.getElementById(id); }

/** 시점 A/B 식별자 정규화 */
function _scSide(s) { return (s === 'B' || s === 'b') ? 'B' : 'A'; }

/** 사용 가능한 모든 발행월(YYYY-MM) 목록 — 내림차순 (최신 우선) */
function _scGetAllMonths() {
    const buildings = window.state?.allBuildings || [];
    const dates = srGetAllPublishDates(buildings);  // 오름차순 ['YYYY-MM', ...]
    return [...dates].sort().reverse();
}

// ═══════════════════════════════════════════════════════════════
// 3. 모달 동적 생성 / 주입
// ═══════════════════════════════════════════════════════════════

/**
 * 모달 DOM을 동적으로 body 에 주입 (portal.html 수정 최소화).
 * 이미 있으면 재주입하지 않음.
 */
function _scInjectModal() {
    if (_scQS('sc-modal')) return;

    const wrap = document.createElement('div');
    wrap.id = 'sc-modal';
    wrap.style.cssText = `
        display:none; position:fixed; top:50%; left:50%;
        transform:translate(-50%,-50%); background:var(--bg-card);
        border-radius:14px; padding:0; width:97%; max-width:1280px;
        z-index:1020; box-shadow:0 16px 56px rgba(0,0,0,0.35);
        max-height:93vh; overflow:hidden; flex-direction:column;
    `;

    wrap.innerHTML = `
        <!-- 헤더 -->
        <div style="padding:16px 24px; background:linear-gradient(135deg,#0f4c81,#1a73e8);
                    border-radius:14px 14px 0 0; display:flex;
                    justify-content:space-between; align-items:center; flex-shrink:0;">
            <div>
                <div style="font-size:16px; font-weight:700; color:#fff;">
                    📊 공실률 계산 및 비교
                </div>
                <div id="sc-subtitle"
                     style="font-size:12px; color:rgba(255,255,255,0.8); margin-top:2px;">
                    두 시점의 동일 빌딩 셋 기반 공실률·임대가·보증금·관리비 비교
                </div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
                <button id="sc-btn-load" onclick="window._scOpenLoadList && window._scOpenLoadList()"
                    style="padding:6px 12px; background:rgba(255,255,255,0.18);
                           border:1px solid rgba(255,255,255,0.35); color:#fff;
                           border-radius:7px; cursor:pointer; font-size:12px; font-weight:600;"
                    title="저장된 비교 세션 불러오기 (Step 6)">
                    📂 불러오기
                </button>
                <button id="sc-btn-save" onclick="window._scSaveCompare && window._scSaveCompare()"
                    disabled
                    style="padding:6px 12px; background:rgba(255,255,255,0.12);
                           border:1px solid rgba(255,255,255,0.20); color:rgba(255,255,255,0.6);
                           border-radius:7px; cursor:not-allowed; font-size:12px; font-weight:600;"
                    title="현재 비교 세션 저장 (Step 6)">
                    💾 저장
                </button>
                <button onclick="window.closeCompareModal()"
                    style="background:rgba(255,255,255,0.15); border:none; color:#fff;
                           font-size:20px; width:34px; height:34px;
                           border-radius:8px; cursor:pointer;">×</button>
            </div>
        </div>

        <!-- 본체 (스크롤) -->
        <div style="overflow-y:auto; flex:1; min-height:0;">

            <!-- ━━━ STEP 2A: RAW 엑셀 업로드 / 모집단 정의 ━━━ -->
            <div id="sc-raw-section"
                 style="padding:16px 24px; border-bottom:1px solid var(--border-color);
                        background:linear-gradient(90deg, #fef3c7 0%, #fef9e7 100%);">
                <div style="display:flex; align-items:center; justify-content:space-between;
                            gap:12px; flex-wrap:wrap;">
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span style="font-size:13px; font-weight:700; color:#92400e;">
                            📁 1단계 — 모집단(RAW 엑셀) 업로드
                        </span>
                        <span style="font-size:11px; color:#92400e; opacity:0.75;">
                            조사 대상 빌딩 마스터 리스트
                        </span>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <input type="file" id="sc-raw-file" accept=".xlsx,.xls"
                            onchange="window._scOnRawUpload(this)"
                            style="display:none;">
                        <button onclick="document.getElementById('sc-raw-file').click()"
                            style="padding:7px 14px; background:#f59e0b; color:#fff;
                                   border:none; border-radius:7px; cursor:pointer;
                                   font-size:12px; font-weight:700; white-space:nowrap;">
                            📂 RAW 엑셀 선택
                        </button>
                        <button id="sc-raw-clear"
                            onclick="window._scClearRaw()"
                            disabled
                            style="padding:7px 12px; background:transparent;
                                   color:#92400e; border:1px solid #f59e0b;
                                   border-radius:7px; cursor:not-allowed; opacity:0.4;
                                   font-size:11px; font-weight:600;">
                            초기화
                        </button>
                    </div>
                </div>
                <div id="sc-raw-status"
                     style="margin-top:10px; padding:10px 14px; background:#fff;
                            border-radius:6px; border:1px dashed #f59e0b;
                            font-size:12px; color:#92400e;">
                    아직 RAW 엑셀이 업로드되지 않았습니다. 위 버튼을 눌러 파일을 선택하세요.
                </div>
                <div id="sc-raw-unmatch-area" style="display:none; margin-top:8px;"></div>
            </div>

            <!-- ━━━ STEP 1: 시점 선택 섹션 (모집단 로드 전엔 비활성화) ━━━ -->
            <div id="sc-point-section"
                 style="padding:18px 24px 12px; border-bottom:1px solid var(--border-color);
                        background:var(--bg-secondary); position:relative;">
                <div id="sc-point-overlay"
                     style="position:absolute; top:0; left:0; right:0; bottom:0;
                            background:rgba(248,250,252,0.85); z-index:1;
                            display:flex; align-items:center; justify-content:center;
                            font-size:12px; color:var(--text-muted);
                            backdrop-filter:blur(1px);">
                    🔒 먼저 RAW 엑셀을 업로드해야 시점 선택이 활성화됩니다.
                </div>
                <div style="font-size:11px; font-weight:700; color:var(--text-muted);
                            margin-bottom:8px; text-transform:uppercase; letter-spacing:0.5px;">
                    📅 2단계 — 비교 시점 선택
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:18px;">
                    <!-- 시점 A -->
                    <div style="border-left:4px solid #0284c7; padding-left:12px;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                            <span style="font-size:13px; font-weight:700; color:#0284c7;">
                                시점 A (기준)
                            </span>
                            <select id="sc-month-A"
                                onchange="window._scOnMonthChange('A', this.value)"
                                style="padding:5px 10px; border:1px solid var(--border-color);
                                       border-radius:6px; background:var(--bg-primary);
                                       color:var(--text-primary); font-size:12px; cursor:pointer;
                                       min-width:140px;">
                                <option value="">-- 월 선택 --</option>
                            </select>
                            <span id="sc-count-A"
                                style="font-size:11px; color:var(--text-muted);"></span>
                        </div>
                        <div id="sc-filters-A"
                             style="display:flex; flex-wrap:wrap; gap:6px;
                                    font-size:11px; color:var(--text-muted);">
                            <span>필터: 모듈 로드 중…</span>
                        </div>
                    </div>

                    <!-- 시점 B -->
                    <div style="border-left:4px solid #ea580c; padding-left:12px;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                            <span style="font-size:13px; font-weight:700; color:#ea580c;">
                                시점 B (비교)
                            </span>
                            <select id="sc-month-B"
                                onchange="window._scOnMonthChange('B', this.value)"
                                style="padding:5px 10px; border:1px solid var(--border-color);
                                       border-radius:6px; background:var(--bg-primary);
                                       color:var(--text-primary); font-size:12px; cursor:pointer;
                                       min-width:140px;">
                                <option value="">-- 월 선택 --</option>
                            </select>
                            <span id="sc-count-B"
                                style="font-size:11px; color:var(--text-muted);"></span>
                        </div>
                        <div id="sc-filters-B"
                             style="display:flex; flex-wrap:wrap; gap:6px;
                                    font-size:11px; color:var(--text-muted);">
                            <span>필터: 모듈 로드 중…</span>
                        </div>
                    </div>
                </div>

                <!-- 진행 상태 안내 -->
                <div id="sc-progress-banner"
                     style="margin-top:12px; padding:8px 12px;
                            background:var(--bg-card); border-radius:6px;
                            font-size:11px; color:var(--text-muted);
                            border:1px dashed var(--border-color);">
                    💡 두 시점을 모두 선택하면 빌딩 리스트가 표시됩니다.
                </div>
            </div>

            <!-- 빌딩 리스트 + 상세 영역 (Step 2-4) -->
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:0;
                        min-height:380px; border-bottom:1px solid var(--border-color);">
                <div id="sc-pane-list"
                     style="padding:16px 20px; border-right:1px solid var(--border-color);">
                    <div style="font-size:13px; font-weight:700; color:var(--text-primary);
                                margin-bottom:8px;">
                        🏢 대상 빌딩 리스트
                    </div>
                    <div id="sc-building-list"
                         style="font-size:12px; color:var(--text-muted); padding:30px 0;
                                text-align:center;">
                        시점을 먼저 선택해주세요.
                    </div>
                </div>
                <div id="sc-pane-detail"
                     style="padding:16px 20px;">
                    <div style="font-size:13px; font-weight:700; color:var(--text-primary);
                                margin-bottom:8px;">
                        📑 빌딩 상세 — 회사·공실 선택
                    </div>
                    <div id="sc-building-detail"
                         style="font-size:12px; color:var(--text-muted); padding:30px 0;
                                text-align:center;">
                        좌측에서 빌딩을 선택해주세요.
                    </div>
                </div>
            </div>

            <!-- 결과 영역 (Step 5) -->
            <div style="padding:16px 24px;">
                <div style="display:flex; justify-content:space-between; align-items:center;
                            margin-bottom:10px;">
                    <div style="font-size:13px; font-weight:700; color:var(--text-primary);">
                        📈 비교 결과
                    </div>
                    <button id="sc-btn-calc"
                        onclick="window._scCalculate && window._scCalculate()"
                        disabled
                        style="padding:8px 18px; background:var(--bg-secondary);
                               color:var(--text-muted); border:1px solid var(--border-color);
                               border-radius:7px; cursor:not-allowed; font-size:13px;
                               font-weight:700;">
                        📐 공실률 계산하기
                    </button>
                </div>
                <div id="sc-result-area"
                     style="background:var(--bg-secondary); border-radius:8px;
                            padding:24px; text-align:center; color:var(--text-muted);
                            font-size:12px; min-height:120px;
                            display:flex; align-items:center; justify-content:center;">
                    양 시점 모두 빌딩·회사·공실을 선택하면 [공실률 계산하기] 버튼이 활성화됩니다.
                </div>
            </div>

        </div>
    `;

    document.body.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════════════
// 4. RAW 엑셀 업로드 / 모집단 매칭 (Step 2A)
// ═══════════════════════════════════════════════════════════════

// ── 4-A. 매칭용 정규화 헬퍼 (v1.2) ───────────────────────────────

// v1.7.1: srNormBuilding 이 채우지 않는 필드 안전 액세스 헬퍼
//   srNormBuilding 은 _region, _subCategory, _gradeAuto, _sizeBand 만 채움
//   → grossFloorPy(원본) 와 _subCategory(서브권역) 를 직접 사용
function _scGrossPy(b) {
    if (!b) return 0;
    return parseFloat(b.grossFloorPy) || parseFloat(b._grossPy) || 0;
}
function _scSubRegion(b) {
    if (!b) return '';
    // srDetectReportRegion 결과의 subCategory (예: '마포/공덕', 'DMC', '서울기타')
    return b._subCategory || b._subRegion || '';
}
/**
 * 빌딩명 정규화 — 공백·구두점·괄호·접미어 제거 후 lowercase
 * "미래에셋 센터원" → "미래에셋센터원"
 * "GS Tower" → "gstower"
 */
function _scNormName(s) {
    if (s == null) return '';
    return String(s)
        .toLowerCase()
        .replace(/\s+/g, '')                      // 공백 전부 제거
        .replace(/[·•・･ㆍ]/g, '')                  // 가운데점류
        .replace(/[\-–—_]/g, '')                  // 하이픈류
        .replace(/[()()【】\[\]『』「」<>《》]/g, '') // 괄호류
        .replace(/[,.]/g, '')                     // 쉼표·마침표
        .trim();
}

/** Dice bigram 유사도 (admin-research에서 검증된 패턴, 0~1) */
function _scDiceSim(a, b) {
    const na = _scNormName(a);
    const nb = _scNormName(b);
    if (!na || !nb) return 0;
    if (na === nb)  return 1;
    if (na.length < 2 || nb.length < 2) return 0;
    const aGrams = new Set();
    const bGrams = new Set();
    for (let i = 0; i < na.length - 1; i++) aGrams.add(na.substring(i, i + 2));
    for (let i = 0; i < nb.length - 1; i++) bGrams.add(nb.substring(i, i + 2));
    let inter = 0;
    aGrams.forEach(g => { if (bGrams.has(g)) inter++; });
    return (2 * inter) / (aGrams.size + bGrams.size);
}

/**
 * 주소 키 추출 — 시도/구 prefix 제거, 도로명+건물번호만 추출
 * "서울특별시 중구 을지로5길 26" → "을지로5길26"
 */
function _scAddrKey(road, num, fullAddr) {
    const stripPunct = s => String(s || '').replace(/\s+/g, '').replace(/[·•・]/g, '');
    if (road && num) return stripPunct(road) + stripPunct(num);
    if (fullAddr) {
        const cleaned = String(fullAddr)
            .replace(/^대한민국\s*/, '')
            .replace(/^서울특별시\s*/, '')
            .replace(/^서울시\s*/, '')
            .replace(/^서울\s*/, '')
            .replace(/^경기도\s*/, '')
            .replace(/^인천광역시\s*/, '')
            .replace(/^[가-힣]{1,4}구\s*/, '')   // "중구 ", "강남구 " 제거
            .replace(/^[가-힣]{1,4}동\s*\d*\s*/, ''); // 지번주소 동 제거
        return stripPunct(cleaned);
    }
    return '';
}

/**
 * portal 빌딩의 가능한 모든 ID 필드 후보 반환
 * (b.id 가 Firebase autoKey 라 RAW 엑셀 ID번호와 다를 수 있음)
 */
function _scGetBuildingIds(b) {
    const fields = [b.id, b.idNum, b.bldgId, b.researchId, b.excelId, b.bldgNo];
    return fields.filter(v => v != null && String(v).trim() !== '')
                 .map(v => String(v).trim());
}

/**
 * portal 빌딩의 가능한 모든 주소 필드 후보 반환
 */
function _scGetBuildingAddrs(b) {
    const fields = [b.address, b.roadAddress, b.lotAddress, b.oldAddress, b.fullAddress];
    return fields.filter(v => v != null && String(v).trim() !== '')
                 .map(v => String(v).trim());
}

// ── 4-B. 매칭 알고리즘 v3 (주소 우선) ────────────────────────────

/**
 * RAW 엑셀의 행과 portal 빌딩을 매칭한다 (v3).
 *
 * 핵심 철학: 빌딩명은 변동·오타·접미어 차이가 많지만
 *           도로명+건물번호는 행정상 유일하므로 주소를 메인 키로 한다.
 *
 * 5단계 매칭:
 *   1차: ID번호 정확 매칭 (다중 필드)
 *   2차: 도로명+건물번호 정확 매칭 (단독 hit)            ← 메인
 *   3차: 도로명+건물번호 다중 hit → 빌딩명으로 disambiguate (단지 빌딩 케이스)
 *   4차: 주소 누락 행 fallback — 빌딩명 정규화 단독 hit
 *   5차: Dice 유사도 ≥ 0.85 + 주소 일치 (최후 수단)
 *
 * @param {Object} rawRow  엑셀 한 행
 * @param {Array}  portalBuildings  window.state.allBuildings
 * @returns {{building, matchedBy, score}|null}
 */
function _scMatchRawRow(rawRow, portalBuildings) {
    const norm    = v => String(v == null ? '' : v).trim();
    const rawId   = norm(rawRow['ID번호']);
    const rawName = norm(rawRow['빌딩명']);
    const rawRoad = norm(rawRow['도로명']);
    const rawNum  = norm(rawRow['건물번호']);
    const rawAddrKey  = _scAddrKey(rawRoad, rawNum, '');
    const rawNameNorm = _scNormName(rawName);

    // ── 1차: ID번호 정확 매칭 (다중 필드 시도) ──
    if (rawId && rawId !== 'New' && rawId !== 'NaN' && !isNaN(parseInt(rawId, 10))) {
        const hit = portalBuildings.find(b =>
            _scGetBuildingIds(b).some(id => id === rawId));
        if (hit) return { building: hit, matchedBy: 'id', score: 1 };
    }

    // ── 2차·3차: 도로명+건물번호 매칭 (메인) ──
    if (rawAddrKey) {
        const hits = portalBuildings.filter(b =>
            _scGetBuildingAddrs(b).some(a => {
                const k = _scAddrKey('', '', a);
                return k && (k.includes(rawAddrKey) || rawAddrKey.includes(k));
            }));

        // 단독 hit → 즉시 확정
        if (hits.length === 1) {
            return { building: hits[0], matchedBy: 'addr', score: 1 };
        }

        // 다중 hit (단지 빌딩 케이스) → 빌딩명으로 disambiguate
        if (hits.length > 1) {
            // 정규화 이름 정확 일치
            if (rawNameNorm) {
                const exactName = hits.find(b =>
                    _scNormName(b.name || b.buildingName) === rawNameNorm);
                if (exactName) {
                    return { building: exactName, matchedBy: 'addr+name', score: 0.98 };
                }
            }
            // 빌딩명 Dice 유사도 best
            if (rawName) {
                let best = null, bestScore = 0;
                for (const b of hits) {
                    const sc = _scDiceSim(rawName, b.name || b.buildingName || '');
                    if (sc > bestScore) { bestScore = sc; best = b; }
                }
                if (best && bestScore >= 0.5) {
                    return { building: best, matchedBy: `addr+fuzzy(${bestScore.toFixed(2)})`, score: bestScore };
                }
            }
            // disambiguate 실패 — 보수적으로 null (오매칭 방지)
            // 하지만 사용자에게 알리기 위해 첫 번째 hit 반환 + ambiguous 플래그
            return { building: hits[0], matchedBy: `addr-ambiguous(${hits.length})`, score: 0.6 };
        }
    }

    // ── 4차: 주소 누락 행 fallback — 빌딩명 정규화 단독 hit ──
    if (!rawAddrKey && rawNameNorm) {
        const exact = portalBuildings.filter(b =>
            _scNormName(b.name || b.buildingName) === rawNameNorm);
        if (exact.length === 1) {
            return { building: exact[0], matchedBy: 'name-only', score: 0.85 };
        }
    }

    // ── 5차: Dice 유사도 + 주소 일치 (최후 수단) ──
    if (rawNameNorm && rawNameNorm.length >= 2 && rawAddrKey) {
        let best = null, bestScore = 0;
        for (const b of portalBuildings) {
            const sc = _scDiceSim(rawName, b.name || b.buildingName || '');
            if (sc > bestScore) { bestScore = sc; best = b; }
        }
        if (best && bestScore >= 0.85) {
            const ok = _scGetBuildingAddrs(best).some(a => {
                const k = _scAddrKey('', '', a);
                return k && (k.includes(rawAddrKey) || rawAddrKey.includes(k));
            });
            if (ok) {
                return { building: best, matchedBy: `fuzzy+addr(${bestScore.toFixed(2)})`, score: bestScore };
            }
        }
    }

    return null;
}

/** RAW 매칭 실패 사유 분류 (v3, 주소 기준) */
function _scUnmatchReason(rawRow, portalBuildings) {
    const norm    = v => String(v == null ? '' : v).trim();
    const rawName = norm(rawRow['빌딩명']);
    const rawRoad = norm(rawRow['도로명']);
    const rawNum  = norm(rawRow['건물번호']);
    const rawAddrKey = _scAddrKey(rawRoad, rawNum, '');

    if (!rawName && !rawAddrKey) return '빌딩명·주소 모두 없음';
    if (!rawAddrKey)              return '도로명/건물번호 누락 — 이름매칭 실패';

    // 도로명만이라도 일치하는 portal 빌딩이 있는지
    const roadKey = _scAddrKey(rawRoad, '', '');
    if (roadKey) {
        const sameRoad = portalBuildings.filter(b =>
            _scGetBuildingAddrs(b).some(a => {
                const k = _scAddrKey('', '', a);
                return k && k.includes(roadKey);
            }));
        if (sameRoad.length > 0) {
            return `같은 도로명 ${sameRoad.length}개 있음 — 건물번호 불일치`;
        }
    }
    return 'portal 에 등록되지 않음';
}

/** RAW 엑셀 업로드 핸들러 — 파일 input 의 onchange 에서 호출 */
window._scOnRawUpload = function(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!window.XLSX) {
        _scShowRawStatus('error', 'SheetJS(XLSX) 가 로드되지 않았습니다. portal.html line 11 의 SheetJS 로드 확인 필요');
        return;
    }
    _scShowRawStatus('loading', `📥 ${file.name} 읽는 중…`);

    const reader = new FileReader();
    reader.onload = e => {
        try {
            const wb    = window.XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
            const sheet = wb.Sheets[wb.SheetNames[0]];
            const rows  = window.XLSX.utils.sheet_to_json(sheet, { defval: '' });
            _scProcessRawRows(file.name, rows);
        } catch (err) {
            console.error('[stats-compare] RAW 엑셀 파싱 실패:', err);
            _scShowRawStatus('error', `❌ 엑셀 파싱 실패: ${err.message}`);
        }
    };
    reader.onerror = () => _scShowRawStatus('error', '❌ 파일 읽기 실패');
    reader.readAsArrayBuffer(file);

    // 같은 파일 재선택 가능하도록 input 값 리셋
    input.value = '';
};

/** 파싱된 행들을 portal 빌딩과 매칭하여 _scState.researchMaster 에 저장 */
function _scProcessRawRows(fileName, rows) {
    const portalBuildings = window.state?.allBuildings || [];
    if (portalBuildings.length === 0) {
        _scShowRawStatus('error', '❌ portal 빌딩 데이터가 아직 로드되지 않았습니다. 페이지 새로고침 후 다시 시도하세요.');
        return;
    }

    const matched   = [];
    const unmatched = [];

    rows.forEach(raw => {
        // 빌딩명 없는 행은 헤더 잔재 또는 빈 줄 → 무시
        if (!raw['빌딩명'] || String(raw['빌딩명']).trim() === '') return;
        const m = _scMatchRawRow(raw, portalBuildings);
        if (m) matched.push({ raw, building: m.building, matchedBy: m.matchedBy, score: m.score });
        else   unmatched.push({ raw, reason: _scUnmatchReason(raw, portalBuildings) });
    });

    _scState.researchMaster = {
        loaded:      true,
        fileName,
        rawRows:     rows,
        matched,
        unmatched,
        showUnmatch: false,
        showMatched: false,
        matchSearch: '',
        expandMode:  _scState.researchMaster.expandMode || false,   // v1.7.7: 기존 토글 유지
    };

    _scRenderRawStatus();
    _scLockUnlockPointSection(true);
    _scRenderBuildingLists();   // Step 2B: 모집단 변경 시 리스트 갱신

    // 미매칭 진단을 콘솔에 자동 출력 — 사용자가 어느 필드가 다른지 한눈에 확인
    _scLogUnmatchDiag(unmatched, portalBuildings);
};

/**
 * 미매칭 진단 — 처음 10개 미매칭에 대해 portal 에서 같은 도로명을 가진 후보를 출력.
 * 주소 기준이므로 빌딩명 형식 차이 영향 없이 진단 가능.
 */
function _scLogUnmatchDiag(unmatched, portalBuildings) {
    if (!unmatched || unmatched.length === 0) return;

    console.group(`%c[stats-compare] 미매칭 진단 — 처음 10개 (전체 ${unmatched.length}개, 주소 기준)`,
                  'color:#dc2626; font-weight:bold;');

    // portal 빌딩 첫 3개 샘플 — 사용 가능한 주소 필드 확인용
    if (portalBuildings.length > 0) {
        console.log('%c[참고] portal 빌딩 첫 3개의 주요 필드:', 'color:#6b7280;');
        console.table(portalBuildings.slice(0, 3).map(b => ({
            id:           b.id || '',
            name:         b.name || b.buildingName || '',
            address:      b.address || '',
            roadAddress:  b.roadAddress || '',
            lotAddress:   b.lotAddress || '',
        })));
    }

    unmatched.slice(0, 10).forEach((u, i) => {
        const rawName = u.raw['빌딩명'] || '';
        const rawRoad = u.raw['도로명'] || '';
        const rawNum  = u.raw['건물번호'] || '';
        const rawAddrKey = _scAddrKey(rawRoad, rawNum, '');
        const roadKey    = _scAddrKey(rawRoad, '', '');

        console.group(`%c❌ ${i+1}. ${rawName}  |  주소: ${rawRoad} ${rawNum}`,
                      'color:#dc2626;');

        // 같은 도로명을 가진 portal 빌딩 후보
        const cands = portalBuildings
            .map(b => {
                const addrs = _scGetBuildingAddrs(b);
                let bestAddr = '';
                let roadHit = false;
                let numHit  = false;
                for (const a of addrs) {
                    const k = _scAddrKey('', '', a);
                    if (!k) continue;
                    if (roadKey && k.includes(roadKey)) {
                        roadHit = true;
                        if (rawAddrKey && (k.includes(rawAddrKey) || rawAddrKey.includes(k))) {
                            numHit = true;
                        }
                        bestAddr = a;
                        break;
                    }
                }
                return {
                    building:  b,
                    roadHit, numHit, bestAddr,
                    nameScore: _scDiceSim(rawName, b.name || b.buildingName || ''),
                };
            })
            .filter(c => c.roadHit || c.nameScore >= 0.6)
            .sort((a, b) => {
                if (a.numHit  !== b.numHit)  return a.numHit  ? -1 : 1;
                if (a.roadHit !== b.roadHit) return a.roadHit ? -1 : 1;
                return b.nameScore - a.nameScore;
            })
            .slice(0, 5);

        if (cands.length === 0) {
            console.log('%c   → portal 에 같은 도로명 빌딩 없음 (실제로 portal 미등록)',
                        'color:#9ca3af;');
        } else {
            console.table(cands.map(c => ({
                addr주소hit:  c.numHit ? '✓번지' : (c.roadHit ? '~도로' : ''),
                nameScore:   c.nameScore.toFixed(2),
                portalName:  c.building.name || c.building.buildingName || '',
                portalAddr:  (c.bestAddr || c.building.address || '').slice(0, 50),
                portalId:    c.building.id || '',
            })));
        }
        console.groupEnd();
    });
    console.groupEnd();

    console.log(
        '%c💡 진단 활용법:\n' +
        '  · "✓번지" 표시 후보가 있는데 매칭 실패 → 주소 정규화에 추가 케이스 필요 (caseyaml 알려주세요)\n' +
        '  · "~도로" 표시만 있는 후보 → portal 의 건물번호가 RAW 와 다름 (오등록일 가능성)\n' +
        '  · 후보 자체가 없음 → portal 에 미등록된 빌딩 (정상)',
        'color:#0284c7;'
    );
};

/** RAW 매칭 결과 표시 */
function _scRenderRawStatus() {
    const rm = _scState.researchMaster;
    if (!rm.loaded) {
        _scShowRawStatus('idle', '아직 RAW 엑셀이 업로드되지 않았습니다. 위 버튼을 눌러 파일을 선택하세요.');
        return;
    }

    const totalRaw = rm.matched.length + rm.unmatched.length;
    const matchPct = totalRaw > 0 ? (rm.matched.length / totalRaw * 100).toFixed(1) : '0.0';

    // 매칭 방식별 카운트 (v3 — 주소 우선)
    const byId          = rm.matched.filter(m => m.matchedBy === 'id').length;
    const byAddr        = rm.matched.filter(m => m.matchedBy === 'addr').length;
    const byAddrName    = rm.matched.filter(m => m.matchedBy === 'addr+name').length;
    const byAddrFuzzy   = rm.matched.filter(m => String(m.matchedBy).startsWith('addr+fuzzy(')).length;
    const byAddrAmbig   = rm.matched.filter(m => String(m.matchedBy).startsWith('addr-ambiguous')).length;
    const byNameOnly    = rm.matched.filter(m => m.matchedBy === 'name-only').length;
    const byFuzzyAddr   = rm.matched.filter(m => String(m.matchedBy).startsWith('fuzzy+addr(')).length;

    const statusEl = _scQS('sc-raw-status');
    if (statusEl) {
        statusEl.style.background    = '#fff';
        statusEl.style.borderStyle   = 'solid';
        statusEl.style.borderColor   = '#16a34a';
        statusEl.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
                <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
                    <span style="font-weight:700; color:#15803d;">
                        ✅ ${rm.fileName}
                    </span>
                    <span style="color:#374151;">
                        RAW <strong>${totalRaw.toLocaleString()}</strong>개 ·
                        매칭 <strong style="color:#16a34a;">${rm.matched.length.toLocaleString()}</strong>개 (${matchPct}%) ·
                        미매칭 <strong style="color:#dc2626;">${rm.unmatched.length.toLocaleString()}</strong>개
                    </span>
                </div>
                ${rm.matched.length > 0 || rm.unmatched.length > 0 ? `
                    <div style="display:flex; gap:6px; flex-wrap:wrap;">
                        <button onclick="window._scToggleExpandMode()"
                            style="padding:4px 10px;
                                   background:${rm.expandMode ? '#9d174d' : '#fce7f3'};
                                   color:${rm.expandMode ? '#fff' : '#9d174d'};
                                   border:1px solid ${rm.expandMode ? '#9d174d' : '#fbcfe8'};
                                   border-radius:5px;
                                   font-size:11px; font-weight:700; cursor:pointer;
                                   white-space:nowrap;"
                            title="RAW에 없지만 양 시점 모두 OCR 데이터가 있는 portal 빌딩을 자동 포함합니다.">
                            📊 portal 확장 ${rm.expandMode ? 'ON' : 'OFF'}
                        </button>
                        ${rm.matched.length > 0 ? `
                            <button onclick="window._scToggleMatched()"
                                style="padding:4px 10px; background:#dbeafe; color:#1e40af;
                                       border:1px solid #93c5fd; border-radius:5px;
                                       font-size:11px; font-weight:600; cursor:pointer;">
                                ${rm.showMatched ? '매칭 접기' : '매칭 보기/편집'}
                            </button>
                        ` : ''}
                        ${rm.unmatched.length > 0 ? `
                            <button onclick="window._scToggleUnmatch()"
                                style="padding:4px 10px; background:#fef2f2; color:#991b1b;
                                       border:1px solid #fca5a5; border-radius:5px;
                                       font-size:11px; font-weight:600; cursor:pointer;">
                                ${rm.showUnmatch ? '미매칭 접기' : '미매칭 보기/매칭'}
                            </button>
                        ` : ''}
                    </div>
                ` : ''}
            </div>
            <div style="margin-top:6px; font-size:11px; color:#6b7280;">
                매칭 내역: ID번호 <strong>${byId}</strong>
                · 주소단독 <strong style="color:#16a34a;">${byAddr}</strong>
                · 주소+이름 <strong>${byAddrName}</strong>
                · 주소+유사 <strong>${byAddrFuzzy}</strong>
                ${byAddrAmbig > 0 ? `· <span style="color:#ea580c;">⚠️ 주소중복 ${byAddrAmbig}</span>` : ''}
                · 이름만 <strong>${byNameOnly}</strong>
                · 유사+주소 <strong>${byFuzzyAddr}</strong>
            </div>
        `;
    }

    // 미매칭 영역
    const unmatchEl = _scQS('sc-raw-unmatch-area');
    if (unmatchEl) {
        if (rm.showUnmatch && rm.unmatched.length > 0) {
            unmatchEl.style.display = 'block';
            unmatchEl.innerHTML = `
                <div style="background:#fff; border:1px solid #fca5a5; border-radius:6px;
                            padding:10px 14px; max-height:260px; overflow-y:auto;">
                    <div style="font-size:11px; font-weight:700; color:#991b1b; margin-bottom:6px;">
                        ⚠️ 미매칭 ${rm.unmatched.length}개 (분모에서 제외됨)
                        — 우측 [🔗 매칭] 버튼으로 수동 매칭 가능
                    </div>
                    <table style="width:100%; font-size:11px; border-collapse:collapse;">
                        <thead>
                            <tr style="color:#6b7280; text-align:left;">
                                <th style="padding:3px 6px; width:50px;">ID</th>
                                <th style="padding:3px 6px;">빌딩명</th>
                                <th style="padding:3px 6px;">주소</th>
                                <th style="padding:3px 6px; width:200px;">사유</th>
                                <th style="padding:3px 6px; width:64px;">액션</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rm.unmatched.slice(0, 200).map((u, idx) => `
                                <tr style="border-top:1px solid #fee2e2;">
                                    <td style="padding:3px 6px; color:#9ca3af;">${u.raw['ID번호'] || '-'}</td>
                                    <td style="padding:3px 6px; font-weight:600;">${u.raw['빌딩명'] || '-'}</td>
                                    <td style="padding:3px 6px; color:#6b7280;">
                                        ${(u.raw['도로명'] || '') + ' ' + (u.raw['건물번호'] || '')}
                                    </td>
                                    <td style="padding:3px 6px; color:#dc2626;">${u.reason}</td>
                                    <td style="padding:3px 6px;">
                                        <button onclick="window._scOpenManualMatch('unmatched', ${idx})"
                                            style="padding:2px 8px; background:#1a73e8; color:#fff;
                                                   border:none; border-radius:4px; font-size:10px;
                                                   font-weight:600; cursor:pointer;">
                                            🔗 매칭
                                        </button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    ${rm.unmatched.length > 200
                        ? `<div style="font-size:10px; color:#9ca3af; margin-top:6px; text-align:center;">
                             ※ 처음 200개만 표시 — 전체는 미매칭 ${rm.unmatched.length}개</div>`
                        : ''}
                </div>
            `;
        } else {
            unmatchEl.style.display = 'none';
            unmatchEl.innerHTML = '';
        }
    }

    // 매칭 영역 (v1.4 신규) — 매칭된 빌딩 목록 + 검색 + 변경/해제
    let matchEl = _scQS('sc-raw-match-area');
    if (!matchEl) {
        // 미매칭 영역 다음에 신규 div 삽입
        matchEl = document.createElement('div');
        matchEl.id = 'sc-raw-match-area';
        matchEl.style.cssText = 'display:none; margin-top:8px;';
        if (unmatchEl && unmatchEl.parentNode) {
            unmatchEl.parentNode.insertBefore(matchEl, unmatchEl.nextSibling);
        }
    }
    if (matchEl) {
        if (rm.showMatched && rm.matched.length > 0) {
            matchEl.style.display = 'block';
            const q = (rm.matchSearch || '').trim().toLowerCase();
            const filtered = q
                ? rm.matched.filter(m => {
                    const rn = String(m.raw['빌딩명'] || '').toLowerCase();
                    const ra = `${m.raw['도로명'] || ''} ${m.raw['건물번호'] || ''}`.toLowerCase();
                    const pn = String(m.building.name || m.building.buildingName || '').toLowerCase();
                    const pa = String(m.building.address || m.building.roadAddress || '').toLowerCase();
                    return rn.includes(q) || ra.includes(q) || pn.includes(q) || pa.includes(q);
                  })
                : rm.matched;
            const showRows = filtered.slice(0, 100);
            matchEl.innerHTML = `
                <div style="background:#fff; border:1px solid #93c5fd; border-radius:6px;
                            padding:10px 14px; max-height:340px; overflow-y:auto;">
                    <div style="display:flex; align-items:center; justify-content:space-between;
                                gap:10px; margin-bottom:8px;">
                        <div style="font-size:11px; font-weight:700; color:#1e40af;">
                            🔗 매칭 ${rm.matched.length}개
                            ${q ? `· 필터 결과 ${filtered.length}개` : ''}
                            ${filtered.length > 100 ? ` · 처음 100개만 표시` : ''}
                        </div>
                        <input type="text" value="${q.replace(/"/g, '&quot;')}"
                            placeholder="이름·주소 검색"
                            oninput="window._scOnMatchSearch(this.value)"
                            style="padding:4px 10px; font-size:11px; min-width:180px;
                                   border:1px solid #cbd5e1; border-radius:5px;
                                   background:#fff; color:#0f172a;">
                    </div>
                    <table style="width:100%; font-size:11px; border-collapse:collapse;">
                        <thead>
                            <tr style="color:#6b7280; text-align:left; background:#f8fafc;">
                                <th style="padding:4px 6px;">RAW 빌딩명</th>
                                <th style="padding:4px 6px;">RAW 주소</th>
                                <th style="padding:4px 6px; width:90px;">매칭방식</th>
                                <th style="padding:4px 6px;">portal 빌딩명</th>
                                <th style="padding:4px 6px;">portal 주소</th>
                                <th style="padding:4px 6px; width:100px;">액션</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${showRows.map(m => {
                                const realIdx = rm.matched.indexOf(m);
                                const isAmbiguous = String(m.matchedBy || '').startsWith('addr-ambiguous');
                                const isManual    = m.matchedBy === 'manual';
                                const matchedBadge = isManual
                                    ? `<span style="color:#7c3aed; font-weight:700;">✋ ${m.matchedBy}</span>`
                                    : isAmbiguous
                                    ? `<span style="color:#ea580c; font-weight:700;">⚠️ ${m.matchedBy}</span>`
                                    : `<span style="color:#16a34a;">${m.matchedBy}</span>`;
                                return `
                                    <tr style="border-top:1px solid #e5e7eb;
                                               ${isAmbiguous ? 'background:#fff7ed;' : ''}">
                                        <td style="padding:4px 6px; font-weight:600;">${m.raw['빌딩명'] || '-'}</td>
                                        <td style="padding:4px 6px; color:#6b7280;">
                                            ${(m.raw['도로명'] || '') + ' ' + (m.raw['건물번호'] || '')}
                                        </td>
                                        <td style="padding:4px 6px; font-size:10px;">${matchedBadge}</td>
                                        <td style="padding:4px 6px; font-weight:600; color:#0f172a;">
                                            ${m.building.name || m.building.buildingName || '-'}
                                        </td>
                                        <td style="padding:4px 6px; color:#6b7280;
                                                   max-width:220px; white-space:nowrap;
                                                   overflow:hidden; text-overflow:ellipsis;">
                                            ${m.building.address || m.building.roadAddress || '-'}
                                        </td>
                                        <td style="padding:4px 6px; white-space:nowrap;">
                                            <button onclick="window._scOpenManualMatch('matched', ${realIdx})"
                                                style="padding:2px 6px; background:#dbeafe; color:#1e40af;
                                                       border:1px solid #93c5fd; border-radius:4px;
                                                       font-size:10px; font-weight:600; cursor:pointer;
                                                       margin-right:3px;">
                                                ✏️ 변경
                                            </button>
                                            <button onclick="window._scUnmatchEntry(${realIdx})"
                                                style="padding:2px 6px; background:#fee2e2; color:#991b1b;
                                                       border:1px solid #fca5a5; border-radius:4px;
                                                       font-size:10px; font-weight:600; cursor:pointer;">
                                                ❌ 해제
                                            </button>
                                        </td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                    ${filtered.length === 0
                        ? `<div style="font-size:11px; color:#9ca3af; padding:14px; text-align:center;">
                             검색 결과 없음</div>`
                        : ''}
                </div>
            `;
        } else {
            matchEl.style.display = 'none';
            matchEl.innerHTML = '';
        }
    }

    // 초기화 버튼 활성화
    const clearBtn = _scQS('sc-raw-clear');
    if (clearBtn) {
        clearBtn.disabled = false;
        clearBtn.style.cursor = 'pointer';
        clearBtn.style.opacity = '1';
    }
}

/** 상태 메시지 표시 (idle / loading / error / success) */
function _scShowRawStatus(kind, msg) {
    const el = _scQS('sc-raw-status');
    if (!el) return;
    const palette = {
        idle:    { bg: '#fff',    border: '#f59e0b', color: '#92400e' },
        loading: { bg: '#eff6ff', border: '#3b82f6', color: '#1e40af' },
        error:   { bg: '#fef2f2', border: '#dc2626', color: '#991b1b' },
        success: { bg: '#f0fdf4', border: '#16a34a', color: '#15803d' },
    };
    const p = palette[kind] || palette.idle;
    el.style.background  = p.bg;
    el.style.borderColor = p.border;
    el.style.borderStyle = (kind === 'idle') ? 'dashed' : 'solid';
    el.style.color       = p.color;
    el.innerHTML         = msg;
}

/** 미매칭 목록 펼침/접기 */
window._scToggleUnmatch = function() {
    _scState.researchMaster.showUnmatch = !_scState.researchMaster.showUnmatch;
    if (_scState.researchMaster.showUnmatch) _scState.researchMaster.showMatched = false;
    _scRenderRawStatus();
};

/** 매칭 목록 펼침/접기 (v1.4) */
window._scToggleMatched = function() {
    _scState.researchMaster.showMatched = !_scState.researchMaster.showMatched;
    if (_scState.researchMaster.showMatched) _scState.researchMaster.showUnmatch = false;
    _scRenderRawStatus();
};

/** 매칭 테이블 검색어 변경 (v1.4) */
window._scOnMatchSearch = function(q) {
    _scState.researchMaster.matchSearch = q || '';
    _scRenderRawStatus();
};

/** v1.7.7: portal 확장 모드 토글 */
window._scToggleExpandMode = function() {
    const rm = _scState.researchMaster;
    rm.expandMode = !rm.expandMode;
    _scRenderRawStatus();
    _scRenderBuildingLists();          // 후보 리스트 즉시 갱신
    _scRenderResultPlaceholder();      // 결과 카운트 갱신
    _scMarkDirty();
    if (rm.expandMode) {
        const aYM = _scState.pointA.yyyymm;
        const bYM = _scState.pointB.yyyymm;
        if (!aYM || !bYM) {
            console.log('[stats-compare] 확장 모드는 양 시점 모두 선택돼야 효과를 봅니다');
        }
    }
};

// ── 4-D. 수동 매칭/편집 (v1.4) ────────────────────────────────────

let _scMMSearchTimer = null;

/** 수동 매칭 모달 DOM 동적 주입 */
function _scInjectManualMatchModal() {
    if (_scQS('sc-mm-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'sc-mm-modal';
    wrap.style.cssText = `
        display:none; position:fixed; top:50%; left:50%;
        transform:translate(-50%,-50%); background:var(--bg-card);
        border-radius:12px; padding:0; width:680px; max-width:92vw;
        z-index:1030; box-shadow:0 24px 60px rgba(0,0,0,0.5);
        max-height:82vh; overflow:hidden; display:flex; flex-direction:column;
    `;
    wrap.innerHTML = `
        <div style="padding:14px 20px; background:linear-gradient(135deg,#1a73e8,#0f4c81);
                    color:#fff; display:flex; justify-content:space-between;
                    align-items:center; flex-shrink:0;">
            <div>
                <div style="font-size:14px; font-weight:700;">🔗 수동 매칭 / 편집</div>
                <div id="sc-mm-rawinfo" style="font-size:11px; opacity:0.85; margin-top:2px;">
                    -
                </div>
            </div>
            <button onclick="window._scCloseManualMatch()"
                style="background:rgba(255,255,255,0.2); border:none; color:#fff;
                       font-size:18px; width:30px; height:30px; border-radius:6px;
                       cursor:pointer;">×</button>
        </div>
        <div style="padding:12px 20px; flex-shrink:0;
                    border-bottom:1px solid var(--border-color);">
            <input id="sc-mm-search" type="text"
                placeholder="🔍 portal 빌딩 검색 (이름 또는 주소 일부)"
                oninput="window._scOnMMSearch(this.value)"
                style="width:100%; padding:9px 12px; font-size:13px;
                       border:1px solid var(--border-color); border-radius:6px;
                       background:var(--bg-primary); color:var(--text-primary);
                       box-sizing:border-box;">
        </div>
        <div id="sc-mm-results" style="flex:1; overflow-y:auto; padding:0 20px 14px;
                                       min-height:200px;">
            -
        </div>
        <div style="padding:10px 20px; border-top:1px solid var(--border-color);
                    background:var(--bg-secondary); display:flex;
                    justify-content:space-between; align-items:center; flex-shrink:0;">
            <span style="font-size:11px; color:var(--text-muted);">
                💡 후보를 클릭하면 매칭이 즉시 적용됩니다 (자동 매칭을 덮어씀)
            </span>
            <button onclick="window._scCloseManualMatch()"
                style="padding:6px 14px; background:var(--bg-card);
                       border:1px solid var(--border-color); color:var(--text-primary);
                       border-radius:6px; cursor:pointer; font-size:12px;">
                취소
            </button>
        </div>
    `;
    document.body.appendChild(wrap);
}

/** 수동 매칭 시작 — 미매칭/매칭 항목 양쪽에서 호출 */
window._scOpenManualMatch = function(targetType, targetIndex) {
    _scInjectManualMatchModal();
    _scState._mmTarget = { type: targetType, index: targetIndex };

    let rawRow, currentMatch;
    if (targetType === 'unmatched') {
        const u = _scState.researchMaster.unmatched[targetIndex];
        if (!u) return;
        rawRow = u.raw;
    } else {
        const m = _scState.researchMaster.matched[targetIndex];
        if (!m) return;
        rawRow = m.raw;
        currentMatch = m.building;
    }

    const info = _scQS('sc-mm-rawinfo');
    if (info) {
        const rawAddr = `${rawRow['도로명'] || ''} ${rawRow['건물번호'] || ''}`.trim();
        info.innerHTML = `
            RAW: <strong>${rawRow['빌딩명'] || '-'}</strong>
            <span style="opacity:0.75;">(${rawAddr || '주소 없음'})</span>
            ${currentMatch ? `
                <br>현재 매칭: <strong>${currentMatch.name || currentMatch.buildingName || '-'}</strong>
            ` : ''}
        `;
    }
    const search = _scQS('sc-mm-search');
    if (search) { search.value = ''; setTimeout(() => search.focus(), 50); }

    _scRenderMMRecommend(rawRow);

    const modal = _scQS('sc-mm-modal');
    if (modal) modal.style.display = 'flex';
};

/** 추천 후보 렌더 (검색어 비었을 때) */
function _scRenderMMRecommend(rawRow) {
    const portalBuildings = window.state?.allBuildings || [];
    const rawName = rawRow['빌딩명'] || '';
    const rawRoad = rawRow['도로명'] || '';
    const rawNum  = rawRow['건물번호'] || '';
    const rawAddrKey = _scAddrKey(rawRoad, rawNum, '');
    const roadKey    = _scAddrKey(rawRoad, '', '');

    const cands = portalBuildings
        .map(b => {
            const addrs = _scGetBuildingAddrs(b);
            let addrScore = 0;
            for (const a of addrs) {
                const k = _scAddrKey('', '', a);
                if (!k) continue;
                if (rawAddrKey && (k.includes(rawAddrKey) || rawAddrKey.includes(k))) {
                    addrScore = 1; break;
                }
                if (roadKey && k.includes(roadKey)) {
                    addrScore = Math.max(addrScore, 0.5);
                }
            }
            const nameScore = _scDiceSim(rawName, b.name || b.buildingName || '');
            return {
                building: b,
                addrScore,
                nameScore,
                totalScore: addrScore * 1.5 + nameScore,
            };
        })
        .filter(c => c.totalScore >= 0.3)
        .sort((a, b) => b.totalScore - a.totalScore)
        .slice(0, 12);

    _scRenderMMResults(cands, '🎯 추천 후보 (주소·이름 유사도)', true);
}

/** 검색 (디바운스) */
window._scOnMMSearch = function(query) {
    clearTimeout(_scMMSearchTimer);
    _scMMSearchTimer = setTimeout(() => _scDoMMSearch(query), 120);
};

function _scDoMMSearch(query) {
    query = String(query || '').trim().toLowerCase();
    const target = _scState._mmTarget;
    if (!target) return;

    if (!query) {
        const rawRow = (target.type === 'unmatched')
            ? _scState.researchMaster.unmatched[target.index]?.raw
            : _scState.researchMaster.matched[target.index]?.raw;
        if (rawRow) _scRenderMMRecommend(rawRow);
        return;
    }

    const portalBuildings = window.state?.allBuildings || [];
    const results = portalBuildings
        .map(b => {
            const name  = String(b.name || b.buildingName || '').toLowerCase();
            const addrs = _scGetBuildingAddrs(b).map(a => String(a).toLowerCase());

            let score = 0;
            if      (name === query)          score = 100;
            else if (name.startsWith(query))  score = 50;
            else if (name.includes(query))    score = 30;
            else if (addrs.some(a => a.includes(query))) score = 20;
            else {
                const sim = _scDiceSim(query, name);
                if (sim >= 0.4) score = sim * 10;
            }
            return { building: b, score };
        })
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 50);

    _scRenderMMResults(results, `🔍 검색 결과 ${results.length}개`, false);
}

/** 결과 카드 렌더 — 추천 모드와 검색 모드 양쪽에서 사용 */
function _scRenderMMResults(items, title, isRecommend) {
    const el = _scQS('sc-mm-results');
    if (!el) return;
    if (!items || items.length === 0) {
        el.innerHTML = `
            <div style="padding:40px 0; text-align:center; color:var(--text-muted);
                        font-size:12px;">
                ${isRecommend ? '추천 후보를 찾을 수 없습니다. 위 검색창에 빌딩명/주소를 입력하세요.' : '일치하는 빌딩 없음'}
            </div>
        `;
        return;
    }
    el.innerHTML = `
        <div style="font-size:11px; font-weight:700; color:var(--text-muted);
                    margin:10px 0 8px; text-transform:uppercase; letter-spacing:0.5px;">
            ${title}
        </div>
        ${items.map(r => {
            const b = r.building;
            const name = b.name || b.buildingName || '';
            const addr = b.address || b.roadAddress || '';
            const id   = String(b.id || '').replace(/'/g, "\\'");
            const scoreText = isRecommend
                ? `📍${(r.addrScore * 100).toFixed(0)}% 📛${(r.nameScore * 100).toFixed(0)}%`
                : `★${(r.score / 10).toFixed(1)}`;
            return `
                <div onclick="window._scConfirmManualMatch('${id}')"
                    style="padding:10px 12px; border:1px solid var(--border-color);
                           border-radius:6px; margin-bottom:6px; cursor:pointer;
                           background:var(--bg-primary); transition:background 0.12s;"
                    onmouseover="this.style.background='#eff6ff';"
                    onmouseout="this.style.background='var(--bg-primary)';">
                    <div style="display:flex; justify-content:space-between; align-items:start; gap:10px;">
                        <div style="flex:1; min-width:0;">
                            <div style="font-weight:600; font-size:13px; color:var(--text-primary);">
                                ${name || '(이름 없음)'}
                            </div>
                            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;
                                        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                ${addr || '(주소 없음)'}
                            </div>
                        </div>
                        <div style="font-size:10px; color:#0284c7; flex-shrink:0;
                                    font-family:monospace; padding-top:2px;">
                            ${scoreText}
                        </div>
                    </div>
                </div>
            `;
        }).join('')}
    `;
}

/** 매칭 확정 — portal 빌딩 클릭 시 호출 */
window._scConfirmManualMatch = function(buildingId) {
    const target = _scState._mmTarget;
    if (!target) return;
    const portalBuildings = window.state?.allBuildings || [];
    const building = portalBuildings.find(b => String(b.id) === String(buildingId));
    if (!building) {
        alert('빌딩을 찾을 수 없습니다.');
        return;
    }
    const rm = _scState.researchMaster;

    // 동일 portal 빌딩이 다른 RAW 행에 이미 매칭됐는지 확인
    const conflictIdx = rm.matched.findIndex((m, i) =>
        String(m.building.id) === String(buildingId)
        && !(target.type === 'matched' && i === target.index)
    );
    if (conflictIdx >= 0) {
        const conflictRaw = rm.matched[conflictIdx].raw;
        const ok = confirm(
            `이 portal 빌딩은 이미 다른 RAW 행에 매칭돼 있습니다.\n\n` +
            `기존 매칭: ${conflictRaw['빌딩명']} (${conflictRaw['도로명'] || ''} ${conflictRaw['건물번호'] || ''})\n\n` +
            `[확인] 누르면 기존 매칭이 해제되고 진행합니다.\n` +
            `[취소] 누르면 변경하지 않고 그대로 둡니다.`
        );
        if (!ok) return;
        const removed = rm.matched.splice(conflictIdx, 1)[0];
        rm.unmatched.push({ raw: removed.raw, reason: '수동 매칭 충돌로 자동 해제' });
        // target.index 보정 (matched 배열에서 빠졌으니)
        if (target.type === 'matched' && target.index > conflictIdx) target.index--;
    }

    if (target.type === 'unmatched') {
        const removed = rm.unmatched.splice(target.index, 1)[0];
        rm.matched.push({
            raw:       removed.raw,
            building,
            matchedBy: 'manual',
            score:     1,
        });
    } else {
        const m = rm.matched[target.index];
        if (m) {
            m.building   = building;
            m.matchedBy  = 'manual';
            m.score      = 1;
        }
    }

    _scState._mmTarget = null;
    window._scCloseManualMatch();
    _scRenderRawStatus();
    _scRenderBuildingLists();   // Step 2B: 모집단 변경 반영
};

/** 매칭 해제 — 매칭 → 미매칭으로 되돌림 */
window._scUnmatchEntry = function(matchedIndex) {
    const rm = _scState.researchMaster;
    const m  = rm.matched[matchedIndex];
    if (!m) return;
    const portalName = m.building.name || m.building.buildingName || '-';
    if (!confirm(`매칭을 해제하시겠습니까?\n\nRAW: ${m.raw['빌딩명']}\nportal: ${portalName}`)) return;
    const removed = rm.matched.splice(matchedIndex, 1)[0];
    rm.unmatched.push({ raw: removed.raw, reason: '수동 해제' });
    _scRenderRawStatus();
    _scRenderBuildingLists();   // Step 2B: 모집단 변경 반영
};

/** 수동 매칭 모달 닫기 */
window._scCloseManualMatch = function() {
    const modal = _scQS('sc-mm-modal');
    if (modal) modal.style.display = 'none';
    _scState._mmTarget = null;
};

/** RAW 엑셀 초기화 (재업로드 준비) */
window._scClearRaw = function() {
    if (!confirm('RAW 엑셀을 초기화하시겠습니까? 진행 중인 시점·필터·선택이 모두 사라집니다.')) return;
    _scState.researchMaster = {
        loaded: false, fileName: '', rawRows: [], matched: [], unmatched: [],
        showUnmatch: false, showMatched: false, matchSearch: '', expandMode: false,
    };
    // 시점·선택 상태도 함께 리셋 (모집단 변경 = 모든 후속 단계 무효)
    _scState.pointA.yyyymm = '';
    _scState.pointB.yyyymm = '';
    _scState.pointA.selections.clear();
    _scState.pointB.selections.clear();
    const sa = _scQS('sc-month-A'); if (sa) sa.value = '';
    const sb = _scQS('sc-month-B'); if (sb) sb.value = '';
    _scRenderRawStatus();
    _scLockUnlockPointSection(false);
    _scUpdateProgressBanner();
    const clearBtn = _scQS('sc-raw-clear');
    if (clearBtn) {
        clearBtn.disabled = true;
        clearBtn.style.cursor = 'not-allowed';
        clearBtn.style.opacity = '0.4';
    }
};

/** 시점 선택 섹션 락/언락 (모집단 로드 전엔 잠금) */
function _scLockUnlockPointSection(unlocked) {
    const overlay = _scQS('sc-point-overlay');
    if (overlay) overlay.style.display = unlocked ? 'none' : 'flex';
}

// ═══════════════════════════════════════════════════════════════
// 5B. Step 2B — 시점별 후보 빌딩 산출 + 빌딩 리스트 렌더
// ═══════════════════════════════════════════════════════════════

const SR_SIZE_BANDS_FULL = ['Prime급', '대형', '중대형', '중형', '소형'];

/**
 * vacancy 의 출처(회사명) 추출 — OCR 임대안내문 source 필드
 * 필드 우선순위: source → company → originSource → publisher
 */
function _scVacancySource(vacancy) {
    return String(
        vacancy?.source ||
        vacancy?.company ||
        vacancy?.originSource ||
        vacancy?.publisher ||
        ''
    ).trim() || '미상';
}

/**
 * 빌딩의 특정 월(yyyymm) 발행 vacancy 만 추출.
 * srActiveVacancies 로 deleted/hidden 제외 후 publishDate 정규화 비교.
 */
function _scVacanciesByMonth(building, yyyymm) {
    if (!yyyymm) return [];
    const all = srActiveVacancies(building);
    return all.filter(v => srNormalizeDate(v.publishDate) === yyyymm);
}

/**
 * 빌딩의 특정 월 발행 vacancy 의 회사 목록 (중복 제거, 카운트 포함).
 * @returns {Array<{source, count}>}
 */
function _scSourcesByMonth(building, yyyymm) {
    const vacs = _scVacanciesByMonth(building, yyyymm);
    const map  = new Map();
    vacs.forEach(v => {
        const s = _scVacancySource(v);
        map.set(s, (map.get(s) || 0) + 1);
    });
    return [...map.entries()].map(([source, count]) => ({ source, count }));
}

/**
 * 시점(side)에 대한 후보 빌딩 산출 파이프라인:
 *   1) 모집단 = researchMaster.matched 의 portal 빌딩 (Map<id, raw>)
 *      + (v1.7.7 expandMode) portal 전체에서 양 시점 모두 OCR 있는 빌딩
 *   2) 해당 월에 OCR 임대안내문이 있는 빌딩만
 *      + (v1.7.6) _meta 공실없음 선언만 있는 빌딩도 포함
 *   3) 필터(권역/등급) 적용
 *
 * @returns {Array<{building, sources, raw, hasNoVacDecl, isExpand}>}
 */
function _scGetCandidates(side) {
    side = _scSide(side);
    const st = _scState[`point${side}`];
    if (!st.yyyymm) return [];

    const rm = _scState.researchMaster;
    if (!rm.loaded) return [];

    // 모집단 맵: portal building.id → RAW row
    const popMap = new Map();
    rm.matched.forEach(m => popMap.set(String(m.building.id), m.raw));

    // 정규화된 빌딩 배열 — portal-stats.js 의 srLib 재사용
    const norm = (window.srLib?.srGetNormBuildings?.() || srGetNormBuildings()) || [];

    // v1.7.7: 확장 모드 — portal 전체에서 양 시점 모두 OCR 있는 빌딩 셋 (RAW 매칭 안 된 것만)
    let expandIds = null;
    if (rm.expandMode) {
        const otherYM = _scState[`point${side === 'A' ? 'B' : 'A'}`].yyyymm;
        if (otherYM) {
            // 양 시점 모두 OCR 또는 _meta noVacancy 있는 portal 빌딩
            expandIds = new Set();
            for (const b of norm) {
                if (popMap.has(String(b.id))) continue;  // 이미 RAW 매칭됨
                const hasOnThis  = _scSourcesByMonth(b, st.yyyymm).length > 0
                                  || _scHasNoVacancyDeclaration(b, st.yyyymm);
                const hasOnOther = _scSourcesByMonth(b, otherYM).length > 0
                                  || _scHasNoVacancyDeclaration(b, otherYM);
                if (hasOnThis && hasOnOther) expandIds.add(String(b.id));
            }
        }
    }

    const cands = [];
    for (const b of norm) {
        const isInRaw    = popMap.has(String(b.id));
        const isInExpand = expandIds && expandIds.has(String(b.id));
        if (!isInRaw && !isInExpand) continue;            // 모집단 제약

        const sources = _scSourcesByMonth(b, st.yyyymm);
        const hasNoVacDecl = _scHasNoVacancyDeclaration(b, st.yyyymm);
        if (sources.length === 0 && !hasNoVacDecl) continue;

        // 필터 (v1.7.4: 권역+등급 두 축만)
        const f = st.filters;
        if (f.regions.length && !f.regions.includes(b._region))   continue;
        if (f.grades.length  && !f.grades.includes(b._gradeAuto)) continue;

        cands.push({
            building:    b,
            sources,
            raw:         popMap.get(String(b.id)) || null,
            hasNoVacDecl,
            isExpand:    !isInRaw && isInExpand,           // v1.7.7: 확장 빌딩 표식
        });
    }

    // 정렬: 권역 → 등급 → 빌딩명
    const regionOrder = Object.fromEntries(SR_REGIONS.map((r, i) => [r, i]));
    const gradeOrder  = Object.fromEntries(SR_GRADES.map((g, i)  => [g, i]));
    cands.sort((a, b) => {
        const ra = regionOrder[a.building._region] ?? 99;
        const rb = regionOrder[b.building._region] ?? 99;
        if (ra !== rb) return ra - rb;
        const ga = gradeOrder[a.building._gradeAuto] ?? 99;
        const gb = gradeOrder[b.building._gradeAuto] ?? 99;
        if (ga !== gb) return ga - gb;
        return String(a.building.name || '').localeCompare(String(b.building.name || ''));
    });
    return cands;
}

/** 빌딩 카드 1개 HTML 생성 */
function _scBuildingCardHtml(side, item) {
    side = _scSide(side);
    const b   = item.building;
    const st  = _scState[`point${side}`];
    const sel = st.selections.get(String(b.id));
    const isNoVacancy   = !!(sel && sel.noVacancy);
    const isSelected    = !!sel && (isNoVacancy || (sel.selectedVacKeys && sel.selectedVacKeys.size > 0));
    const chosenSource  = sel?.chosenSource || '';
    const isNoVacCand   = !!item.hasNoVacDecl && !isNoVacancy;   // v1.7.6: 후보(자동 마크 X)
    const isExpand      = !!item.isExpand;                       // v1.7.7: 확장 빌딩

    const region    = b._region    || '-';
    const grade     = b._gradeAuto || '-';
    const grossPy   = _scGrossPy(b);

    const regionColor = SR_REGION_COLOR[region] || '#94a3b8';
    const gradeColor  = SR_GRADE_COLOR[grade]   || '#94a3b8';

    // 회사 칩 (chosenSource 와 일치하면 선택 상태 강조)
    const sourceChips = item.sources.map(s => {
        const isChosen = (s.source === chosenSource);
        return `<span style="
            display:inline-block; padding:1px 7px; border-radius:9px;
            font-size:10px; margin:1px 2px 1px 0; white-space:nowrap;
            background:${isChosen ? '#1e40af' : '#e0e7ff'};
            color:${isChosen ? '#fff' : '#3730a3'};
            border:1px solid ${isChosen ? '#1e40af' : '#c7d2fe'};
            ${isChosen ? 'font-weight:700;' : ''}
        ">${s.source} ${s.count}</span>`;
    }).join('');

    const cardBg     = isSelected ? '#eff6ff' : '#fff';
    const cardBorder = isSelected ? '#1e40af' : 'var(--border-color)';

    return `
        <div onclick="window._scOnBuildingClick('${side}', '${String(b.id).replace(/'/g, "\\'")}')"
            style="padding:8px 10px; border:1px solid ${cardBorder}; border-radius:7px;
                   margin-bottom:5px; cursor:pointer; background:${cardBg};
                   transition:background 0.12s;"
            onmouseover="this.style.background='${isSelected ? '#dbeafe' : '#f8fafc'}';"
            onmouseout="this.style.background='${cardBg}';">
            <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-bottom:3px;">
                <span style="font-weight:700; font-size:12px; color:var(--text-primary);">
                    ${isNoVacancy ? '✅ ' : (isSelected ? '✅ ' : '')}${b.name || b.buildingName || '-'}
                </span>
                <span style="padding:1px 5px; background:${regionColor}; color:#fff;
                             border-radius:8px; font-size:9px; font-weight:600;">
                    ${region}
                </span>
                <span style="padding:1px 5px; background:${gradeColor}; color:#fff;
                             border-radius:8px; font-size:9px; font-weight:600;">
                    ${grade}
                </span>
                <span style="font-size:10px; color:var(--text-muted);">
                    ${grossPy ? Math.round(grossPy).toLocaleString() + '평' : '?'}
                </span>
                ${isNoVacancy ? `
                    <span style="padding:1px 6px; background:#7c3aed; color:#fff;
                                 border-radius:8px; font-size:9px; font-weight:700;">
                        0공실
                    </span>
                ` : isNoVacCand ? `
                    <span style="padding:1px 6px; background:#f3e8ff; color:#6b21a8;
                                 border:1px solid #d8b4fe;
                                 border-radius:8px; font-size:9px; font-weight:600;"
                          title="이 빌딩은 ${st.yyyymm} 에 '공실 없음' 으로 선언되어 있습니다. 우측 패널에서 [✅ 공실 없음 확정] 클릭으로 통계에 포함하세요.">
                        🔒 0공실 후보
                    </span>
                ` : ''}
                ${isExpand ? `
                    <span style="padding:1px 6px; background:#fce7f3; color:#9d174d;
                                 border:1px solid #fbcfe8;
                                 border-radius:8px; font-size:9px; font-weight:600;"
                          title="RAW 엑셀에 없지만 양 시점 모두 OCR 데이터가 있어 확장 모드로 자동 포함된 빌딩입니다.">
                        📊 portal
                    </span>
                ` : ''}
            </div>
            <div style="line-height:1.4;">${sourceChips}</div>
        </div>
    `;
}

/** 시점별 빌딩 리스트 렌더 (좌측 sc-pane-list 영역에 듀얼 컬럼) */
/**
 * v1.7.9: 좌측 빌딩 리스트를 페어 레이아웃으로 재구성.
 *   - 같은 buildingId 의 A 후보 + B 후보를 한 행에 좌우 배치
 *   - 행 좌측에 exclude 체크박스 (기본 ON, 끄면 계산 제외)
 *   - A 또는 B 한쪽만 있는 빌딩도 명확히 표시 (반대쪽은 회색 placeholder)
 */
function _scRenderBuildingLists() {
    const listEl = _scQS('sc-building-list');
    if (!listEl) return;

    const aMonth = _scState.pointA.yyyymm;
    const bMonth = _scState.pointB.yyyymm;

    if (!aMonth && !bMonth) {
        listEl.innerHTML = `
            <div style="font-size:12px; color:var(--text-muted); padding:30px 0; text-align:center;">
                시점을 먼저 선택해주세요.
            </div>
        `;
        _scUpdateCount('A', null);
        _scUpdateCount('B', null);
        return;
    }

    const candA = aMonth ? _scGetCandidates('A') : [];
    const candB = bMonth ? _scGetCandidates('B') : [];
    _scUpdateCount('A', aMonth ? candA.length : null);
    _scUpdateCount('B', bMonth ? candB.length : null);

    if (candA.length === 0 && candB.length === 0) {
        listEl.innerHTML = `
            <div style="font-size:12px; color:var(--text-muted); padding:30px 0; text-align:center;">
                조건에 맞는 빌딩이 없습니다.<br>
                <span style="font-size:10px; opacity:0.7;">필터를 조정하거나 다른 월을 선택하세요.</span>
            </div>
        `;
        return;
    }

    // 빌딩 ID 별로 A·B 후보 매핑
    const aById = new Map(candA.map(c => [String(c.building.id), c]));
    const bById = new Map(candB.map(c => [String(c.building.id), c]));

    // 모든 빌딩 ID (A ∪ B), 정렬 키는 (양쪽=0/한쪽=1, 권역, 등급, 이름) — 양쪽 있는 빌딩 먼저
    const allIds = [...new Set([...aById.keys(), ...bById.keys()])];
    const regionOrder = Object.fromEntries(SR_REGIONS.map((r, i) => [r, i]));
    const gradeOrder  = Object.fromEntries(SR_GRADES.map((g, i)  => [g, i]));
    allIds.sort((id1, id2) => {
        const c1 = aById.get(id1) || bById.get(id1);
        const c2 = aById.get(id2) || bById.get(id2);
        const both1 = (aById.has(id1) && bById.has(id1)) ? 0 : 1;
        const both2 = (aById.has(id2) && bById.has(id2)) ? 0 : 1;
        if (both1 !== both2) return both1 - both2;       // 양쪽 있는 게 먼저
        const r1 = regionOrder[c1.building._region] ?? 99;
        const r2 = regionOrder[c2.building._region] ?? 99;
        if (r1 !== r2) return r1 - r2;
        const g1 = gradeOrder[c1.building._gradeAuto] ?? 99;
        const g2 = gradeOrder[c2.building._gradeAuto] ?? 99;
        if (g1 !== g2) return g1 - g2;
        return String(c1.building.name || '').localeCompare(String(c2.building.name || ''));
    });

    // 통계: 양쪽 있는 빌딩 / 한쪽만 있는 빌딩 / exclude 된 빌딩
    let bothCount = 0, onlyACount = 0, onlyBCount = 0;
    allIds.forEach(id => {
        if (aById.has(id) && bById.has(id)) bothCount++;
        else if (aById.has(id)) onlyACount++;
        else onlyBCount++;
    });
    const excludedCount = [..._scState.excludedBuildingIds].filter(id => allIds.includes(id)).length;

    // 페어 행 렌더
    const renderPairRow = (bid) => {
        const aItem  = aById.get(bid);
        const bItem  = bById.get(bid);
        const refItem = aItem || bItem;
        const b      = refItem.building;
        const isBoth = !!aItem && !!bItem;
        const isExcluded = _scState.excludedBuildingIds.has(String(bid));

        const region    = b._region    || '-';
        const grade     = b._gradeAuto || '-';
        const grossPy   = _scGrossPy(b);
        const regionColor = SR_REGION_COLOR[region] || '#94a3b8';
        const gradeColor  = SR_GRADE_COLOR[grade]   || '#94a3b8';

        const bidEsc = String(bid).replace(/'/g, "\\'");

        // A·B 카드 영역 — 한쪽만 있으면 placeholder
        const renderSideCard = (side, item, accent, monthLabel) => {
            if (!item) {
                return `
                    <div style="border:1px dashed var(--border-color); border-radius:6px;
                                padding:8px 10px; background:#f8fafc;
                                font-size:11px; color:#9ca3af; text-align:center;
                                min-height:54px; display:flex; align-items:center; justify-content:center;">
                        ${monthLabel} 데이터 없음
                    </div>
                `;
            }
            return _scBuildingCardHtml(side, item);
        };

        return `
            <div style="display:grid; grid-template-columns:30px 1fr 1fr; gap:8px;
                        margin-bottom:6px; padding:6px 8px;
                        background:${isExcluded ? '#fef2f2' : (isBoth ? 'transparent' : '#fffbeb')};
                        border:1px solid ${isExcluded ? '#fca5a5' : (isBoth ? 'var(--border-color)' : '#fde68a')};
                        border-radius:7px;
                        opacity:${isExcluded ? '0.55' : '1'};">
                <!-- 좌측 체크박스 (exclude 토글) -->
                <div style="display:flex; align-items:center; justify-content:center;">
                    <input type="checkbox" ${isExcluded ? '' : 'checked'}
                        onclick="event.stopPropagation(); window._scToggleExclude('${bidEsc}')"
                        title="${isExcluded ? '계산에 포함하기' : '계산에서 제외하기'}"
                        style="width:18px; height:18px; cursor:pointer;">
                </div>
                <!-- A 카드 -->
                <div>${renderSideCard('A', aItem, '#0284c7', '시점 A')}</div>
                <!-- B 카드 -->
                <div>${renderSideCard('B', bItem, '#ea580c', '시점 B')}</div>
            </div>
        `;
    };

    // 헤더 (sticky)
    const headerHtml = `
        <div style="position:sticky; top:0; background:var(--bg-card); z-index:2;
                    padding:6px 8px; border-bottom:1px solid var(--border-color);
                    margin-bottom:6px;">
            <div style="display:grid; grid-template-columns:30px 1fr 1fr; gap:8px;
                        font-size:11px; font-weight:700;">
                <div style="text-align:center; color:var(--text-muted);" title="체크 = 계산 포함 / 해제 = 제외">✓</div>
                <div style="color:#0284c7;">시점 A · ${aMonth || '-'} · ${candA.length}개</div>
                <div style="color:#ea580c;">시점 B · ${bMonth || '-'} · ${candB.length}개</div>
            </div>
            <div style="margin-top:4px; font-size:10px; color:var(--text-muted);">
                전체 ${allIds.length}개 · 양시점 ${bothCount} · 시점A만 ${onlyACount} · 시점B만 ${onlyBCount}
                ${excludedCount > 0 ? ` · <span style="color:#dc2626; font-weight:700;">제외 ${excludedCount}</span>` : ''}
            </div>
        </div>
    `;

    listEl.innerHTML = `
        <div style="overflow-y:auto; max-height:560px;">
            ${headerHtml}
            ${allIds.map(renderPairRow).join('')}
        </div>
    `;
}

/** v1.7.9: 빌딩 단위 exclude 토글 */
window._scToggleExclude = function(buildingId) {
    const bid = String(buildingId);
    if (_scState.excludedBuildingIds.has(bid)) {
        _scState.excludedBuildingIds.delete(bid);
    } else {
        _scState.excludedBuildingIds.add(bid);
    }
    _scMarkDirty();
    _scRenderBuildingLists();
    _scRenderResultPlaceholder();
};

/** 빌딩 카드 클릭 → 우측 상세 패널 (Step 3 실구현) */
window._scOnBuildingClick = function(side, buildingId) {
    side = _scSide(side);
    _scState.selectedBuildingId = String(buildingId);
    _scState._lastClickedSide   = side;       // 마지막 클릭한 시점 (UI 상단 강조용)
    _scRenderBuildingDetail();
};

// ═══════════════════════════════════════════════════════════════
// 5D. Step 3 — 우측 상세 패널 (회사·공실 선택)
// ═══════════════════════════════════════════════════════════════

/** 빌딩의 정규화 객체 가져오기 */
function _scFindNormBuilding(buildingId) {
    if (!buildingId) return null;
    const norm = (window.srLib?.srGetNormBuildings?.() || srGetNormBuildings()) || [];
    return norm.find(b => String(b.id) === String(buildingId)) || null;
}

/** vacancy 의 고유키 — selectedVacKeys 에 저장할 식별자 */
function _scVacancyKey(v) {
    return String(v.id || v._id || v.vacancyId || v.key
                  || `${_scVacancySource(v)}__${v.publishDate || ''}__${v.floorText || v.floor || ''}__${v.exclusiveArea || v.rentArea || 0}`);
}

/** vacancy 의 면적(평) 추출 */
function _scVacAreaPy(v) {
    return Number(v.exclusiveArea ?? v.rentArea ?? 0) || 0;
}

/** v1.7.10: 전용면적 별도 추출 (UI 표시용) */
function _scVacExclusivePy(v) {
    return Number(v.exclusiveArea ?? 0) || 0;
}

/** vacancy 1행에서 (rentPy, depositPy, maintenancePy) 추출 — 없으면 null */
function _scVacPrices(v) {
    return {
        rentPy:        srParsePrice(v.rentPy)        ?? null,
        depositPy:     srParsePrice(v.depositPy)     ?? null,
        maintenancePy: srParsePrice(v.maintenancePy) ?? null,
    };
}

// ── v1.7.2: 입주시기 판정 ────────────────────────────────────────
// editor.js 의 _seIsImmediateMoveIn 과 동일 키워드 (브리프 §4 원칙)

/** 즉시입주 키워드 — 단독 또는 결합형 */
const SC_IMMEDIATE_KEYWORDS = ['즉시', '즉시입주', '즉시가능', '바로입주', '바로가능'];

/**
 * 입주시기를 3분류로 판정:
 *   - 'immediate' 🟢 즉시입주 (자동 공실 포함 권장)
 *   - 'future'    🟡 미래 날짜 또는 텍스트 (사용자 판단)
 *   - 'empty'     ⚪ 미기재
 * @returns {{kind: 'immediate'|'future'|'empty', label: string, color: string, raw: string}}
 */
function _scClassifyMoveIn(vacancy) {
    const raw = String(vacancy?.moveInDate || '').trim();
    if (!raw) {
        return { kind: 'empty', label: '미기재', color: '#9ca3af', raw: '' };
    }
    const norm = raw.replace(/[\s\-()[\]【】·.,/]/g, '').toLowerCase();
    if (SC_IMMEDIATE_KEYWORDS.some(k => norm === k || norm.includes(k))) {
        return { kind: 'immediate', label: '즉시', color: '#16a34a', raw };
    }
    return { kind: 'future', label: raw, color: '#ea580c', raw };
}

// ── v1.7.6: 통계 편집 _meta noVacancy 선언 감지 ────────────────
// editor.js (Phase 6 Step 3.5) 가 만든 자료구조:
//   vacancy._key.endsWith('_meta') 이고 vacancy.noVacancy === true 면
//   해당 월에 "공실 없음" 선언이 있는 것
// 사용자는 이걸 자동 마크하지 않고, 후보 리스트에만 노출 (옵션 B 합의)

/**
 * 빌딩이 해당 월에 _meta 공실없음 선언을 가지는지
 * @returns {boolean}
 */
function _scHasNoVacancyDeclaration(building, yyyymm) {
    if (!yyyymm) return false;
    const vacs = (building?.vacancies) || [];
    for (const v of vacs) {
        if (!v || !v._key) continue;
        if (!String(v._key).endsWith('_meta')) continue;
        if (v.noVacancy !== true) continue;
        if (srNormalizeDate(v.publishDate) === yyyymm) return true;
    }
    return false;
}

/** floorPricing 폴백 — yyyymm 시점 또는 그 이전의 가장 최신값 */
function _scFloorFallback(building, yyyymm) {
    const fps = (building.floorPricing || []).slice();
    if (fps.length === 0) return { rentPy: null, depositPy: null, maintenancePy: null };
    fps.sort((a, b) => String(b.effectiveDate || '').localeCompare(String(a.effectiveDate || '')));
    const target = fps.find(fp => {
        const d = String(fp.effectiveDate || '').slice(0, 7);
        return d && d <= yyyymm;
    }) || fps[0];
    return {
        rentPy:        srParsePrice(target.rentPy)        ?? null,
        depositPy:     srParsePrice(target.depositPy)     ?? null,
        maintenancePy: srParsePrice(target.maintenancePy) ?? null,
    };
}

/** 우측 상세 패널 렌더 */
function _scRenderBuildingDetail() {
    const detailEl = _scQS('sc-building-detail');
    if (!detailEl) return;

    const bid = _scState.selectedBuildingId;
    if (!bid) {
        detailEl.innerHTML = `
            <div style="font-size:12px; color:var(--text-muted); padding:30px 0; text-align:center;">
                좌측에서 빌딩을 선택해주세요.
            </div>
        `;
        return;
    }
    const b = _scFindNormBuilding(bid);
    if (!b) {
        detailEl.innerHTML = `
            <div style="font-size:12px; color:#dc2626; padding:30px 0; text-align:center;">
                빌딩을 찾을 수 없습니다 (id=${bid}).
            </div>
        `;
        return;
    }

    const aMonth = _scState.pointA.yyyymm;
    const bMonth = _scState.pointB.yyyymm;

    detailEl.innerHTML = `
        <div style="margin-bottom:8px; padding:8px 10px; background:var(--bg-secondary);
                    border-radius:7px; border-left:3px solid #1a73e8;
                    display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
            <div style="flex:1; min-width:0;">
                <div style="font-size:13px; font-weight:700; color:var(--text-primary);">
                    ${b.name || b.buildingName || '-'}
                </div>
                <div style="font-size:10px; color:var(--text-muted); margin-top:3px;">
                    ${b._region || '-'} · ${b._gradeAuto || '-'} ·
                    ${_scGrossPy(b) ? Math.round(_scGrossPy(b)).toLocaleString() + '평' : '?'}
                </div>
            </div>
            <button onclick="event.stopPropagation(); window._scRefreshBuildingDetail()"
                title="portal 의 최신 임대안내문 데이터를 다시 읽어 우측 패널을 갱신합니다"
                style="padding:4px 10px; background:#fff; border:1px solid var(--border-color);
                       border-radius:5px; font-size:10px; color:var(--text-primary);
                       cursor:pointer; white-space:nowrap; flex-shrink:0;">
                🔄 새로고침
            </button>
        </div>

        <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            ${_scRenderSidePanel('A', b, aMonth)}
            ${_scRenderSidePanel('B', b, bMonth)}
        </div>
    `;
}

/** v1.7.9: 빌딩 상세 새로고침 — 좌측 리스트와 우측 패널 모두 다시 렌더 */
window._scRefreshBuildingDetail = function() {
    // portal-data.js 의 onValue 리스너가 실시간 업데이트하므로
    // window.state.allBuildings 가 항상 최신. 단순히 다시 렌더만 해도 새 데이터 반영됨.
    _scRenderBuildingLists();
    _scRenderBuildingDetail();
    _scRenderResultPlaceholder();
    console.log('[stats-compare] 빌딩 상세 새로고침 완료');
};

/** 한 시점 패널 (A 또는 B) HTML 생성 */
function _scRenderSidePanel(side, building, yyyymm) {
    side = _scSide(side);
    const accent  = (side === 'A') ? '#0284c7' : '#ea580c';
    const accentBg= (side === 'A') ? '#e0f2fe' : '#ffedd5';

    if (!yyyymm) {
        return `
            <div style="border:1px solid var(--border-color); border-radius:7px; padding:10px;">
                <div style="font-size:11px; font-weight:700; color:${accent}; margin-bottom:6px;">
                    시점 ${side} (월 미선택)
                </div>
                <div style="font-size:11px; color:var(--text-muted); padding:14px 0; text-align:center;">
                    상단에서 월을 선택하세요.
                </div>
            </div>
        `;
    }

    const vacs = _scVacanciesByMonth(building, yyyymm);
    const hasNoVacDecl = _scHasNoVacancyDeclaration(building, yyyymm);

    // v1.7.6: vacancy 가 없어도 _meta 공실없음 선언이 있으면 0공실 확정 버튼만 띄움
    if (vacs.length === 0 && hasNoVacDecl) {
        const sel = _scState[`point${side}`].selections.get(String(building.id));
        const isNoVacancy = !!(sel && sel.noVacancy);
        const bidEsc = String(building.id).replace(/'/g, "\\'");
        return `
            <div style="border:1px solid var(--border-color); border-radius:7px; padding:10px;
                        background:${isNoVacancy ? '#faf5ff' : 'transparent'};">
                <div style="display:flex; justify-content:space-between; align-items:center;
                            margin-bottom:8px;">
                    <span style="font-size:11px; font-weight:700; color:${accent};">
                        시점 ${side} · ${yyyymm}
                    </span>
                    <span style="font-size:10px;">
                        ${isNoVacancy
                            ? '<strong style="color:#7c3aed;">✅ 0공실 확정</strong>'
                            : '<span style="color:#9ca3af;">미선택</span>'}
                    </span>
                </div>
                <div style="padding:8px 10px; background:#f3e8ff;
                            border:1px solid #d8b4fe; border-radius:5px;
                            font-size:11px; color:#6b21a8; line-height:1.5; margin-bottom:8px;">
                    🔒 통계 편집에서 이 빌딩은 <strong>${yyyymm} 공실 없음</strong> 으로 선언되어 있습니다.<br>
                    공실 vacancy 행은 없지만, "공실률 0%" 빌딩으로 통계에 포함할 수 있습니다.
                </div>
                <button onclick="event.stopPropagation(); window._scToggleNoVacancy('${side}', '${bidEsc}')"
                    style="width:100%; padding:8px; cursor:pointer;
                           background:${isNoVacancy ? '#7c3aed' : '#f3e8ff'};
                           color:${isNoVacancy ? '#fff' : '#6b21a8'};
                           border:1px solid ${isNoVacancy ? '#7c3aed' : '#d8b4fe'};
                           border-radius:5px; font-size:12px; font-weight:700;">
                    ${isNoVacancy ? '✅ 0공실 확정 (해제하려면 다시 클릭)' : '✅ 0공실 확정으로 통계 포함'}
                </button>
            </div>
        `;
    }

    if (vacs.length === 0) {
        return `
            <div style="border:1px solid var(--border-color); border-radius:7px; padding:10px;">
                <div style="font-size:11px; font-weight:700; color:${accent}; margin-bottom:6px;">
                    시점 ${side} · ${yyyymm}
                </div>
                <div style="font-size:11px; color:#dc2626; padding:14px 0; text-align:center;">
                    이 월의 OCR 임대안내문 없음
                </div>
            </div>
        `;
    }

    // 회사별 그룹핑
    const bySource = {};
    vacs.forEach(v => {
        const s = _scVacancySource(v);
        (bySource[s] = bySource[s] || []).push(v);
    });
    const sources = Object.keys(bySource).sort();

    const st  = _scState[`point${side}`];
    const sel = st.selections.get(String(building.id));
    const chosenSource    = sel?.chosenSource || sources[0];     // 기본값: 첫 번째 회사
    const selectedVacKeys = sel?.selectedVacKeys || new Set();
    const isNoVacancy     = !!(sel && sel.noVacancy);            // v1.7.5: 0공실 확정 플래그

    const tabs = sources.map(s => {
        const isOn  = (s === chosenSource);
        const count = bySource[s].length;
        return `
            <span onclick="window._scChooseSource('${side}', '${String(building.id).replace(/'/g, "\\'")}', '${s.replace(/'/g, "\\'")}')"
                style="padding:3px 8px; font-size:10px; cursor:pointer;
                       border:1px solid ${isOn ? accent : 'var(--border-color)'};
                       background:${isOn ? accent : 'var(--bg-card)'};
                       color:${isOn ? '#fff' : 'var(--text-primary)'};
                       border-radius:10px; font-weight:${isOn ? 700 : 500};
                       white-space:nowrap;">
                ${s} ${count}
            </span>
        `;
    }).join('');

    const chosenVacs = bySource[chosenSource] || [];
    const totalSelArea = [...selectedVacKeys]
        .map(k => chosenVacs.find(v => _scVacancyKey(v) === k))
        .filter(Boolean)
        .reduce((sum, v) => sum + _scVacAreaPy(v), 0);

    const allKeys     = chosenVacs.map(v => _scVacancyKey(v));
    const allSelected = allKeys.length > 0 && allKeys.every(k => selectedVacKeys.has(k));

    // v1.7.2: 입주시기 분포
    const miCounts = { immediate: 0, future: 0, empty: 0 };
    chosenVacs.forEach(v => { miCounts[_scClassifyMoveIn(v).kind]++; });
    const hasImmediate = miCounts.immediate > 0;

    // v1.7.5: 상단 상태 라벨 — 3가지 상태 (공실 N개 선택 / 0공실 확정 / 미선택)
    let statusLabel;
    if (isNoVacancy) {
        statusLabel = `<strong style="color:#7c3aed;">✅ 0공실 확정</strong>`;
    } else if (selectedVacKeys.size > 0) {
        statusLabel = `<strong style="color:${accent};">선택 ${selectedVacKeys.size}개 · ${totalSelArea.toFixed(1)}평</strong>`;
    } else {
        statusLabel = '미선택';
    }

    const bidEsc = String(building.id).replace(/'/g, "\\'");

    const rows = chosenVacs.map(v => {
        const key   = _scVacancyKey(v);
        const isOn  = selectedVacKeys.has(key);
        const area  = _scVacAreaPy(v);          // v1.7.10: 임대면적
        const excl  = _scVacExclusivePy(v);     // v1.7.10: 전용면적
        const floor = v.floorText || v.floor || '-';
        const px    = _scVacPrices(v);
        const mi    = _scClassifyMoveIn(v);
        const fmtP  = n => (n != null) ? Math.round(n / 1000).toLocaleString() : '-';
        // 입주시기 라벨 (긴 텍스트는 자르고 title로 풀 표시)
        const miShort = mi.kind === 'immediate' ? '즉시'
                       : mi.kind === 'empty'    ? '-'
                       : (mi.raw.length > 10 ? mi.raw.slice(0, 10) + '…' : mi.raw);
        return `
            <tr style="border-top:1px solid var(--border-color);
                       background:${isOn ? '#eff6ff' : 'transparent'};
                       cursor:pointer;"
                onclick="window._scToggleVacancy('${side}', '${String(building.id).replace(/'/g, "\\'")}', '${key.replace(/'/g, "\\'")}')">
                <td style="padding:3px 4px; text-align:center;">
                    <input type="checkbox" ${isOn ? 'checked' : ''}
                        onclick="event.stopPropagation(); window._scToggleVacancy('${side}', '${String(building.id).replace(/'/g, "\\'")}', '${key.replace(/'/g, "\\'")}')"
                        style="cursor:pointer;">
                </td>
                <td style="padding:3px 4px; font-weight:600;">${floor}</td>
                <td style="padding:3px 4px; text-align:right; font-weight:600;"
                    title="임대면적 (계산에 사용)">${area ? area.toFixed(1) : '-'}</td>
                <td style="padding:3px 4px; text-align:right; color:#9ca3af; font-size:9px;"
                    title="전용면적 (참고용)">${excl ? excl.toFixed(1) : '-'}</td>
                <td style="padding:3px 4px; text-align:center; color:${mi.color};
                           font-weight:${mi.kind === 'immediate' ? 700 : 500};
                           white-space:nowrap;"
                    title="${mi.raw || '미기재'}">
                    ${mi.kind === 'immediate' ? '🟢 ' : (mi.kind === 'future' ? '🟡 ' : '')}${miShort}
                </td>
                <td style="padding:3px 4px; text-align:right; color:#1a73e8;">${fmtP(px.rentPy)}</td>
                <td style="padding:3px 4px; text-align:right; color:#9333ea;">${fmtP(px.depositPy)}</td>
                <td style="padding:3px 4px; text-align:right; color:#16a34a;">${fmtP(px.maintenancePy)}</td>
            </tr>
        `;
    }).join('');

    return `
        <div style="border:1px solid var(--border-color); border-radius:7px; padding:8px 10px;
                    background:${sel ? accentBg + '40' : 'transparent'};">
            <div style="display:flex; justify-content:space-between; align-items:center;
                        margin-bottom:5px;">
                <span style="font-size:11px; font-weight:700; color:${accent};">
                    시점 ${side} · ${yyyymm}
                </span>
                <span style="font-size:10px; color:var(--text-muted);">
                    ${statusLabel}
                </span>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:3px; margin-bottom:5px;">
                ${tabs}
            </div>
            <!-- v1.7.2: 입주시기 분포 + 즉시만 / v1.7.5: 공실 없음 버튼 -->
            <div style="display:flex; justify-content:space-between; align-items:center;
                        margin-bottom:6px; gap:6px; flex-wrap:wrap;">
                <span style="font-size:10px; color:var(--text-muted); white-space:nowrap;">
                    입주시기:
                    ${miCounts.immediate > 0 ? `<span style="color:#16a34a; font-weight:700;">🟢 즉시 ${miCounts.immediate}</span>` : ''}
                    ${miCounts.future > 0    ? ` <span style="color:#ea580c;">🟡 예정 ${miCounts.future}</span>` : ''}
                    ${miCounts.empty > 0     ? ` <span style="color:#9ca3af;">⚪ 미기재 ${miCounts.empty}</span>` : ''}
                </span>
                <div style="display:flex; gap:4px; flex-wrap:wrap;">
                    ${hasImmediate && !isNoVacancy ? `
                        <button onclick="event.stopPropagation(); window._scSelectImmediate('${side}', '${bidEsc}')"
                            style="padding:2px 8px; background:#dcfce7; color:#15803d;
                                   border:1px solid #86efac; border-radius:4px; cursor:pointer;
                                   font-size:10px; font-weight:600; white-space:nowrap;">
                            ⚡ 즉시만 선택
                        </button>
                    ` : ''}
                    <button onclick="event.stopPropagation(); window._scToggleNoVacancy('${side}', '${bidEsc}')"
                        style="padding:2px 8px;
                               background:${isNoVacancy ? '#7c3aed' : '#f3e8ff'};
                               color:${isNoVacancy ? '#fff' : '#6b21a8'};
                               border:1px solid ${isNoVacancy ? '#7c3aed' : '#d8b4fe'};
                               border-radius:4px; cursor:pointer;
                               font-size:10px; font-weight:700; white-space:nowrap;">
                        ${isNoVacancy ? '✅ 0공실 확정 (해제)' : '✅ 공실 없음 확정'}
                    </button>
                </div>
            </div>
            <div style="max-height:180px; overflow-y:auto;
                        border:1px solid var(--border-color); border-radius:5px; background:#fff;
                        ${isNoVacancy ? 'opacity:0.45; pointer-events:none;' : ''}">
                <table style="width:100%; font-size:10px; border-collapse:collapse;">
                    <thead style="position:sticky; top:0; background:var(--bg-secondary); z-index:1;">
                        <tr style="color:#6b7280;">
                            <th style="padding:3px 4px; width:24px;">
                                <input type="checkbox" ${allSelected ? 'checked' : ''}
                                    ${isNoVacancy ? 'disabled' : ''}
                                    onclick="event.stopPropagation(); window._scToggleAllVacancies('${side}', '${bidEsc}', this.checked)">
                            </th>
                            <th style="padding:3px 4px; text-align:left;">층</th>
                            <th style="padding:3px 4px; text-align:right;" title="임대면적 (계산 기준)">임대평</th>
                            <th style="padding:3px 4px; text-align:right; color:#9ca3af;" title="전용면적 (참고)">전용평</th>
                            <th style="padding:3px 4px; text-align:center;" title="🟢 즉시 / 🟡 예정 / - 미기재">입주시기</th>
                            <th style="padding:3px 4px; text-align:right;" title="천원/평">임대료</th>
                            <th style="padding:3px 4px; text-align:right;" title="천원/평">보증금</th>
                            <th style="padding:3px 4px; text-align:right;" title="천원/평">관리비</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            ${isNoVacancy ? `
                <div style="margin-top:5px; padding:5px 8px; background:#faf5ff;
                            border-left:3px solid #7c3aed; border-radius:3px;
                            font-size:10px; color:#6b21a8;">
                    💡 이 빌딩은 공실 0으로 처리되며 분모(연면적)에는 포함됩니다.
                    가격 데이터는 floorPricing 폴백을 사용합니다.
                </div>
            ` : ''}
        </div>
    `;
}

/** 회사 탭 클릭 — chosenSource 변경 (선택은 유지하되, 다른 회사 선택은 비움) */
window._scChooseSource = function(side, buildingId, source) {
    side = _scSide(side);
    const st = _scState[`point${side}`];
    const cur = st.selections.get(String(buildingId));
    if (cur && cur.chosenSource === source) return;  // 동일 회사면 no-op

    // 회사가 바뀌면 vacancy 선택 초기화 (다른 회사의 vacancy 키와 섞이지 않도록)
    // v1.7.5: noVacancy 플래그는 회사와 무관하므로 보존
    st.selections.set(String(buildingId), {
        chosenSource:    source,
        selectedVacKeys: new Set(),
        noVacancy:       !!cur?.noVacancy,
    });
    _scMarkDirty();
    _scRenderBuildingDetail();
    _scRenderBuildingLists();          // 좌측 카드의 chosenSource 강조 갱신
    _scRenderResultPlaceholder();      // 결과/계산 버튼 상태 갱신
};

/** vacancy 행 토글 */
window._scToggleVacancy = function(side, buildingId, vacKey) {
    side = _scSide(side);
    const st = _scState[`point${side}`];
    const cur = st.selections.get(String(buildingId));
    if (!cur) return;
    if (cur.noVacancy) return;        // v1.7.5: 0공실 확정 상태에선 vacancy 토글 무시 (UI도 비활성)

    if (cur.selectedVacKeys.has(vacKey)) {
        cur.selectedVacKeys.delete(vacKey);
        // v1.7.5: vacancy 모두 해제되면 selections 자체 제거
        // 단 noVacancy 플래그가 있으면 보존 (이미 위에서 return 했으므로 여기 도달 X)
        if (cur.selectedVacKeys.size === 0 && !cur.noVacancy) {
            st.selections.delete(String(buildingId));
        }
    } else {
        cur.selectedVacKeys.add(vacKey);
    }
    _scMarkDirty();
    _scRenderBuildingDetail();
    _scRenderBuildingLists();
    _scRenderResultPlaceholder();
};

/** 현재 회사의 모든 vacancy 일괄 토글 */
window._scToggleAllVacancies = function(side, buildingId, checkAll) {
    side = _scSide(side);
    const st = _scState[`point${side}`];
    const b  = _scFindNormBuilding(buildingId);
    if (!b || !st.yyyymm) return;
    const cur = st.selections.get(String(buildingId));
    const chosenSource = cur?.chosenSource;
    if (!chosenSource) return;
    if (cur?.noVacancy) return;       // v1.7.5: 0공실 확정 시 무시

    const vacs = _scVacanciesByMonth(b, st.yyyymm).filter(v => _scVacancySource(v) === chosenSource);
    if (checkAll) {
        const keys = new Set(vacs.map(_scVacancyKey));
        st.selections.set(String(buildingId), { chosenSource, selectedVacKeys: keys, noVacancy: false });
    } else {
        st.selections.delete(String(buildingId));
    }
    _scMarkDirty();
    _scRenderBuildingDetail();
    _scRenderBuildingLists();
    _scRenderResultPlaceholder();
};

/** v1.7.2: 즉시입주만 선택 — 현재 회사의 vacancy 중 moveInDate=즉시 만 체크 */
window._scSelectImmediate = function(side, buildingId) {
    side = _scSide(side);
    const st = _scState[`point${side}`];
    const b  = _scFindNormBuilding(buildingId);
    if (!b || !st.yyyymm) return;
    const cur = st.selections.get(String(buildingId));
    const chosenSource = cur?.chosenSource;
    if (!chosenSource) return;
    if (cur?.noVacancy) return;       // v1.7.5: 0공실 확정 시 무시

    const vacs = _scVacanciesByMonth(b, st.yyyymm).filter(v => _scVacancySource(v) === chosenSource);
    const immediateVacs = vacs.filter(v => _scClassifyMoveIn(v).kind === 'immediate');
    if (immediateVacs.length === 0) return;

    const keys = new Set(immediateVacs.map(_scVacancyKey));
    st.selections.set(String(buildingId), { chosenSource, selectedVacKeys: keys, noVacancy: false });
    _scMarkDirty();
    _scRenderBuildingDetail();
    _scRenderBuildingLists();
    _scRenderResultPlaceholder();
};

/** v1.7.5: 0공실 확정 토글 — 분모는 포함, 분자=0 */
window._scToggleNoVacancy = function(side, buildingId) {
    side = _scSide(side);
    const st  = _scState[`point${side}`];
    const cur = st.selections.get(String(buildingId));
    const b   = _scFindNormBuilding(buildingId);
    if (!b || !st.yyyymm) return;

    // 토글 OFF → selections 제거 (selectedVacKeys 도 비어있으니)
    if (cur?.noVacancy) {
        if (cur.selectedVacKeys && cur.selectedVacKeys.size > 0) {
            // vacancy 도 선택돼있으면 noVacancy만 푸는 게 아니라 충돌 → vacancy 우선
            cur.noVacancy = false;
        } else {
            st.selections.delete(String(buildingId));
        }
    }
    // 토글 ON → vacancy 선택 비우고 noVacancy 플래그
    else {
        // chosenSource 결정: 기존 선택 → 그대로 / _meta source → 그것 / 첫 회사 → 미상
        let chosenSource = cur?.chosenSource;
        if (!chosenSource) {
            // _meta noVacancy 선언 vacancy 의 source 를 우선 사용 (v1.7.6)
            const metaV = (b.vacancies || []).find(v =>
                v && v._key && String(v._key).endsWith('_meta')
                && v.noVacancy === true
                && srNormalizeDate(v.publishDate) === st.yyyymm
            );
            if (metaV) {
                chosenSource = _scVacancySource(metaV);
            } else {
                const vacs = _scVacanciesByMonth(b, st.yyyymm);
                const sources = [...new Set(vacs.map(_scVacancySource))].sort();
                chosenSource = sources[0] || '미상';
            }
        }
        st.selections.set(String(buildingId), {
            chosenSource,
            selectedVacKeys: new Set(),
            noVacancy:       true,
        });
    }
    _scMarkDirty();
    _scRenderBuildingDetail();
    _scRenderBuildingLists();
    _scRenderResultPlaceholder();
};

// ═══════════════════════════════════════════════════════════════
// 5E. Step 4 — 공통 빌딩 셋 검출 + [계산하기] 버튼 활성화
// ═══════════════════════════════════════════════════════════════

/**
 * 양 시점 모두 selections 에 등록된 buildingId 셋 반환.
 * 유효 조건: selectedVacKeys.size > 0  OR  noVacancy === true (v1.7.5)
 * v1.7.9: excludedBuildingIds 에 있는 빌딩은 제외
 */
function _scGetCommonBuildingIds() {
    const isValid = v => (v.selectedVacKeys && v.selectedVacKeys.size > 0) || v.noVacancy === true;
    const excluded = _scState.excludedBuildingIds || new Set();
    const aSet = new Set();
    _scState.pointA.selections.forEach((v, k) => {
        if (isValid(v) && !excluded.has(String(k))) aSet.add(k);
    });
    const bSet = new Set();
    _scState.pointB.selections.forEach((v, k) => {
        if (isValid(v) && !excluded.has(String(k))) bSet.add(k);
    });
    const common = [...aSet].filter(id => bSet.has(id));
    const onlyA  = [...aSet].filter(id => !bSet.has(id));
    const onlyB  = [...bSet].filter(id => !aSet.has(id));
    return { aSet, bSet, common, onlyA, onlyB };
}

/** 결과 영역 placeholder 갱신 — 공통 셋·경고·계산 버튼 활성화 */
function _scRenderResultPlaceholder() {
    const area = _scQS('sc-result-area');
    if (!area) return;

    const { aSet, bSet, common, onlyA, onlyB } = _scGetCommonBuildingIds();

    // v1.7.5: 0공실 확정 카운트 (디버깅·검증용)
    let noVacA = 0, noVacB = 0;
    _scState.pointA.selections.forEach(v => { if (v.noVacancy) noVacA++; });
    _scState.pointB.selections.forEach(v => { if (v.noVacancy) noVacB++; });

    // v1.7.6: 0공실 후보(_meta 선언) 빌딩 수 — 사용자가 아직 클릭 안 한 것
    let candA = 0, candB = 0;
    // v1.7.7: 확장 모드로 추가된 빌딩 수 (선택 여부와 무관, 후보 단계)
    let expA = 0, expB = 0;
    if (_scState.pointA.yyyymm) {
        for (const c of _scGetCandidates('A')) {
            if (c.hasNoVacDecl && !_scState.pointA.selections.get(String(c.building.id))?.noVacancy) candA++;
            if (c.isExpand) expA++;
        }
    }
    if (_scState.pointB.yyyymm) {
        for (const c of _scGetCandidates('B')) {
            if (c.hasNoVacDecl && !_scState.pointB.selections.get(String(c.building.id))?.noVacancy) candB++;
            if (c.isExpand) expB++;
        }
    }

    const aOK = !!_scState.pointA.yyyymm;
    const bOK = !!_scState.pointB.yyyymm;
    const monthsOK = aOK && bOK && (_scState.pointA.yyyymm !== _scState.pointB.yyyymm);
    const canCalc  = monthsOK && common.length > 0;

    // 경고 메시지 (한쪽만 선택된 빌딩)
    const warn = (onlyA.length + onlyB.length) > 0
        ? `<div style="margin-top:10px; padding:8px 12px; background:#fff7ed;
                       border-radius:5px; border:1px solid #fed7aa; font-size:11px;
                       color:#9a3412; text-align:left;">
              ⚠️ 한쪽 시점에만 선택된 빌딩이 있습니다 — 분모에서 자동 제외됩니다.<br>
              <span style="font-weight:600;">시점 A 만 선택: ${onlyA.length}개 · 시점 B 만 선택: ${onlyB.length}개</span>
              ${(onlyA.length + onlyB.length <= 8)
                  ? `<div style="margin-top:4px; font-size:10px; opacity:0.8;">
                       ${[...onlyA.map(id => 'A: ' + (_scFindNormBuilding(id)?.name || id)),
                          ...onlyB.map(id => 'B: ' + (_scFindNormBuilding(id)?.name || id))].join(' · ')}
                     </div>`
                  : ''}
           </div>`
        : '';

    area.innerHTML = `
        <div style="width:100%; text-align:left;">
            <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap;
                        font-size:12px; color:var(--text-primary);">
                <span style="padding:4px 10px; background:#dbeafe; color:#1e40af;
                             border-radius:14px; font-weight:600;">
                    시점 A 선택: ${aSet.size}개
                    ${noVacA > 0 ? `<span style="color:#7c3aed; font-size:10px;"> · 0공실 ${noVacA}</span>` : ''}
                </span>
                <span style="padding:4px 10px; background:#ffedd5; color:#9a3412;
                             border-radius:14px; font-weight:600;">
                    시점 B 선택: ${bSet.size}개
                    ${noVacB > 0 ? `<span style="color:#7c3aed; font-size:10px;"> · 0공실 ${noVacB}</span>` : ''}
                </span>
                <span style="padding:4px 10px;
                             background:${common.length > 0 ? '#dcfce7' : 'var(--bg-card)'};
                             color:${common.length > 0 ? '#15803d' : 'var(--text-muted)'};
                             border-radius:14px; font-weight:700;
                             border:1px solid ${common.length > 0 ? '#86efac' : 'var(--border-color)'};">
                    ✅ 공통 빌딩: ${common.length}개
                </span>
            </div>
            ${(candA + candB) > 0 ? `
                <div style="margin-top:8px; padding:6px 10px; background:#f3e8ff;
                            border-left:3px solid #7c3aed; border-radius:5px;
                            font-size:11px; color:#6b21a8;">
                    🔒 통계 편집에서 0공실 선언된 빌딩이 있습니다 —
                    시점 A: <strong>${candA}개</strong> · 시점 B: <strong>${candB}개</strong>
                    (좌측 리스트에서 보라색 칩 빌딩 클릭 → [✅ 0공실 확정] 으로 통계 포함)
                </div>
            ` : ''}
            ${_scState.researchMaster.expandMode && (expA + expB) > 0 ? `
                <div style="margin-top:8px; padding:6px 10px; background:#fce7f3;
                            border-left:3px solid #9d174d; border-radius:5px;
                            font-size:11px; color:#9d174d;">
                    📊 portal 확장 모드 ON — RAW에 없지만 양 시점 OCR 있는 빌딩 자동 포함:
                    시점 A: <strong>${expA}개</strong> · 시점 B: <strong>${expB}개</strong>
                </div>
            ` : ''}
            ${warn}
            ${!canCalc ? `
                <div style="margin-top:10px; font-size:11px; color:var(--text-muted);">
                    ${!monthsOK
                        ? '두 시점을 서로 다른 월로 선택하세요.'
                        : '양 시점 모두 빌딩·회사·공실을 선택하면 [공실률 계산하기] 버튼이 활성화됩니다.'}
                </div>
            ` : `
                <div style="margin-top:10px; font-size:11px; color:#15803d; font-weight:600;">
                    🚀 계산 준비 완료. 우측 상단 [공실률 계산하기] 버튼을 누르세요.
                </div>
            `}
        </div>
    `;

    // 계산 버튼 활성화
    const btn = _scQS('sc-btn-calc');
    if (btn) {
        btn.disabled        = !canCalc;
        btn.style.cursor    = canCalc ? 'pointer' : 'not-allowed';
        btn.style.background= canCalc ? '#1a73e8' : 'var(--bg-secondary)';
        btn.style.color     = canCalc ? '#fff'    : 'var(--text-muted)';
        btn.style.borderColor = canCalc ? '#1a73e8' : 'var(--border-color)';
    }
}

// ═══════════════════════════════════════════════════════════════
// 5F. Step 5 — 계산 + 결과 카드
// ═══════════════════════════════════════════════════════════════

/**
 * 한 시점의 한 빌딩에 대해, 사용자 선택을 기반으로 메트릭 추출.
 *   - vacancyAreaPy: 선택된 vacancy 들의 면적 합 (공실면적 분자)
 *   - rentPy/depositPy/maintenancePy: 선택된 vacancy 들의 가격 평균 (없으면 floorPricing 폴백)
 * @returns {{vacancyAreaPy, rentPy, depositPy, maintenancePy, missing}}
 */
function _scExtractBuildingMetrics(side, buildingId) {
    side = _scSide(side);
    const st = _scState[`point${side}`];
    const sel = st.selections.get(String(buildingId));
    if (!sel) {
        return { vacancyAreaPy: 0, rentPy: null, depositPy: null, maintenancePy: null, missing: ['no-selection'] };
    }
    const b = _scFindNormBuilding(buildingId);
    if (!b) return { vacancyAreaPy: 0, rentPy: null, depositPy: null, maintenancePy: null, missing: ['no-building'] };

    // v1.7.5: 0공실 확정 → 분자 0, 가격은 floorPricing 폴백만
    if (sel.noVacancy) {
        const fb = _scFloorFallback(b, st.yyyymm);
        const missing = [];
        if (fb.rentPy        == null) missing.push('rent');
        if (fb.depositPy     == null) missing.push('deposit');
        if (fb.maintenancePy == null) missing.push('maintenance');
        return {
            vacancyAreaPy: 0,
            rentPy:        fb.rentPy,
            depositPy:     fb.depositPy,
            maintenancePy: fb.maintenancePy,
            missing,
            isNoVacancy:   true,
        };
    }

    if (!sel.selectedVacKeys || sel.selectedVacKeys.size === 0) {
        return { vacancyAreaPy: 0, rentPy: null, depositPy: null, maintenancePy: null, missing: ['no-selection'] };
    }

    const vacs = _scVacanciesByMonth(b, st.yyyymm)
        .filter(v => _scVacancySource(v) === sel.chosenSource)
        .filter(v => sel.selectedVacKeys.has(_scVacancyKey(v)));

    let vacArea = 0;
    const rentVals = [], depVals = [], mntVals = [];
    vacs.forEach(v => {
        vacArea += _scVacAreaPy(v);
        const px = _scVacPrices(v);
        if (px.rentPy)        rentVals.push(px.rentPy);
        if (px.depositPy)     depVals.push(px.depositPy);
        if (px.maintenancePy) mntVals.push(px.maintenancePy);
    });

    const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;
    let rentPy = avg(rentVals);
    let depPy  = avg(depVals);
    let mntPy  = avg(mntVals);

    // floorPricing 폴백 (vacancy 에 가격이 없을 때만)
    const missing = [];
    if (rentPy == null || depPy == null || mntPy == null) {
        const fb = _scFloorFallback(b, st.yyyymm);
        if (rentPy == null) { rentPy = fb.rentPy; if (rentPy == null) missing.push('rent'); }
        if (depPy  == null) { depPy  = fb.depositPy; if (depPy  == null) missing.push('deposit'); }
        if (mntPy  == null) { mntPy  = fb.maintenancePy; if (mntPy  == null) missing.push('maintenance'); }
    }

    return {
        vacancyAreaPy: vacArea,
        rentPy:        rentPy,
        depositPy:     depPy,
        maintenancePy: mntPy,
        missing,
    };
}

/**
 * 권역별 가중평균 집계.
 * 공실률    = Σ공실면적(임대평) / Σ연면적 × 100   (분자=임대면적, 분모=연면적)
 * 평균임대가 = Σ(임대료×연면적) / Σ(연면적, 임대료 있는 빌딩)   ← 연면적 가중평균
 * 보증금/관리비 동일 방식.
 *
 * @returns Map<region, {bldgCount, grossPy, vacPy, vacRate,
 *                       rentSum, rentWeight, rentAvg, depSum, depWeight, depAvg,
 *                       mntSum, mntWeight, mntAvg}>
 */
function _scAggregateByRegion(commonIds, side) {
    side = _scSide(side);
    const init = () => ({
        bldgCount:0, grossPy:0, vacPy:0, vacRate:0,
        rentSum:0, rentWeight:0, rentAvg:null,
        depSum:0,  depWeight:0,  depAvg:null,
        mntSum:0,  mntWeight:0,  mntAvg:null,
    });
    const map = new Map();
    SR_REGIONS.forEach(r => map.set(r, init()));
    map.set('TOTAL', init());

    commonIds.forEach(bid => {
        const b = _scFindNormBuilding(bid);
        if (!b) return;
        const region = b._region || 'ETC';
        const gross  = _scGrossPy(b);
        if (gross <= 0) return;       // 분모 0 방지

        const m = _scExtractBuildingMetrics(side, bid);

        const buckets = [map.get(region) || map.get('ETC'), map.get('TOTAL')];
        buckets.forEach(bk => {
            bk.bldgCount += 1;
            bk.grossPy   += gross;
            bk.vacPy     += m.vacancyAreaPy;
            if (m.rentPy        != null) { bk.rentSum += m.rentPy        * gross; bk.rentWeight += gross; }
            if (m.depositPy     != null) { bk.depSum  += m.depositPy     * gross; bk.depWeight  += gross; }
            if (m.maintenancePy != null) { bk.mntSum  += m.maintenancePy * gross; bk.mntWeight  += gross; }
        });
    });

    map.forEach(bk => {
        bk.vacRate = bk.grossPy > 0 ? (bk.vacPy / bk.grossPy * 100) : 0;
        bk.rentAvg = bk.rentWeight > 0 ? bk.rentSum / bk.rentWeight : null;
        bk.depAvg  = bk.depWeight  > 0 ? bk.depSum  / bk.depWeight  : null;
        bk.mntAvg  = bk.mntWeight  > 0 ? bk.mntSum  / bk.mntWeight  : null;
    });
    return map;
}

/** 숫자 포맷 — 천원/평 단위 */
function _scFmtKW(v) {
    if (v == null) return '-';
    return Math.round(v / 1000).toLocaleString();
}

/** 증감 배지 */
function _scDeltaBadge(cur, prev, type) {
    if (cur == null || prev == null) {
        return `<span style="font-size:10px; color:#9ca3af;">-</span>`;
    }
    const diff = cur - prev;
    const isVacRate = (type === 'vacRate');
    const sign = diff > 0 ? '▲' : (diff < 0 ? '▼' : '–');
    let color;
    if (Math.abs(diff) < (isVacRate ? 0.05 : 50)) color = '#9ca3af';
    else if (isVacRate) color = (diff > 0) ? '#dc2626' : '#16a34a';   // 공실률은 ↑ 나쁨
    else                color = (diff > 0) ? '#16a34a' : '#dc2626';   // 가격은 ↑ 좋음 (관점에 따라)
    const fmt = isVacRate ? `${diff > 0 ? '+' : ''}${diff.toFixed(2)}%p`
                          : `${diff > 0 ? '+' : ''}${_scFmtKW(diff)}`;
    return `<span style="font-size:10px; font-weight:700; color:${color};">
                ${sign} ${fmt}
            </span>`;
}

/** 결과 카드 4종 + 권역×등급 교차표 렌더 */
window._scCalculate = function() {
    const { common } = _scGetCommonBuildingIds();
    if (common.length === 0) {
        alert('공통 빌딩이 없습니다.');
        return;
    }
    const aMonth = _scState.pointA.yyyymm;
    const bMonth = _scState.pointB.yyyymm;

    const aggA = _scAggregateByRegion(common, 'A');
    const aggB = _scAggregateByRegion(common, 'B');

    const area = _scQS('sc-result-area');
    if (!area) return;

    // 권역별 카드 (TOTAL 포함)
    const orderedRegions = ['TOTAL', ...SR_REGIONS.filter(r => (aggA.get(r)?.bldgCount || 0) + (aggB.get(r)?.bldgCount || 0) > 0)];

    const renderRegionRow = (r) => {
        const a = aggA.get(r) || {};
        const b = aggB.get(r) || {};
        const isTotal = (r === 'TOTAL');
        const color = isTotal ? '#0f172a' : (SR_REGION_COLOR[r] || '#64748b');
        return `
            <tr style="border-top:1px solid var(--border-color);
                       ${isTotal ? 'background:#f1f5f9; font-weight:700;' : ''}">
                <td style="padding:6px 8px; font-weight:700; color:${color};">
                    ${isTotal ? '🌐 전체' : r}
                </td>
                <td style="padding:6px 8px; text-align:right; color:var(--text-muted);">
                    ${a.bldgCount || 0}
                </td>
                <td style="padding:6px 8px; text-align:right;">
                    <strong style="color:#0284c7;">${(a.vacRate || 0).toFixed(2)}%</strong>
                </td>
                <td style="padding:6px 8px; text-align:right;">
                    <strong style="color:#ea580c;">${(b.vacRate || 0).toFixed(2)}%</strong>
                </td>
                <td style="padding:6px 8px; text-align:right;">
                    ${_scDeltaBadge(b.vacRate, a.vacRate, 'vacRate')}
                </td>
                <td style="padding:6px 8px; text-align:right; color:#0284c7;">
                    ${_scFmtKW(a.rentAvg)}
                </td>
                <td style="padding:6px 8px; text-align:right; color:#ea580c;">
                    ${_scFmtKW(b.rentAvg)}
                </td>
                <td style="padding:6px 8px; text-align:right;">
                    ${_scDeltaBadge(b.rentAvg, a.rentAvg, 'rent')}
                </td>
                <td style="padding:6px 8px; text-align:right; color:#0284c7;">
                    ${_scFmtKW(a.depAvg)}
                </td>
                <td style="padding:6px 8px; text-align:right; color:#ea580c;">
                    ${_scFmtKW(b.depAvg)}
                </td>
                <td style="padding:6px 8px; text-align:right;">
                    ${_scDeltaBadge(b.depAvg, a.depAvg, 'deposit')}
                </td>
                <td style="padding:6px 8px; text-align:right; color:#0284c7;">
                    ${_scFmtKW(a.mntAvg)}
                </td>
                <td style="padding:6px 8px; text-align:right; color:#ea580c;">
                    ${_scFmtKW(b.mntAvg)}
                </td>
                <td style="padding:6px 8px; text-align:right;">
                    ${_scDeltaBadge(b.mntAvg, a.mntAvg, 'maintenance')}
                </td>
            </tr>
        `;
    };

    // 헤더 카드 (TOTAL 의 4지표를 큰 글씨로)
    const T_A = aggA.get('TOTAL'), T_B = aggB.get('TOTAL');
    const heroCards = `
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:10px;">
            ${_scHeroCard('📉 공실률', `${(T_A.vacRate||0).toFixed(2)}%`, `${(T_B.vacRate||0).toFixed(2)}%`,
                          _scDeltaBadge(T_B.vacRate, T_A.vacRate, 'vacRate'))}
            ${_scHeroCard('💰 평균임대가', `${_scFmtKW(T_A.rentAvg)}`, `${_scFmtKW(T_B.rentAvg)}`,
                          _scDeltaBadge(T_B.rentAvg, T_A.rentAvg, 'rent'), '천원/평')}
            ${_scHeroCard('🏦 평균보증금', `${_scFmtKW(T_A.depAvg)}`, `${_scFmtKW(T_B.depAvg)}`,
                          _scDeltaBadge(T_B.depAvg, T_A.depAvg, 'deposit'), '천원/평')}
            ${_scHeroCard('🔧 평균관리비', `${_scFmtKW(T_A.mntAvg)}`, `${_scFmtKW(T_B.mntAvg)}`,
                          _scDeltaBadge(T_B.mntAvg, T_A.mntAvg, 'maintenance'), '천원/평')}
        </div>
    `;

    // ★ v1.7.8: sc-result-area 가 display:flex 로 초기화돼 있으므로 명시적 block 으로 재설정
    area.style.cssText = `
        background: var(--bg-card);
        border-radius: 8px;
        padding: 16px 18px;
        text-align: left;
        color: var(--text-primary);
        min-height: 180px;
        display: block;
    `;

    area.innerHTML = `
        <!-- 1행: 헤더 (제목·메타·액션 버튼) -->
        <div style="display:flex; justify-content:space-between; align-items:center;
                    margin-bottom:14px; flex-wrap:wrap; gap:10px;
                    padding-bottom:12px; border-bottom:1px solid var(--border-color);">
            <div>
                <div style="font-size:14px; font-weight:700; color:var(--text-primary);">
                    📊 비교 결과 — 공통 빌딩 ${common.length}개
                </div>
                <div style="font-size:11px; color:var(--text-muted); margin-top:3px;">
                    시점 A: <strong style="color:#0284c7;">${aMonth}</strong> (기준)
                    · 시점 B: <strong style="color:#ea580c;">${bMonth}</strong> (비교)
                    · 연면적 가중평균
                </div>
            </div>
            <div style="display:flex; gap:6px;">
                <button onclick="window._scExportExcel()"
                    style="padding:7px 14px; font-size:12px; background:#16a34a; color:#fff;
                           border:none; border-radius:6px; cursor:pointer; font-weight:600;
                           white-space:nowrap;">
                    📥 엑셀 다운로드
                </button>
                <button onclick="window._scClearResult()"
                    style="padding:7px 14px; font-size:12px; background:transparent;
                           border:1px solid var(--border-color); border-radius:6px;
                           color:var(--text-primary); cursor:pointer; white-space:nowrap;">
                    결과 닫기
                </button>
            </div>
        </div>

        <!-- 2행: Hero 카드 4종 (전체 풀폭, 4분할) -->
        <div style="margin-bottom:14px;">
            ${heroCards}
        </div>

        <!-- 3행: 권역별 비교표 (전체 풀폭, 가로 스크롤) -->
        <div style="background:#fff; border:1px solid var(--border-color);
                    border-radius:8px; overflow:hidden;">
            <div style="overflow-x:auto;">
                <table style="width:100%; min-width:1080px; font-size:11px;
                              border-collapse:collapse;">
                    <thead style="background:var(--bg-secondary);">
                        <tr>
                            <th rowspan="2" style="padding:8px 10px; text-align:left; vertical-align:bottom;
                                width:80px; white-space:nowrap;">권역</th>
                            <th rowspan="2" style="padding:8px 10px; text-align:right; vertical-align:bottom;
                                width:60px;">빌딩수</th>
                            <th colspan="3" style="padding:6px 8px; text-align:center;
                                background:#f0f9ff; color:#0c4a6e; border-bottom:1px solid #bae6fd;">
                                📉 공실률 (%)
                            </th>
                            <th colspan="3" style="padding:6px 8px; text-align:center;
                                background:#fff7ed; color:#7c2d12; border-bottom:1px solid #fed7aa;">
                                💰 임대가 (천원/평)
                            </th>
                            <th colspan="3" style="padding:6px 8px; text-align:center;
                                background:#f5f3ff; color:#4c1d95; border-bottom:1px solid #ddd6fe;">
                                🏦 보증금 (천원/평)
                            </th>
                            <th colspan="3" style="padding:6px 8px; text-align:center;
                                background:#f0fdf4; color:#14532d; border-bottom:1px solid #bbf7d0;">
                                🔧 관리비 (천원/평)
                            </th>
                        </tr>
                        <tr style="font-size:10px; color:var(--text-muted);">
                            <th style="padding:4px 6px; text-align:right; width:70px;">A</th>
                            <th style="padding:4px 6px; text-align:right; width:70px;">B</th>
                            <th style="padding:4px 6px; text-align:right; width:60px;">Δ</th>
                            <th style="padding:4px 6px; text-align:right; width:70px;">A</th>
                            <th style="padding:4px 6px; text-align:right; width:70px;">B</th>
                            <th style="padding:4px 6px; text-align:right; width:60px;">Δ</th>
                            <th style="padding:4px 6px; text-align:right; width:70px;">A</th>
                            <th style="padding:4px 6px; text-align:right; width:70px;">B</th>
                            <th style="padding:4px 6px; text-align:right; width:60px;">Δ</th>
                            <th style="padding:4px 6px; text-align:right; width:70px;">A</th>
                            <th style="padding:4px 6px; text-align:right; width:70px;">B</th>
                            <th style="padding:4px 6px; text-align:right; width:60px;">Δ</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${orderedRegions.map(renderRegionRow).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        <!-- 4행: 산식 안내 -->
        <div style="margin-top:10px; padding:8px 12px; background:var(--bg-secondary);
                    border-radius:5px; font-size:10px; color:var(--text-muted); line-height:1.7;">
            💡 <strong>산식</strong>: 공실률 = Σ공실면적(임대평) ÷ Σ연면적 × 100 ·
                평균값 = Σ(빌딩값 × 연면적) ÷ Σ(연면적, 값 있는 빌딩 한정) ·
                Δ = 시점 B − 시점 A · 가격 단위 = 천원/평/月.
                vacancy 에 가격이 누락된 빌딩은 floorPricing 의 동시점 또는 최신값으로 폴백.
        </div>
    `;
};

/** Hero 카드 1개 */
function _scHeroCard(label, valA, valB, deltaHtml, unit = '%') {
    return `
        <div style="background:#fff; border:1px solid var(--border-color);
                    border-radius:8px; padding:10px 12px;">
            <div style="font-size:11px; font-weight:700; color:var(--text-muted); margin-bottom:6px;">
                ${label}
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; gap:6px;">
                <div style="text-align:left;">
                    <div style="font-size:9px; color:#0284c7;">시점 A</div>
                    <div style="font-size:14px; font-weight:700; color:#0284c7;">${valA}</div>
                </div>
                <div style="text-align:center; font-size:14px; color:#9ca3af;">→</div>
                <div style="text-align:right;">
                    <div style="font-size:9px; color:#ea580c;">시점 B</div>
                    <div style="font-size:14px; font-weight:700; color:#ea580c;">${valB}</div>
                </div>
            </div>
            <div style="text-align:center; margin-top:6px; padding-top:6px;
                        border-top:1px dashed var(--border-color);">
                ${deltaHtml}
                <span style="font-size:9px; color:var(--text-muted); margin-left:4px;">${unit !== '%' ? unit : ''}</span>
            </div>
        </div>
    `;
}

/** 결과 영역 닫기 (placeholder 로 복귀) */
window._scClearResult = function() {
    const area = _scQS('sc-result-area');
    if (area) {
        // v1.7.8: 결과 카드 cssText를 모두 덮어썼으므로 placeholder 스타일로 명시 복귀
        area.style.cssText = `
            background: var(--bg-secondary);
            border-radius: 8px;
            padding: 24px;
            text-align: center;
            color: var(--text-muted);
            font-size: 12px;
            min-height: 120px;
            display: flex;
            align-items: center;
            justify-content: center;
        `;
    }
    _scRenderResultPlaceholder();
};

// ═══════════════════════════════════════════════════════════════
// 5G. Step 6 — 직렬화 / 역직렬화 (Set ↔ Firebase plain object)
// ═══════════════════════════════════════════════════════════════

/**
 * _scState 의 selections (Map<id, {chosenSource, selectedVacKeys:Set}>) 를
 * Firebase 저장 가능한 plain object 로 변환:
 *   { [bid]: { chosenSource, selectedVacKeys: { [k]: true, ... } } }
 */
// ── v1.7.11: Firebase Realtime DB 키 escape ──
// 금지 문자: . # $ / [ ]
// 안전한 sentinel 로 치환 (URL encode 와 다른 문자라 충돌 없음)
const _SC_KEY_ESCAPE_MAP = {
    '.': '\u2024',  // ONE DOT LEADER (점처럼 보이지만 다른 코드포인트)
    '#': '\uFF03',  // FULLWIDTH NUMBER SIGN
    '$': '\uFF04',
    '/': '\uFF0F',
    '[': '\uFF3B',
    ']': '\uFF3D',
};
const _SC_KEY_UNESCAPE_MAP = Object.fromEntries(
    Object.entries(_SC_KEY_ESCAPE_MAP).map(([k, v]) => [v, k])
);

/** Firebase 키로 사용 가능하게 변환 */
function _scEscapeKey(s) {
    if (s == null) return '';
    return String(s).replace(/[.#$/[\]]/g, ch => _SC_KEY_ESCAPE_MAP[ch] || ch);
}
/** escape 된 키 원복 */
function _scUnescapeKey(s) {
    if (s == null) return '';
    return String(s).replace(/[\u2024\uFF03\uFF04\uFF0F\uFF3B\uFF3D]/g, ch => _SC_KEY_UNESCAPE_MAP[ch] || ch);
}

function _scSerializeSelections(selectionsMap) {
    const out = {};
    selectionsMap.forEach((val, bid) => {
        const keysObj = {};
        if (val.selectedVacKeys && val.selectedVacKeys.size > 0) {
            // v1.7.11: vacancy 키에 . / # $ [ ] 가 있으면 Firebase 가 거부
            //          → escape 해서 저장. 불러올 때 unescape.
            val.selectedVacKeys.forEach(k => { keysObj[_scEscapeKey(k)] = true; });
        }
        out[_scEscapeKey(bid)] = {
            chosenSource:    val.chosenSource || '',
            selectedVacKeys: keysObj,
            noVacancy:       !!val.noVacancy,   // v1.7.5
        };
    });
    return out;
}

/** Firebase plain object → Map<id, {chosenSource, selectedVacKeys:Set, noVacancy}> */
function _scDeserializeSelections(plainObj) {
    const map = new Map();
    if (!plainObj) return map;
    Object.keys(plainObj).forEach(bidEsc => {
        const v = plainObj[bidEsc] || {};
        // v1.7.11: 키 unescape (구버전에 escape 안 된 키도 그대로 통과)
        const bid  = _scUnescapeKey(bidEsc);
        const keys = new Set(Object.keys(v.selectedVacKeys || {}).map(_scUnescapeKey));
        map.set(String(bid), {
            chosenSource:    v.chosenSource || '',
            selectedVacKeys: keys,
            noVacancy:       !!v.noVacancy,    // v1.7.5
        });
    });
    return map;
}

/** 현재 _scState 를 Firebase 페이로드로 변환 */
function _scBuildPayload(title) {
    const user = window.state?.currentUser?.email || 'unknown';
    const now  = new Date().toISOString();
    // v1.7.9: excludedBuildingIds Set → object {id:true}
    // v1.7.11: building id 도 escape (대부분 영문이라 영향 없지만 안전 차원)
    const excludedObj = {};
    (_scState.excludedBuildingIds || new Set()).forEach(id => {
        excludedObj[_scEscapeKey(id)] = true;
    });
    return {
        title:     String(title || _scState.title || '제목없음').slice(0, 200),
        updatedAt: now,
        updatedBy: user,
        version:   (_scState.version || 0) + 1,
        expandMode: !!_scState.researchMaster.expandMode,   // v1.7.7
        excludedBuildingIds: excludedObj,                   // v1.7.9
        pointA: {
            yyyymm:     _scState.pointA.yyyymm || '',
            filters:    _scNormalizeFilters(_scState.pointA.filters),
            selections: _scSerializeSelections(_scState.pointA.selections),
        },
        pointB: {
            yyyymm:     _scState.pointB.yyyymm || '',
            filters:    _scNormalizeFilters(_scState.pointB.filters),
            selections: _scSerializeSelections(_scState.pointB.selections),
        },
    };
}

/**
 * v1.7.12: payload 의 모든 객체 키를 재귀 검사.
 * Firebase 금지 문자(. # $ / [ ])가 포함된 키가 있으면 경로와 함께 반환.
 * 저장 직전 안전 검증용.
 * @returns {string[]} 발견된 위반 경로 목록 (없으면 빈 배열)
 */
function _scValidateFirebaseKeys(obj, path = '$') {
    const violations = [];
    if (obj == null || typeof obj !== 'object') return violations;
    if (Array.isArray(obj)) {
        obj.forEach((v, i) => {
            violations.push(..._scValidateFirebaseKeys(v, `${path}[${i}]`));
        });
        return violations;
    }
    Object.keys(obj).forEach(k => {
        if (/[.#$/[\]]/.test(k)) {
            violations.push(`${path}.${k}`);
        }
        violations.push(..._scValidateFirebaseKeys(obj[k], `${path}.${k}`));
    });
    return violations;
}

/** filters 의 빈 배열은 Firebase 에서 안전하게 보존 */
function _scNormalizeFilters(f) {
    return {
        regions:    Array.isArray(f.regions)    ? f.regions    : [],
        grades:     Array.isArray(f.grades)     ? f.grades     : [],
        sizeBands:  Array.isArray(f.sizeBands)  ? f.sizeBands  : [],
        subRegions: Array.isArray(f.subRegions) ? f.subRegions : [],
    };
}

// ═══════════════════════════════════════════════════════════════
// 5H. Step 6 — Firebase 저장 / 불러오기
// ═══════════════════════════════════════════════════════════════

/** [💾 저장] 버튼 핸들러 — 신규 저장 또는 덮어쓰기 */
window._scSaveCompare = async function() {
    const monthsOK = _scState.pointA.yyyymm && _scState.pointB.yyyymm
                     && _scState.pointA.yyyymm !== _scState.pointB.yyyymm;
    if (!monthsOK) {
        alert('저장 전에 두 시점을 서로 다른 월로 선택하세요.');
        return;
    }

    // 제목 입력 (덮어쓰기면 기존 제목 디폴트)
    const defaultTitle = _scState.title
        || `${_scState.pointA.yyyymm} ↔ ${_scState.pointB.yyyymm} 비교`;
    const title = prompt(
        _scState.compareId
            ? '비교 세션 제목 (덮어쓰기):'
            : '비교 세션 제목 (신규 저장):',
        defaultTitle
    );
    if (title == null) return;     // 취소
    if (!title.trim()) {
        alert('제목을 입력하세요.');
        return;
    }

    // v1.7.12: payload 빌드 후 Firebase 키 사전 검증
    const payload = _scBuildPayload(title);
    const violations = _scValidateFirebaseKeys(payload);
    if (violations.length > 0) {
        console.error('[stats-compare] Firebase 금지 문자 키 발견:', violations);
        alert(
            '저장 전 검증 실패: Firebase 금지 문자(. # $ / [ ])가 포함된 키가 있습니다.\n' +
            '콘솔에 상세 위치가 출력됐습니다. 새로고침 후 다시 시도하세요.\n\n' +
            `위반 경로 ${violations.length}개 (첫 3개):\n` + violations.slice(0, 3).join('\n')
        );
        return;
    }

    try {
        const { db, ref, get, set, push, update, serverTimestamp } =
            await import('./portal-firebase.js');

        // 신규 저장
        if (!_scState.compareId) {
            const newRef = push(ref(db, 'statsCompare'));
            payload.createdAt = payload.updatedAt;
            payload.createdBy = payload.updatedBy;
            await set(newRef, payload);
            _scState.compareId = newRef.key;
            _scState.title     = payload.title;
            _scState.version   = payload.version;
            _scState.dirty     = false;
            await _scLogCompareAction('create', newRef.key, payload.version);
            alert(`✅ 저장 완료\n제목: ${payload.title}\nID: ${newRef.key}`);
        }
        // 덮어쓰기 (낙관적 락)
        else {
            const snap = await get(ref(db, `statsCompare/${_scState.compareId}`));
            if (!snap.exists()) {
                if (!confirm('원본이 삭제된 상태입니다. 신규 ID 로 다시 저장할까요?')) return;
                _scState.compareId = '';
                _scState.version   = 0;
                return window._scSaveCompare();
            }
            const remote = snap.val() || {};
            if ((remote.version || 0) !== (_scState.version || 0)) {
                if (!confirm(
                    `다른 사용자가 먼저 수정한 것 같습니다.\n` +
                    `원격 version: ${remote.version || 0}, 내 version: ${_scState.version || 0}\n\n` +
                    `[확인] 강제 덮어쓰기 / [취소] 중단`
                )) return;
            }
            // createdAt/By 보존
            payload.createdAt = remote.createdAt || payload.updatedAt;
            payload.createdBy = remote.createdBy || payload.updatedBy;

            try {
                await set(ref(db, `statsCompare/${_scState.compareId}`), payload);
            } catch (setErr) {
                // v1.7.12: 기존 노드에 호환 안 되는 자식 키가 있을 때
                // → 신규 ID 로 강제 분기 (사용자 데이터 보호)
                console.warn('[stats-compare] 덮어쓰기 실패, 신규 ID 폴백:', setErr.message);
                if (confirm(
                    '기존 저장 노드에 호환 안 되는 데이터가 있어 덮어쓰기 실패했습니다.\n' +
                    '[확인] 신규 ID 로 다시 저장 (안전) / [취소] 중단'
                )) {
                    const fallbackRef = push(ref(db, 'statsCompare'));
                    await set(fallbackRef, payload);
                    _scState.compareId = fallbackRef.key;
                    _scState.title     = payload.title;
                    _scState.version   = payload.version;
                    _scState.dirty     = false;
                    await _scLogCompareAction('create-fallback', fallbackRef.key, payload.version);
                    alert(`✅ 신규 ID 로 저장 완료\n제목: ${payload.title}\nID: ${fallbackRef.key}\n\n` +
                          `(기존 ID: ${_scState.compareId} 의 호환 문제로 새 노드 생성)`);
                    _scUpdateSubtitle();
                    return;
                }
                throw setErr;
            }
            _scState.title   = payload.title;
            _scState.version = payload.version;
            _scState.dirty   = false;
            await _scLogCompareAction('update', _scState.compareId, payload.version);
            alert(`✅ 덮어쓰기 완료\n제목: ${payload.title}\nversion: ${payload.version}`);
        }
        _scUpdateSubtitle();
    } catch (err) {
        console.error('[stats-compare] 저장 실패:', err);
        alert(`❌ 저장 실패: ${err.message}\n\n` +
              `콘솔에 상세 에러가 출력됐습니다. 그대로 캡쳐해서 알려주세요.`);
    }
};

/** 변경 로그 — /statsCompareLogs/{autoKey} */
async function _scLogCompareAction(action, compareId, version) {
    try {
        const { db, ref, push } = await import('./portal-firebase.js');
        const user = window.state?.currentUser?.email || 'unknown';
        await push(ref(db, 'statsCompareLogs'), {
            compareId, action, user,
            ts: new Date().toISOString(),
            version,
        });
    } catch (e) { /* 로그 실패는 무시 */ }
}

/** [📂 불러오기] 버튼 — 세션 목록 모달 */
window._scOpenLoadList = async function() {
    _scInjectLoadModal();
    const m = _scQS('sc-load-modal');
    if (m) m.style.display = 'flex';
    _scRenderLoadList(null);     // 로딩 상태 표시
    try {
        const { db, ref, get } = await import('./portal-firebase.js');
        const snap = await get(ref(db, 'statsCompare'));
        const all = snap.exists() ? snap.val() : {};
        const list = Object.keys(all).map(id => ({ id, ...all[id] }));
        // updatedAt 내림차순
        list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
        _scRenderLoadList(list);
    } catch (err) {
        console.error('[stats-compare] 목록 로드 실패:', err);
        _scRenderLoadList([], err.message);
    }
};

/** 불러오기 모달 DOM 주입 */
function _scInjectLoadModal() {
    if (_scQS('sc-load-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'sc-load-modal';
    wrap.style.cssText = `
        display:none; position:fixed; top:50%; left:50%;
        transform:translate(-50%,-50%); background:var(--bg-card);
        border-radius:12px; width:720px; max-width:94vw;
        z-index:1030; box-shadow:0 24px 60px rgba(0,0,0,0.5);
        max-height:82vh; flex-direction:column;
    `;
    wrap.innerHTML = `
        <div style="padding:14px 20px; background:linear-gradient(135deg,#0f4c81,#1a73e8);
                    color:#fff; display:flex; justify-content:space-between;
                    align-items:center; border-radius:12px 12px 0 0; flex-shrink:0;">
            <div style="font-size:14px; font-weight:700;">📂 저장된 비교 세션 불러오기</div>
            <button onclick="window._scCloseLoadModal()"
                style="background:rgba(255,255,255,0.2); border:none; color:#fff;
                       font-size:18px; width:30px; height:30px; border-radius:6px;
                       cursor:pointer;">×</button>
        </div>
        <div id="sc-load-list" style="flex:1; overflow-y:auto; padding:14px 20px;
                                       min-height:240px;"></div>
        <div style="padding:10px 20px; border-top:1px solid var(--border-color);
                    background:var(--bg-secondary); border-radius:0 0 12px 12px;
                    display:flex; justify-content:flex-end; flex-shrink:0;">
            <button onclick="window._scCloseLoadModal()"
                style="padding:6px 14px; background:var(--bg-card);
                       border:1px solid var(--border-color); color:var(--text-primary);
                       border-radius:6px; cursor:pointer; font-size:12px;">
                닫기
            </button>
        </div>
    `;
    document.body.appendChild(wrap);
}

/** 불러오기 모달 닫기 */
window._scCloseLoadModal = function() {
    const m = _scQS('sc-load-modal');
    if (m) m.style.display = 'none';
};

/** 세션 목록 렌더 */
function _scRenderLoadList(list, errMsg) {
    const el = _scQS('sc-load-list');
    if (!el) return;
    if (list == null) {
        el.innerHTML = `<div style="padding:40px 0; text-align:center; color:var(--text-muted);">로딩 중…</div>`;
        return;
    }
    if (errMsg) {
        el.innerHTML = `<div style="padding:30px 0; text-align:center; color:#dc2626;">❌ ${errMsg}</div>`;
        return;
    }
    if (list.length === 0) {
        el.innerHTML = `
            <div style="padding:40px 0; text-align:center; color:var(--text-muted);">
                저장된 비교 세션이 없습니다.<br>
                <span style="font-size:11px; opacity:0.7;">현재 작업을 [💾 저장] 으로 첫 세션을 만들어보세요.</span>
            </div>
        `;
        return;
    }

    el.innerHTML = list.map(item => {
        const isCurrent = (item.id === _scState.compareId);
        const aBldgs = Object.keys(item.pointA?.selections || {}).length;
        const bBldgs = Object.keys(item.pointB?.selections || {}).length;
        return `
            <div style="border:1px solid ${isCurrent ? '#1a73e8' : 'var(--border-color)'};
                        background:${isCurrent ? '#eff6ff' : 'var(--bg-primary)'};
                        border-radius:7px; padding:10px 12px; margin-bottom:8px;
                        display:flex; justify-content:space-between; align-items:center;
                        gap:12px;">
                <div style="flex:1; min-width:0; cursor:pointer;"
                    onclick="window._scLoadCompare('${item.id}')">
                    <div style="font-size:13px; font-weight:700; color:var(--text-primary);">
                        ${isCurrent ? '⭐ ' : ''}${item.title || '(제목없음)'}
                    </div>
                    <div style="font-size:10px; color:var(--text-muted); margin-top:3px;">
                        ${item.pointA?.yyyymm || '-'} ↔ ${item.pointB?.yyyymm || '-'}
                        · A:${aBldgs}개 · B:${bBldgs}개
                        · v${item.version || 0}
                        · ${(item.updatedAt || '').slice(0, 16).replace('T', ' ')}
                        · ${item.updatedBy || '-'}
                    </div>
                </div>
                <div style="display:flex; gap:4px;">
                    <button onclick="window._scLoadCompare('${item.id}')"
                        style="padding:5px 11px; background:#1a73e8; color:#fff;
                               border:none; border-radius:5px; cursor:pointer;
                               font-size:11px; font-weight:600;">
                        불러오기
                    </button>
                    <button onclick="window._scDeleteCompare('${item.id}')"
                        style="padding:5px 9px; background:#fee2e2; color:#991b1b;
                               border:1px solid #fca5a5; border-radius:5px;
                               cursor:pointer; font-size:11px;">
                        🗑️
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

/** 세션 불러오기 — 클릭한 ID 의 데이터로 _scState 복원 */
window._scLoadCompare = async function(compareId) {
    if (_scState.dirty
        && !confirm('저장하지 않은 변경사항이 있습니다. 그래도 불러올까요?')) return;
    try {
        const { db, ref, get } = await import('./portal-firebase.js');
        const snap = await get(ref(db, `statsCompare/${compareId}`));
        if (!snap.exists()) {
            alert('해당 세션이 존재하지 않습니다 (이미 삭제되었을 수 있음).');
            return;
        }
        const data = snap.val() || {};
        _scState.compareId = compareId;
        _scState.title     = data.title || '';
        _scState.version   = data.version || 0;
        _scState.dirty     = false;
        _scState.researchMaster.expandMode = !!data.expandMode;     // v1.7.7
        _scState.excludedBuildingIds = new Set(
            Object.keys(data.excludedBuildingIds || {}).map(_scUnescapeKey)
        );  // v1.7.9 + v1.7.11 unescape
        _scState.pointA.yyyymm     = data.pointA?.yyyymm || '';
        _scState.pointA.filters    = _scNormalizeFilters(data.pointA?.filters || {});
        _scState.pointA.selections = _scDeserializeSelections(data.pointA?.selections);
        _scState.pointB.yyyymm     = data.pointB?.yyyymm || '';
        _scState.pointB.filters    = _scNormalizeFilters(data.pointB?.filters || {});
        _scState.pointB.selections = _scDeserializeSelections(data.pointB?.selections);

        // UI 동기화
        const sa = _scQS('sc-month-A'); if (sa) sa.value = _scState.pointA.yyyymm;
        const sb = _scQS('sc-month-B'); if (sb) sb.value = _scState.pointB.yyyymm;
        _scRenderFilters('A');
        _scRenderFilters('B');
        _scRenderBuildingLists();
        _scState.selectedBuildingId = null;
        _scRenderBuildingDetail();
        _scUpdateProgressBanner();
        _scRenderResultPlaceholder();
        _scUpdateSubtitle();

        window._scCloseLoadModal();

        // 모집단(RAW) 미로드 시 안내
        if (!_scState.researchMaster.loaded) {
            setTimeout(() => alert(
                '✅ 비교 세션을 불러왔습니다.\n\n' +
                '⚠️ 모집단(RAW 엑셀) 이 아직 업로드되지 않았습니다.\n' +
                '빌딩 리스트를 보려면 RAW 엑셀을 업로드하세요.\n' +
                '(선택·계산 자체는 RAW 없이도 가능합니다)'
            ), 100);
        }
    } catch (err) {
        console.error('[stats-compare] 불러오기 실패:', err);
        alert(`❌ 불러오기 실패: ${err.message}`);
    }
};

/** 세션 삭제 */
window._scDeleteCompare = async function(compareId) {
    let title = compareId;
    try {
        const { db, ref, get } = await import('./portal-firebase.js');
        const snap = await get(ref(db, `statsCompare/${compareId}/title`));
        if (snap.exists()) title = String(snap.val() || compareId);
    } catch (e) { /* lookup 실패 시 id 로 표기 */ }

    if (!confirm(`"${title}" 세션을 삭제하시겠습니까?\n복구할 수 없습니다.`)) return;
    try {
        const fb = await import('./portal-firebase.js');
        const { db, ref } = fb;
        const path = ref(db, `statsCompare/${compareId}`);
        // remove() 가 export 돼있지 않은 환경 대비 폴백: set(null)
        if (typeof fb.remove === 'function') {
            await fb.remove(path);
        } else if (typeof fb.set === 'function') {
            await fb.set(path, null);
        } else {
            throw new Error('remove/set 함수를 찾을 수 없습니다.');
        }
        await _scLogCompareAction('delete', compareId, 0);
        if (_scState.compareId === compareId) {
            _scState.compareId = '';
            _scState.version   = 0;
            _scState.title     = '';
            _scUpdateSubtitle();
        }
        // 목록 새로고침
        window._scOpenLoadList();
    } catch (err) {
        console.error('[stats-compare] 삭제 실패:', err);
        alert(`❌ 삭제 실패: ${err.message}`);
    }
};

/** 헤더 부제 갱신 — 현재 세션 제목 + version 표시 */
function _scUpdateSubtitle() {
    const el = _scQS('sc-subtitle');
    if (!el) return;
    if (_scState.compareId) {
        el.innerHTML = `📁 <strong>${_scState.title || '(제목없음)'}</strong> · v${_scState.version} ${_scState.dirty ? '<span style="color:#fde68a;">* 미저장</span>' : ''}`;
    } else {
        el.textContent = '두 시점의 동일 빌딩 셋 기반 공실률·임대가·보증금·관리비 비교';
    }
}

/** [💾 저장] 버튼 활성/비활성 토글 */
function _scUpdateSaveButton() {
    const btn = _scQS('sc-btn-save');
    if (!btn) return;
    const monthsOK = _scState.pointA.yyyymm && _scState.pointB.yyyymm
                     && _scState.pointA.yyyymm !== _scState.pointB.yyyymm;
    const ok = !!monthsOK;
    btn.disabled = !ok;
    btn.style.cursor       = ok ? 'pointer' : 'not-allowed';
    btn.style.background   = ok ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.12)';
    btn.style.color        = ok ? '#fff' : 'rgba(255,255,255,0.6)';
    btn.style.borderColor  = ok ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.20)';
}

// ═══════════════════════════════════════════════════════════════
// 5I. Step 6 — 엑셀 다운로드 (5시트)
// ═══════════════════════════════════════════════════════════════

/**
 * 결과 카드의 [📥 엑셀] 버튼 핸들러.
 * 시트 구성:
 *   1) 요약       — Hero 카드 4종 + 메타데이터
 *   2) 권역별     — 권역×4지표 비교표
 *   3) 시점A선택  — 선택된 vacancy 행 상세
 *   4) 시점B선택  — 선택된 vacancy 행 상세
 *   5) 공통빌딩  — 공통 빌딩 리스트 + 권역/등급/연면적
 */
window._scExportExcel = function() {
    if (!window.XLSX) {
        alert('SheetJS(XLSX) 가 로드되지 않았습니다.');
        return;
    }
    const { common } = _scGetCommonBuildingIds();
    if (common.length === 0) {
        alert('공통 빌딩이 없습니다.');
        return;
    }

    const aMonth = _scState.pointA.yyyymm;
    const bMonth = _scState.pointB.yyyymm;
    const aggA = _scAggregateByRegion(common, 'A');
    const aggB = _scAggregateByRegion(common, 'B');

    const wb = window.XLSX.utils.book_new();

    // ── 시트 1: 요약 ──
    const T_A = aggA.get('TOTAL'), T_B = aggB.get('TOTAL');
    const meta = [
        ['항목', '값'],
        ['세션 제목', _scState.title || '(제목없음)'],
        ['시점 A', aMonth],
        ['시점 B', bMonth],
        ['공통 빌딩 수', common.length],
        ['생성일시', new Date().toLocaleString('ko-KR')],
        ['생성자', window.state?.currentUser?.email || 'unknown'],
        [],
        ['지표', '시점 A', '시점 B', '증감(B-A)', '단위'],
        ['공실률', (T_A.vacRate || 0).toFixed(2), (T_B.vacRate || 0).toFixed(2),
         ((T_B.vacRate || 0) - (T_A.vacRate || 0)).toFixed(2), '%'],
        ['평균임대료', _scExcelKW(T_A.rentAvg), _scExcelKW(T_B.rentAvg),
         _scExcelDelta(T_B.rentAvg, T_A.rentAvg), '천원/평/月'],
        ['평균보증금', _scExcelKW(T_A.depAvg), _scExcelKW(T_B.depAvg),
         _scExcelDelta(T_B.depAvg, T_A.depAvg), '천원/평'],
        ['평균관리비', _scExcelKW(T_A.mntAvg), _scExcelKW(T_B.mntAvg),
         _scExcelDelta(T_B.mntAvg, T_A.mntAvg), '천원/평/月'],
        [],
        ['※ 산식'],
        ['공실률', '= Σ공실면적(임대평) ÷ Σ연면적 × 100 (가중평균)'],
        ['평균값', '= Σ(빌딩값 × 연면적) ÷ Σ(연면적, 값 있는 빌딩 한정) — 연면적 가중평균'],
        ['vacancy 가격 누락 시', 'floorPricing 동시점 또는 이전 최신값으로 폴백'],
    ];
    const ws1 = window.XLSX.utils.aoa_to_sheet(meta);
    ws1['!cols'] = [{ wch: 18 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
    window.XLSX.utils.book_append_sheet(wb, ws1, '요약');

    // ── 시트 2: 권역별 ──
    const regList = ['TOTAL', ...SR_REGIONS.filter(r =>
        (aggA.get(r)?.bldgCount || 0) + (aggB.get(r)?.bldgCount || 0) > 0)];
    const regHeader = [
        '권역', '빌딩수',
        '공실률A(%)', '공실률B(%)', '공실률Δ(%p)',
        '임대료A', '임대료B', '임대료Δ',
        '보증금A', '보증금B', '보증금Δ',
        '관리비A', '관리비B', '관리비Δ',
    ];
    const regRows = regList.map(r => {
        const a = aggA.get(r) || {}, b = aggB.get(r) || {};
        return [
            r === 'TOTAL' ? '전체' : r,
            a.bldgCount || 0,
            +(a.vacRate || 0).toFixed(2),
            +(b.vacRate || 0).toFixed(2),
            +(((b.vacRate || 0) - (a.vacRate || 0))).toFixed(2),
            _scExcelKW(a.rentAvg), _scExcelKW(b.rentAvg), _scExcelDelta(b.rentAvg, a.rentAvg),
            _scExcelKW(a.depAvg),  _scExcelKW(b.depAvg),  _scExcelDelta(b.depAvg,  a.depAvg),
            _scExcelKW(a.mntAvg),  _scExcelKW(b.mntAvg),  _scExcelDelta(b.mntAvg,  a.mntAvg),
        ];
    });
    const ws2 = window.XLSX.utils.aoa_to_sheet([regHeader, ...regRows]);
    ws2['!cols'] = [{ wch: 10 }, { wch: 8 }, ...Array(12).fill({ wch: 12 })];
    window.XLSX.utils.book_append_sheet(wb, ws2, '권역별 비교');

    // ── 시트 3, 4: 시점 A·B 선택 상세 ──
    ['A', 'B'].forEach(side => {
        const yyyymm = _scState[`point${side}`].yyyymm;
        const header = [
            'buildingId', '빌딩명', '권역', '등급', '규모', '연면적(평)',
            '회사', '층', '임대면적(평)', '전용면적(평)', '입주시기', '입주분류',
            '임대료(원/평)', '보증금(원/평)', '관리비(원/평)',
            '공통셋포함',
        ];
        const rows = [];
        const sels = _scState[`point${side}`].selections;
        sels.forEach((sel, bid) => {
            const b = _scFindNormBuilding(bid);
            if (!b) return;
            // v1.7.5: 0공실 확정 빌딩은 vacancy 0행이지만 한 줄로 기록
            if (sel.noVacancy) {
                rows.push([
                    bid,
                    b.name || b.buildingName || '',
                    b._region || '',
                    b._gradeAuto || '',
                    b._sizeBand || '',
                    _scGrossPy(b),
                    sel.chosenSource || '',
                    '-',
                    0,           // 임대면적
                    0,           // 전용면적
                    '0공실 확정',
                    '0공실',
                    '', '', '',
                    common.includes(String(bid)) ? 'Y' : 'N',
                ]);
                return;
            }
            const vacs = _scVacanciesByMonth(b, yyyymm)
                .filter(v => _scVacancySource(v) === sel.chosenSource)
                .filter(v => sel.selectedVacKeys.has(_scVacancyKey(v)));
            vacs.forEach(v => {
                const px = _scVacPrices(v);
                const mi = _scClassifyMoveIn(v);
                rows.push([
                    bid,
                    b.name || b.buildingName || '',
                    b._region || '',
                    b._gradeAuto || '',
                    b._sizeBand || '',
                    _scGrossPy(b),
                    sel.chosenSource || '',
                    v.floorText || v.floor || '',
                    _scVacAreaPy(v),         // 임대면적 (계산 기준)
                    _scVacExclusivePy(v),    // 전용면적 (참고)
                    mi.raw || '',
                    mi.kind === 'immediate' ? '즉시' : (mi.kind === 'future' ? '예정' : '미기재'),
                    px.rentPy || '',
                    px.depositPy || '',
                    px.maintenancePy || '',
                    common.includes(String(bid)) ? 'Y' : 'N',
                ]);
            });
        });
        const ws = window.XLSX.utils.aoa_to_sheet([header, ...rows]);
        ws['!cols'] = [{ wch: 14 }, { wch: 22 }, { wch: 8 }, { wch: 6 }, { wch: 8 },
                       { wch: 10 }, { wch: 12 }, { wch: 8 }, { wch: 11 }, { wch: 11 },
                       { wch: 14 }, { wch: 8 },
                       { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 8 }];
        window.XLSX.utils.book_append_sheet(wb, ws, `시점${side} 선택`);
    });

    // ── 시트 5: 공통 빌딩 ──
    const cHeader = [
        'buildingId', '빌딩명', '주소', '권역', '세부권역', '등급', '규모', '연면적(평)',
        'A_회사', 'A_공실면적(임대평)', 'A_임대료', 'A_보증금', 'A_관리비',
        'B_회사', 'B_공실면적(임대평)', 'B_임대료', 'B_보증금', 'B_관리비',
    ];
    const cRows = common.map(bid => {
        const b = _scFindNormBuilding(bid);
        if (!b) return null;
        const mA = _scExtractBuildingMetrics('A', bid);
        const mB = _scExtractBuildingMetrics('B', bid);
        const selA = _scState.pointA.selections.get(String(bid));
        const selB = _scState.pointB.selections.get(String(bid));
        return [
            bid,
            b.name || b.buildingName || '',
            b.address || b.roadAddress || '',
            b._region || '',
            _scSubRegion(b),
            b._gradeAuto || '',
            b._sizeBand || '',
            _scGrossPy(b),
            selA?.chosenSource || '',
            mA.vacancyAreaPy || 0,
            _scExcelRaw(mA.rentPy), _scExcelRaw(mA.depositPy), _scExcelRaw(mA.maintenancePy),
            selB?.chosenSource || '',
            mB.vacancyAreaPy || 0,
            _scExcelRaw(mB.rentPy), _scExcelRaw(mB.depositPy), _scExcelRaw(mB.maintenancePy),
        ];
    }).filter(Boolean);
    const ws5 = window.XLSX.utils.aoa_to_sheet([cHeader, ...cRows]);
    ws5['!cols'] = [{ wch: 14 }, { wch: 22 }, { wch: 30 }, { wch: 8 }, { wch: 14 },
                    { wch: 6 }, { wch: 8 }, { wch: 10 },
                    ...Array(10).fill({ wch: 12 })];
    window.XLSX.utils.book_append_sheet(wb, ws5, '공통 빌딩');

    // 파일명: 비교_2025-12_2026-01_20260428.xlsx
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fname = `비교_${aMonth}_${bMonth}_${today}.xlsx`;
    window.XLSX.writeFile(wb, fname);
};

/** 천원 단위 변환 — null/0 = 빈칸 */
function _scExcelKW(v) {
    if (v == null) return '';
    return Math.round(v / 1000);
}
/** 증감 (천원 단위) */
function _scExcelDelta(cur, prev) {
    if (cur == null || prev == null) return '';
    return Math.round((cur - prev) / 1000);
}
/** 원/평 그대로 */
function _scExcelRaw(v) {
    if (v == null) return '';
    return Math.round(v);
}

// ═══════════════════════════════════════════════════════════════
// 5C. Step 2B — 필터 멀티픽커 모달
// ═══════════════════════════════════════════════════════════════

/** 필터 모달 DOM 동적 주입 (1회) */
function _scInjectFilterModal() {
    if (_scQS('sc-fp-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'sc-fp-modal';
    wrap.style.cssText = `
        display:none; position:fixed; top:50%; left:50%;
        transform:translate(-50%,-50%); background:var(--bg-card);
        border-radius:12px; padding:0; width:560px; max-width:92vw;
        z-index:1030; box-shadow:0 24px 60px rgba(0,0,0,0.5);
        max-height:82vh; display:flex; flex-direction:column;
    `;
    wrap.innerHTML = `
        <div id="sc-fp-header" style="padding:14px 20px;
                    background:linear-gradient(135deg,#1a73e8,#0f4c81);
                    color:#fff; display:flex; justify-content:space-between;
                    align-items:center; flex-shrink:0; border-radius:12px 12px 0 0;">
            <div style="font-size:14px; font-weight:700;">🔧 필터 변경 — <span id="sc-fp-side">A</span></div>
            <button onclick="window._scCloseFilterPicker()"
                style="background:rgba(255,255,255,0.2); border:none; color:#fff;
                       font-size:18px; width:30px; height:30px; border-radius:6px;
                       cursor:pointer;">×</button>
        </div>
        <div id="sc-fp-body" style="padding:16px 20px; overflow-y:auto; flex:1;"></div>
        <div style="padding:10px 20px; border-top:1px solid var(--border-color);
                    background:var(--bg-secondary); display:flex;
                    justify-content:space-between; align-items:center;
                    border-radius:0 0 12px 12px; flex-shrink:0;">
            <button onclick="window._scClearFilters()"
                style="padding:6px 14px; background:transparent; border:1px solid var(--border-color);
                       color:var(--text-primary); border-radius:6px; cursor:pointer; font-size:12px;">
                필터 초기화
            </button>
            <div>
                <button onclick="window._scCloseFilterPicker()"
                    style="padding:6px 14px; background:#1a73e8; color:#fff;
                           border:none; border-radius:6px; cursor:pointer; font-size:12px;
                           font-weight:600;">
                    적용 / 닫기
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(wrap);
}

/** 필터 모달 본체 렌더 (v1.7.4: 권역·등급 두 그룹만 — 규모는 등급과 redundant) */
function _scRenderFilterPicker(side) {
    side = _scSide(side);
    const f = _scState[`point${side}`].filters;

    const chipGroup = (label, options, selected, key, colorMap) => `
        <div style="margin-bottom:14px;">
            <div style="font-size:11px; font-weight:700; color:var(--text-muted);
                        margin-bottom:6px; text-transform:uppercase; letter-spacing:0.5px;">
                ${label} <span style="opacity:0.6;">(${selected.length}/${options.length})</span>
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:5px;">
                ${options.map(opt => {
                    const isOn = selected.includes(opt);
                    const c    = colorMap?.[opt];
                    const bg   = isOn ? (c || '#1a73e8') : 'var(--bg-secondary)';
                    const fg   = isOn ? '#fff'           : 'var(--text-primary)';
                    const bd   = isOn ? (c || '#1a73e8') : 'var(--border-color)';
                    return `
                        <span onclick="window._scToggleFilter('${side}','${key}','${String(opt).replace(/'/g, "\\'")}')"
                            style="padding:5px 11px; border:1px solid ${bd};
                                   background:${bg}; color:${fg};
                                   border-radius:14px; font-size:11px; cursor:pointer;
                                   font-weight:${isOn ? '700' : '500'};
                                   transition:all 0.12s;">
                            ${opt}
                        </span>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    const sideEl = _scQS('sc-fp-side');
    if (sideEl) {
        sideEl.textContent = (side === 'A') ? '시점 A (기준)' : '시점 B (비교)';
        sideEl.style.color = (side === 'A') ? '#bae6fd' : '#fed7aa';
    }
    const headerEl = _scQS('sc-fp-header');
    if (headerEl) {
        headerEl.style.background = (side === 'A')
            ? 'linear-gradient(135deg,#0284c7,#0369a1)'
            : 'linear-gradient(135deg,#ea580c,#c2410c)';
    }

    const body = _scQS('sc-fp-body');
    if (body) {
        body.innerHTML = `
            ${chipGroup('권역', SR_REGIONS, f.regions, 'regions', SR_REGION_COLOR)}
            ${chipGroup('등급 (연면적 기반 자동 분류)', SR_GRADES, f.grades, 'grades', SR_GRADE_COLOR)}
            <div style="font-size:10px; color:var(--text-muted); padding:8px 0 0;
                        border-top:1px dashed var(--border-color); line-height:1.6;">
                💡 등급은 연면적으로 자동 결정됩니다:<br>
                &nbsp;&nbsp;Prime ≥ 20,000평 · A ≥ 10,000 · B ≥ 5,000 · C ≥ 3,000 · D ≥ 1,000 · E &lt; 1,000
            </div>
        `;
    }
}

/** 필터 칩 토글 */
window._scToggleFilter = function(side, key, value) {
    side = _scSide(side);
    const arr = _scState[`point${side}`].filters[key];
    if (!arr) return;
    const idx = arr.indexOf(value);
    if (idx >= 0) arr.splice(idx, 1);
    else          arr.push(value);
    _scRenderFilterPicker(side);    // 모달 갱신
    _scRenderFilters(side);         // 메인 헤더 요약 갱신
    _scRenderBuildingLists();       // 빌딩 리스트 갱신
};

/** 현재 시점의 필터 모두 비우기 */
window._scClearFilters = function() {
    const sideEl  = _scQS('sc-fp-side');
    const sideTxt = sideEl?.textContent || '';
    const side    = sideTxt.includes('B') ? 'B' : 'A';
    const f = _scState[`point${side}`].filters;
    f.regions    = [];
    f.grades     = [];
    f.sizeBands  = [];
    f.subRegions = [];
    _scRenderFilterPicker(side);
    _scRenderFilters(side);
    _scRenderBuildingLists();
};

/** 필터 모달 닫기 */
window._scCloseFilterPicker = function() {
    const m = _scQS('sc-fp-modal');
    if (m) m.style.display = 'none';
};

/** 두 시점 month 셀렉트 박스 옵션 채우기 */
function _scPopulateMonthSelects() {
    const months = _scGetAllMonths();
    ['A', 'B'].forEach(side => {
        const sel = _scQS(`sc-month-${side}`);
        if (!sel) return;
        const cur = _scState[`point${side}`].yyyymm;
        sel.innerHTML = `<option value="">-- 월 선택 --</option>` +
            months.map(m => {
                const isSel = (m === cur) ? 'selected' : '';
                return `<option value="${m}" ${isSel}>${m}</option>`;
            }).join('');
    });
}

/**
 * 필터 영역 UI 렌더 — Step 1 에서는 placeholder 만 표시.
 * Step 2 에서 실제 권역/등급/규모 칩 멀티픽커로 교체 예정.
 */
function _scRenderFilters(side) {
    side = _scSide(side);
    const el = _scQS(`sc-filters-${side}`);
    if (!el) return;
    const f = _scState[`point${side}`].filters;
    const summary = [];
    if (f.grades.length)  summary.push(`등급: ${f.grades.join(',')}`);
    if (f.regions.length) summary.push(`권역: ${f.regions.join(',')}`);
    const txt = summary.length ? summary.join(' | ') : '필터: 전체';
    el.innerHTML = `
        <span style="opacity:0.7;">${txt}</span>
        <button onclick="window._scOpenFilterPicker && window._scOpenFilterPicker('${side}')"
            style="padding:2px 8px; border:1px solid var(--border-color); border-radius:10px;
                   background:var(--bg-card); color:var(--text-primary); font-size:11px;
                   cursor:pointer;">
            필터 변경
        </button>
    `;
}

/** 카운트 표시 — Step 2 에서 매칭 빌딩 수로 채워짐 */
function _scUpdateCount(side, n) {
    side = _scSide(side);
    const el = _scQS(`sc-count-${side}`);
    if (el) el.textContent = (n != null) ? `(${n}개 빌딩)` : '';
}

// ═══════════════════════════════════════════════════════════════
// 6. 진입점 / 이벤트 핸들러 (window 노출)
// ═══════════════════════════════════════════════════════════════

/** 모달 열기 — Top 메뉴 nav-item 에서 호출 */
window.openCompareModal = function() {
    _scInjectModal();
    _scPopulateMonthSelects();
    _scRenderFilters('A');
    _scRenderFilters('B');
    _scUpdateCount('A', null);
    _scUpdateCount('B', null);
    // 모집단(RAW) 상태 반영
    _scRenderRawStatus();
    _scLockUnlockPointSection(_scState.researchMaster.loaded);
    _scUpdateProgressBanner();
    _scRenderBuildingLists();
    _scRenderBuildingDetail();          // Step 3
    _scRenderResultPlaceholder();       // Step 4·5
    _scUpdateSubtitle();                // Step 6
    _scUpdateSaveButton();              // Step 6
    const modal = _scQS('sc-modal');
    if (modal) modal.style.display = 'flex';
    console.log('[stats-compare] modal opened');
};

/** 모달 닫기 */
window.closeCompareModal = function() {
    const modal = _scQS('sc-modal');
    if (modal) modal.style.display = 'none';
};

window._scOnMonthChange = function(side, yyyymm) {
    side = _scSide(side);
    const st = _scState[`point${side}`];
    if (st.yyyymm !== yyyymm) {
        // 월이 바뀌면 해당 시점의 모든 빌딩 선택을 비움 (vacancy 키가 무효해짐)
        st.selections.clear();
    }
    st.yyyymm = yyyymm || '';
    _scMarkDirty();
    _scRenderBuildingLists();
    _scRenderBuildingDetail();
    _scUpdateProgressBanner();
    _scRenderResultPlaceholder();
    _scUpdateSaveButton();
    _scUpdateSubtitle();
};

/** 진행 상태 배너 업데이트 */
function _scUpdateProgressBanner() {
    const el = _scQS('sc-progress-banner');
    if (!el) return;
    const a = _scState.pointA.yyyymm;
    const b = _scState.pointB.yyyymm;
    let msg, color;
    if (!a && !b) {
        msg   = '💡 두 시점을 모두 선택하면 빌딩 리스트가 표시됩니다.';
        color = 'var(--text-muted)';
    } else if (!a || !b) {
        msg   = '⏳ 아직 한쪽 시점이 선택되지 않았습니다.';
        color = '#ea580c';
    } else if (a === b) {
        msg   = '⚠️ 두 시점이 같습니다. 비교를 위해 서로 다른 월을 선택하세요.';
        color = '#dc2626';
    } else {
        msg   = `✅ ${a} ↔ ${b} · 좌측에서 빌딩 카드를 클릭해 회사·공실 선택 단계로 이동하세요. <span style="opacity:0.6;">(회사·공실 선택 UI는 Step 3)</span>`;
        color = '#16a34a';
    }
    el.innerHTML = `<span style="color:${color};">${msg}</span>`;
}

/** [계산하기] 버튼 활성화 — Step 4·5 의 _scRenderResultPlaceholder 에 위임 */
function _scUpdateCalcButton() {
    _scRenderResultPlaceholder();
}

/** 필터 멀티픽커 모달 열기 (Step 2B 구현) */
window._scOpenFilterPicker = function(side) {
    side = _scSide(side);
    if (!_scState.researchMaster.loaded) {
        alert('먼저 RAW 엑셀을 업로드하세요.');
        return;
    }
    _scInjectFilterModal();
    _scRenderFilterPicker(side);
    const m = _scQS('sc-fp-modal');
    if (m) m.style.display = 'flex';
};

/** dirty 표시 + 부제·저장버튼 즉시 갱신 (선택 변경 시 사용) */
function _scMarkDirty() {
    _scState.dirty = true;
    _scUpdateSubtitle();
    _scUpdateSaveButton();
}

/** _scOpenLoadList / _scSaveCompare 는 Step 6 (5H 섹션) 에 실구현됨 */

/** _scCalculate 는 Step 5 (5F 섹션)에 실구현됨 */

// ═══════════════════════════════════════════════════════════════
// 7. ESC 키 닫기
// ═══════════════════════════════════════════════════════════════

if (!window._scEscRegistered) {
    window._scEscRegistered = true;
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        // v1.4: 수동 매칭 모달이 떠 있으면 그걸 먼저 닫음
        const mm = document.getElementById('sc-mm-modal');
        if (mm && mm.style.display !== 'none' && mm.style.display !== '') {
            window._scCloseManualMatch();
            return;
        }
        // v1.5: 필터 모달이 떠 있으면 그걸 먼저 닫음
        const fp = document.getElementById('sc-fp-modal');
        if (fp && fp.style.display !== 'none' && fp.style.display !== '') {
            window._scCloseFilterPicker();
            return;
        }
        // v1.7: 불러오기 모달이 떠 있으면 그걸 먼저 닫음
        const ld = document.getElementById('sc-load-modal');
        if (ld && ld.style.display !== 'none' && ld.style.display !== '') {
            window._scCloseLoadModal();
            return;
        }
        const modal = _scQS('sc-modal');
        if (modal && modal.style.display !== 'none' && modal.style.display !== '') {
            // 다른 모달이 위에 떠 있으면 양보 (편집 모달 등)
            const editor = document.getElementById('stats-editor-modal');
            if (editor && editor.style.display !== 'none' && editor.style.display !== '') return;
            const stat = document.getElementById('statResearchModal');
            if (stat && stat.style.display !== 'none' && stat.style.display !== '') return;
            window.closeCompareModal();
        }
    });
}

// ═══════════════════════════════════════════════════════════════
// 8. 로드 완료 로그
// ═══════════════════════════════════════════════════════════════

console.log('[portal-stats-compare] v1.7.12 (저장 안정화 — 키 검증 + 신규ID 폴백) 로드 완료');

// v1.7.1: 분류 기준 검증을 위한 콘솔 진단
//   사용자가 F12 콘솔에서 첫 빌딩의 자동 분류 결과를 즉시 확인 가능
window._scDiagFields = function() {
    const norm = (window.srLib?.srGetNormBuildings?.() || srGetNormBuildings()) || [];
    if (norm.length === 0) {
        console.log('[stats-compare] 빌딩 데이터가 아직 로드되지 않음');
        return;
    }
    console.group('%c[stats-compare] 자동 분류 검증 — 처음 5개 빌딩',
                  'color:#0284c7; font-weight:bold;');
    console.table(norm.slice(0, 5).map(b => ({
        id:           b.id,
        name:         b.name || b.buildingName || '',
        address:      (b.address || '').slice(0, 30),
        '_region(자동)':      b._region,
        '_subCategory(자동)': b._subCategory,
        '_gradeAuto(자동)':   b._gradeAuto,
        '_sizeBand(자동)':    b._sizeBand,
        'grossFloorPy(원본)': b.grossFloorPy,
        '_grossPy헬퍼':       _scGrossPy(b),
    })));
    console.log('%c💡 권역/등급/규모는 모두 portal-stats.js 의 srNormBuilding 이 ' +
                '주소·연면적 기반으로 자동 계산합니다 (Firebase 저장값 의존 X)',
                'color:#16a34a;');
    console.groupEnd();
};
console.log('[stats-compare] 자동분류 검증: 콘솔에 _scDiagFields() 입력');
