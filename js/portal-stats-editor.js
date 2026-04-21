/**
 * portal-stats-editor.js
 * ═══════════════════════════════════════════════════════════════
 * 통계 대상 편집 UI (Phase 1)
 *
 * 목적:
 *   - 사용자가 통계 산출 대상(빌딩/vacancy)을 개별 선택/제외 가능
 *   - Firebase /statsFilter/{quarter} 에 분기별 독립 저장
 *   - Firebase /statsFilterLogs 에 편집 이력 기록 (감사 추적)
 *   - 낙관적 락(version)으로 충돌 감지
 *
 * 데이터 파이프라인:
 *   1차: 전체 빌딩 (현재 admin-research 플래그 미주입 상태라 필터 걷어냄 — Line 372 참조)
 *     ↓
 *   2차: 등급/권역/세부권역 필터
 *     ↓
 *   3차: 공실정보 매칭 토글 (기본 ON)
 *     ↓
 *   4차: 빌딩 단위 체크박스 제외
 *     ↓
 *   5차: vacancy 단위 체크박스 제외
 *     ↓
 *   📊 통계 산출
 *
 * 의존성:
 *   - window.state.allBuildings — 빌딩 전체
 *   - window.state.currentUser — 사용자 정보
 *   - srGetNormBuildings() — 정규화 빌딩 (portal-stats.js)
 *   - srActiveVacancies() — 활성 공실 (portal-stats.js)
 *   - Firebase DB (./portal-firebase.js)
 *
 * Firebase 스키마:
 *   /statsFilter/{quarter}
 *       version           : number (낙관적 락)
 *       updatedAt         : ISO timestamp
 *       updatedBy         : email
 *       filters           : { grades, regions, subRegions, vacOnly }
 *       excludedBuildings : { [buildingId]: { memo, excludedAt, excludedBy } }
 *       excludedVacancies : { [bid__vkey]:  { buildingId, vacancyKey, memo, excludedAt, excludedBy, judgedBy? } }
 *                           ※ Phase 6 Step 3.5: judgedBy: 'auto' | 'manual'
 *                              'auto'  — 자동 판정 엔진이 시드한 결과 (다음 시드 시 덮어써도 OK)
 *                              'manual'— 사용자가 체크박스 토글로 명시 지정 (시드 시 보존)
 *                              필드 없음 — 레거시 데이터. 로드 시 'manual'로 간주(사용자 수동 가정)
 *       verifiedGuides    : { [bid__src__pd]: { verifiedAt, verifiedBy } }  // Phase 4
 *       repCells          : { [bid__yyyymm]: { chosenSource, chosenAt, chosenBy, memo? } }  // Phase 6
 *       repMonths         : { [bid]: { yyyymm, chosenAt, chosenBy, memo? } }  // Phase 6
 *       verifiedBuildings : { [bid]: { verifiedAt, verifiedBy, quarter, memo? } }  // Phase 6 Step 3.5
 *       verifiedRegions   : { [quarter__region]: { verifiedAt, verifiedBy, buildingCount, memo? } }  // Phase 6 Step 3.5
 *   /statsFilterLogs/{autoKey}
 *       quarter, action, targetId, memo, user, ts, prevVersion
 * ═══════════════════════════════════════════════════════════════
 */

import {
    srGetNormBuildings,
    srActiveVacancies,
    srVacancyAreaPy,
    srNormalizeDate,
    srGetQuarter,
} from './portal-stats.js';

// ═══════════════════════════════════════════════════════════════
// 1. 전역 상태
// ═══════════════════════════════════════════════════════════════

/** 현재 편집 중인 분기 및 필터/제외 상태 */
const _seState = {
    quarter:  '',             // "2024Q4" 같은 분기 키
    version:  0,              // 모달 열 때 스냅샷. 저장 시 충돌 감지용
    loaded:   false,          // Firebase 로드 완료?

    // 2차 필터 상태
    filters: {
        grades:     [],        // 비어있으면 전체
        regions:    [],
        subRegions: [],
        vacOnly:    true,      // 3차 토글: 공실정보 매칭 (기본 ON)
    },

    // 4차 선택: 빌딩 단위 제외
    excludedBuildings: new Map(),   // buildingId → { memo, excludedAt, excludedBy }

    // 5차 선택: vacancy 단위 제외
    excludedVacancies: new Map(),   // `${bid}__${vkey}` → { buildingId, vacancyKey, memo, excludedAt, excludedBy }

    // Phase 4 (2026-04): 임대안내문 그룹(회사+발행월) 검증마크
    // key: `${bid}__${source}__${publishDate}` → { verifiedAt, verifiedBy }
    verifiedGuides: new Map(),

    // Phase 6 (2026-04): 월별·회사별 공실률 매트릭스 대표값 선택
    // key: `${buildingId}__${yyyymm}` → { chosenSource, chosenAt, chosenBy, memo? }
    //   chosenSource === null  → "이 월 명시적 제외" (분기 집계에서 해당 월 빼기)
    //   chosenSource === string → 해당 (빌딩, 월) 의 대표 발행사
    repCells: new Map(),

    // Phase 6 (2026-04): 분기 집계에 쓸 "빌딩별 대표 월"
    // key: buildingId → { yyyymm, chosenAt, chosenBy, memo? }
    //   yyyymm === null   → "이 빌딩 전체 제외" (설계문서 § Firebase 스키마 주의: 객체 wrap)
    //   yyyymm === string → repCells 에 존재하는 월 중 사용자가 선택한 대표 월
    // ※ Firebase Realtime DB 특성상 value 로 null 직접 저장 시 키가 삭제되므로
    //   value 를 객체로 감싸고 내부 필드만 null 로 표현. 감사추적 필드도 동시 확보.
    repMonths: new Map(),

    // Phase 6 Step 3.5 (2026-04): 빌딩 검수 완료 마크
    // key: buildingId → { verifiedAt, verifiedBy, quarter, memo? }
    // ※ excludedBuildings 와 별개 레이어 — "검수함" 은 "제외" 를 의미하지 않음.
    //   현업이 해당 빌딩의 공실 행을 모두 확인했다는 체크리스트 용도.
    verifiedBuildings: new Map(),

    // Phase 6 Step 3.5 (2026-04): 권역 검수 완료 마크 (분기 × 권역)
    // key: `${quarter}__${region}` → { verifiedAt, verifiedBy, buildingCount, memo? }
    //   e.g. "2026Q1__CBD"
    //   권역의 모든 대상 빌딩이 verifiedBuildings 에 있을 때 활성되는 "권역 확정" 마크.
    verifiedRegions: new Map(),

    // UI 상태
    selectedBuildingId:  null,       // 좌측에서 선택된 빌딩 (우측 vacancy 리스트 표시 대상)
    selectedSource:      null,       // Phase 4: 우측 회사 탭 선택 (null=첫번째 자동)
    selectedPublishDate: null,       // Phase 4: 우측 발행월 선택 (null=해당 source의 최신 자동)
    searchQuery:         '',

    // Phase 6 Step 3.5 (2026-04): 빌딩 단위 자동 판정 시드 완료 플래그
    // ※ 인메모리 전용 (Firebase 저장 X) — 모달 오픈마다 재시드 가능하도록 각 세션에서 리셋
    //   `_seSeedAutoJudgments(bid, vacs)` 가 이 Set 으로 중복 방지.
    //   modal open / quarter change 시 .clear() 호출해 리셋.
    seededBuildings: new Set(),

    // Phase 3: 미저장 변경 추적
    dirty:              false,      // 마지막 적용 후 변경 있었는지
};

/** 편집 이력 UI 상태 (접기/펴기) */
let _seLogExpanded = false;

// ═══════════════════════════════════════════════════════════════
// 2. 유틸리티
// ═══════════════════════════════════════════════════════════════

/**
 * Firebase 키 제약 회피: :: → __
 *
 * ⚠️ 주의 (Phase 2): Firebase auto-key (vacId) 는 영숫자 + '-' 구성이므로 '__' 포함 위험 없음.
 * 그러나 buildingId 가 향후 수동 부여 형태로 바뀌면 파싱 충돌 가능.
 * 현재는 excludedVacancies 의 value 에 buildingId/vacancyKey 가 명시 저장되므로
 * _seParseVacKey 는 사용하지 않음. (방어용 보관)
 */
function _seMakeVacKey(buildingId, vacancyKey) {
    return `${buildingId}__${vacancyKey}`;
}

/**
 * Phase 4: 임대안내문 그룹 키 — buildingId + source + publishDate 조합.
 * Firebase 키 제약(공백/슬래시/따옴표) 회피용 sanitize 포함.
 */
function _seSanitizeKeyPart(s) {
    return String(s ?? '').replace(/[.#$\[\]\/\s'"`]/g, '_');
}
function _seMakeGuideKey(buildingId, source, publishDate) {
    return `${buildingId}__${_seSanitizeKeyPart(source)}__${_seSanitizeKeyPart(publishDate)}`;
}
/** @deprecated Phase 2 기준 사용처 없음. 필요 시 excludedVacancies 의 value 에서 직접 참조 권장. */
function _seParseVacKey(combinedKey) {
    const idx = combinedKey.indexOf('__');
    if (idx < 0) return { buildingId: combinedKey, vacancyKey: '' };
    return {
        buildingId: combinedKey.slice(0, idx),
        vacancyKey: combinedKey.slice(idx + 2),
    };
}

/** 현재 로그인 사용자 식별자 */
function _seGetCurrentUser() {
    const u = window.state?.currentUser;
    return u?.email || u?.displayName || 'unknown';
}

/** ISO timestamp */
function _seNow() { return new Date().toISOString(); }

/** HTML escape */
function _seEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, m =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

/** 사용 가능한 분기 목록 (현재+최근 8분기) */
function _seGetAvailableQuarters() {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const curQ = Math.ceil(m / 3);

    const out = [];
    for (let i = 0; i < 8; i++) {
        let yy = y, qq = curQ - i;
        while (qq <= 0) { qq += 4; yy--; }
        out.push(`${yy}Q${qq}`);
    }
    return out;
}

/** 메모 없으면 자동 기본값 */
function _seDefaultMemo(user) {
    return `사유 미입력 — ${user}`;
}

// ─ Phase 6 Step 3.5: 분기·층·입주시기 유틸 ─────────────────────

/**
 * 분기 문자열 → 해당 분기의 마지막 월 (YYYY-MM)
 * @param {string} quarter  "2026Q1"
 * @returns {string}        "2026-03"  (파싱 실패 시 '')
 */
function _seGetQuarterLastMonth(quarter) {
    const m = /^(\d{4})Q([1-4])$/.exec(String(quarter || '').trim());
    if (!m) return '';
    const year = m[1];
    const q    = parseInt(m[2], 10);
    const lastMon = q * 3;  // Q1→3, Q2→6, Q3→9, Q4→12
    return `${year}-${String(lastMon).padStart(2, '0')}`;
}

/**
 * 층명이 지하인지 판정
 * - 패턴: "B1F" / "b2" / "지하1층" / "지하" 포함
 * - 일반 숫자층("1F", "B동 1층") 오판 방지: B로 시작하되 뒤가 숫자여야 지하
 * @param {string} floor  층명 원본
 * @returns {boolean}
 */
function _seIsUnderground(floor) {
    if (!floor) return false;
    const s = String(floor).trim();
    if (!s || s === '-') return false;
    // 명시 키워드
    if (s.includes('지하')) return true;
    // 정규식: 대소문자 구분없이 B + 숫자 + 선택적 F (B1F, B2, b1 등)
    if (/^B\d+F?$/i.test(s)) return true;
    // 영문 "basement" 보조
    if (/^basement/i.test(s)) return true;
    return false;
}

/**
 * 입주시기 텍스트 정규화 후 "즉시입주 가능" 여부 판정
 * - "즉시" / "즉시입주" / "바로입주" / "즉시가능" 등 매칭
 * - 공백·기호 제거 후 정확 키워드 체크
 * @param {string} moveInDate  vacancy.moveInDate 원본
 * @returns {boolean}
 */
function _seIsImmediateMoveIn(moveInDate) {
    if (!moveInDate) return false;
    // 공백·하이픈·괄호·특수문자 제거 → 소문자 변환
    const norm = String(moveInDate).replace(/[\s\-()[\]【】·.,/]/g, '').toLowerCase();
    if (!norm) return false;
    // 정확 매칭 (브리프 §4 원칙: "즉시/즉시입주"만 자동 포함, 날짜형은 수동)
    const IMMEDIATE_KEYWORDS = ['즉시', '즉시입주', '즉시가능', '바로입주', '바로가능'];
    return IMMEDIATE_KEYWORDS.some(kw => norm.includes(kw));
}

/**
 * 공실 행 자동 판정 엔진 (Phase 6 Step 3.5)
 *
 * 판정 규칙 (브리프 §4 — 최소주의 원칙):
 *   ⚡ 즉시: moveInDate 가 "즉시/즉시입주" → 포함
 *   🔻 지하: floor 가 B1F/지하 패턴 → 제외
 *   ❓ 검수필요: 그 외 모든 경우 (리테일 자동 판정 보류 — Q1=C안)
 *
 * @param {Object} vacancy
 * @returns {{ shouldInclude: boolean, badge: string, reason: string }}
 */
function _seAutoJudgeVacancy(vacancy) {
    if (!vacancy) {
        return { shouldInclude: false, badge: '❓', reason: '데이터 없음' };
    }
    const floor      = vacancy.floor || vacancy.floors || '';
    const moveInDate = vacancy.moveInDate || '';

    // 1) 지하층 최우선 제외 (층 기준이 가장 강한 신호)
    if (_seIsUnderground(floor)) {
        return {
            shouldInclude: false,
            badge: '🔻',
            reason: `지하층(${floor}) 자동 제외`,
        };
    }

    // 2) 즉시 입주 가능 → 자동 포함
    if (_seIsImmediateMoveIn(moveInDate)) {
        return {
            shouldInclude: true,
            badge: '⚡',
            reason: `입주시기 "${moveInDate}" → 즉시입주 자동 포함`,
        };
    }

    // 3) 그 외 모든 경우 → 검수필요 (기본 제외, 사용자 수동 결정 대기)
    //    리테일은 Q1=C안(자동 판정 보류)에 따라 ❓ 로 흡수.
    //    "26년 3월 입주 가능" 같은 미래 날짜형도 여기 포함 — 사용자가 보고 판단.
    return {
        shouldInclude: false,
        badge: '❓',
        reason: moveInDate
            ? `입주시기 "${moveInDate}" → 검수 필요`
            : '입주시기 미기재 → 검수 필요',
    };
}

/**
 * 빌딩 단위 자동 판정 시드 (Phase 6 Step 3.5)
 *
 * 시드 정책 (설계 대화 확정 — 옵션 B + lazy):
 *   1) 이미 excludedVacancies 에 entry 가 있으면 judgedBy 불문 **건드리지 않음**
 *      (사용자 수동 결정은 물론, 이전 자동 시드 결과도 보존 — idempotent)
 *   2) entry 가 없는 공실만 자동 판정 수행
 *   3) shouldInclude=false 인 경우 excludedVacancies 에 추가 (judgedBy='auto')
 *      shouldInclude=true 인 경우 아무것도 하지 않음 (= 포함 상태 유지)
 *   4) 본 함수는 _seState.seededBuildings 체크로 모달 오픈당 1회만 실행
 *
 * @param {string} bid  buildingId
 * @param {Array}  vacs 해당 빌딩의 활성 공실 배열
 */
function _seSeedAutoJudgments(bid, vacs) {
    if (!bid || !Array.isArray(vacs)) return;
    if (_seState.seededBuildings.has(bid)) return;  // 이미 시드됨

    const user = _seGetCurrentUser();
    const now  = _seNow();
    const lastM = _seGetQuarterLastMonth(_seState.quarter);

    for (const v of vacs) {
        const vkey = v?._key || '';
        if (!vkey) continue;
        const ck = _seMakeVacKey(bid, vkey);

        // 이미 어떤 결정이든 있으면 skip (수동·자동 모두 보존)
        if (_seState.excludedVacancies.has(ck)) continue;

        // 1순위 (Phase 6 Step 3.5 핫픽스): 분기 마지막 월 외 발행호 공실은 먼저 제외
        //  floor/moveInDate 판정과 무관하게, 발행 시점이 분기 마지막 월이 아니면 이번 분기 통계에 포함하지 않음.
        //  배지(⚡/🔻/❓)는 _seAutoJudgeVacancy 가 공실 내재 속성으로 렌더 시점에 계속 표시 (A안 유지).
        //  사용자가 "분기 외 월을 의도적 선택" 시에만 수동 체크로 통계 편입 가능.
        const vNorm = srNormalizeDate(v.publishDate || '');
        if (lastM && vNorm && vNorm !== lastM) {
            _seState.excludedVacancies.set(ck, {
                buildingId: bid,
                vacancyKey: vkey,
                memo:       `📅 자동: 분기 마지막 월(${lastM}) 외 발행 (${vNorm})`,
                excludedAt: now,
                excludedBy: user,
                judgedBy:   'auto',
            });
            continue;
        }

        // 2순위: 분기 마지막 월 내 공실에 대해서만 floor/moveInDate 기준 판정
        const { shouldInclude, badge, reason } = _seAutoJudgeVacancy(v);
        if (shouldInclude) continue;  // 포함 판정은 별도 저장 불필요

        _seState.excludedVacancies.set(ck, {
            buildingId: bid,
            vacancyKey: vkey,
            memo:       `${badge} 자동: ${reason}`,
            excludedAt: now,
            excludedBy: user,
            judgedBy:   'auto',
        });
    }

    _seState.seededBuildings.add(bid);
}

/**
 * yyyymm 이 해당 분기에 속하는가?
 * @param {string} yyyymm  "2026-03"
 * @param {string} quarter "2026Q1"
 * @returns {boolean}
 */
function _seIsInQuarter(yyyymm, quarter) {
    const ym = /^(\d{4})-(\d{2})$/.exec(String(yyyymm || ''));
    if (!ym) return false;
    const qm = /^(\d{4})Q([1-4])$/.exec(String(quarter || ''));
    if (!qm) return false;
    if (ym[1] !== qm[1]) return false;
    const mon = parseInt(ym[2], 10);
    const q   = parseInt(qm[2], 10);
    return Math.ceil(mon / 3) === q;
}

/**
 * 빌딩의 "분기 마지막 월 상태" 뱃지 판정 (Phase 6 Step 3.5 §②)
 *
 * 우선순위 (위에서부터 체크, 첫 매칭 반환):
 *   🟢 green  — 분기 마지막 월에 공실 정보 존재 (vacancy 행 있음)
 *   ⚪ white  — 분기 마지막 월에 _meta.noVacancy=true (공실없음 명시 선언)
 *   🟡 yellow — 분기 마지막 월 OCR 없음, but 분기 내 다른 월에 OCR 있음
 *   🔴 red    — 분기 내 어떤 월에도 OCR 없음
 *
 * @param {Object} building
 * @returns {{ code: 'green'|'white'|'yellow'|'red', label: string, lastMonthVacCount: number, totalVacCount: number }}
 */
function _seGetBuildingBadge(building) {
    const quarter = _seState.quarter;
    const lastM   = _seGetQuarterLastMonth(quarter);
    // "2026-03" → "3월"
    const lastMonLabel = lastM ? `${parseInt(lastM.slice(5, 7), 10)}월` : '';

    const rawVacs = (building && building.vacancies) || [];
    let vacInLastM = 0;
    let vacInAnyMonthInQuarter = 0;
    let noVacancyDeclaredInLastM = false;
    let anyOcrAcrossAllMonths = false;

    for (const v of rawVacs) {
        if (!v) continue;
        const norm = srNormalizeDate(v.publishDate);
        if (!norm) continue;

        const isMeta = v._key && String(v._key).endsWith('_meta');
        const inLastM = norm === lastM;
        const inQuarter = _seIsInQuarter(norm, quarter);

        if (isMeta) {
            // _meta: 공실없음 선언 등 메타 행 — 공실 카운트에는 넣지 않지만
            // OCR 존재 증거로는 인정 (발행사가 그 월에 안내문 발행했다는 뜻)
            if (inLastM && v.noVacancy === true) noVacancyDeclaredInLastM = true;
            if (inQuarter) anyOcrAcrossAllMonths = true;
            continue;
        }
        // 일반 공실 행
        if (v.status === 'deleted' || v.hidden === true || v.deleted === true) continue;
        if (inLastM)   vacInLastM++;
        if (inQuarter) vacInAnyMonthInQuarter++;
        if (inQuarter) anyOcrAcrossAllMonths = true;
    }

    if (vacInLastM > 0) {
        return {
            code: 'green',
            label: `${lastMonLabel} 공실 ${vacInLastM}건`,
            lastMonthVacCount: vacInLastM,
            totalVacCount:     vacInAnyMonthInQuarter,
        };
    }
    if (noVacancyDeclaredInLastM) {
        return {
            code: 'white',
            label: `${lastMonLabel} 공실 없음`,
            lastMonthVacCount: 0,
            totalVacCount:     vacInAnyMonthInQuarter,
        };
    }
    if (anyOcrAcrossAllMonths) {
        return {
            code: 'yellow',
            label: `${lastMonLabel} 정보 없음`,
            lastMonthVacCount: 0,
            totalVacCount:     vacInAnyMonthInQuarter,
        };
    }
    return {
        code: 'red',
        label: '모든 월 정보 없음',
        lastMonthVacCount: 0,
        totalVacCount:     0,
    };
}

// ═══════════════════════════════════════════════════════════════
// 3. Firebase 로드/저장
// ═══════════════════════════════════════════════════════════════

/**
 * 분기 필터 로드 (없으면 빈 상태로 초기화)
 * @returns {Promise<{version: number}>}
 */
async function _seLoadStatsFilter(quarter) {
    const { db, ref, get } = await import('./portal-firebase.js');
    const snap = await get(ref(db, `statsFilter/${quarter}`));
    if (!snap.exists()) {
        // 신규 분기 — 빈 상태
        _seState.filters = { grades: [], regions: [], subRegions: [], vacOnly: true };
        _seState.excludedBuildings.clear();
        _seState.excludedVacancies.clear();
        _seState.verifiedGuides.clear();  // Phase 4
        _seState.repCells.clear();        // Phase 6
        _seState.repMonths.clear();       // Phase 6
        _seState.verifiedBuildings.clear();  // Phase 6 Step 3.5
        _seState.verifiedRegions.clear();    // Phase 6 Step 3.5
        return { version: 0 };
    }
    const data = snap.val() || {};

    _seState.filters = {
        grades:     Array.isArray(data.filters?.grades)     ? data.filters.grades     : [],
        regions:    Array.isArray(data.filters?.regions)    ? data.filters.regions    : [],
        subRegions: Array.isArray(data.filters?.subRegions) ? data.filters.subRegions : [],
        vacOnly:    data.filters?.vacOnly !== false,  // undefined 는 true 로
    };

    _seState.excludedBuildings.clear();
    Object.entries(data.excludedBuildings || {}).forEach(([bid, v]) => {
        _seState.excludedBuildings.set(bid, v || {});
    });

    _seState.excludedVacancies.clear();
    Object.entries(data.excludedVacancies || {}).forEach(([combinedKey, v]) => {
        const val = v || {};
        // Phase 6 Step 3.5: judgedBy 필드 레거시 호환
        // 과거 데이터는 사용자가 직접 지정한 결과 → 'manual' 로 간주 (자동 시드가 덮어쓰지 않음)
        if (!val.judgedBy) val.judgedBy = 'manual';
        _seState.excludedVacancies.set(combinedKey, val);
    });

    // Phase 4: 검증된 임대안내문
    _seState.verifiedGuides.clear();
    Object.entries(data.verifiedGuides || {}).forEach(([guideKey, v]) => {
        _seState.verifiedGuides.set(guideKey, v || {});
    });

    // Phase 6: 매트릭스 대표 셀 (buildingId__yyyymm → { chosenSource, ... })
    _seState.repCells.clear();
    Object.entries(data.repCells || {}).forEach(([key, v]) => {
        _seState.repCells.set(key, v || {});
    });

    // Phase 6: 빌딩별 대표 월 (buildingId → { yyyymm, chosenAt, chosenBy, memo? })
    // ※ 과거 스펙(단순 string|null)으로 저장된 데이터와 호환 처리: string 이면 객체로 승격
    _seState.repMonths.clear();
    Object.entries(data.repMonths || {}).forEach(([bid, v]) => {
        if (v === null || v === undefined) return;  // Firebase 에서 null 은 이미 키가 빠짐
        if (typeof v === 'string') {
            // legacy: "2025-12" 형태 → 객체로 래핑
            _seState.repMonths.set(bid, { yyyymm: v, chosenAt: '', chosenBy: '' });
        } else if (typeof v === 'object') {
            _seState.repMonths.set(bid, v);
        }
    });

    // Phase 6 Step 3.5: 빌딩 검수 완료
    _seState.verifiedBuildings.clear();
    Object.entries(data.verifiedBuildings || {}).forEach(([bid, v]) => {
        _seState.verifiedBuildings.set(bid, v || {});
    });

    // Phase 6 Step 3.5: 권역 검수 완료 (quarter__region)
    _seState.verifiedRegions.clear();
    Object.entries(data.verifiedRegions || {}).forEach(([key, v]) => {
        _seState.verifiedRegions.set(key, v || {});
    });

    return { version: typeof data.version === 'number' ? data.version : 0 };
}

/**
 * 저장 (충돌 감지 포함)
 * @returns {Promise<{ok: boolean, reason?: string, newVersion?: number}>}
 */
async function _seSaveStatsFilter() {
    const { db, ref, get, update, push, set } = await import('./portal-firebase.js');
    const quarter = _seState.quarter;
    if (!quarter) return { ok: false, reason: '분기가 선택되지 않았습니다.' };

    // 1. 최신 version 조회 → 충돌 감지
    const latestSnap = await get(ref(db, `statsFilter/${quarter}/version`));
    const latestVersion = latestSnap.exists() ? (latestSnap.val() || 0) : 0;
    if (latestVersion !== _seState.version) {
        return {
            ok: false,
            reason: `다른 사용자가 먼저 저장했습니다 (현재 v${latestVersion}, 내 스냅샷 v${_seState.version}). 새로고침 후 다시 시도해주세요.`,
        };
    }

    const newVersion = latestVersion + 1;
    const user  = _seGetCurrentUser();
    const now   = _seNow();

    // 2. 저장 페이로드 구성
    const excludedBuildingsObj = {};
    for (const [bid, v] of _seState.excludedBuildings.entries()) {
        excludedBuildingsObj[bid] = v;
    }
    const excludedVacanciesObj = {};
    for (const [ck, v] of _seState.excludedVacancies.entries()) {
        excludedVacanciesObj[ck] = v;
    }
    // Phase 4: 검증된 임대안내문 그룹
    const verifiedGuidesObj = {};
    for (const [gk, v] of _seState.verifiedGuides.entries()) {
        verifiedGuidesObj[gk] = v;
    }

    // Phase 6: 매트릭스 대표 셀
    const repCellsObj = {};
    for (const [k, v] of _seState.repCells.entries()) {
        repCellsObj[k] = v;
    }

    // Phase 6: 빌딩별 대표 월 (value 객체 형태 그대로 저장 — null 값 회피)
    const repMonthsObj = {};
    for (const [bid, v] of _seState.repMonths.entries()) {
        if (v && typeof v === 'object') repMonthsObj[bid] = v;
    }

    // Phase 6 Step 3.5: 빌딩 검수 완료
    const verifiedBuildingsObj = {};
    for (const [bid, v] of _seState.verifiedBuildings.entries()) {
        verifiedBuildingsObj[bid] = v;
    }
    // Phase 6 Step 3.5: 권역 검수 완료 (quarter__region)
    const verifiedRegionsObj = {};
    for (const [k, v] of _seState.verifiedRegions.entries()) {
        verifiedRegionsObj[k] = v;
    }

    const payload = {
        version:           newVersion,
        updatedAt:         now,
        updatedBy:         user,
        filters:           _seState.filters,
        excludedBuildings: excludedBuildingsObj,
        excludedVacancies: excludedVacanciesObj,
        verifiedGuides:    verifiedGuidesObj,       // Phase 4
        repCells:          repCellsObj,             // Phase 6
        repMonths:         repMonthsObj,            // Phase 6
        verifiedBuildings: verifiedBuildingsObj,    // Phase 6 Step 3.5
        verifiedRegions:   verifiedRegionsObj,      // Phase 6 Step 3.5
    };

    // 3. /statsFilter/{quarter} 덮어쓰기
    await set(ref(db, `statsFilter/${quarter}`), payload);

    // 4. /statsFilterLogs 에 이력 추가
    const logEntry = {
        quarter,
        action:      'bulk_apply',
        targetId:    '',
        memo:        `v${_seState.version} → v${newVersion} 적용 (건물 제외 ${_seState.excludedBuildings.size}건, vacancy 제외 ${_seState.excludedVacancies.size}건, 검증 안내문 ${_seState.verifiedGuides.size}건, 매트릭스 셀 ${_seState.repCells.size}건, 대표월 ${_seState.repMonths.size}건, 빌딩검수 ${_seState.verifiedBuildings.size}건, 권역확정 ${_seState.verifiedRegions.size}건)`,
        user,
        ts:          now,
        prevVersion: _seState.version,
        newVersion,
    };
    await push(ref(db, 'statsFilterLogs'), logEntry);

    _seState.version = newVersion;
    return { ok: true, newVersion };
}

/**
 * 최근 편집 이력 로드 (해당 분기 최근 20건)
 */
async function _seLoadRecentLogs(quarter, limit = 20) {
    const { db, ref, get } = await import('./portal-firebase.js');
    const snap = await get(ref(db, 'statsFilterLogs'));
    if (!snap.exists()) return [];
    const all = snap.val() || {};
    const filtered = Object.entries(all)
        .map(([k, v]) => ({ _id: k, ...v }))
        .filter(l => l.quarter === quarter)
        .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))
        .slice(0, limit);
    return filtered;
}

/**
 * Phase 3: 개별 액션 로그 즉시 Firebase push.
 * 실패해도 UI 는 진행 (낙관적). 에러는 콘솔에만.
 *
 * @param {string} action     'add_building' | 'remove_building' | 'add_vacancy' | 'remove_vacancy' | 'filter_change'
 * @param {string} targetId   빌딩 id 또는 "bid__vkey" 또는 filter 키
 * @param {string} targetLabel 빌딩명 또는 "YYYY-MM source floor" 등 사람이 보는 라벨
 * @param {string} memo       사용자 메모 or 기본값
 */
async function _sePushActionLog(action, targetId, targetLabel, memo) {
    try {
        const { db, ref, push } = await import('./portal-firebase.js');
        await push(ref(db, 'statsFilterLogs'), {
            quarter:     _seState.quarter,
            action,
            targetId:    targetId    || '',
            targetLabel: targetLabel || '',
            memo:        memo        || '',
            user:        _seGetCurrentUser(),
            ts:          _seNow(),
            prevVersion: _seState.version,
        });
    } catch (err) {
        console.warn('[StatsEditor] action log push failed:', err, { action, targetId });
    }
}

/**
 * Phase 3: 편집 이력 패널이 열려있다면 재로드 (실시간 반영).
 */
async function _seReloadLogPanelIfOpen() {
    if (!_seLogExpanded) return;
    const body = document.getElementById('se-log-body');
    if (!body) return;
    // 현재 분기 로드
    try {
        const logs = await _seLoadRecentLogs(_seState.quarter, 20);
        if (logs.length === 0) {
            body.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:12px;">편집 이력 없음</div>`;
        } else {
            body.innerHTML = logs.map(l => {
                const act = l.action || '-';
                const label = (typeof _SE_ACTION_LABEL !== 'undefined' && _SE_ACTION_LABEL[act]) || act;
                const color = (typeof _SE_ACTION_COLOR !== 'undefined' && _SE_ACTION_COLOR[act]) || '#64748b';
                const ts = (l.ts || '').slice(0, 16).replace('T', ' ');
                return `
                <div class="se-log-row">
                    <span class="se-log-ts">${_seEsc(ts)}</span>
                    <span class="se-log-user">${_seEsc(l.user || '-')}</span>
                    <span class="se-log-action" style="color:${color};">${_seEsc(label)}</span>
                    <span class="se-log-memo">${_seEsc(l.targetLabel ? `${l.targetLabel} — ` : '')}${_seEsc(l.memo || '')}</span>
                </div>`;
            }).join('');
        }
        body.dataset.loadedQuarter = _seState.quarter;
    } catch (err) {
        console.warn('[StatsEditor] log panel reload failed:', err);
    }
}

/**
 * Phase 3: dirty 플래그 설정 및 beforeunload 핸들러 등록/해제 관리.
 * dirty=true 로 전환 시 beforeunload 리스너 부착, false 로 전환 시 해제.
 */
function _seBeforeUnloadHandler(e) {
    if (!_seState.dirty) return;
    // 크롬 최신 정책: 커스텀 메시지는 표시 안 되지만 네이티브 확인창은 뜸
    e.preventDefault();
    e.returnValue = '저장되지 않은 변경 사항이 있습니다. 정말 나가시겠습니까?';
    return e.returnValue;
}
function _seSetDirty(v) {
    const was = _seState.dirty;
    _seState.dirty = !!v;
    if (was === _seState.dirty) return;  // 변화 없으면 skip

    if (_seState.dirty) {
        window.addEventListener('beforeunload', _seBeforeUnloadHandler);
    } else {
        window.removeEventListener('beforeunload', _seBeforeUnloadHandler);
    }
    // 적용 버튼에 dirty 상태 표시 (시각적 피드백)
    const btn = document.getElementById('se-apply-btn');
    if (btn) {
        if (_seState.dirty) {
            btn.textContent = '✓ 적용 (변경 있음)';
            btn.style.boxShadow = '0 0 0 3px rgba(251, 191, 36, 0.5)';
        } else {
            btn.textContent = '✓ 적용';
            btn.style.boxShadow = '';
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// 4. 파이프라인 — 현재 필터 상태로 빌딩 리스트 계산
// ═══════════════════════════════════════════════════════════════

/**
 * 각 단계별 건수 계산 (화면 상단 표시용)
 * @returns {{raw, afterFilter, afterVacOnly, afterExclude, buildings}}
 */
function _seRunPipeline() {
    const norm = srGetNormBuildings();

    // 1차: 전체 빌딩 허용
    // ⚠️ 2026-04 현재 admin-research 파이프라인이 isResearchTarget / researchMatchStatus
    //    플래그를 데이터에 주입하기 전이라, 엄격 조건을 걸면 RAW=0 으로 막혀버림.
    //    admin-research 가 안정 주입하게 되면 아래 한 줄로 복원:
    //    const raw = norm.filter(b => b.isResearchTarget === true || b.researchMatchStatus);
    const raw = norm;

    // 2차: 등급/권역/세부권역 필터
    const f = _seState.filters;
    const match = (arr, val) => !arr || arr.length === 0 || arr.includes(val);
    const afterFilter = raw.filter(b => {
        if (!match(f.grades,     b._gradeAuto))  return false;
        if (!match(f.regions,    b._region))     return false;
        if (f.subRegions.length > 0 && !f.subRegions.includes(b.subRegion || '')) return false;
        return true;
    });

    // 3차: 분기 마지막 월 OCR 매칭 (Phase 6 Step 3.5 — vacOnly 대체)
    //  vacOnly=ON 시: 🟢(공실) + ⚪(공실없음선언) 만 통과. 🟡/🔴 은 걸러냄.
    //  vacOnly=OFF 시: 전부 통과 (사용자가 🟡/🔴 도 수동 검토).
    const afterLastMonthMatch = f.vacOnly
        ? afterFilter.filter(b => {
            const badge = _seGetBuildingBadge(b);
            return badge.code === 'green' || badge.code === 'white';
        })
        : afterFilter;

    // 4차: 대표 선택 — 분기 마지막 월 repCells 에 chosenSource 가 지정된 빌딩
    //  (자동 시드는 아직 없음. 수동 탭 클릭으로만 카운트. 자동 시드는 사이클 4-C 에서 렌더 시 발동)
    //  현재는 repCells 에 해당 (bid, lastM) 키가 있고 chosenSource 가 비어있지 않으면 카운트.
    const quarter = _seState.quarter;
    const lastM   = _seGetQuarterLastMonth(quarter);
    const afterRepChosen = afterLastMonthMatch.filter(b => {
        if (!lastM) return false;
        const cell = _seState.repCells.get(`${b.id}__${lastM}`);
        return !!(cell && cell.chosenSource);
    });

    // 5차: 유효 공실 건수 — 분기 마지막 월의 대표 소스에 속한 vacancy 중
    //       excludedVacancies 에 없는 것만 카운트
    let validVacancyCount = 0;
    afterRepChosen.forEach(b => {
        const cell = _seState.repCells.get(`${b.id}__${lastM}`);
        const chosenSrc = cell?.chosenSource;
        if (!chosenSrc) return;
        const rawVacs = b.vacancies || [];
        for (const v of rawVacs) {
            if (!v) continue;
            if (v._key && String(v._key).endsWith('_meta')) continue;
            if (v.status === 'deleted' || v.hidden === true || v.deleted === true) continue;
            const src  = v.source || v.sourceCompany || '(미지정)';
            const norm = srNormalizeDate(v.publishDate);
            if (norm !== lastM) continue;
            if (src !== chosenSrc) continue;
            const ck = _seMakeVacKey(b.id, v._key || '');
            if (_seState.excludedVacancies.has(ck)) continue;
            validVacancyCount++;
        }
    });

    // 4차 (기존 호환): 빌딩 단위 제외 — 위 단계들과 별개로 건물 제외 상태 집계
    const afterExclude = afterLastMonthMatch.filter(b => !_seState.excludedBuildings.has(b.id));

    // 검색 필터 (UI 전용 — 건수엔 영향 X, 반환 리스트에만 적용)
    const query = _seState.searchQuery.trim().toLowerCase();
    const displayBuildings = query
        ? afterLastMonthMatch.filter(b => {
            const nm = (b.name || b.buildingName || '').toLowerCase();
            const ad = (b.address || '').toLowerCase();
            return nm.includes(query) || ad.includes(query);
        })
        : afterLastMonthMatch;

    return {
        raw:                raw.length,
        afterFilter:        afterFilter.length,
        afterLastMonthMatch: afterLastMonthMatch.length,   // 🟢⚪ 빌딩 수
        afterRepChosen:     afterRepChosen.length,         // 대표 선택 완료 빌딩 수
        validVacancyCount,                                 // 유효 공실 건수 (5단계)
        afterVacOnly:       afterLastMonthMatch.length,    // 레거시 호환 (기존 코드 참조용)
        afterExclude:       afterExclude.length,           // 레거시 호환
        buildings:          displayBuildings,
    };
}

// ═══════════════════════════════════════════════════════════════
// 5. 모달 오픈/클로즈
// ═══════════════════════════════════════════════════════════════

window.openStatsEditorModal = async function() {
    const modal = document.getElementById('stats-editor-modal');
    if (!modal) return;

    // 기본 분기: 현재 분기
    const now = new Date();
    const curQ = `${now.getFullYear()}Q${Math.ceil((now.getMonth() + 1) / 3)}`;
    _seState.quarter = curQ;
    _seState.loaded  = false;
    _seState.searchQuery = '';
    _seState.selectedBuildingId = null;
    _seState.seededBuildings.clear();  // Phase 6 Step 3.5: 자동 시드 재실행 허용
    _seSetDirty(false);  // Phase 3: 모달 열 때 dirty 리셋

    // 모달 표시
    modal.style.display = 'flex';

    // 분기 셀렉트 초기화
    _seRenderQuarterSelect();

    // Firebase 로드 + 렌더
    await _seReloadAndRender();
};

window.closeStatsEditorModal = function() {
    // Phase 3: 미저장 변경 있으면 경고
    if (_seState.dirty) {
        const ok = confirm('저장되지 않은 변경 사항이 있습니다.\n' +
                           '이대로 닫으면 변경이 메모리에서 사라집니다.\n' +
                           '(편집 이력 로그는 이미 Firebase 에 기록되었습니다.)\n\n' +
                           '정말 닫으시겠습니까?');
        if (!ok) return;
    }
    _seSetDirty(false);  // beforeunload 해제
    const modal = document.getElementById('stats-editor-modal');
    if (modal) modal.style.display = 'none';
};

async function _seReloadAndRender() {
    const ind = document.getElementById('se-loading');
    if (ind) ind.style.display = 'block';
    try {
        const { version } = await _seLoadStatsFilter(_seState.quarter);
        _seState.version = version;
        _seState.loaded  = true;
        _seRenderAll();
    } catch (err) {
        console.error('[StatsEditor] load failed:', err);
        alert(`분기 데이터 로드 실패: ${err.message}`);
    } finally {
        if (ind) ind.style.display = 'none';
    }
}

// ═══════════════════════════════════════════════════════════════
// 6. 렌더링
// ═══════════════════════════════════════════════════════════════

function _seRenderAll() {
    _seRenderHeaderInfo();
    _seRenderFilters();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderVacancyList();
    _seRenderSelectionSummary();
}

function _seRenderQuarterSelect() {
    const sel = document.getElementById('se-quarter');
    if (!sel) return;
    const qs = _seGetAvailableQuarters();
    sel.innerHTML = qs.map(q => `<option value="${q}"${q === _seState.quarter ? ' selected' : ''}>${q}</option>`).join('');
}

function _seRenderHeaderInfo() {
    const ver = document.getElementById('se-version-label');
    if (ver) ver.textContent = `v${_seState.version}`;
    const user = document.getElementById('se-user-label');
    if (user) user.textContent = _seGetCurrentUser();
}

function _seRenderFilters() {
    const f = _seState.filters;
    // 공통 헬퍼 — 등급/권역/세부권역 블록에서 모두 사용되므로 최상단에 선언
    // ※ Phase 6 Step 3.5 에서 권역 진행률 계산에도 쓰이므로 TDZ 회피 위해 여기로 승격
    const match = (arr, val) => !arr || arr.length === 0 || arr.includes(val);

    // 등급 체크박스
    const GRADES = ['Prime', 'A', 'B', 'C', 'D', 'E'];
    const gradeWrap = document.getElementById('se-filter-grades');
    if (gradeWrap) {
        gradeWrap.innerHTML = GRADES.map(g => `
            <label class="se-chip${f.grades.includes(g) ? ' se-chip-on' : ''}">
                <input type="checkbox" ${f.grades.includes(g) ? 'checked' : ''}
                    onchange="_seToggleFilter('grades', '${g}', this.checked)">
                ${g}
            </label>
        `).join('');
    }

    // 권역 체크박스 (Phase 6 Step 3.5: 진행률 배지 + 확정 상태/버튼)
    const REGIONS = ['CBD', 'GBD', 'YBD', 'BBD', 'Others'];
    const regWrap = document.getElementById('se-filter-regions');
    if (regWrap) {
        // 각 권역별 검수 진행률 계산 (Q2=A안 분모 규칙)
        //   🟢⚪ 빌딩: 무조건 분모, 검수 토글 시 분자
        //   🟡🔴 빌딩: 검수 토글된 것만 분모·분자 모두 포함
        const raw2 = srGetNormBuildings();
        const afterGrade = raw2.filter(b => match(f.grades, b._gradeAuto));
        const progressByRegion = {};
        REGIONS.forEach(r => progressByRegion[r] = { denom: 0, num: 0, total: 0 });
        afterGrade.forEach(b => {
            const r = b._region;
            if (!(r in progressByRegion)) return;
            progressByRegion[r].total++;
            const bb = _seGetBuildingBadge(b);
            const isGreenOrWhite = bb.code === 'green' || bb.code === 'white';
            const isVerified = _seState.verifiedBuildings.has(b.id);
            if (isGreenOrWhite) {
                progressByRegion[r].denom++;
                if (isVerified) progressByRegion[r].num++;
            } else if (isVerified) {
                progressByRegion[r].denom++;
                progressByRegion[r].num++;
            }
        });

        regWrap.innerHTML = REGIONS.map(r => {
            const p = progressByRegion[r];
            const isSelected = f.regions.includes(r);
            const verifiedKey = `${_seState.quarter}__${r}`;
            const isConfirmed = _seState.verifiedRegions.has(verifiedKey);
            const confirmedInfo = isConfirmed ? _seState.verifiedRegions.get(verifiedKey) : null;
            const isFull = p.denom > 0 && p.num === p.denom;

            const progressHtml = p.total > 0
                ? `<span class="se-region-progress${isFull ? ' se-region-progress-full' : ''}">${p.num}/${p.denom}</span>`
                : '';

            let trailingHtml = '';
            if (isConfirmed) {
                trailingHtml = `<span class="se-region-confirmed-badge"
                    title="${_seEsc((confirmedInfo?.verifiedAt || '').slice(0,10))} · ${_seEsc(confirmedInfo?.verifiedBy || '')}"
                    onclick="_seConfirmVerifyRegion('${r}')" role="button">
                    ✅ 확정
                </span>`;
            } else if (isFull) {
                trailingHtml = `<button class="se-region-confirm-btn"
                    onclick="_seConfirmVerifyRegion('${r}')"
                    title="${r} 권역 검수 확정">
                    🎯 ${r} 확정
                </button>`;
            }

            return `<div class="se-region-group">
                <label class="se-chip${isSelected ? ' se-chip-on' : ''}${isConfirmed ? ' se-chip-confirmed' : ''}">
                    <input type="checkbox" ${isSelected ? 'checked' : ''}
                        onchange="_seToggleFilter('regions', '${r}', this.checked)">
                    ${r}
                    ${progressHtml}
                </label>
                ${trailingHtml}
            </div>`;
        }).join('');
    }

    // 세부권역: 현재 2차 필터 통과 빌딩에서 동적 추출
    // 1차 RAW 필터는 _seRunPipeline 과 동일 — 현재는 전체 허용
    const raw = srGetNormBuildings();
    const candidatePool = raw.filter(b =>
        match(f.grades, b._gradeAuto) && match(f.regions, b._region));
    const subRegionSet = new Set();
    candidatePool.forEach(b => { if (b.subRegion) subRegionSet.add(b.subRegion); });
    const subRegions = [...subRegionSet].sort();
    const subWrap = document.getElementById('se-filter-subregions');
    if (subWrap) {
        if (subRegions.length === 0) {
            subWrap.innerHTML = `<span style="color:var(--text-muted); font-size:11px;">세부권역 정보 없음</span>`;
        } else {
            subWrap.innerHTML = subRegions.map(sr => `
                <label class="se-chip${f.subRegions.includes(sr) ? ' se-chip-on' : ''}">
                    <input type="checkbox" ${f.subRegions.includes(sr) ? 'checked' : ''}
                        onchange="_seToggleFilter('subRegions', '${_seEsc(sr)}', this.checked)">
                    ${_seEsc(sr)}
                </label>
            `).join('');
        }
    }

    // vacOnly 토글
    const vacCb = document.getElementById('se-vac-only');
    if (vacCb) vacCb.checked = !!f.vacOnly;
}

function _seRenderPipelineSummary() {
    const pipeline = _seRunPipeline();
    const el = document.getElementById('se-pipeline-summary');
    if (!el) return;
    const lastM = _seGetQuarterLastMonth(_seState.quarter);
    const lastMonLabel = lastM ? `${parseInt(lastM.slice(5, 7), 10)}월` : '';
    el.innerHTML = `
        <div class="se-pipe-step">RAW: <b>${pipeline.raw}</b></div>
        <span class="se-pipe-arrow">→</span>
        <div class="se-pipe-step">2차 필터: <b>${pipeline.afterFilter}</b></div>
        <span class="se-pipe-arrow">→</span>
        <div class="se-pipe-step">${lastMonLabel} 매칭: <b>${pipeline.afterLastMonthMatch}</b></div>
        <span class="se-pipe-arrow">→</span>
        <div class="se-pipe-step">대표 선택: <b>${pipeline.afterRepChosen}</b></div>
        <span class="se-pipe-arrow">→</span>
        <div class="se-pipe-step se-pipe-final">유효 공실: <b>${pipeline.validVacancyCount}</b>건</div>
    `;
}

function _seRenderBuildingList() {
    const el = document.getElementById('se-building-list');
    if (!el) return;

    const pipeline = _seRunPipeline();
    const buildings = pipeline.buildings;

    if (buildings.length === 0) {
        el.innerHTML = `<div style="padding:40px 20px; text-align:center; color:var(--text-muted); font-size:13px;">
            필터 조건에 맞는 빌딩이 없습니다.
        </div>`;
        return;
    }

    // 등급 순 정렬 (Prime → A → ... → E), 같은 등급 내에서 이름순
    const GRADE_ORDER = { 'Prime':0, 'A':1, 'B':2, 'C':3, 'D':4, 'E':5 };
    const sorted = [...buildings].sort((a, b) => {
        const ga = GRADE_ORDER[a._gradeAuto] ?? 99;
        const gb = GRADE_ORDER[b._gradeAuto] ?? 99;
        if (ga !== gb) return ga - gb;
        const an = a.name || a.buildingName || '';
        const bn = b.name || b.buildingName || '';
        return an.localeCompare(bn, 'ko');
    });

    el.innerHTML = sorted.map(b => {
        const isExcluded = _seState.excludedBuildings.has(b.id);
        const isSelected = _seState.selectedBuildingId === b.id;
        const memo = isExcluded ? _seState.excludedBuildings.get(b.id).memo || '' : '';

        // Phase 6 Step 3.5: 빌딩 상태 뱃지 + 분기 내/전체 공실 카운터
        const bb = _seGetBuildingBadge(b);
        const totalVacCount = (b._activeVacs || []).length;

        // Phase 6 Step 3.5: 빌딩 검수 완료 상태
        const isVerifiedBldg = _seState.verifiedBuildings.has(b.id);
        const verBldgInfo = isVerifiedBldg ? _seState.verifiedBuildings.get(b.id) : null;

        return `<div class="se-bldg-row${isSelected ? ' se-bldg-selected' : ''}${isExcluded ? ' se-bldg-excluded' : ''}${isVerifiedBldg ? ' se-bldg-verified' : ''}"
                     onclick="_seSelectBuilding('${_seEsc(b.id)}')">
            <input type="checkbox" class="se-bldg-cb"
                ${!isExcluded ? 'checked' : ''}
                onclick="event.stopPropagation()"
                onchange="_seToggleBuilding('${_seEsc(b.id)}', this.checked)">
            <div class="se-bldg-info">
                <div class="se-bldg-name">${_seEsc(b.name || b.buildingName || '(이름 없음)')}</div>
                <div class="se-bldg-meta">
                    <span class="se-badge se-badge-grade">${_seEsc(b._gradeAuto || '-')}</span>
                    <span class="se-badge se-badge-region">${_seEsc(b._region || '-')}</span>
                    <span class="se-badge se-badge-status se-badge-status-${bb.code}" title="${_seEsc(bb.label)}">
                        ${_seEsc(bb.label)}
                    </span>
                </div>
                <div class="se-bldg-vac-count">
                    <b>${bb.lastMonthVacCount}</b>건 <span style="color:var(--text-muted);">/ 전체 ${totalVacCount}건</span>
                </div>
                ${memo ? `<div class="se-memo">📝 ${_seEsc(memo)}</div>` : ''}
            </div>
            <button class="se-verify-toggle${isVerifiedBldg ? ' se-verify-toggle-on' : ''}"
                    onclick="event.stopPropagation(); _seToggleVerifyBuilding('${_seEsc(b.id)}')"
                    title="${isVerifiedBldg
                        ? `검수 해제 — ${_seEsc((verBldgInfo?.verifiedAt || '').slice(0,10))} · ${_seEsc(verBldgInfo?.verifiedBy || '')}`
                        : '이 빌딩의 공실 행을 모두 확인했음을 표시'}">
                ${isVerifiedBldg ? '✓' : '○'}
            </button>
        </div>`;
    }).join('');
}

/**
 * Phase 4: 선택된 빌딩의 vacancy 를 (source, publishDate) 로 그룹핑하여 정리된 구조 반환.
 * @returns {{
 *   sourceStats: Array<{source:string, count:number, pdCount:number}>,  // 회사별 탭용
 *   pdsBySource: Map<string, string[]>,  // source → 발행월 내림차순 목록
 *   groups: Map<string, Array<vacancy>>, // `${source}__${pd}` → vacancy 목록
 * }}
 */
function _seBuildGuideIndex(building) {
    const vacs = srActiveVacancies(building);
    const bySrcPd  = new Map();   // "src__pd" → vacancy[]
    const pdsBySrc = new Map();   // src → Set<pd>
    const srcCount = new Map();   // src → count

    vacs.forEach(v => {
        const src = v.source || v.sourceCompany || '(미지정)';
        const pd  = v.publishDate || '(미기재)';
        const gk  = `${src}__${pd}`;
        if (!bySrcPd.has(gk))    bySrcPd.set(gk, []);
        bySrcPd.get(gk).push(v);
        if (!pdsBySrc.has(src))  pdsBySrc.set(src, new Set());
        pdsBySrc.get(src).add(pd);
        srcCount.set(src, (srcCount.get(src) || 0) + 1);
    });

    // 정렬: source 는 vacancy 많은 순, 발행월은 최신 내림차순
    const sourceStats = [...srcCount.entries()]
        .map(([source, count]) => ({
            source,
            count,
            pdCount: pdsBySrc.get(source)?.size || 0,
        }))
        .sort((a, b) => b.count - a.count);

    const pdsBySource = new Map();
    for (const [src, pdSet] of pdsBySrc.entries()) {
        const sorted = [...pdSet].sort((a, b) => {
            const da = srNormalizeDate(a === '(미기재)' ? '' : a);
            const db = srNormalizeDate(b === '(미기재)' ? '' : b);
            return (db || '').localeCompare(da || '');
        });
        pdsBySource.set(src, sorted);
    }

    return { sourceStats, pdsBySource, groups: bySrcPd };
}

/**
 * Phase 4: 그룹(source+publishDate)의 체크 상태 계산.
 * @returns {'all'|'partial'|'none'}
 */
function _seGroupCheckState(bid, vacs) {
    let inc = 0, exc = 0;
    vacs.forEach(v => {
        const ck = _seMakeVacKey(bid, v._key || '');
        if (_seState.excludedVacancies.has(ck)) exc++;
        else inc++;
    });
    if (exc === 0)               return 'all';
    if (inc === 0)               return 'none';
    return 'partial';
}

/** 숫자 천단위 포맷 (문자열/숫자 모두 허용) */
function _seFmtNum(v) {
    const n = parseFloat(String(v ?? '').replace(/,/g, ''));
    if (!Number.isFinite(n) || n === 0) return '-';
    return n.toLocaleString('ko-KR');
}

function _seRenderVacancyList() {
    const el = document.getElementById('se-vacancy-list');
    if (!el) return;

    const bid = _seState.selectedBuildingId;
    if (!bid) {
        el.innerHTML = `<div class="se-empty">
            좌측에서 빌딩을 선택하면<br>해당 빌딩의 임대안내문이 표시됩니다.
        </div>`;
        return;
    }

    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    if (!b) {
        el.innerHTML = `<div class="se-empty" style="color:var(--danger);">빌딩을 찾을 수 없습니다.</div>`;
        return;
    }

    // Phase 6 Step 3.5: 빌딩 진입 시 lazy 자동 판정 시드 (idempotent)
    //   이미 시드된 빌딩은 재실행 안 됨. 사용자 수동 결정도 보존.
    const activeVacs = srActiveVacancies(b);
    _seSeedAutoJudgments(bid, activeVacs);

    const idx = _seBuildGuideIndex(b);
    if (idx.sourceStats.length === 0) {
        el.innerHTML = `<div class="se-empty">이 빌딩의 활성 임대안내문이 없습니다.</div>`;
        return;
    }

    // Phase 6 Step 3.5: 분기 마지막 월 + 대표 회사 자동 시드
    const quarter = _seState.quarter;
    const lastM   = _seGetQuarterLastMonth(quarter);
    if (lastM) {
        const repKey = `${bid}__${lastM}`;
        const existingRep = _seState.repCells.get(repKey);
        if (!existingRep || !existingRep.chosenSource) {
            // 분기 마지막 월에 실제 발행이 있는 회사 중 최다 → 자동 시드
            // (sourceStats 는 이미 vacancy 많은 순으로 정렬되어 있음)
            const topSrc = idx.sourceStats.find(s => {
                const pdsOfSrc = idx.pdsBySource.get(s.source) || [];
                return pdsOfSrc.some(pd => srNormalizeDate(pd) === lastM);
            });
            if (topSrc) {
                _seState.repCells.set(repKey, {
                    chosenSource: topSrc.source,
                    chosenAt:     _seNow(),
                    chosenBy:     _seGetCurrentUser(),
                    memo:         '자동 시드 (최다 발행 회사)',
                });
                // ※ dirty 표시 안 함 — 자동 시드는 묵시적 상태이며 사용자가 실제 변경 시 저장됨
            }
        }
    }

    // 현재 대표 회사 (⭐ 표시용, 분기 마지막 월 기준)
    const repChosenSource = lastM
        ? (_seState.repCells.get(`${bid}__${lastM}`)?.chosenSource || null)
        : null;

    // selectedSource 기본값: 첫 번째 (vacancy 가장 많은 회사)
    let curSrc = _seState.selectedSource;
    if (!curSrc || !idx.sourceStats.find(s => s.source === curSrc)) {
        curSrc = idx.sourceStats[0].source;
        _seState.selectedSource = curSrc;
    }
    const pds = idx.pdsBySource.get(curSrc) || [];

    // Phase 6 Step 3.5: selectedPublishDate 기본값 = 분기 마지막 월
    //   해당 회사에 분기 마지막 월 발행호가 있으면 그걸 기본, 없으면 기존처럼 최신.
    let curPd = _seState.selectedPublishDate;
    if (!curPd || !pds.includes(curPd)) {
        const pdForLastM = pds.find(pd => srNormalizeDate(pd) === lastM);
        curPd = pdForLastM || pds[0] || null;
        _seState.selectedPublishDate = curPd;
    }

    const curPdNorm = srNormalizeDate(curPd || '');
    const curPdOutOfQuarter = curPdNorm && !_seIsInQuarter(curPdNorm, quarter);

    const bldgName  = _seEsc(b.name || b.buildingName || '');
    const totalVacs = idx.sourceStats.reduce((s, x) => s + x.count, 0);

    // ── 1. 헤더 (빌딩명 + 총 건수) ────────────────────
    const headerHtml = `
        <div class="se-bldg-title">
            <span>🏢 ${bldgName}</span>
            <span style="font-size:11px; font-weight:400; color:var(--text-muted);">
                총 임대안내문 ${totalVacs}건 · 회사 ${idx.sourceStats.length}곳
            </span>
        </div>`;

    // ── 2. 회사별 탭 (Phase 6 Step 3.5: 대표 회사에 ⭐) ─
    const tabsHtml = `
        <div class="se-src-tabs">
            ${idx.sourceStats.map(s => {
                const isRep = s.source === repChosenSource;
                return `<button class="se-src-tab${s.source === curSrc ? ' se-src-tab-on' : ''}${isRep ? ' se-src-tab-rep' : ''}"
                        onclick="_seSelectSource('${_seEsc(s.source)}')"
                        title="${isRep ? '분기 마지막 월 대표 회사 (클릭 시 재지정)' : '클릭 시 이 회사를 분기 대표로 지정'}">
                    ${isRep ? '⭐ ' : ''}${_seEsc(s.source)}
                    <span class="se-src-tab-count">${s.count}</span>
                </button>`;
            }).join('')}
        </div>`;

    // ── 3. 발행월 셀렉트 (Phase 6 Step 3.5: [분기 외] 배지) ──
    const pdSelectHtml = `
        <div class="se-pd-wrap">
            <span>📅 발행월</span>
            <select class="se-pd-select" onchange="_seSelectPublishDate(this.value)">
                ${pds.map(pd => {
                    const norm = srNormalizeDate(pd);
                    const outOfQ = norm && !_seIsInQuarter(norm, quarter);
                    const label = outOfQ ? `${pd} [분기 외]` : pd;
                    return `<option value="${_seEsc(pd)}"${pd === curPd ? ' selected' : ''}>
                        ${_seEsc(label)}
                    </option>`;
                }).join('')}
            </select>
            ${curPdOutOfQuarter
                ? `<span style="color:#c2410c; font-size:11px; font-weight:600;">⚠️ 분기 외 발행호 — 의도적 선택 시에만 통계 반영</span>`
                : `<span style="color:var(--text-muted); font-size:11px;">— ${_seEsc(curSrc)} 의 발행호 ${pds.length}건</span>`
            }
        </div>`;

    // ── 4. 현재 (source, pd) 그룹 카드 ────────────────
    const groupKey = `${curSrc}__${curPd}`;
    const groupVacs = idx.groups.get(groupKey) || [];
    const guideFbKey = _seMakeGuideKey(bid, curSrc, curPd);
    const isVerified = _seState.verifiedGuides.has(guideFbKey);
    const verInfo    = isVerified ? _seState.verifiedGuides.get(guideFbKey) : null;

    // 층 번호 기준 정렬 (숫자 추출 후 오름차순)
    const sortedVacs = [...groupVacs].sort((a, b) => {
        const na = parseInt(String(a.floor || a.floors || '').replace(/[^0-9-]/g, ''), 10) || 0;
        const nb = parseInt(String(b.floor || b.floors || '').replace(/[^0-9-]/g, ''), 10) || 0;
        return na - nb;
    });

    // 헤더 체크박스 3상태
    const groupState = _seGroupCheckState(bid, sortedVacs);

    const groupCardHtml = `
        <div class="se-guide-card${isVerified ? ' se-guide-verified' : ''}">
            <div class="se-guide-header">
                <input type="checkbox" class="se-group-cb"
                    ${groupState === 'all' ? 'checked' : ''}
                    ${groupState === 'partial' ? 'data-indeterminate="true"' : ''}
                    onchange="_seToggleGroupExclude('${_seEsc(bid)}', '${_seEsc(curSrc)}', '${_seEsc(curPd)}', this.checked)"
                    title="그룹 전체 체크/해제">
                <div class="se-guide-title">
                    <span>${_seEsc(curSrc)} · ${_seEsc(curPd)}</span>
                    <span style="font-size:11px; font-weight:400; color:var(--text-muted);">
                        공실 ${sortedVacs.length}건
                    </span>
                    ${isVerified ? `
                        <span class="se-guide-verify-badge" title="${_seEsc((verInfo?.verifiedAt || '').slice(0,10))} · ${_seEsc(verInfo?.verifiedBy || '')}">
                            ✓ 검증됨
                        </span>
                    ` : ''}
                </div>
                <div class="se-guide-actions">
                    <button class="se-guide-btn se-guide-btn-orig"
                            onclick="_seOpenGuidePreview('${_seEsc(bid)}', '${_seEsc(curSrc)}', '${_seEsc(curPd)}')"
                            title="OCR 추출 원본 이미지 (PDF→이미지)를 보며 검증">
                        🖼 원본보기
                    </button>
                    <button class="se-guide-btn se-guide-btn-verify${isVerified ? ' se-verified' : ''}"
                            onclick="_seToggleVerifyGuide('${_seEsc(bid)}', '${_seEsc(curSrc)}', '${_seEsc(curPd)}')"
                            title="원본과 대조 후 검증 완료 표시">
                        ${isVerified ? '✓ 검증됨' : '✓ 검증마크'}
                    </button>
                </div>
            </div>
            <table class="se-guide-table">
                <thead>
                    <tr>
                        <th style="width:32px;"></th>
                        <th style="width:42px;">판정</th>
                        <th>층</th>
                        <th>임대면적</th>
                        <th>전용면적</th>
                        <th>보증금/평</th>
                        <th>임대료/평</th>
                        <th>관리비/평</th>
                        <th>입주</th>
                    </tr>
                </thead>
                <tbody>
                    ${sortedVacs.map(v => {
                        const vkey = v._key || '';
                        const ck   = _seMakeVacKey(bid, vkey);
                        const excEntry = _seState.excludedVacancies.get(ck);
                        const exc = !!excEntry;
                        const floor = v.floor || v.floors || '-';
                        const rA = v.rentArea || v.rentAreaPy || '';
                        const eA = v.exclusiveArea || v.exclusiveAreaPy || '';

                        // Phase 6 Step 3.5: 자동 판정 배지 (실시간 재판정)
                        //  judgment 는 vacancy 데이터 자체에 기반 (사용자 오버라이드와 무관)
                        //  체크박스 상태는 excludedVacancies 기준이므로 배지/체크 불일치 가능 → 정상
                        const judgment = _seAutoJudgeVacancy(v);
                        const manualOverride = excEntry && excEntry.judgedBy === 'manual';
                        // 배지 툴팁: 자동 판정 근거 + (있으면) 사용자 수동 오버라이드 표시
                        const badgeTitle = manualOverride
                            ? `자동 판정: ${judgment.reason}\n현재 상태: 사용자 수동 지정`
                            : judgment.reason;
                        // 배지 색상 클래스: 배지 문자로 분기
                        const badgeCls = judgment.badge === '⚡' ? 'se-auto-badge-immediate'
                                       : judgment.badge === '🔻' ? 'se-auto-badge-underground'
                                       : 'se-auto-badge-review';

                        return `<tr class="${exc ? 'se-vac-row-excluded' : ''}">
                            <td>
                                <input type="checkbox" class="se-vac-cell-cb"
                                    ${!exc ? 'checked' : ''}
                                    onchange="_seToggleVacancy('${_seEsc(bid)}', '${_seEsc(vkey)}', this.checked)">
                            </td>
                            <td>
                                <span class="se-auto-badge ${badgeCls}${manualOverride ? ' se-auto-badge-manual' : ''}"
                                      title="${_seEsc(badgeTitle)}">
                                    ${judgment.badge}${manualOverride ? '✋' : ''}
                                </span>
                            </td>
                            <td>${_seEsc(floor)}${String(floor).match(/^\d+$/) ? 'F' : ''}</td>
                            <td>${_seFmtNum(rA)}${rA ? '평' : ''}</td>
                            <td>${_seFmtNum(eA)}${eA ? '평' : ''}</td>
                            <td>${_seFmtNum(v.depositPy)}</td>
                            <td>${_seFmtNum(v.rentPy)}</td>
                            <td>${_seFmtNum(v.maintenancePy)}</td>
                            <td>${_seEsc(v.moveInDate || '-')}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;

    el.innerHTML = headerHtml + tabsHtml + pdSelectHtml + groupCardHtml;

    // HTML attribute로는 indeterminate 직접 설정 불가 — DOM property로 후처리
    const grpCb = el.querySelector('.se-group-cb[data-indeterminate="true"]');
    if (grpCb) grpCb.indeterminate = true;
}

function _seRenderSelectionSummary() {
    const el = document.getElementById('se-selection-summary');
    if (!el) return;
    const nb = _seState.excludedBuildings.size;
    const nv = _seState.excludedVacancies.size;
    el.innerHTML = `
        제외된 빌딩: <b style="color:var(--danger);">${nb}</b>건 ·
        제외된 임대안내문: <b style="color:var(--danger);">${nv}</b>건
    `;
}

// ═══════════════════════════════════════════════════════════════
// 7. 사용자 인터랙션 핸들러 (window 노출)
// ═══════════════════════════════════════════════════════════════

window._seOnQuarterChange = async function() {
    const sel = document.getElementById('se-quarter');
    if (!sel) return;

    // Phase 3: 미저장 변경 있으면 경고
    if (_seState.dirty) {
        const ok = confirm(`저장되지 않은 변경 사항이 있습니다 (${_seState.quarter}).\n` +
                           `다른 분기로 전환하면 변경이 사라집니다.\n\n계속하시겠습니까?`);
        if (!ok) {
            // 셀렉트 원복
            sel.value = _seState.quarter;
            return;
        }
    }

    _seState.quarter = sel.value;
    _seState.selectedBuildingId = null;
    _seState.seededBuildings.clear();  // Phase 6 Step 3.5: 분기 바뀌면 재시드
    _seSetDirty(false);  // 새 분기 로드하므로 dirty 리셋
    await _seReloadAndRender();
};

window._seToggleFilter = function(type, value, checked) {
    const arr = _seState.filters[type];
    if (!Array.isArray(arr)) return;
    const idx = arr.indexOf(value);
    if (checked && idx < 0) arr.push(value);
    else if (!checked && idx >= 0) arr.splice(idx, 1);
    // Phase 3: 필터 변경 로그 + dirty
    _sePushActionLog('filter_change', `${type}:${value}`, value,
        `${type} ${checked ? '추가' : '제거'}: ${value}`);
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    // 상위 필터가 바뀌면 세부권역 재계산 필요
    _seRenderFilters();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderVacancyList();  // 선택 빌딩이 필터에서 빠지면 리스트 갱신
};

window._seToggleVacOnly = function(checked) {
    _seState.filters.vacOnly = !!checked;
    // Phase 3
    _sePushActionLog('filter_change', 'vacOnly', 'vacOnly',
        `공실정보 필터 ${checked ? 'ON' : 'OFF'}`);
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderVacancyList();
};

window._seOnSearch = function(val) {
    _seState.searchQuery = val || '';
    _seRenderBuildingList();
};

window._seSelectBuilding = function(bid) {
    _seState.selectedBuildingId = bid;
    // Phase 4: 빌딩 바뀔 때 탭/발행월 선택 리셋 — 첫번째 자동 선택되도록
    _seState.selectedSource      = null;
    _seState.selectedPublishDate = null;
    _seRenderBuildingList();
    _seRenderVacancyList();
};

// ─ Phase 4: 임대안내문 그룹 핸들러 ──────────────────────────

/** 회사 탭 전환 (Phase 6 Step 3.5: 클릭 = 대표 회사 지정)
 *
 *  A안 — 현재 보고 있는 발행월(selectedPublishDate)의 yyyymm 에 해당하는
 *  repCells 셀의 chosenSource 를 즉시 덮어쓰기. 사용자가 분기 외 월을 보고 있으면
 *  그 월에 대표가 기록되어 매트릭스 탭(Step 4)에서도 해당 월 집계에 반영.
 */
window._seSelectSource = function(source) {
    const bid = _seState.selectedBuildingId;
    const prevPd = _seState.selectedPublishDate;
    const prevPdNorm = srNormalizeDate(prevPd || '');

    // 1) 현재 pd 의 yyyymm 에 대표 기록 (있을 때만)
    if (bid && prevPdNorm) {
        const repKey = `${bid}__${prevPdNorm}`;
        const prevCell = _seState.repCells.get(repKey);
        if (!prevCell || prevCell.chosenSource !== source) {
            _seState.repCells.set(repKey, {
                chosenSource: source,
                chosenAt:     _seNow(),
                chosenBy:     _seGetCurrentUser(),
                memo:         '사용자 탭 클릭으로 지정',
            });
            _sePushActionLog('choose_rep_source', repKey, `${source} @ ${prevPdNorm}`,
                `${prevPdNorm} 대표 회사 = ${source}`);
            _seSetDirty(true);
        }
    }

    // 2) 선택 상태 전환 — 발행월은 새 회사의 최신(또는 분기 마지막 월)으로 자동 재선정
    _seState.selectedSource      = source;
    _seState.selectedPublishDate = null;  // 다음 렌더에서 자동 선정
    _seReloadLogPanelIfOpen();
    _seRenderPipelineSummary();   // 대표 선택 카운트 갱신
    _seRenderVacancyList();
};

/** 발행월 전환 */
window._seSelectPublishDate = function(pd) {
    _seState.selectedPublishDate = pd;
    _seRenderVacancyList();
};

/**
 * 그룹(회사+발행월) 전체 체크/해제.
 * 개별 vacancy 로그 폭발 방지 위해 bulk_toggle_guide 단일 로그로 기록.
 */
window._seToggleGroupExclude = function(bid, source, pd, includeChecked) {
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    if (!b) return;
    const vacs = srActiveVacancies(b).filter(v => {
        const vs = v.source || v.sourceCompany || '(미지정)';
        const vp = v.publishDate || '(미기재)';
        return vs === source && vp === pd;
    });
    if (vacs.length === 0) return;

    const user = _seGetCurrentUser();
    const now  = _seNow();
    const bName = (b.name || b.buildingName) || bid;
    const memo  = `${source} · ${pd} 그룹 ${includeChecked ? '전체 포함' : '전체 제외'} (${vacs.length}건)`;

    vacs.forEach(v => {
        const ck = _seMakeVacKey(bid, v._key || '');
        if (includeChecked) {
            _seState.excludedVacancies.delete(ck);
        } else {
            _seState.excludedVacancies.set(ck, {
                buildingId: bid,
                vacancyKey: v._key || '',
                memo,
                excludedAt: now,
                excludedBy: user,
                judgedBy:   'manual',  // Phase 6 Step 3.5: 그룹 bulk 도 사용자 명시 결정
            });
        }
    });

    _sePushActionLog('bulk_toggle_guide',
        _seMakeGuideKey(bid, source, pd),
        `${bName} / ${source} · ${pd}`,
        memo);
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderPipelineSummary();
    _seRenderVacancyList();
    _seRenderSelectionSummary();
};

/** 그룹 검증마크 토글 */
window._seToggleVerifyGuide = function(bid, source, pd) {
    const gk = _seMakeGuideKey(bid, source, pd);
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bName = (b && (b.name || b.buildingName)) || bid;
    const label = `${bName} / ${source} · ${pd}`;

    if (_seState.verifiedGuides.has(gk)) {
        _seState.verifiedGuides.delete(gk);
        _sePushActionLog('unverify_guide', gk, label, '검증 해제');
    } else {
        _seState.verifiedGuides.set(gk, {
            verifiedAt: _seNow(),
            verifiedBy: _seGetCurrentUser(),
        });
        _sePushActionLog('verify_guide', gk, label, '원본 대조 후 검증 완료');
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderVacancyList();
};

/**
 * Phase 4+5: 원본 OCR 이미지 프리뷰 모달 오픈.
 *
 * 데이터 흐름 (2단계):
 *   1) 즉시: 해당 (bid, source, pd) 그룹의 vacancy → 이 빌딩 공실이 있는 페이지 좌측 퀵링크
 *   2) 비동기: listAll(leasing-docs/{source}/{pd}) → 안내문 전체 페이지 목록 (219페이지 등)
 *      → 네비게이션 바에서 전후 페이지 탐색 가능
 *   URL 해상: 필요한 페이지만 lazy (vacancy.pageImageUrl 우선 재사용, 없으면 getDownloadURL)
 */
window._seOpenGuidePreview = async function(bid, source, pd) {
    const modal = document.getElementById('se-guide-preview-modal');
    if (!modal) { console.warn('[StatsEditor] preview modal not found'); return; }
    // 상태 초기화
    _sePreviewState.bid             = bid;
    _sePreviewState.source          = source;
    _sePreviewState.publishDate     = pd;
    _sePreviewState.activePage      = null;
    _sePreviewState.allPages        = [];
    _sePreviewState.urlCache        = new Map();
    _sePreviewState.loadingManifest = true;
    _sePreviewState.imageReqSeq     = 0;

    // 1차 즉시 렌더: 이 빌딩 공실 페이지만 먼저 보이게
    const groupPages = _seGetGroupPages(bid, source, pd);
    if (groupPages.length > 0 && groupPages[0].pageNum !== 'unknown') {
        _sePreviewState.activePage = groupPages[0].pageNum;
    }

    modal.classList.add('show');
    _seRenderGuidePreview();

    // 키보드 리스너 부착 (중복 방지)
    if (!_sePreviewState.keyHandler) {
        _sePreviewState.keyHandler = _seGpKeyHandler;
        document.addEventListener('keydown', _sePreviewState.keyHandler);
    }

    // 2차 비동기: 안내문 전체 파일 목록 로드
    try {
        const res = await _seLoadFolderManifest(source, pd);
        if (res.ok) {
            _sePreviewState.allPages = res.files;
            console.log(`[StatsEditor] manifest loaded: ${source}/${pd} — ${res.files.length}페이지`);
        } else {
            console.warn('[StatsEditor] manifest load failed:', res.error);
            // Fallback: 그룹 매핑 페이지만 allPages 에 채워서 네비게이션은 동작하게
            _sePreviewState.allPages = groupPages
                .filter(p => p.pageNum !== 'unknown')
                .map(p => ({
                    pageNum:    parseInt(p.pageNum, 10) || 0,
                    fileName:   '',
                    storageRef: null,
                }));
        }
    } finally {
        _sePreviewState.loadingManifest = false;
        _seRenderGuidePreview();
        _seUpdatePreviewImage();  // 첫 이미지 lazy 로드
    }
};

/**
 * Phase 5: 안내문 폴더의 파일 목록 가져오기 (listAll, 메타데이터만).
 * 파일명 패턴 `page_004.jpg` 에서 pageNum 추출 + pageNum 오름차순 정렬.
 */
async function _seLoadFolderManifest(source, pd) {
    try {
        const { storage, storageRef } = await import('./portal-firebase.js');
        const { listAll } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js');
        const sfx = s => String(s).replace(/[\s.]+/g, '_').replace(/__+/g, '_');
        const path = `leasing-docs/${sfx(source)}/${sfx(pd)}`;

        const result = await listAll(storageRef(storage, path));
        const files = result.items
            .map(ref => {
                // 파일명에서 첫 번째 숫자 시퀀스를 pageNum 으로 사용
                const m = ref.name.match(/(\d+)/);
                return {
                    pageNum:    m ? parseInt(m[1], 10) : null,
                    fileName:   ref.name,
                    storageRef: ref,
                };
            })
            .filter(f => f.pageNum != null)
            .sort((a, b) => a.pageNum - b.pageNum);
        return { ok: true, files, path };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * Phase 5: 특정 pageNum 의 다운로드 URL 해상 (캐시 우선).
 *   우선순위: urlCache > vacancy.pageImageUrl > getDownloadURL(storageRef)
 */
async function _seResolvePageUrl(pageNum) {
    if (_sePreviewState.urlCache.has(pageNum)) {
        return _sePreviewState.urlCache.get(pageNum);
    }
    // 이 빌딩 그룹의 vacancy 가 이미 보유한 URL 재사용
    const gp = _seGetGroupPages(_sePreviewState.bid, _sePreviewState.source, _sePreviewState.publishDate);
    const mapped = gp.find(p => String(p.pageNum) === String(pageNum));
    if (mapped && mapped.pageImageUrl) {
        _sePreviewState.urlCache.set(pageNum, mapped.pageImageUrl);
        return mapped.pageImageUrl;
    }
    // allPages 에서 storageRef 로 fetch
    const file = _sePreviewState.allPages.find(f => f.pageNum === pageNum);
    if (!file || !file.storageRef) return null;
    try {
        const { getDownloadURL } = await import('https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js');
        const url = await getDownloadURL(file.storageRef);
        _sePreviewState.urlCache.set(pageNum, url);
        return url;
    } catch (err) {
        console.warn('[StatsEditor] getDownloadURL failed:', err);
        return null;
    }
}

/** Phase 5: 이미지 영역만 비동기로 업데이트 (race-condition 방지) */
async function _seUpdatePreviewImage() {
    const imgSlot = document.getElementById('se-gp-imgslot');
    if (!imgSlot) return;
    const pn = _sePreviewState.activePage;
    if (pn == null) {
        imgSlot.innerHTML = `<div style="color:#cbd5e1; font-size:13px;">표시할 페이지가 없습니다.</div>`;
        return;
    }
    // 캐시에 있으면 즉시 표시 (로딩 깜빡임 방지)
    if (_sePreviewState.urlCache.has(pn)) {
        _seDisplayImage(_sePreviewState.urlCache.get(pn), pn);
        return;
    }
    // 로딩 placeholder
    imgSlot.innerHTML = `<div style="color:#94a3b8; font-size:13px;">🔄 페이지 ${_seEsc(pn)} 로딩중...</div>`;
    // 시퀀스 증가 후 fetch — 도중 다른 페이지 요청 오면 이 응답 무시
    const mySeq = ++_sePreviewState.imageReqSeq;
    const url = await _seResolvePageUrl(pn);
    if (mySeq !== _sePreviewState.imageReqSeq) return;  // 다른 요청이 덮어씀
    if (!url) {
        imgSlot.innerHTML = `<div style="color:#fbbf24; text-align:center; padding:40px;">
            ⚠️ 페이지 ${_seEsc(pn)} 의 이미지를 가져올 수 없습니다.
        </div>`;
        return;
    }
    _seDisplayImage(url, pn);
}

function _seDisplayImage(url, pageNum) {
    const imgSlot = document.getElementById('se-gp-imgslot');
    if (!imgSlot) return;
    imgSlot.innerHTML = `<img src="${_seEsc(url)}" alt="page ${_seEsc(pageNum)}"
        class="se-gp-img"
        onerror="this.outerHTML='<div style=&quot;color:#ef4444;padding:40px;text-align:center;&quot;>❌ 이미지 로드 실패<br><span style=&quot;font-size:11px;opacity:0.8;&quot;>페이지 ${_seEsc(pageNum)} · Storage 권한 또는 URL 오류</span></div>'">`;
}

/** Phase 5: 키보드 단축키 핸들러 (document keydown) */
function _seGpKeyHandler(e) {
    const modal = document.getElementById('se-guide-preview-modal');
    if (!modal || !modal.classList.contains('show')) return;
    // 숫자 입력 중인 인풋이면 ← → 허용 X (페이지 번호 입력 방해 금지)
    if (e.target && e.target.tagName === 'INPUT') {
        if (e.key === 'Escape') { e.preventDefault(); _seCloseGuidePreview(); }
        return;
    }
    switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); _sePageStep(-1); break;
        case 'ArrowRight': e.preventDefault(); _sePageStep(1);  break;
        case 'Home':       e.preventDefault(); _sePageFirst();  break;
        case 'End':        e.preventDefault(); _sePageLast();   break;
        case 'Escape':     e.preventDefault(); _seCloseGuidePreview(); break;
    }
}

window._seCloseGuidePreview = function() {
    const modal = document.getElementById('se-guide-preview-modal');
    if (modal) modal.classList.remove('show');
    // 키보드 리스너 제거 — 메모리 누수 방지
    if (_sePreviewState.keyHandler) {
        document.removeEventListener('keydown', _sePreviewState.keyHandler);
        _sePreviewState.keyHandler = null;
    }
};

/** 프리뷰 모달 전역 상태 */
const _sePreviewState = {
    bid:         null,
    source:      null,
    publishDate: null,
    activePage:  null,  // 현재 표시 중인 pageNum (또는 'unknown' — 페이지번호 없는 경우)

    // Phase 5: 안내문 전체 네비게이션
    allPages:        [],             // [{pageNum:int, fileName:string, storageRef:ref|null}]
    urlCache:        new Map(),      // pageNum → downloadURL (lazy 해상)
    loadingManifest: false,          // listAll 진행 중 플래그
    imageReqSeq:     0,              // 이미지 race-condition 방지용 시퀀스
    keyHandler:      null,           // document keydown 리스너 참조 (제거용)
};

/**
 * Phase 4: 현재 그룹의 vacancy 들에서 고유 페이지 목록 추출.
 * @returns {Array<{pageNum:(number|'unknown'), pageImageUrl:string, vacancies:Array}>}
 */
function _seGetGroupPages(bid, source, pd) {
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    if (!b) return [];
    const vacs = srActiveVacancies(b).filter(v => {
        const vs = v.source || v.sourceCompany || '(미지정)';
        const vp = v.publishDate || '(미기재)';
        return vs === source && vp === pd;
    });
    // pageNum 별 그룹핑 (같은 페이지에 여러 층 정보가 있을 수 있음)
    const byPage = new Map();
    vacs.forEach(v => {
        const pn  = (v.pageNum != null && v.pageNum !== '') ? v.pageNum : 'unknown';
        const url = v.pageImageUrl || '';
        if (!byPage.has(pn)) {
            byPage.set(pn, { pageNum: pn, pageImageUrl: url, vacancies: [] });
        }
        // 같은 페이지인데 URL 다를 수 있으면 첫 번째 non-empty 유지
        const entry = byPage.get(pn);
        if (!entry.pageImageUrl && url) entry.pageImageUrl = url;
        entry.vacancies.push(v);
    });
    // 오름차순 (unknown 은 맨 끝)
    const pages = [...byPage.values()].sort((a, b) => {
        if (a.pageNum === 'unknown') return 1;
        if (b.pageNum === 'unknown') return -1;
        return (parseInt(a.pageNum, 10) || 0) - (parseInt(b.pageNum, 10) || 0);
    });
    return pages;
}

/** 프리뷰 모달 전체 렌더 (페이지 퀵링크 + 네비게이션 바 + 중앙 이미지 슬롯 + 우측 정보) */
function _seRenderGuidePreview() {
    const { bid, source, publishDate, allPages, loadingManifest } = _sePreviewState;
    if (!bid || !source || !publishDate) return;

    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bldgName = (b && (b.name || b.buildingName)) || bid;
    const titleEl  = document.getElementById('se-gp-title');
    const subEl    = document.getElementById('se-gp-subtitle');
    if (titleEl) titleEl.textContent = `🖼 ${source} · ${publishDate} — ${bldgName}`;

    const groupPages = _seGetGroupPages(bid, source, publishDate);

    if (subEl) {
        const gcount   = groupPages.reduce((s,p)=>s+p.vacancies.length,0);
        const manifest = loadingManifest
            ? '안내문 전체 로딩중…'
            : (allPages.length > 0 ? `전체 ${allPages.length}페이지` : '전체 페이지 정보 없음');
        subEl.textContent = `이 빌딩 공실 ${groupPages.length}페이지 · ${gcount}건 · ${manifest}`;
    }

    // activePage 미설정이면 첫 페이지
    if (_sePreviewState.activePage == null) {
        if (groupPages.length > 0 && groupPages[0].pageNum !== 'unknown') {
            _sePreviewState.activePage = groupPages[0].pageNum;
        } else if (allPages.length > 0) {
            _sePreviewState.activePage = allPages[0].pageNum;
        }
    }
    const curPn = _sePreviewState.activePage;

    // ── 좌: 이 빌딩 공실 페이지 퀵링크 ─────────────────
    const listEl = document.getElementById('se-gp-pagelist');
    if (listEl) {
        if (groupPages.length === 0) {
            listEl.innerHTML = `<div class="se-empty" style="padding:20px 8px;">
                공실 페이지 정보 없음
            </div>`;
        } else {
            const header = `<div style="font-size:10px; color:var(--text-muted);
                            padding:4px 6px; margin-bottom:6px; text-transform:uppercase;
                            letter-spacing:0.05em; font-weight:600;">
                이 빌딩 공실
            </div>`;
            const items = groupPages.map(p => {
                const on = (String(p.pageNum) === String(curPn)) ? ' se-gp-page-on' : '';
                const label = (p.pageNum === 'unknown') ? '페이지?' : `p.${p.pageNum}`;
                return `<button class="se-gp-page-btn${on}"
                    onclick="_seSelectPreviewPage('${_seEsc(p.pageNum)}')">
                    ${_seEsc(label)}
                    <div class="se-gp-page-btn-meta">공실 ${p.vacancies.length}건</div>
                </button>`;
            }).join('');
            listEl.innerHTML = header + items;
        }
    }

    // ── 중앙 위: 네비게이션 바 ─────────────────────────
    const navEl = document.getElementById('se-gp-nav');
    if (navEl) {
        if (allPages.length === 0) {
            navEl.innerHTML = loadingManifest
                ? `<div style="color:#94a3b8; font-size:12px;">🔄 안내문 전체 페이지 목록 로딩 중…</div>`
                : `<div style="color:#fbbf24; font-size:12px;">⚠️ 전체 페이지 목록을 가져오지 못했습니다. 이 빌딩 공실 페이지만 탐색 가능합니다.</div>`;
        } else {
            const curIdx = allPages.findIndex(p => p.pageNum === curPn);
            const minP = allPages[0].pageNum;
            const maxP = allPages[allPages.length - 1].pageNum;
            const atFirst = curIdx <= 0;
            const atLast  = curIdx < 0 || curIdx >= allPages.length - 1;
            navEl.innerHTML = `
                <button class="se-gp-nav-btn" onclick="_sePageFirst()"
                        ${atFirst ? 'disabled' : ''} title="첫 페이지 (Home)">⏮</button>
                <button class="se-gp-nav-btn" onclick="_sePageStep(-1)"
                        ${atFirst ? 'disabled' : ''} title="이전 (←)">◀ 이전</button>
                <div class="se-gp-nav-info">
                    <span>p.</span>
                    <input type="number" class="se-gp-nav-input"
                        value="${curPn != null ? curPn : ''}"
                        min="${minP}" max="${maxP}"
                        onchange="_seGoToPage(this.value); this.blur();"
                        title="페이지 번호 직접 입력">
                    <span>/ ${maxP}</span>
                    <span class="se-gp-nav-subtext">
                        · 실존 ${curIdx + 1}/${allPages.length}
                    </span>
                </div>
                <button class="se-gp-nav-btn" onclick="_sePageStep(1)"
                        ${atLast ? 'disabled' : ''} title="다음 (→)">다음 ▶</button>
                <button class="se-gp-nav-btn" onclick="_sePageLast()"
                        ${atLast ? 'disabled' : ''} title="마지막 (End)">⏭</button>
                <span class="se-gp-nav-hint">← → Home End · Esc</span>
            `;
        }
    }

    // ── 중앙 이미지 영역은 _seUpdatePreviewImage() 가 비동기로 처리 ─────

    // ── 우: 현재 페이지의 vacancy + 검증 버튼 ────────────
    const sideEl = document.getElementById('se-gp-sidebar');
    if (sideEl) {
        const gk = _seMakeGuideKey(bid, source, publishDate);
        const isVerified = _seState.verifiedGuides.has(gk);
        const verInfo    = isVerified ? _seState.verifiedGuides.get(gk) : null;

        // 현재 페이지에 매핑된 이 빌딩 vacancy 찾기
        const mappedPage = groupPages.find(p => String(p.pageNum) === String(curPn));
        const isMapped   = !!mappedPage;

        const vacsHtml = isMapped ? mappedPage.vacancies.map(v => {
            const ck = _seMakeVacKey(bid, v._key || '');
            const exc = _seState.excludedVacancies.has(ck);
            return `<div class="se-gp-vac-card${exc ? ' se-gp-vac-excluded' : ''}">
                <div class="se-gp-vac-head">${_seEsc(v.floor || v.floors || '?')}${String(v.floor||'').match(/^\d+$/) ? 'F' : ''}${exc ? ' · 제외됨' : ''}</div>
                <div class="se-gp-vac-row"><span>임대면적</span><span>${_seFmtNum(v.rentArea)}${v.rentArea ? '평' : ''}</span></div>
                <div class="se-gp-vac-row"><span>전용면적</span><span>${_seFmtNum(v.exclusiveArea)}${v.exclusiveArea ? '평' : ''}</span></div>
                <div class="se-gp-vac-row"><span>보증금/평</span><span>${_seFmtNum(v.depositPy)}</span></div>
                <div class="se-gp-vac-row"><span>임대료/평</span><span>${_seFmtNum(v.rentPy)}</span></div>
                <div class="se-gp-vac-row"><span>관리비/평</span><span>${_seFmtNum(v.maintenancePy)}</span></div>
                <div class="se-gp-vac-row"><span>입주</span><span>${_seEsc(v.moveInDate || '-')}</span></div>
            </div>`;
        }).join('') : `
            <div style="padding:14px; background:#fef9c3; border:1px solid #fde047;
                        border-radius:6px; font-size:12px; color:#713f12; text-align:center;">
                ℹ️ 이 페이지에는<br>이 빌딩의 공실 매핑이 없습니다.
                <div style="font-size:11px; opacity:0.8; margin-top:6px;">
                    (안내문 전체 페이지 탐색 중)
                </div>
            </div>`;

        sideEl.innerHTML = `
            <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">
                📋 ${isMapped ? '현재 페이지에 매핑된 공실' : '페이지 ' + _seEsc(curPn)}
            </div>
            ${vacsHtml}
            <div class="se-gp-verify-wrap">
                ${isVerified ? `
                    <div style="font-size:11px; color:#16a34a; margin-bottom:6px;">
                        ✓ ${_seEsc((verInfo?.verifiedAt || '').slice(0,10))} · ${_seEsc(verInfo?.verifiedBy || '')}
                    </div>
                ` : `
                    <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">
                        원본과 대조 후 아래 버튼을 누르세요
                    </div>
                `}
                <button class="se-gp-verify-btn${isVerified ? ' se-verified' : ''}"
                        onclick="_seToggleVerifyGuide('${_seEsc(bid)}', '${_seEsc(source)}', '${_seEsc(publishDate)}'); _seRenderGuidePreview();">
                    ${isVerified ? '✓ 검증됨 (해제)' : '✓ 검증마크 찍기'}
                </button>
            </div>
        `;
    }
}

window._seSelectPreviewPage = function(pageNum) {
    // 문자열 "unknown" 도 허용, 아니면 숫자 변환
    const parsed = (pageNum === 'unknown') ? 'unknown' : (parseInt(pageNum, 10) || pageNum);
    _sePreviewState.activePage = parsed;
    _seRenderGuidePreview();
    _seUpdatePreviewImage();
};

// ─ Phase 5: 안내문 전체 네비게이션 핸들러 ─────────────────
/** 숫자 직접 입력 (input onchange) 또는 프로그램 호출 */
window._seGoToPage = function(pageNum) {
    const target = parseInt(pageNum, 10);
    if (!Number.isFinite(target)) return;
    const pages = _sePreviewState.allPages;
    if (pages.length === 0) return;
    const minP = pages[0].pageNum;
    const maxP = pages[pages.length - 1].pageNum;
    const clamped = Math.max(minP, Math.min(maxP, target));
    // 정확히 존재하면 그걸, 없으면 그 이상의 최초 페이지
    let file = pages.find(p => p.pageNum === clamped);
    if (!file) file = pages.find(p => p.pageNum >= clamped) || pages[pages.length - 1];
    _sePreviewState.activePage = file.pageNum;
    _seRenderGuidePreview();
    _seUpdatePreviewImage();
};

/** 상대 이동: -1 이전, +1 다음 */
window._sePageStep = function(delta) {
    const pages = _sePreviewState.allPages;
    if (pages.length === 0) return;
    const curIdx = pages.findIndex(p => p.pageNum === _sePreviewState.activePage);
    if (curIdx < 0) {
        _sePreviewState.activePage = pages[0].pageNum;
    } else {
        const nextIdx = Math.max(0, Math.min(pages.length - 1, curIdx + delta));
        _sePreviewState.activePage = pages[nextIdx].pageNum;
    }
    _seRenderGuidePreview();
    _seUpdatePreviewImage();
};

window._sePageFirst = function() {
    const pages = _sePreviewState.allPages;
    if (pages.length > 0) {
        _sePreviewState.activePage = pages[0].pageNum;
        _seRenderGuidePreview();
        _seUpdatePreviewImage();
    }
};

window._sePageLast = function() {
    const pages = _sePreviewState.allPages;
    if (pages.length > 0) {
        _sePreviewState.activePage = pages[pages.length - 1].pageNum;
        _seRenderGuidePreview();
        _seUpdatePreviewImage();
    }
};

/** 빌딩 포함/제외 토글 */
window._seToggleBuilding = function(bid, includeChecked) {
    const user = _seGetCurrentUser();
    // 라벨용 빌딩명 추출
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bName = (b && (b.name || b.buildingName)) || bid;

    if (includeChecked) {
        // 포함 → excludedBuildings 에서 제거
        _seState.excludedBuildings.delete(bid);
        // Phase 3: 개별 로그
        _sePushActionLog('add_building', bid, bName, '제외 해제');
    } else {
        // 제외 → 메모 프롬프트 (선택, ESC/취소 시 기본 메모)
        const memoIn = prompt('제외 사유 (선택, Enter로 건너뛰기):', '');
        const memo = (memoIn === null || memoIn.trim() === '')
            ? _seDefaultMemo(user)
            : memoIn.trim();
        _seState.excludedBuildings.set(bid, {
            memo,
            excludedAt: _seNow(),
            excludedBy: user,
        });
        // Phase 3: 개별 로그
        _sePushActionLog('remove_building', bid, bName, memo);
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderPipelineSummary();
    _seRenderBuildingList();
    _seRenderSelectionSummary();
};

/** vacancy 포함/제외 토글 */
window._seToggleVacancy = function(bid, vkey, includeChecked) {
    const user = _seGetCurrentUser();
    const ck = _seMakeVacKey(bid, vkey);
    // 라벨용 vacancy 정보 추출
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bName = (b && (b.name || b.buildingName)) || bid;
    let vLabel = `${bName} / ${vkey}`;
    if (b) {
        const v = (b.vacancies || []).find(x => x && x._key === vkey);
        if (v) {
            const src  = v.source || v.sourceCompany || '-';
            const date = v.publishDate || '-';
            const fl   = v.floor || v.floors || '-';
            vLabel = `${bName} / ${date} ${src} ${fl}층`;
        }
    }

    if (includeChecked) {
        // 제외 해제 (= 포함으로 전환)
        // Phase 6 Step 3.5 known limitation:
        // 여기서 그냥 delete 만 하면 모달 재오픈 시 자동 시드가 다시 자동 제외로 복원할 수 있음.
        // 같은 세션 내에서는 seededBuildings 플래그로 보호되지만, 세션을 넘어가면 복원됨.
        // 현업 피드백 봐서 필요하면 별도 manualIncludes Set 추가 고려.
        const prev = _seState.excludedVacancies.get(ck);
        const prevJudgedBy = prev?.judgedBy || 'manual';
        _seState.excludedVacancies.delete(ck);
        _sePushActionLog('add_vacancy', ck, vLabel,
            prevJudgedBy === 'auto' ? '자동 제외 → 수동 포함' : '제외 해제');
    } else {
        const memoIn = prompt('제외 사유 (선택, Enter로 건너뛰기):', '');
        const memo = (memoIn === null || memoIn.trim() === '')
            ? _seDefaultMemo(user)
            : memoIn.trim();
        _seState.excludedVacancies.set(ck, {
            buildingId: bid,
            vacancyKey: vkey,
            memo,
            excludedAt: _seNow(),
            excludedBy: user,
            judgedBy:   'manual',  // Phase 6 Step 3.5: 사용자 명시 결정 → 시드가 덮어쓰지 않음
        });
        _sePushActionLog('remove_vacancy', ck, vLabel, memo);
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderVacancyList();
    _seRenderSelectionSummary();
};

/**
 * 빌딩 검수 완료 토글 (Phase 6 Step 3.5)
 *  - verifiedBuildings Map 에 set/delete
 *  - 로그 기록 + dirty
 *  - 빌딩 카드 + 권역 진행률 재렌더
 */
window._seToggleVerifyBuilding = function(bid) {
    const user = _seGetCurrentUser();
    const b = (window.state?.allBuildings || []).find(x => x.id === bid);
    const bName = (b && (b.name || b.buildingName)) || bid;
    const quarter = _seState.quarter;

    if (_seState.verifiedBuildings.has(bid)) {
        _seState.verifiedBuildings.delete(bid);
        _sePushActionLog('unverify_building', bid, bName, '빌딩 검수 해제');
    } else {
        _seState.verifiedBuildings.set(bid, {
            verifiedAt: _seNow(),
            verifiedBy: user,
            quarter,
        });
        _sePushActionLog('verify_building', bid, bName, '빌딩 검수 완료');
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderBuildingList();   // 빌딩 카드 ✓ 상태 반영
    _seRenderFilters();        // 권역 진행률 · 확정 버튼 갱신
};

/**
 * 권역 검수 확정 토글 (Phase 6 Step 3.5)
 *  - 미확정 → 확정: 100% 도달 확인 후 verifiedRegions set
 *  - 확정 → 해제: 확정 배지 클릭 시 해제 확인 후 delete
 *  - 로그 기록 + dirty + 필터 재렌더
 */
window._seConfirmVerifyRegion = function(region) {
    const quarter = _seState.quarter;
    const key = `${quarter}__${region}`;
    const user = _seGetCurrentUser();

    if (_seState.verifiedRegions.has(key)) {
        // 해제
        const ok = confirm(`${region} 권역 확정을 해제하시겠습니까?\n검수 진행률 배지는 유지되지만 "🎯 확정" 표시가 사라집니다.`);
        if (!ok) return;
        _seState.verifiedRegions.delete(key);
        _sePushActionLog('unconfirm_region', key, `${quarter} ${region}`, '권역 확정 해제');
    } else {
        // 확정 (진행률 재계산해 분모 저장)
        const raw2 = srGetNormBuildings();
        const f = _seState.filters;
        const matchFn = (arr, val) => !arr || arr.length === 0 || arr.includes(val);
        const afterGrade = raw2.filter(b => matchFn(f.grades, b._gradeAuto));
        let denom = 0, num = 0;
        afterGrade.forEach(b => {
            if (b._region !== region) return;
            const bb = _seGetBuildingBadge(b);
            const isGW = bb.code === 'green' || bb.code === 'white';
            const isVer = _seState.verifiedBuildings.has(b.id);
            if (isGW) { denom++; if (isVer) num++; }
            else if (isVer) { denom++; num++; }
        });
        // 방어: 버튼이 잘못 활성화된 상태에서 호출됐을 때 차단
        if (denom === 0 || num !== denom) {
            alert(`${region} 권역 검수가 완료되지 않았습니다 (${num}/${denom}).\n모든 대상 빌딩을 먼저 "✓ 검수완료"로 표시해주세요.`);
            return;
        }
        const ok = confirm(`${region} 권역 (${denom}개 빌딩) 검수를 확정하시겠습니까?\n확정 후에도 배지 클릭으로 해제할 수 있습니다.`);
        if (!ok) return;
        _seState.verifiedRegions.set(key, {
            verifiedAt:    _seNow(),
            verifiedBy:    user,
            buildingCount: denom,
            memo:          '권역 검수 확정',
        });
        _sePushActionLog('confirm_region', key, `${quarter} ${region}`,
            `권역 확정 (빌딩 ${denom}개)`);
    }
    _seSetDirty(true);
    _seReloadLogPanelIfOpen();
    _seRenderFilters();
};

/** 적용 버튼 */
window._seApply = async function() {
    const btn = document.getElementById('se-apply-btn');

    // Phase 2: 필터 설정이 있으면 전체 통계 영향 확인 프롬프트
    const f = _seState.filters;
    const hasFilter =
        (f.grades && f.grades.length > 0)
        || (f.regions && f.regions.length > 0)
        || (f.subRegions && f.subRegions.length > 0)
        || !f.vacOnly;  // 기본값 true 에서 벗어났으면
    const hasExclusion = _seState.excludedBuildings.size > 0 || _seState.excludedVacancies.size > 0;

    if (hasFilter) {
        const filterSummary = [
            (f.grades && f.grades.length > 0) ? `등급: ${f.grades.join(', ')}` : null,
            (f.regions && f.regions.length > 0) ? `권역: ${f.regions.join(', ')}` : null,
            (f.subRegions && f.subRegions.length > 0) ? `세부권역 ${f.subRegions.length}개` : null,
            !f.vacOnly ? '공실정보 없는 빌딩 포함' : null,
        ].filter(Boolean).join('\n  · ');
        const ok = confirm(
            `⚠️ 필터가 설정되어 있습니다:\n\n  · ${filterSummary}\n\n` +
            `이 필터는 통계 모달 전체 탭에 영구 적용됩니다.\n` +
            `(모든 사용자가 볼 때 동일한 필터 적용)\n\n계속하시겠습니까?`
        );
        if (!ok) return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '저장 중...';
    }
    try {
        const res = await _seSaveStatsFilter();
        if (!res.ok) {
            alert(`❌ 저장 실패\n\n${res.reason}`);
            return;
        }
        // 통계 페이지에 즉시 반영
        if (typeof window._srApplyPersistentExclusions === 'function') {
            window._srApplyPersistentExclusions(
                new Set(_seState.excludedBuildings.keys()),
                new Set(_seState.excludedVacancies.keys()),
                _seState.filters
            );
        }
        const summary = `빌딩 ${_seState.excludedBuildings.size}건, 임대안내문 ${_seState.excludedVacancies.size}건 제외`;
        // Phase 3: 저장 성공 시 dirty 리셋 (closeStatsEditorModal 의 confirm 우회)
        _seSetDirty(false);
        alert(`✅ 적용 완료 (v${res.newVersion})\n\n${summary}`);
        // dirty=false 상태로 모달 닫기
        const modal = document.getElementById('stats-editor-modal');
        if (modal) modal.style.display = 'none';
        if (typeof window.refreshStatResearch === 'function') {
            window.refreshStatResearch();
        }
    } catch (err) {
        console.error('[StatsEditor] apply failed:', err);
        alert(`❌ 저장 중 오류: ${err.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            // dirty 상태면 적용 버튼 텍스트 유지
            if (_seState.dirty) {
                btn.textContent = '✓ 적용 (변경 있음)';
            } else {
                btn.textContent = '✓ 적용';
            }
        }
    }
};

/** 편집 이력 토글 */
const _SE_ACTION_LABEL = {
    'add_building':      '빌딩 포함',
    'remove_building':   '빌딩 제외',
    'add_vacancy':       '공실 포함',
    'remove_vacancy':    '공실 제외',
    'filter_change':     '필터 변경',
    'bulk_apply':        '일괄 적용',
    // Phase 4: 임대안내문 그룹
    'verify_guide':      '안내문 검증',
    'unverify_guide':    '검증 해제',
    'bulk_toggle_guide': '그룹 일괄',
    // Phase 6: 매트릭스 대표값 선택
    'choose_cell':       '셀 선택',
    'choose_month':      '월 선택',
    'exclude_cell':      '셀 제외',
};
const _SE_ACTION_COLOR = {
    'add_building':      '#16a34a',
    'remove_building':   '#dc2626',
    'add_vacancy':       '#16a34a',
    'remove_vacancy':    '#dc2626',
    'filter_change':     '#7c3aed',
    'bulk_apply':        '#1a73e8',
    'verify_guide':      '#16a34a',
    'unverify_guide':    '#64748b',
    'bulk_toggle_guide': '#0891b2',
    // Phase 6
    'choose_cell':       '#0891b2',  // 청록 (설계문서 §로그 액션)
    'choose_month':      '#0e7490',  // 진청록
    'exclude_cell':      '#dc2626',  // 빨강
};

window._seToggleLog = async function() {
    const wrap = document.getElementById('se-log-wrap');
    const body = document.getElementById('se-log-body');
    if (!wrap || !body) return;
    _seLogExpanded = !_seLogExpanded;
    wrap.classList.toggle('se-log-open', _seLogExpanded);

    // Phase 3: 열 때마다 최신 로그 로드 (즉시 기록 정책이므로 캐시 무효)
    if (_seLogExpanded) {
        body.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:12px;">로딩 중...</div>`;
        try {
            const logs = await _seLoadRecentLogs(_seState.quarter, 20);
            if (logs.length === 0) {
                body.innerHTML = `<div style="padding:10px; color:var(--text-muted); font-size:12px;">편집 이력 없음</div>`;
            } else {
                body.innerHTML = logs.map(l => {
                    const act = l.action || '-';
                    const label = _SE_ACTION_LABEL[act] || act;
                    const color = _SE_ACTION_COLOR[act] || '#64748b';
                    const ts = (l.ts || '').slice(0, 16).replace('T', ' ');
                    return `
                    <div class="se-log-row">
                        <span class="se-log-ts">${_seEsc(ts)}</span>
                        <span class="se-log-user">${_seEsc(l.user || '-')}</span>
                        <span class="se-log-action" style="color:${color};">${_seEsc(label)}</span>
                        <span class="se-log-memo">${_seEsc(l.targetLabel ? `${l.targetLabel} — ` : '')}${_seEsc(l.memo || '')}</span>
                    </div>`;
                }).join('');
            }
            body.dataset.loadedQuarter = _seState.quarter;
        } catch (err) {
            body.innerHTML = `<div style="padding:10px; color:var(--danger); font-size:12px;">이력 로드 실패: ${_seEsc(err.message)}</div>`;
        }
    }
};

// ═══════════════════════════════════════════════════════════════
// 8. portal-stats.js 와의 연동 인터페이스
// ═══════════════════════════════════════════════════════════════

/**
 * 통계 모달이 열릴 때(refreshStatResearch 등) 자동으로 현재 분기의 영구 제외를 로드.
 * portal-stats.js 의 openStatResearchModal 에서 호출.
 */
window._seAutoLoadForStats = async function() {
    const now = new Date();
    const curQ = `${now.getFullYear()}Q${Math.ceil((now.getMonth() + 1) / 3)}`;
    try {
        const { db, ref, get } = await import('./portal-firebase.js');
        const snap = await get(ref(db, `statsFilter/${curQ}`));
        const data = snap.exists() ? (snap.val() || {}) : {};
        // FIX (Phase 2): 데이터 없어도 상태 리셋 목적으로 호출 (이전 세션 잔존 제거)
        const excludedBuildings = new Set(Object.keys(data.excludedBuildings || {}));
        const excludedVacancies = new Set(Object.keys(data.excludedVacancies || {}));
        if (typeof window._srApplyPersistentExclusions === 'function') {
            window._srApplyPersistentExclusions(
                excludedBuildings,
                excludedVacancies,
                data.filters || null
            );
        }
    } catch (err) {
        console.warn('[StatsEditor] auto-load failed:', err);
    }
};
