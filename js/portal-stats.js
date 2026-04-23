/**
 * CRE Portal - 통계/리서치 모듈
 * js/portal-stats.js
 *
 * ISSUE-1: 데이터 정규화 레이어
 *   - portal-data.js의 processBuildings() 결과(window.state.allBuildings)를
 *     입력받아 통계에 필요한 파생 필드를 계산한다.
 *
 * ⚠️ 파싱 주의사항 (portal-detail.js 분석 기반)
 *   1. vacancy.rentPy: 문자열 "85,000" 또는 숫자 혼재 → srParsePrice() 필수
 *   2. vacancy.publishDate: "25.03" 또는 "2025-03" 두 포맷 혼재 → srNormalizeDate()
 *   3. vacancy._key?.endsWith('_meta'): _meta 키는 공실 아님, 반드시 필터
 *   4. region: building.region 없으면 주소 기반 추론 필요
 *   5. floorPricing.effectiveDate: "YYYY-MM" 또는 "YYYY-MM-DD" → slice(0,7)
 *   6. floorPricing 값: 정수(원/평), building.rentPy: 숫자(원/평)
 *      vacancy.rentPy: 문자열 "85,000" 포함 → srParsePrice 후 동일 단위
 */

// ═══════════════════════════════════════════════════════════════
// 1. 날짜/분기 정규화
// ═══════════════════════════════════════════════════════════════

/**
 * 다양한 날짜 포맷을 "YYYY-MM" 으로 정규화
 * 지원 포맷: "25.03" | "2025-03" | "2025-03-01" | "2025.03" | ""
 * @param {string|null} dateStr
 * @returns {string} "YYYY-MM" 또는 ""
 */
export function srNormalizeDate(dateStr) {
    if (!dateStr) return '';
    const s = String(dateStr).trim();

    // "25.03" → "2025-03"
    if (/^\d{2}\.\d{2}$/.test(s)) {
        const [yy, mm] = s.split('.');
        return `20${yy}-${mm}`;
    }
    // "2025.03" → "2025-03"
    if (/^\d{4}\.\d{2}$/.test(s)) {
        return s.replace('.', '-');
    }
    // "2025-03-01" 또는 "2025-03" → "2025-03"
    if (/^\d{4}-\d{2}/.test(s)) {
        return s.slice(0, 7);
    }
    return '';
}

/**
 * "YYYY-MM" → 분기 정보 반환
 * @param {string} yyyyMM  예: "2025-03"
 * @returns {{ label: string, year: number, q: number }}  예: { label:"2025Q1", year:2025, q:1 }
 */
export function srGetQuarter(yyyyMM) {
    const norm = srNormalizeDate(yyyyMM);
    if (!norm) return { label: '', year: 0, q: 0 };
    const [yearStr, monStr] = norm.split('-');
    const year = parseInt(yearStr, 10);
    const mon  = parseInt(monStr,  10);
    const q    = Math.ceil(mon / 3);
    return { label: `${year}Q${q}`, year, q };
}

/**
 * 데이터 내 존재하는 모든 publishDate 목록을 YYYY-MM 정규화 후 정렬
 * @param {Array} buildings  state.allBuildings
 * @returns {string[]}  ["2024-01", "2024-02", ...]
 */
export function srGetAllPublishDates(buildings) {
    const set = new Set();
    (buildings || []).forEach(b => {
        srActiveVacancies(b).forEach(v => {
            const d = srNormalizeDate(v.publishDate);
            if (d) set.add(d);
        });
    });
    return [...set].sort();
}

/**
 * 데이터 내 존재하는 모든 effectiveDate 목록 (floorPricing 기준)
 * @param {Array} buildings
 * @returns {string[]}
 */
export function srGetAllEffectiveDates(buildings) {
    const set = new Set();
    (buildings || []).forEach(b => {
        (b.floorPricing || []).forEach(fp => {
            const d = srNormalizeDate(fp.effectiveDate || fp.createdAt);
            if (d) set.add(d);
        });
    });
    return [...set].sort();
}

// ═══════════════════════════════════════════════════════════════
// 2. 권역 추론
// ═══════════════════════════════════════════════════════════════

/**
 * 주소 문자열에서 권역 추론 (레거시 — 지도/빌딩 상세 등에서 사용)
 * portal-utils.js의 detectRegion()과 동일한 로직 (의존성 없이 자체 구현)
 *
 * @deprecated Phase 1 (2026-04) 이후 통계 경로에서는 사용 금지.
 *   통계 집계·차트·편집 모달은 {@link srDetectReportRegion} 을 사용.
 *   본 함수는 지도 마커/빌딩 상세 등 비-통계 UI 에서만 잔존 사용.
 *   기준 차이:
 *     · 본 함수: GBD 에 송파구 포함, YBD 에 마포/당산 포함
 *     · srDetectReportRegion: 오피스 마켓 리포트 기준 (송파/마포 등은 Others)
 *
 * @param {string} address
 * @returns {"CBD"|"GBD"|"YBD"|"BBD"|"ETC"}
 */
export function srDetectRegion(address) {
    if (!address) return 'ETC';
    const a = address;

    // BBD — 분당/판교 (GBD보다 먼저 체크)
    if (/분당|판교|성남시|수정구|중원구|분당구/.test(a)) return 'BBD';

    // GBD — 강남권역
    if (/강남구|서초구|송파구/.test(a)) return 'GBD';

    // YBD — 여의도권역
    if (/영등포구|여의도|마포구|합정|망원|당산/.test(a)) return 'YBD';

    // CBD — 도심권역
    if (/종로구|중구|을지로|광화문|서울역|남대문|명동|청계|세종대로/.test(a)) return 'CBD';

    return 'ETC';
}

/**
 * 빌딩의 권역 반환 (stored → 추론 fallback)
 * @param {Object} building
 * @returns {"CBD"|"GBD"|"YBD"|"BBD"|"ETC"}
 *
 * @deprecated Phase 1 (2026-04) 이후 통계 경로에서는 {@link srDetectReportRegion} 사용.
 */
export function srGetRegion(building) {
    return building.region || srDetectRegion(building.address) || 'ETC';
}

// ─────────────────────────────────────────────────────────────
// Phase 1 (2026-04) 신설 — 오피스 마켓 리포트 기준 권역 분류
// 기존 srDetectRegion 과 분류 기준이 완전히 다름 (_기준.xlsx 참조)
// ─────────────────────────────────────────────────────────────

/**
 * 주소 문자열에서 리포트 기준 권역 반환
 * 오피스 마켓 리포트 분류기준 (_기준.xlsx) 기반
 *
 * 분류 체계 (2026-04 현업 확정):
 *   서울 내: CBD / GBD / YBD / BBD(분당포함) / Others (9개 서브)
 *   서울 외: ETC (리포트 범위 밖)
 *
 * 핵심 차이점 vs srDetectRegion:
 *   · GBD: 송파구 제외
 *   · YBD: 영등포구 여의도동만 (마포/당산 제외)
 *   · CBD: 종로/중구/서대문구 + 용산구 동자동
 *   · BBD: 성남시 분당구만 (수정구·중원구 제외)
 *   · Others: 서울 내 4대권역 아닌 지역 (9개 서브카테고리)
 *   · ETC: 서울이 아닌 모든 지역 (리포트 범위 밖)
 *
 * 우선순위:
 *   0) 서울/분당 판정 — 아니면 즉시 ETC
 *   1) 특수 동 단위 매칭 (동자동/여의도/상암/마곡)
 *   2) Others 서브카테고리 매칭 (잠실/문정/공덕권)
 *   3) 구 단위 매칭 (CBD/GBD)
 *   4) Others 범용 (영등포/용산/구로·금천)
 *   5) 서울 내 미매칭 → Others (서울기타)
 *
 * @param {string} address
 * @returns {{ region: string, subCategory: string }}
 *   region:      'CBD' | 'GBD' | 'YBD' | 'BBD' | 'Others' | 'ETC'
 *   subCategory: Others 세분화 시 서브 이름 (예: '마포/공덕', 'DMC', '서울기타')
 *                메인 권역인 경우 region 과 동일
 */
export function srDetectReportRegion(address) {
    if (!address) return { region: 'ETC', subCategory: 'ETC' };
    const a = address;

    // ─── 0) 서울/분당 여부 판정 ───
    // BBD (성남시 분당구) 는 서울 아니지만 리포트 4대권역 포함 — 먼저 매칭
    if (/성남시\s*분당구|^분당구|\s분당구/.test(a))
        return { region: 'BBD', subCategory: 'BBD' };

    // 서울 아니면 ETC 직행 (리포트 범위 밖)
    if (!/서울/.test(a))
        return { region: 'ETC', subCategory: 'ETC' };

    // ─── 이하 '서울' 포함 주소에 한해 세분화 ───

    // ─── 1) 특수 동 단위 우선 매칭 (행정동 + 도로명 화이트리스트) ───
    // ※ Phase 1 배포 후 진단 결과 (2026-04-23):
    //   DB 주소가 "행정동" 대신 "도로명" 으로 저장된 빌딩이 대다수라
    //   동 단위 매칭만으로는 대규모 누락 발생 → 도로명 화이트리스트 병행.
    //   화이트리스트는 해당 권역 경계 안에 확실히 있는 도로명만 포함.

    // CBD 예외: 용산구 동자동 (용산구 유일한 CBD)
    //   한강대로는 동자동~한강로3가까지 길게 이어져 구간별 구분 불가 → 동 명시만 CBD
    if (/용산구.*동자동|동자동.*용산구/.test(a))
        return { region: 'CBD', subCategory: 'CBD' };

    // YBD: 영등포구 여의도동 + 여의도 섬 도로명 화이트리스트
    //   포함 도로명: 여의대로·여의공원로·여의나루로·여의대방로·여의동로
    //               · 의사당대로·국제금융로·은행로·국회대로·63로
    //   전부 여의도 섬 안 한정 (지리 검증 완료)
    if (/영등포구/.test(a) && (
        /여의도/.test(a) ||
        /여의대로|여의공원로|여의나루로|여의대방로|여의동로/.test(a) ||
        /의사당대로|국제금융로|은행로|국회대로|63로/.test(a)
    )) return { region: 'YBD', subCategory: 'YBD' };

    // Others/DMC: 마포구 상암동 + 상암/DMC 도로명
    //   포함: 상암산로·성암로·매봉산로·월드컵북로
    //   월드컵북로는 상암 한정으로 간주 (현업 확정 2026-04-23)
    if (/마포구/.test(a) && (
        /상암동/.test(a) ||
        /상암산로|성암로|매봉산로|월드컵북로/.test(a)
    )) return { region: 'Others', subCategory: 'DMC' };

    // Others/마곡: 강서구 마곡동 + 마곡 도로명
    //   포함: 마곡중앙로(+가지도로)·마곡동로
    //   공항대로는 마곡~등촌~염창까지 이어져 제외 (보수적 방침)
    if (/강서구/.test(a) && (
        /마곡동/.test(a) ||
        /마곡중앙.*로|마곡동로/.test(a)
    )) return { region: 'Others', subCategory: '마곡' };

    // ─── 2) Others 서브카테고리 매칭 ───
    if (/송파구\s+(잠실본동|잠실\d동|삼전동|석촌동|방이2동)/.test(a))
        return { region: 'Others', subCategory: '잠실' };
    if (/송파구\s+문정\d동/.test(a))
        return { region: 'Others', subCategory: '송파/문정' };
    if (/마포구\s+(용강동|도화동|공덕동|염리동|아현동|마포동|대흥동)/.test(a))
        return { region: 'Others', subCategory: '마포/공덕' };

    // ─── 3) 구 단위 매칭 (CBD/GBD) ───
    if (/종로구|중구\s|서대문구/.test(a)) return { region: 'CBD', subCategory: 'CBD' };
    if (/서초구|강남구/.test(a))          return { region: 'GBD', subCategory: 'GBD' };

    // ─── 4) Others 범용 카테고리 ───
    if (/영등포구/.test(a))       return { region: 'Others', subCategory: '영등포' };
    if (/용산구/.test(a))         return { region: 'Others', subCategory: '용산' };
    if (/구로구|금천구/.test(a)) return { region: 'Others', subCategory: '구로/가산' };

    // ─── 5) 서울 내 미매칭 ───
    // 예: 송파 거여/오금/가락, 동작구, 강북구, 노원구, 성동구, 성북구, 관악구 등
    return { region: 'Others', subCategory: '서울기타' };
}

/**
 * 간편 래퍼 — region 코드만 반환 (차트/필터 매칭용)
 * @param {string} address
 * @returns {string} 'CBD' | 'GBD' | 'YBD' | 'BBD' | 'Others' | 'ETC'
 */
export function srDetectReportRegionCode(address) {
    return srDetectReportRegion(address).region;
}

// ═══════════════════════════════════════════════════════════════
// 3. 가격 파싱
// ═══════════════════════════════════════════════════════════════

/**
 * 다양한 형식의 임대가 값을 숫자(원/평)로 변환
 * 지원: "85,000" | 85000 | "85000" | "" | null | undefined → 숫자 또는 null
 * @param {*} val
 * @returns {number|null}  원/평 단위 숫자, 파싱 불가 시 null
 */
export function srParsePrice(val) {
    if (val === null || val === undefined || val === '') return null;
    const n = parseFloat(String(val).replace(/[^\d.]/g, ''));
    return isNaN(n) || n === 0 ? null : n;
}

/**
 * 원/평 → 만원/평 변환 (표시용)
 * @param {number|null} wonPy
 * @returns {number|null}
 */
export function srToManwon(wonPy) {
    if (wonPy === null) return null;
    return Math.round(wonPy / 10000 * 10) / 10; // 소수점 1자리
}

// ═══════════════════════════════════════════════════════════════
// 4. 등급 계산
// ═══════════════════════════════════════════════════════════════

/**
 * 연면적(평)에서 자동 등급 계산
 * Prime≥20000 / A≥10000 / B≥5000 / C≥3000 / D≥1000 / E<1000
 * @param {*} grossFloorPy
 * @returns {"Prime"|"A"|"B"|"C"|"D"|"E"|""}
 */
export function srGradeFromPy(grossFloorPy) {
    const py = parseFloat(grossFloorPy) || 0;
    if (py === 0)    return '';
    if (py >= 20000) return 'Prime';
    if (py >= 10000) return 'A';
    if (py >= 5000)  return 'B';
    if (py >= 3000)  return 'C';
    if (py >= 1000)  return 'D';
    return 'E';
}

/**
 * 규모 구간 반환 (필터용)
 * 대형(2만평↑) / 중대형(1만~2만) / 중형(5천~1만) / 소형(5천↓)
 * @param {*} grossFloorPy
 * @returns {"대형"|"중대형"|"중형"|"소형"|""}
 */
export function srSizeBand(grossFloorPy) {
    const py = parseFloat(grossFloorPy) || 0;
    if (py === 0)    return '';
    if (py >= 20000) return '대형';
    if (py >= 10000) return '중대형';
    if (py >= 5000)  return '중형';
    return '소형';
}

// ═══════════════════════════════════════════════════════════════
// 5. 공실 필터
// ═══════════════════════════════════════════════════════════════

/**
 * 빌딩에서 활성 공실만 반환
 * 제외: _key?.endsWith('_meta'), status==='deleted', hidden===true
 * @param {Object} building
 * @returns {Array}
 */
export function srActiveVacancies(building) {
    return (building.vacancies || []).filter(v => {
        if (!v) return false;
        if (v._key?.endsWith('_meta')) return false;
        if (v.status === 'deleted') return false;
        if (v.hidden === true) return false;
        if (v.deleted === true) return false;
        return true;
    });
}

/**
 * 공실의 전용면적(평) 반환 — exclusiveArea 우선, 없으면 rentArea fallback
 * @param {Object} vacancy
 * @returns {number}  면적 없으면 0
 */
export function srVacancyAreaPy(vacancy) {
    const excl = parseFloat(vacancy.exclusiveArea) || 0;
    if (excl > 0) return excl;
    return parseFloat(vacancy.rentArea) || 0;
}

/**
 * 빌딩의 활성 공실 전용면적 합계(평)
 * @param {Object} building
 * @returns {number}
 */
export function srVacancyTotalPy(building) {
    return srActiveVacancies(building).reduce((s, v) => s + srVacancyAreaPy(v), 0);
}

/**
 * 빌딩의 추정 공실률 (공실전용 / 연면적)
 * @param {Object} building
 * @returns {number}  0~100, 계산 불가 시 0
 */
export function srVacancyRate(building) {
    const gross = parseFloat(building.grossFloorPy) || 0;
    if (gross === 0) return 0;
    return srVacancyTotalPy(building) / gross * 100;
}

// ═══════════════════════════════════════════════════════════════
// 6. 기준가 추출 (우선순위 적용)
// ═══════════════════════════════════════════════════════════════

/**
 * 빌딩의 대표 기준가 추출
 * 우선순위:
 *   1. floorPricing[isOfficial=true] 중 effectiveDate 최신
 *   2. floorPricing 중 effectiveDate 최신
 *   3. building.rentPy / depositPy / maintenancePy (루트 레벨)
 *
 * @param {Object} building
 * @returns {{ depositPy:number|null, rentPy:number|null, maintenancePy:number|null,
 *             effectiveDate:string, source:string }}
 */
export function srGetBestRent(building) {
    const fps = (building.floorPricing || []).slice();

    // effectiveDate 내림차순 정렬 (최신 우선)
    fps.sort((a, b) => {
        const da = srNormalizeDate(a.effectiveDate || a.createdAt || '');
        const db = srNormalizeDate(b.effectiveDate || b.createdAt || '');
        return db.localeCompare(da);
    });

    // 1순위: isOfficial=true 중 최신
    const official = fps.find(fp => fp.isOfficial);
    if (official) {
        return {
            depositPy:     srParsePrice(official.depositPy),
            rentPy:        srParsePrice(official.rentPy),
            maintenancePy: srParsePrice(official.maintenancePy),
            effectiveDate: srNormalizeDate(official.effectiveDate || official.createdAt),
            source:        official.sourceCompany || official.sourceType || 'official',
        };
    }

    // 2순위: floorPricing 최신
    if (fps.length > 0) {
        const fp = fps[0];
        return {
            depositPy:     srParsePrice(fp.depositPy),
            rentPy:        srParsePrice(fp.rentPy),
            maintenancePy: srParsePrice(fp.maintenancePy),
            effectiveDate: srNormalizeDate(fp.effectiveDate || fp.createdAt),
            source:        fp.sourceCompany || fp.sourceType || 'floorPricing',
        };
    }

    // 3순위: 빌딩 루트 레벨
    return {
        depositPy:     srParsePrice(building.depositPy),
        rentPy:        srParsePrice(building.rentPy),
        maintenancePy: srParsePrice(building.maintenancePy),
        effectiveDate: '',
        source:        'building',
    };
}

// ═══════════════════════════════════════════════════════════════
// 7. 빌딩 정규화 (파생 필드 일괄 계산)
// ═══════════════════════════════════════════════════════════════

/**
 * building 객체에 통계용 파생 필드를 추가하여 반환
 * 원본 객체를 변경하지 않고 새 객체 반환
 *
 * 추가 파생 필드:
 *   _region       : 리포트 기준 권역 (Phase 1 2026-04 이후)
 *   _subCategory  : Others 서브카테고리 (Phase 2 UI용)
 *   _gradeAuto    : 연면적 기반 자동 등급
 *   _sizeBand     : 규모 구간
 *   _activeVacs   : 활성 공실 배열 (캐시)
 *   _vacancyPy    : 공실 전용면적 합계(평)
 *   _vacancyRate  : 추정 공실률 (%)
 *   _bestRent     : srGetBestRent() 결과
 *
 * ※ Phase 1 (2026-04): _region 계산 방식 변경
 *   이전: building.region (DB 저장값) 우선 사용
 *   이후: 주소만 보고 리포트 기준 재계산 (DB 값 무시)
 *   이유: DB 의 region 은 지도 UI 용이고, 리포트 기준과 분류체계가 다름
 *
 * @param {Object} building
 * @returns {Object}
 */
export function srNormBuilding(building) {
    const activeVacs = srActiveVacancies(building);
    const vacancyPy  = activeVacs.reduce((s, v) => s + srVacancyAreaPy(v), 0);
    const gross      = parseFloat(building.grossFloorPy) || 0;
    const reportReg  = srDetectReportRegion(building.address);  // Phase 1: 리포트 기준 재계산

    return {
        ...building,
        _region:       reportReg.region,        // Phase 1: 리포트 기준
        _subCategory:  reportReg.subCategory,   // Phase 1: Others 서브카테고리 (Phase 2 UI용)
        _gradeAuto:    srGradeFromPy(building.grossFloorPy),
        _sizeBand:     srSizeBand(building.grossFloorPy),
        _activeVacs:   activeVacs,
        _vacancyPy:    vacancyPy,
        _vacancyRate:  gross > 0 ? vacancyPy / gross * 100 : 0,
        _bestRent:     srGetBestRent(building),
    };
}

// ═══════════════════════════════════════════════════════════════
// 8. 빌딩 목록 정규화 + 필터 헬퍼
// ═══════════════════════════════════════════════════════════════

/**
 * state.allBuildings 전체를 정규화
 * @returns {Array}  srNormBuilding() 적용된 배열
 */
export function srGetNormBuildings() {
    return (window.state?.allBuildings || []).map(srNormBuilding);
}

// ─────────────────────────────────────────────────────────────
// 이상값 제외 상태 (ISSUE-7/8 연동)
// ─────────────────────────────────────────────────────────────

/**
 * 이상값 제외 전역 상태
 * excludeSet: "buildingId::vacancyKey" 형식의 제외 대상 Set
 *             MONTH_GAP/AREA_BASIS 같이 vacancyKey 없는 유형은 건물 단위 제외 X
 *             → vacancyKey 있는 PRICE_RANGE / UNIT_MISMATCH / BUILDING_MISMATCH만 제외
 */
const _srAnomalyExclude = {
    enabled:    false,
    excludeSet: new Set(),   // "buildingId::vacancyKey"
    lastCount:  0,
};

/**
 * 영구 제외 상태 (portal-stats-editor.js 와 연동)
 * 2026-04 신규 — 통계 대상 편집 UI 에서 Firebase 로드한 영구 제외를 주입받음.
 *
 * excludedBuildings : Set<buildingId>  — 빌딩 통째 제외 (연면적도 분모에서 빠짐)
 * excludedVacancies : Set<`${bid}__${vkey}`> — vacancy 단위 제외
 * filters           : 2차 필터 ({grades,regions,subRegions,vacOnly}) — 필터 적용
 */
const _srPersistentExclude = {
    excludedBuildings: new Set(),
    excludedVacancies: new Set(),
    filters:           null,
    // Phase 6 Post-Tier B 핫픽스 (2026-04): 분기 인식 추가
    //   loadedQuarter: 현재 인메모리 필터가 어느 분기의 Firebase 스냅샷인지 추적.
    //   빈 문자열 = 아직 특정 분기에 귀속되지 않은 상태(초기).
    //   뷰어가 다른 분기를 보려 할 때 자동으로 재로드하기 위한 키.
    loadedQuarter:     '',
};
// Phase 6 Step 3.5 핫픽스 (2026-04): summary 모듈이 편집 상태에 접근할 수 있도록 window 에 노출.
// ※ _srApplyPersistentExclusions 가 매번 새 Set 을 대입하므로 동일 참조 유지를 위해 객체 자체를 노출.
//   summary 모듈은 이 객체에서 excludedBuildings / excludedVacancies / filters 를 읽기 전용으로 사용.
window._srPersistentExclude = _srPersistentExclude;

/**
 * portal-stats-editor.js 에서 호출하는 주입 함수.
 * Firebase 에 저장된 영구 제외 목록과 필터 설정을 portal-stats 에 반영한다.
 *
 * Phase 6 Post-Tier B 핫픽스 (2026-04): 4번째 인자 quarter 추가.
 *   편집 모달에서 어느 분기를 저장한 결과인지 명시. 뷰어가 다른 분기로 이동하면
 *   _srLoadPersistentForQuarter(otherQ) 로 재로드하여 분기간 누수를 방지.
 *   quarter 생략 시 '' 로 기록되며, 이 경우 재로드 조건에 항상 걸려 안전하게 재동기화됨.
 */
window._srApplyPersistentExclusions = function(excludedBuildings, excludedVacancies, filters, quarter) {
    _srPersistentExclude.excludedBuildings = excludedBuildings instanceof Set ? excludedBuildings : new Set();
    _srPersistentExclude.excludedVacancies = excludedVacancies instanceof Set ? excludedVacancies : new Set();

    // Phase 1 마이그 (2026-04): filters.regions 에 'ETC' 있으면 'Others' 자동 추가
    // 편집 모달에서 저장 직후 이 경로로 주입되므로, _srLoadPersistentForQuarter 와 동일하게 마이그.
    // (기존 ETC 단일 바구니가 신 체계에서 Others + ETC 로 분리되었으므로 집계 범위 유지 목적)
    let appliedFilters = filters || null;
    if (appliedFilters && Array.isArray(appliedFilters.regions)) {
        const regs = [...appliedFilters.regions];
        if (regs.includes('ETC') && !regs.includes('Others')) {
            regs.push('Others');
            appliedFilters = { ...appliedFilters, regions: regs };
        }
    }
    _srPersistentExclude.filters       = appliedFilters;
    _srPersistentExclude.loadedQuarter = typeof quarter === 'string' ? quarter : '';
    // 즉시 현재 탭 재렌더
    if (typeof _srRefreshCurrentTab === 'function') _srRefreshCurrentTab();
};

/**
 * Phase 6 Post-Tier B 핫픽스 (2026-04) — 분기별 영구필터 동기화.
 *
 * 뷰어(권역별공실현황 등)에서 다른 분기를 보려 할 때 호출.
 * Firebase `/statsFilter/{quarter}` 에서 최신 스냅샷을 읽어 _srPersistentExclude 를 교체.
 *
 * 동작 규칙:
 *   · quarter 가 이미 loadedQuarter 와 같으면 no-op (중복 로드 방지)
 *   · Firebase 에 해당 분기 데이터가 없으면 빈 필터로 리셋 (이전 분기 잔존 방지)
 *   · 로드 완료 후 현재 탭 재렌더
 *
 * @param {string} quarter  "2026Q1" 형식
 * @returns {Promise<void>}
 */
window._srLoadPersistentForQuarter = async function(quarter) {
    if (!quarter || typeof quarter !== 'string') return;
    if (_srPersistentExclude.loadedQuarter === quarter) return;  // 이미 해당 분기
    try {
        const { db, ref, get } = await import('./portal-firebase.js');
        const snap = await get(ref(db, `statsFilter/${quarter}`));
        const data = snap.exists() ? (snap.val() || {}) : {};
        _srPersistentExclude.excludedBuildings = new Set(Object.keys(data.excludedBuildings || {}));
        _srPersistentExclude.excludedVacancies = new Set(Object.keys(data.excludedVacancies || {}));

        // Phase 1 마이그 (2026-04): filters.regions 에 'ETC' 있으면 'Others' 자동 추가
        // 이유: 기존 'ETC' 는 "서울외 + 서울내 비주력" 을 모두 포함하는 단일 바구니였음.
        //       신 체계에서 "서울내 비주력" 은 'Others' 로 분리됐으므로 기존 집계 범위 유지를 위해
        //       로드 시점에 자동 확장. 사용자는 편집 모달에서 개별 해제 가능.
        const loadedFilters = data.filters || null;
        if (loadedFilters && Array.isArray(loadedFilters.regions)) {
            const regs = [...loadedFilters.regions];
            if (regs.includes('ETC') && !regs.includes('Others')) {
                regs.push('Others');
            }
            loadedFilters.regions = regs;
        }
        _srPersistentExclude.filters       = loadedFilters;
        _srPersistentExclude.loadedQuarter = quarter;
        if (typeof _srRefreshCurrentTab === 'function') _srRefreshCurrentTab();
    } catch (err) {
        console.warn('[portal-stats] quarter sync failed:', quarter, err);
    }
};

/**
 * 이상값 제외 + 영구 제외가 적용된 정규화 빌딩 배열 반환
 * 통계 렌더 함수에서 srGetNormBuildings() 대신 이 함수를 사용
 *
 * 적용 순서:
 *   1) 2차 필터 (등급/권역/세부권역) — portal-stats-editor 에서 로드한 필터
 *   2) vacOnly (3차 필터) — 공실정보 매칭
 *   3) 빌딩 단위 영구 제외 — 분모에서도 완전히 빠짐
 *   4) vacancy 단위 영구 제외 — 해당 vacancy만 제외, 분모 유지
 *   5) 세션 anomaly 제외 — 기존 로직
 */
function _srGetFilteredNormBuildings() {
    let norm = srGetNormBuildings();

    // ── 1) 2차 필터 (등급/권역/세부권역) ─────────────────────
    const pFilters = _srPersistentExclude.filters;
    if (pFilters) {
        const match = (arr, val) => !arr || !arr.length || arr.includes(val);
        norm = norm.filter(b => {
            if (!match(pFilters.grades,     b._gradeAuto)) return false;
            if (!match(pFilters.regions,    b._region))    return false;
            if (pFilters.subRegions && pFilters.subRegions.length > 0
                && !pFilters.subRegions.includes(b.subRegion || '')) return false;
            return true;
        });
        // ── 2) vacOnly ─────────────────────────────────────────
        if (pFilters.vacOnly) {
            norm = norm.filter(b => (b._activeVacs || []).length > 0);
        }
    }

    // ── 3) 빌딩 단위 영구 제외 ─────────────────────────────
    if (_srPersistentExclude.excludedBuildings.size > 0) {
        norm = norm.filter(b => !_srPersistentExclude.excludedBuildings.has(b.id));
    }

    // ── 4) vacancy 단위 영구 제외 + 5) 세션 anomaly 제외 ──
    const anomalySet     = _srAnomalyExclude.enabled ? _srAnomalyExclude.excludeSet : null;
    const persistentVSet = _srPersistentExclude.excludedVacancies;

    if ((anomalySet && anomalySet.size > 0) || persistentVSet.size > 0) {
        norm = norm.map(b => {
            const safeVacs = b._activeVacs.filter(v => {
                if (!v._key) return true;
                // 세션 anomaly key 는 "bid::vkey", 영구 제외 key 는 "bid__vkey" (Firebase 제약)
                if (anomalySet && anomalySet.has(`${b.id}::${v._key}`))   return false;
                if (persistentVSet.has(`${b.id}__${v._key}`))             return false;
                return true;
            });
            if (safeVacs.length === b._activeVacs.length) return b;
            const vacancyPy = safeVacs.reduce((s, v) => s + srVacancyAreaPy(v), 0);
            const gross     = parseFloat(b.grossFloorPy) || 0;
            return {
                ...b,
                _activeVacs:  safeVacs,
                _vacancyPy:   vacancyPy,
                _vacancyRate: gross > 0 ? vacancyPy / gross * 100 : 0,
            };
        });
    }

    return norm;
}

/** 이상값 제외 토글 (헤더 체크박스 onchange) */
window._srToggleAnomalyExclusion = function(checked) {
    _srAnomalyExclude.enabled = !!checked;
    _srUpdateExcludeBanner();
    _srRefreshCurrentTab();
};

/** 현재 활성 탭 재렌더 */
function _srRefreshCurrentTab() {
    const activeBtn = document.querySelector('.sr-tab[style*="rgb(26, 115, 232)"], .sr-tab[style*="#1a73e8"]');
    const tabId = activeBtn?.id?.replace('srtab-', '') || 'vacancy';
    window.switchSRTab(tabId);
}

/** 제외 배너 + 헤더 뱃지 업데이트 */
function _srUpdateExcludeBanner() {
    const banner   = document.getElementById('sr-anomaly-exclude-banner');
    const badge    = document.getElementById('sr-exclude-badge');
    const cntEl    = document.getElementById('sr-anomaly-exclude-cnt');
    const cnt      = _srAnomalyExclude.excludeSet.size;
    const enabled  = _srAnomalyExclude.enabled && cnt > 0;

    if (banner) banner.style.display = enabled ? 'block' : 'none';
    if (cntEl)  cntEl.textContent    = ` (제외 중인 공실: ${cnt}건)`;
    if (badge) {
        if (cnt > 0) {
            badge.style.display = 'inline';
            badge.textContent   = `${cnt}건 제외 중`;
        } else {
            badge.style.display = 'none';
        }
    }
}

/**
 * 공통 필터 옵션 객체 정의
 * @typedef {Object} SRFilter
 * @property {string}   region    ""|"CBD"|"GBD"|"YBD"|"BBD"|"ETC"
 * @property {string}   grade     ""|"Prime"|"A"|"B"|"C"|"D"|"E"
 * @property {string}   sizeBand  ""|"대형"|"중대형"|"중형"|"소형"
 * @property {string}   dateFrom  "YYYY-MM" (vacancy publishDate 기준)
 * @property {string}   dateTo    "YYYY-MM"
 * @property {string}   priceFrom "YYYY-MM" (floorPricing effectiveDate 기준)
 * @property {string}   priceTo   "YYYY-MM"
 * @property {string}   search    빌딩명 검색어
 * @property {string}   vacFilter ""|"yes"|"no"
 * @property {string}   pm        PM사명
 */

/**
 * 정규화된 빌딩 배열에 SRFilter 적용
 * @param {Array}    normBuildings  srGetNormBuildings() 결과
 * @param {SRFilter} filter
 * @returns {Array}
 */
export function srApplyFilter(normBuildings, filter = {}) {
    // 배열/단일값 모두 지원하는 매칭 헬퍼
    const match = (filterVal, itemVal) => {
        if (!filterVal || (Array.isArray(filterVal) && filterVal.length === 0)) return true;
        return Array.isArray(filterVal) ? filterVal.includes(itemVal) : filterVal === itemVal;
    };

    return normBuildings.filter(b => {
        if (!match(filter.region,    b._region))    return false;
        if (!match(filter.grade,     b._gradeAuto)) return false;
        if (!match(filter.sizeBand,  b._sizeBand))  return false;
        if (filter.vacFilter === 'yes' && b._activeVacs.length === 0) return false;
        if (filter.vacFilter === 'no'  && b._activeVacs.length  >  0) return false;
        if (filter.pm && (b.pm || '') !== filter.pm) return false;
        if (filter.search) {
            const q = filter.search.toLowerCase();
            const n = (b.name || '').toLowerCase();
            const a = (b.address || '').toLowerCase();
            if (!n.includes(q) && !a.includes(q)) return false;
        }
        return true;
    });
}

/**
 * 공실을 날짜 범위로 필터 (publishDate 기준)
 * @param {Array}  vacancies  srActiveVacancies() 결과
 * @param {string} from  "YYYY-MM" (빈 문자열이면 하한 없음)
 * @param {string} to    "YYYY-MM" (빈 문자열이면 상한 없음)
 * @returns {Array}
 */
export function srFilterVacByDate(vacancies, from, to) {
    return vacancies.filter(v => {
        const d = srNormalizeDate(v.publishDate);
        if (!d) return true; // publishDate 없으면 포함
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
    });
}

/**
 * floorPricing을 날짜 범위로 필터 (effectiveDate 기준)
 * @param {Array}  pricings
 * @param {string} from
 * @param {string} to
 * @returns {Array}
 */
export function srFilterPriceByDate(pricings, from, to) {
    return pricings.filter(fp => {
        const d = srNormalizeDate(fp.effectiveDate || fp.createdAt || '');
        if (!d) return true;
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
    });
}

// ═══════════════════════════════════════════════════════════════
// 9. 통계 집계 유틸
// ═══════════════════════════════════════════════════════════════

/**
 * 숫자 배열의 평균 (null 제외)
 * @param {(number|null)[]} arr
 * @returns {number|null}
 */
export function srAvg(arr) {
    const valid = arr.filter(v => v !== null && !isNaN(v));
    if (valid.length === 0) return null;
    return valid.reduce((s, v) => s + v, 0) / valid.length;
}

/**
 * 권역 목록 (표시 순서 고정)
 * Phase 1 (2026-04): Others 추가 — 리포트 기준 6개 체계
 *   · CBD/GBD/YBD/BBD: 리포트 4대 주력 권역 (BBD 는 성남 분당구 포함)
 *   · Others: 서울 내 4대권역 아닌 지역 (9개 서브: 마포/공덕·DMC·잠실·송파문정·영등포·구로가산·용산·마곡·서울기타)
 *   · ETC: 서울 외 (리포트 범위 밖)
 */
export const SR_REGIONS = ['CBD', 'GBD', 'YBD', 'BBD', 'Others', 'ETC'];

/**
 * 등급 목록 (표시 순서 고정)
 */
export const SR_GRADES = ['Prime', 'A', 'B', 'C', 'D', 'E'];

/**
 * 권역별 색상
 * Phase 1 (2026-04): Others 색상 추가
 *   · Others: 기존 ETC 색 계승 (slate-500, 중간톤 회색)
 *   · ETC:    중립 회색 (slate-400, 연한톤) — 리포트 범위 밖임을 시각적 구분
 */
export const SR_REGION_COLOR = {
    CBD:    '#0284c7',
    GBD:    '#16a34a',
    YBD:    '#7c3aed',
    BBD:    '#ea580c',
    Others: '#6b7280',  // 기존 ETC 색 계승
    ETC:    '#9ca3af',  // 연한 회색 (Others 와 구분)
};

/**
 * 등급별 색상
 */
export const SR_GRADE_COLOR = {
    Prime: '#0f4c81',
    A:     '#1a73e8',
    B:     '#34d399',
    C:     '#fbbf24',
    D:     '#f97316',
    E:     '#94a3b8',
};

// ═══════════════════════════════════════════════════════════════
// 10. 모달 공개 API (openStatResearchModal 진입점)
//     — ISSUE-2~5 탭 렌더 함수가 추가될 자리
// ═══════════════════════════════════════════════════════════════

/**
 * 현재 모달 필터 상태
 * ISSUE-2~5에서 공유
 */
export const srFilterState = {
    region:    '',
    grade:     '',
    sizeBand:  '',
    dateFrom:  '',
    dateTo:    '',
    priceFrom: '',
    priceTo:   '',
    vacFilter: '',
    pm:        '',
    search:    '',
};

/** 탭 전환 */
window.switchSRTab = function(tab) {
    const tabs = ['summary', 'vacancy', 'rent', 'building', 'table', 'anomaly'];
    tabs.forEach(t => {
        const btn   = document.getElementById(`srtab-${t}`);
        const panel = document.getElementById(`srpanel-${t}`);
        if (!btn || !panel) return;
        const active = (t === tab);
        btn.style.color        = active ? '#1a73e8' : 'var(--text-muted)';
        btn.style.borderBottom = active ? '2px solid #1a73e8' : '2px solid transparent';
        panel.style.display    = active ? 'block' : 'none';
    });
    if (tab === 'summary'  && typeof window._srRenderSummary  === 'function') window._srRenderSummary();
    if (tab === 'vacancy'  && typeof window._srRenderVacancy  === 'function') window._srRenderVacancy();
    if (tab === 'rent'     && typeof window._srRenderRent     === 'function') window._srRenderRent();
    if (tab === 'building' && typeof window._srRenderBuilding === 'function') window._srRenderBuilding();
    if (tab === 'table'    && typeof window._srRenderTable    === 'function') window._srRenderTable();
    if (tab === 'anomaly'  && typeof window._srRenderAnomaly  === 'function') window._srRenderAnomaly();
};

/** 모달 열기 */
window.openStatResearchModal = function() {
    const modal = document.getElementById('statResearchModal');
    if (!modal) { console.warn('[portal-stats] statResearchModal not found'); return; }
    modal.style.display = 'flex';
    // 영구 제외 자동 로드 (portal-stats-editor.js 와 연동)
    if (typeof window._seAutoLoadForStats === 'function') {
        window._seAutoLoadForStats().catch(err => console.warn('[portal-stats] stats filter auto-load failed:', err));
    }
    window.switchSRTab('summary');
};

/** 모달 닫기 */
window.closeStatResearchModal = function() {
    const modal = document.getElementById('statResearchModal');
    if (modal) modal.style.display = 'none';
};

/** 새로고침 */
window.refreshStatResearch = function() {
    const activeTab = [...document.querySelectorAll('.sr-tab')]
        .find(btn => btn.style.color === 'rgb(26, 115, 232)');  // #1a73e8
    const tabId = activeTab?.id?.replace('srtab-', '') || 'vacancy';
    window.switchSRTab(tabId);
};

// ESC 키 닫기 (중복 방지: 기존 핸들러 있으면 skip)
if (!window._srEscRegistered) {
    window._srEscRegistered = true;
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return;
        // 편집 모달이 열려있으면 먼저 닫기
        const editor = document.getElementById('stats-editor-modal');
        if (editor && editor.style.display !== 'none' && editor.style.display !== '') {
            if (typeof window.closeStatsEditorModal === 'function') window.closeStatsEditorModal();
            return;
        }
        const modal = document.getElementById('statResearchModal');
        if (modal && modal.style.display !== 'none') window.closeStatResearchModal();
    });
}

// ─────────────────────────────────────────────────────────────
// 전역 노출 (portal.html 인라인 스크립트 및 이후 ISSUE에서 참조)
// ─────────────────────────────────────────────────────────────
window.srLib = {
    // ── ISSUE-1: 데이터 정규화 레이어 ──
    srNormalizeDate,
    srGetQuarter,
    srGetAllPublishDates,
    srGetAllEffectiveDates,
    srDetectRegion,
    srGetRegion,
    srDetectReportRegion,      // Phase 1 (2026-04): 리포트 기준 권역 분류
    srDetectReportRegionCode,  // Phase 1 (2026-04): 리포트 기준 권역 코드만 반환
    srParsePrice,
    srToManwon,
    srGradeFromPy,
    srSizeBand,
    srActiveVacancies,
    srVacancyAreaPy,
    srVacancyTotalPy,
    srVacancyRate,
    srGetBestRent,
    srNormBuilding,
    srGetNormBuildings,
    srApplyFilter,
    srFilterVacByDate,
    srFilterPriceByDate,
    srAvg,
    srFilterState,
    SR_REGIONS,
    SR_GRADES,
    SR_REGION_COLOR,
    SR_GRADE_COLOR,
    // ── ISSUE-5: Excel 다운로드 ──
    downloadExcel: () => window._srDownloadExcel?.(),
};

// ═══════════════════════════════════════════════════════════════
// 공통: 복수 선택 멀티픽커 (MultiPicker)
// 권역·등급·규모 필터를 단일 선택 → 복수 선택으로 지원
// ═══════════════════════════════════════════════════════════════

/** 멀티픽커 레지스트리: id → { values:Set, placeholder:string, onChange:fn } */
const _srMultiReg = {};

/**
 * 멀티픽커 HTML 생성 (체크박스 드롭다운)
 * @param {string}   id          고유 식별자 (예: 'srF-region')
 * @param {string}   placeholder 미선택 시 표시 텍스트 (예: '전체 권역')
 * @param {Array}    options     [[value, label], ...] 형식
 * @param {Function} onChangeFn  값 변경 시 호출할 콜백
 * @returns {string} HTML 문자열
 */
function _srMultiPicker(id, placeholder, options, onChangeFn) {
    if (!_srMultiReg[id]) _srMultiReg[id] = { values: new Set() };
    const reg = _srMultiReg[id];
    reg.placeholder = placeholder;
    reg.onChange    = onChangeFn;

    const vals  = reg.values;
    const label = _srMultiBtnLabel(id);
    const active = vals.size > 0;

    const optHtml = options.map(([v, l]) => `
        <label style="display:flex;align-items:center;gap:7px;padding:6px 12px;cursor:pointer;
                       font-size:12px;white-space:nowrap;border-radius:5px;transition:background 0.1s;"
               onmouseover="this.style.background='var(--bg-secondary)'"
               onmouseout="this.style.background='transparent'"
               onclick="event.stopPropagation()">
          <input type="checkbox" value="${v}" ${vals.has(v)?'checked':''}
                 onchange="window._srMultiToggle('${id}','${v}',this.checked)"
                 style="accent-color:#1a73e8;cursor:pointer;width:13px;height:13px;flex-shrink:0;">
          <span>${l}</span>
        </label>`).join('');

    return `
    <div class="sr-multi-wrap" id="${id}-wrap"
         style="position:relative;display:inline-block;flex-shrink:0;">
      <button type="button"
          onclick="event.stopPropagation();window._srMultiOpen('${id}')"
          style="padding:5px 10px;border:1px solid ${active?'#93c5fd':'var(--border-color)'};
                 border-radius:6px;background:${active?'#eff6ff':'var(--bg-primary)'};
                 color:${active?'#1e40af':'var(--text-primary)'};
                 font-size:12px;cursor:pointer;white-space:nowrap;min-width:80px;text-align:left;
                 display:flex;align-items:center;justify-content:space-between;gap:6px;">
        <span id="${id}-label">${label}</span>
        <span style="opacity:0.45;font-size:9px;flex-shrink:0;">▾</span>
      </button>
      <div id="${id}-dropdown" class="sr-multi-dd"
           style="display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:9999;
                  background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px;
                  box-shadow:0 6px 20px rgba(0,0,0,0.15);padding:6px 4px;min-width:148px;"
           onclick="event.stopPropagation()">
        <div style="display:flex;justify-content:space-between;padding:4px 10px 6px;
                    border-bottom:1px solid var(--border-color);margin-bottom:3px;">
          <span style="font-size:10px;color:var(--text-muted);">${placeholder}</span>
          <button type="button" onclick="window._srMultiClear('${id}')"
              style="font-size:10px;color:#1a73e8;background:none;border:none;cursor:pointer;padding:0;">
            전체해제
          </button>
        </div>
        ${optHtml}
      </div>
    </div>`;
}

/** 버튼 레이블 텍스트 계산 */
function _srMultiBtnLabel(id) {
    const reg = _srMultiReg[id];
    if (!reg || reg.values.size === 0) return reg?.placeholder || '';
    const vals = [...reg.values];
    if (vals.length === 1) return vals[0];
    if (vals.length === 2) return vals.join(', ');
    return `${vals[0]} 외 ${vals.length - 1}`;
}

/** 드롭다운 열기/닫기 토글 */
window._srMultiOpen = function(id) {
    document.querySelectorAll('.sr-multi-dd').forEach(dd => {
        if (dd.id !== `${id}-dropdown`) dd.style.display = 'none';
    });
    const dd = document.getElementById(`${id}-dropdown`);
    if (dd) dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
};

/** 체크박스 토글 */
window._srMultiToggle = function(id, value, checked) {
    const reg = _srMultiReg[id];
    if (!reg) return;
    if (checked) reg.values.add(value);
    else         reg.values.delete(value);
    _srMultiRefreshBtn(id);
    if (reg.onChange) reg.onChange();
};

/** 전체 해제 */
window._srMultiClear = function(id) {
    const reg = _srMultiReg[id];
    if (!reg) return;
    reg.values.clear();
    const dd = document.getElementById(`${id}-dropdown`);
    if (dd) dd.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
    _srMultiRefreshBtn(id);
    if (reg.onChange) reg.onChange();
};

/** 버튼 텍스트 + 색상 갱신 */
function _srMultiRefreshBtn(id) {
    const reg   = _srMultiReg[id];
    if (!reg) return;
    const label = document.getElementById(`${id}-label`);
    const btn   = label?.closest('button');
    const active = reg.values.size > 0;
    if (label) label.textContent = _srMultiBtnLabel(id);
    if (btn) {
        btn.style.borderColor  = active ? '#93c5fd' : 'var(--border-color)';
        btn.style.background   = active ? '#eff6ff'  : 'var(--bg-primary)';
        btn.style.color        = active ? '#1e40af'  : 'var(--text-primary)';
    }
}

/** 멀티픽커 현재 선택 값 배열 반환 */
window._srGetMultiValues = function(id) {
    return _srMultiReg[id] ? [..._srMultiReg[id].values] : [];
};

/** 클릭 외부 시 모든 드롭다운 닫기 (1회 등록) */
if (!window._srMultiClickRegistered) {
    window._srMultiClickRegistered = true;
    document.addEventListener('click', () => {
        document.querySelectorAll('.sr-multi-dd').forEach(dd => { dd.style.display = 'none'; });
    });
}

// ═══════════════════════════════════════════════════════════════
// ISSUE-2: TAB1 — 공실 현황 대시보드
// ═══════════════════════════════════════════════════════════════

// ── 공통 필터 UI 상태 (모든 탭이 공유) ──
const _srUI = {
    region:    [],   // 복수 선택 배열
    grade:     [],
    sizeBand:  [],
    dateFrom:  '',
    dateTo:    '',
    sortCol:   'vacancyPy',
    sortDir:   'desc',
};

// ─────────────────────────────────────────────────────────────
// 2-A. 공통 필터 바 렌더 (TAB1 상단, 이후 탭도 재사용)
// ─────────────────────────────────────────────────────────────
function _srRenderFilterBar(containerId, onChangeCb) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;

    // 날짜 옵션: 데이터 내 실제 publishDate 목록
    const allDates = srGetAllPublishDates(window.state?.allBuildings || []);
    const dateOpts = allDates.map(d => `<option value="${d}">${d}</option>`).join('');

    const regionPicker = _srMultiPicker('srF-region', '전체 권역',
        SR_REGIONS.map(r => [r, r]), window._srOnFilterChange);
    const gradePicker = _srMultiPicker('srF-grade', '전체 등급',
        SR_GRADES.map(g => [g, g]), window._srOnFilterChange);
    const sizePicker = _srMultiPicker('srF-size', '전체 규모', [
        ['대형','대형 (2만평↑)'],['중대형','중대형 (1만~2만)'],
        ['중형','중형 (5천~1만)'],['소형','소형 (5천↓)'],
    ], window._srOnFilterChange);

    wrap.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 0 4px;">
      ${regionPicker}
      ${gradePicker}
      ${sizePicker}
      <span style="font-size:12px; color:var(--text-muted); white-space:nowrap;">발행월</span>
      <select id="srF-from" onchange="_srOnFilterChange()"
        style="padding:5px 10px; border:1px solid var(--border-color); border-radius:6px;
               background:var(--bg-primary); color:var(--text-primary); font-size:12px; cursor:pointer;">
        <option value="">시작월</option>${dateOpts}
      </select>
      <span style="font-size:12px; color:var(--text-muted);">~</span>
      <select id="srF-to" onchange="_srOnFilterChange()"
        style="padding:5px 10px; border:1px solid var(--border-color); border-radius:6px;
               background:var(--bg-primary); color:var(--text-primary); font-size:12px; cursor:pointer;">
        <option value="">종료월</option>${dateOpts}
      </select>
      <button onclick="_srResetFilter()"
        style="padding:5px 12px; border:1px solid var(--border-color); border-radius:6px;
               background:var(--bg-primary); color:var(--text-muted); font-size:12px; cursor:pointer;">
        ↺ 초기화
      </button>
      <button onclick="_srOpenCompareModal()" title="두 분기의 공실 변화를 AI 가 분석"
        style="padding:5px 12px; border:1px solid #7c3aed; border-radius:6px;
               background:linear-gradient(135deg, #7c3aed 0%, #a855f7 100%);
               color:#fff; font-size:12px; cursor:pointer; font-weight:600;
               box-shadow:0 1px 3px rgba(124,58,237,.3);">
        📊 분기 비교 분석
      </button>
      <span id="sr-filter-summary"
        style="margin-left:auto; font-size:11px; color:var(--text-muted); white-space:nowrap;"></span>
    </div>`;

    // 날짜 상태 복원
    const fEl = document.getElementById('srF-from');
    const tEl = document.getElementById('srF-to');
    if (fEl) fEl.value = _srUI.dateFrom;
    if (tEl) tEl.value = _srUI.dateTo;
}

window._srOnFilterChange = function() {
    _srUI.region   = window._srGetMultiValues('srF-region');
    _srUI.grade    = window._srGetMultiValues('srF-grade');
    _srUI.sizeBand = window._srGetMultiValues('srF-size');
    _srUI.dateFrom = document.getElementById('srF-from')?.value || '';
    _srUI.dateTo   = document.getElementById('srF-to')?.value   || '';

    // Phase 6 Post-Tier B 핫픽스 (2026-04): 날짜 범위가 단일 분기로 좁혀지면
    // 해당 분기의 영구필터(편집 저장본)를 Firebase 에서 자동 로드.
    // 분기 누수(last-saved quarter 의 제외목록이 다른 분기 뷰에 적용) 방지.
    // ※ 범위가 여러 분기를 걸치면(예: 2025-12 ~ 2026-03) 현재 인메모리 유지 — 모호성 회피.
    const qFrom = _srUI.dateFrom ? srGetQuarter(_srUI.dateFrom).label : '';
    const qTo   = _srUI.dateTo   ? srGetQuarter(_srUI.dateTo).label   : '';
    if (qFrom && qTo && qFrom === qTo && qFrom !== _srPersistentExclude.loadedQuarter) {
        if (typeof window._srLoadPersistentForQuarter === 'function') {
            window._srLoadPersistentForQuarter(qFrom);
            // 비동기 로드 완료 시 내부에서 _srRefreshCurrentTab 재호출되므로 여기선 return.
            return;
        }
    }

    window._srRenderVacancy();
};

window._srResetFilter = function() {
    ['srF-region','srF-grade','srF-size'].forEach(id => {
        if (_srMultiReg[id]) { _srMultiReg[id].values.clear(); _srMultiRefreshBtn(id); }
        const dd = document.getElementById(`${id}-dropdown`);
        if (dd) dd.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
    });
    _srUI.region = _srUI.grade = _srUI.sizeBand = [];
    _srUI.dateFrom = _srUI.dateTo = '';
    const fEl = document.getElementById('srF-from');
    const tEl = document.getElementById('srF-to');
    if (fEl) fEl.value = '';
    if (tEl) tEl.value = '';
    window._srRenderVacancy();
};

// ─────────────────────────────────────────────────────────────
// 2-B. KPI 카드 렌더
// ─────────────────────────────────────────────────────────────
function _srRenderKPI(filtered) {
    const el = document.getElementById('sr-kpi-row');
    if (!el) return;

    let totalVacs = 0, totalVacPy = 0, vacBldgs = 0, totalGross = 0;
    let latestDate = '';

    filtered.forEach(b => {
        const vacs = srFilterVacByDate(b._activeVacs, _srUI.dateFrom, _srUI.dateTo);
        const vpy  = vacs.reduce((s, v) => s + srVacancyAreaPy(v), 0);
        totalVacs  += vacs.length;
        totalVacPy += vpy;
        if (vpy > 0) vacBldgs++;
        totalGross += parseFloat(b.grossFloorPy) || 0;

        vacs.forEach(v => {
            const d = srNormalizeDate(v.publishDate);
            if (d > latestDate) latestDate = d;
        });
    });

    const vacRate = totalGross > 0 ? (totalVacPy / totalGross * 100).toFixed(1) : '-';

    const cards = [
        { icon:'🏢', label:'분석 빌딩',     value: filtered.length.toLocaleString() + '개',       color:'#1a73e8' },
        { icon:'🔴', label:'공실 있는 빌딩', value: vacBldgs.toLocaleString() + '개',              color:'#dc2626' },
        { icon:'📋', label:'공실 건수',      value: totalVacs.toLocaleString() + '건',             color:'#d97706' },
        { icon:'📐', label:'공실 전용면적',  value: Math.round(totalVacPy).toLocaleString() + '평', color:'#9333ea' },
        { icon:'📊', label:'추정 공실률',    value: vacRate + '%',                                 color: parseFloat(vacRate) > 10 ? '#dc2626' : parseFloat(vacRate) > 5 ? '#d97706' : '#16a34a' },
    ];

    el.innerHTML = cards.map(c => `
      <div style="background:var(--bg-secondary); border:1px solid var(--border-color);
                  border-radius:10px; padding:14px 16px;">
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">${c.icon} ${c.label}</div>
        <div style="font-size:22px; font-weight:700; color:${c.color};">${c.value}</div>
      </div>`).join('');

    // 기준월 표시
    const summary = document.getElementById('sr-filter-summary');
    if (summary) summary.textContent = latestDate ? `최신 데이터: ${latestDate}` : '';
}

// ─────────────────────────────────────────────────────────────
// 2-C. 시계열 스택바 차트 (월별/분기별)
// ─────────────────────────────────────────────────────────────
function _srRenderTimeSeries(filtered) {
    const wrap = document.getElementById('sr-timeseries-wrap');
    if (!wrap) return;

    const modeEl = document.getElementById('sr-ts-mode');
    const mode   = modeEl?.value || 'month';  // "month" | "quarter"

    // 기간 버킷 집계 { "2025-01": { CBD:0, GBD:0, ... }, ... }
    const buckets = {};
    filtered.forEach(b => {
        const vacs = srFilterVacByDate(b._activeVacs, _srUI.dateFrom, _srUI.dateTo);
        vacs.forEach(v => {
            const raw   = srNormalizeDate(v.publishDate);
            if (!raw) return;
            const key   = mode === 'quarter' ? srGetQuarter(raw).label : raw;
            const rgn   = b._region;
            if (!buckets[key]) { buckets[key] = {}; SR_REGIONS.forEach(r => buckets[key][r] = 0); }
            buckets[key][rgn] = (buckets[key][rgn] || 0) + srVacancyAreaPy(v);
        });
    });

    // 최근 N 버킷만 표시
    const N = mode === 'quarter' ? 8 : 12;
    const keys = Object.keys(buckets).sort().slice(-N);

    if (keys.length === 0) {
        wrap.innerHTML = '<div style="padding:32px; text-align:center; color:var(--text-muted);">데이터 없음</div>';
        return;
    }

    const maxTotal = Math.max(...keys.map(k => SR_REGIONS.reduce((s,r) => s+(buckets[k][r]||0), 0)), 1);

    const bars = keys.map(k => {
        const total = SR_REGIONS.reduce((s, r) => s + (buckets[k][r] || 0), 0);
        const barW  = (total / maxTotal * 100).toFixed(1);
        const segs  = SR_REGIONS
            .filter(r => buckets[k][r] > 0)
            .map(r => {
                const pct = (buckets[k][r] / total * 100).toFixed(1);
                return `<div title="${r}: ${Math.round(buckets[k][r]).toLocaleString()}평"
                             style="width:${pct}%; background:${SR_REGION_COLOR[r]}; height:100%;
                                    display:inline-block; vertical-align:top;"></div>`;
            }).join('');
        return `
          <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <div style="width:52px; font-size:11px; color:var(--text-muted); text-align:right;
                        white-space:nowrap; flex-shrink:0;">${k}</div>
            <div style="flex:1; background:var(--bg-secondary); border-radius:4px;
                        overflow:hidden; height:18px; position:relative;">
              <div style="height:100%; width:${barW}%; display:flex;">${segs}</div>
            </div>
            <div style="width:72px; font-size:11px; color:var(--text-muted); text-align:right;
                        flex-shrink:0;">${Math.round(total).toLocaleString()}평</div>
          </div>`;
    }).join('');

    // 범례
    const legend = SR_REGIONS.map(r =>
        `<span style="display:inline-flex; align-items:center; gap:4px; margin-right:12px; font-size:11px;">
           <span style="width:10px;height:10px;border-radius:2px;background:${SR_REGION_COLOR[r]};display:inline-block;"></span>
           ${r}
         </span>`).join('');

    wrap.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:10px; flex-wrap:wrap;">
        <select id="sr-ts-mode" onchange="_srRenderVacancy()"
          style="padding:4px 8px; border:1px solid var(--border-color); border-radius:5px;
                 background:var(--bg-primary); color:var(--text-primary); font-size:12px; cursor:pointer;">
          <option value="month"   ${mode==='month'  ?'selected':''}>월별</option>
          <option value="quarter" ${mode==='quarter'?'selected':''}>분기별</option>
        </select>
        <div style="margin-left:auto;">${legend}</div>
      </div>
      ${bars}`;
}

// ─────────────────────────────────────────────────────────────
// 2-D. 권역×등급 교차 테이블
// ─────────────────────────────────────────────────────────────
function _srRenderCrossTable(filtered) {
    const el = document.getElementById('sr-vacancy-cross');
    if (!el) return;

    // [region][grade] → { cnt, py }
    const data = {};
    SR_REGIONS.forEach(r => { data[r] = {}; SR_GRADES.forEach(g => { data[r][g] = {cnt:0, py:0}; }); });

    filtered.forEach(b => {
        const r    = b._region;
        const g    = b._gradeAuto || 'E';
        const vacs = srFilterVacByDate(b._activeVacs, _srUI.dateFrom, _srUI.dateTo);
        if (!(r in data)) return;
        vacs.forEach(v => {
            data[r][g].cnt++;
            data[r][g].py += srVacancyAreaPy(v);
        });
    });

    const rowTotals = SR_REGIONS.map(r => ({
        cnt: SR_GRADES.reduce((s,g)=>s+data[r][g].cnt, 0),
        py:  SR_GRADES.reduce((s,g)=>s+data[r][g].py,  0),
    }));
    const colTotals = SR_GRADES.map(g => ({
        cnt: SR_REGIONS.reduce((s,r)=>s+data[r][g].cnt, 0),
        py:  SR_REGIONS.reduce((s,r)=>s+data[r][g].py,  0),
    }));

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0; z-index:1;">
        <tr>
          <th style="padding:8px 10px; text-align:left; border-bottom:2px solid var(--border-color);">권역</th>
          ${SR_GRADES.map((g,i)=>`
            <th style="padding:8px 10px; text-align:center; border-bottom:2px solid var(--border-color);
                       color:${SR_GRADE_COLOR[g]};">${g}</th>`).join('')}
          <th style="padding:8px 10px; text-align:right; border-bottom:2px solid var(--border-color);">합계</th>
        </tr>
      </thead>
      <tbody>`;

    SR_REGIONS.forEach((r, ri) => {
        const rt = rowTotals[ri];
        html += `<tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px 10px; font-weight:700; color:${SR_REGION_COLOR[r]};">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                         background:${SR_REGION_COLOR[r]};margin-right:5px;"></span>${r}
          </td>
          ${SR_GRADES.map(g => {
              const d = data[r][g];
              if (d.cnt === 0) return `<td style="padding:8px 10px; text-align:center; color:var(--text-muted);">-</td>`;
              return `<td style="padding:8px 10px; text-align:center;" title="${r} ${g}: ${Math.round(d.py).toLocaleString()}평">
                        <strong style="color:${SR_GRADE_COLOR[g]};">${d.cnt}</strong>
                        <span style="font-size:10px; color:var(--text-muted); display:block;">${Math.round(d.py).toLocaleString()}평</span>
                      </td>`;
          }).join('')}
          <td style="padding:8px 10px; text-align:right; font-weight:600;">
            ${rt.cnt}<span style="font-size:10px;color:var(--text-muted);display:block;">${Math.round(rt.py).toLocaleString()}평</span>
          </td>
        </tr>`;
    });

    // 합계 행
    const grandCnt = rowTotals.reduce((s,t)=>s+t.cnt,0);
    const grandPy  = rowTotals.reduce((s,t)=>s+t.py, 0);
    html += `<tr style="background:var(--bg-secondary); font-weight:700; border-top:2px solid var(--border-color);">
      <td style="padding:8px 10px;">합계</td>
      ${colTotals.map(ct=>
        `<td style="padding:8px 10px; text-align:center;">
           ${ct.cnt ? ct.cnt : '-'}
           ${ct.py ? `<span style="font-size:10px;color:var(--text-muted);display:block;">${Math.round(ct.py).toLocaleString()}평</span>` : ''}
         </td>`).join('')}
      <td style="padding:8px 10px; text-align:right;">
        ${grandCnt}<span style="font-size:10px;color:var(--text-muted);display:block;">${Math.round(grandPy).toLocaleString()}평</span>
      </td>
    </tr>`;
    html += '</tbody></table>';
    el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// 2-E. 빌딩별 공실 Top20 테이블
// ─────────────────────────────────────────────────────────────
function _srRenderTop20(filtered) {
    const el = document.getElementById('sr-top20');
    if (!el) return;

    // 공실면적 내림차순 Top20
    const ranked = filtered
        .map(b => {
            const vacs = srFilterVacByDate(b._activeVacs, _srUI.dateFrom, _srUI.dateTo);
            const py   = vacs.reduce((s,v)=>s+srVacancyAreaPy(v), 0);
            return { b, vacs, py };
        })
        .filter(row => row.py > 0 || row.vacs.length > 0)
        .sort((a,b) => b.py - a.py)
        .slice(0, 20);

    if (ranked.length === 0) {
        el.innerHTML = '<div style="padding:32px; text-align:center; color:var(--text-muted);">공실 데이터 없음</div>';
        return;
    }

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0; z-index:1;">
        <tr>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:center; width:30px;">#</th>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:left;">빌딩명</th>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:center;">권역</th>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:center;">등급</th>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:right;">연면적(평)</th>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:right;">공실건수</th>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:right;">공실면적(평)</th>
          <th style="padding:7px 10px; border-bottom:2px solid var(--border-color); text-align:right;">추정공실률</th>
        </tr>
      </thead>
      <tbody>`;

    ranked.forEach(({ b, vacs, py }, idx) => {
        const gross    = parseFloat(b.grossFloorPy) || 0;
        const rate     = gross > 0 ? (py / gross * 100).toFixed(1) + '%' : '-';
        const rateNum  = gross > 0 ? py / gross * 100 : 0;
        const rateClr  = rateNum > 15 ? '#dc2626' : rateNum > 8 ? '#d97706' : '#16a34a';
        const bg       = idx % 2 === 1 ? 'background:var(--bg-secondary);' : '';
        const clickFn  = `window.openStatBuildingDetail && window.openStatBuildingDetail('${b.id}')`;

        html += `
        <tr style="${bg} border-bottom:1px solid var(--border-color); cursor:pointer;"
            onclick="${clickFn}"
            onmouseover="this.style.background='var(--bg-hover, var(--bg-secondary))'"
            onmouseout="this.style.background='${idx%2===1?'var(--bg-secondary)':'transparent'}'">
          <td style="padding:7px 10px; text-align:center; color:var(--text-muted); font-weight:600;">${idx+1}</td>
          <td style="padding:7px 10px; font-weight:500; max-width:160px; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap;" title="${b.name}">${b.name||'-'}</td>
          <td style="padding:7px 10px; text-align:center; font-weight:700; color:${SR_REGION_COLOR[b._region]||'#64748b'};">${b._region}</td>
          <td style="padding:7px 10px; text-align:center; font-weight:700; color:${SR_GRADE_COLOR[b._gradeAuto]||'#94a3b8'};">${b._gradeAuto||'-'}</td>
          <td style="padding:7px 10px; text-align:right; color:var(--text-muted);">${gross?Math.round(gross).toLocaleString():'-'}</td>
          <td style="padding:7px 10px; text-align:right; color:#dc2626; font-weight:600;">${vacs.length}</td>
          <td style="padding:7px 10px; text-align:right; font-weight:700; color:#d97706;">${Math.round(py).toLocaleString()}</td>
          <td style="padding:7px 10px; text-align:right; font-weight:700; color:${rateClr};">${rate}</td>
        </tr>`;
    });

    html += '</tbody></table>';
    el.innerHTML = html;
}

// 빌딩 행 클릭 시 상세패널 연동
window.openStatBuildingDetail = function(buildingId) {
    if (!buildingId) return;
    // portal-detail.js의 openDetail 또는 showBuildingDetail 함수 호출 시도
    if (typeof window.showBuildingDetail === 'function') {
        window.closeStatResearchModal();
        window.showBuildingDetail(buildingId);
        return;
    }
    if (typeof window.openDetail === 'function') {
        const b = window.state?.allBuildings?.find(x => x.id === buildingId);
        if (b) { window.closeStatResearchModal(); window.openDetail(b); }
        return;
    }
    // fallback: 지도에서 찾기
    const b = window.state?.allBuildings?.find(x => x.id === buildingId);
    if (b && window.panToBuilding) {
        window.closeStatResearchModal();
        setTimeout(() => window.panToBuilding(b), 200);
    }
};

// ─────────────────────────────────────────────────────────────
// 2-F. 권역별 공실률 바 (요약)
// ─────────────────────────────────────────────────────────────
function _srRenderRegionBars(filtered) {
    const el = document.getElementById('sr-region-bars');
    if (!el) return;

    const stats = {};
    SR_REGIONS.forEach(r => { stats[r] = { gross:0, vacPy:0, cnt:0 }; });

    filtered.forEach(b => {
        const r    = b._region;
        const vacs = srFilterVacByDate(b._activeVacs, _srUI.dateFrom, _srUI.dateTo);
        const py   = vacs.reduce((s,v)=>s+srVacancyAreaPy(v), 0);
        if (!(r in stats)) return;
        stats[r].gross += parseFloat(b.grossFloorPy) || 0;
        stats[r].vacPy += py;
        stats[r].cnt   += vacs.length;
    });

    const maxRate = Math.max(...SR_REGIONS.map(r =>
        stats[r].gross > 0 ? stats[r].vacPy / stats[r].gross * 100 : 0), 1);

    el.innerHTML = SR_REGIONS.map(r => {
        const s    = stats[r];
        const rate = s.gross > 0 ? (s.vacPy / s.gross * 100) : 0;
        const barW = (rate / maxRate * 100).toFixed(1);
        const clr  = SR_REGION_COLOR[r];
        return `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <div style="width:36px; font-weight:700; font-size:12px; color:${clr}; flex-shrink:0;">${r}</div>
          <div style="flex:1; background:var(--bg-secondary); border-radius:5px; overflow:hidden;
                      height:20px; position:relative; min-width:0;">
            <div style="height:100%; width:${barW}%; background:${clr}; border-radius:5px;
                        transition:width 0.4s ease;"></div>
            <span style="position:absolute; left:8px; top:50%; transform:translateY(-50%);
                         font-size:11px; font-weight:600; color:#fff;
                         text-shadow:0 1px 2px rgba(0,0,0,0.5);">${rate.toFixed(1)}%</span>
          </div>
          <div style="width:120px; font-size:11px; color:var(--text-muted); text-align:right; flex-shrink:0;">
            ${Math.round(s.vacPy).toLocaleString()}평 / ${s.cnt}건
          </div>
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// 2-G. TAB1 메인 렌더 (모든 섹션 조합)
// ─────────────────────────────────────────────────────────────
window._srRenderVacancy = function() {
    const normBuildings = _srGetFilteredNormBuildings();
    const filtered = srApplyFilter(normBuildings, {
        region:   _srUI.region,    // 배열 or 빈배열
        grade:    _srUI.grade,
        sizeBand: _srUI.sizeBand,
    });

    // 필터 UI (최초 렌더 또는 재렌더)
    _srRenderFilterBar('sr-filter-bar', window._srRenderVacancy);

    // 각 섹션 렌더
    _srRenderKPI(filtered);
    _srRenderRegionBars(filtered);
    _srRenderTimeSeries(filtered);
    _srRenderCrossTable(filtered);
    _srRenderTop20(filtered);

    // 필터 요약
    const summary = document.getElementById('sr-filter-summary');
    if (summary) {
        const parts = [];
        // Phase 6 Post-Tier B 핫픽스 (2026-04): 현재 적용 중인 영구필터 분기를 맨 앞에 노출.
        // 편집 저장 후 어떤 분기의 제외목록이 이 뷰에 적용되는지 항상 보이게 하여 혼동 방지.
        if (_srPersistentExclude.loadedQuarter) {
            parts.push(`📌 영구필터: ${_srPersistentExclude.loadedQuarter}`);
        }
        if (_srUI.region.length)   parts.push(_srUI.region.join(','));
        if (_srUI.grade.length)    parts.push(_srUI.grade.join(',') + '등급');
        if (_srUI.sizeBand.length) parts.push(_srUI.sizeBand.join(','));
        if (_srUI.dateFrom || _srUI.dateTo)
            parts.push(`${_srUI.dateFrom||'~'}~${_srUI.dateTo||'현재'}`);
        summary.textContent = parts.length ? `필터: ${parts.join(' · ')} (${filtered.length}개 빌딩)` :
                                              `전체 ${filtered.length}개 빌딩`;
    }
};

// openStatResearchModal에서 vacancy 탭 선택 시 자동 렌더
// (ISSUE-1의 switchSRTab이 window._srRenderVacancy 호출)

// ISSUE-2 loaded

// ═══════════════════════════════════════════════════════════════
// ISSUE-3: TAB2 — 임대조건 분석
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 3-A. 필터 바 (TAB2 전용 — TAB1과 독립적으로 관리)
// ─────────────────────────────────────────────────────────────
const _srRentUI = {
    region:    [],   // 복수 선택 배열
    grade:     [],
    sizeBand:  [],
    priceFrom: '',
    priceTo:   '',
};

function _srRentFilterBar() {
    const wrap = document.getElementById('sr-rent-filter-bar');
    if (!wrap) return;

    const allDates = srGetAllEffectiveDates(window.state?.allBuildings || []);
    const opts = allDates.map(d => `<option value="${d}">${d}</option>`).join('');

    const rPicker = _srMultiPicker('srR-region', '전체 권역',
        SR_REGIONS.map(r=>[r,r]), window._srRentFilterChange);
    const gPicker = _srMultiPicker('srR-grade', '전체 등급',
        SR_GRADES.map(g=>[g,g]), window._srRentFilterChange);
    const sPicker = _srMultiPicker('srR-size', '전체 규모', [
        ['대형','대형 (2만평↑)'],['중대형','중대형 (1만~2만)'],
        ['중형','중형 (5천~1만)'],['소형','소형 (5천↓)'],
    ], window._srRentFilterChange);

    wrap.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:12px 0 4px;">
      ${rPicker}
      ${gPicker}
      ${sPicker}
      <span style="font-size:12px; color:var(--text-muted); white-space:nowrap;">기준가 적용일</span>
      <select id="srR-from" onchange="_srRentFilterChange()"
        style="padding:5px 10px; border:1px solid var(--border-color); border-radius:6px;
               background:var(--bg-primary); color:var(--text-primary); font-size:12px; cursor:pointer;">
        <option value="">시작월</option>${opts}
      </select>
      <span style="font-size:12px; color:var(--text-muted);">~</span>
      <select id="srR-to" onchange="_srRentFilterChange()"
        style="padding:5px 10px; border:1px solid var(--border-color); border-radius:6px;
               background:var(--bg-primary); color:var(--text-primary); font-size:12px; cursor:pointer;">
        <option value="">종료월</option>${opts}
      </select>
      <button onclick="_srRentFilterReset()"
        style="padding:5px 12px; border:1px solid var(--border-color); border-radius:6px;
               background:var(--bg-primary); color:var(--text-muted); font-size:12px; cursor:pointer;">
        ↺ 초기화
      </button>
      <span id="sr-rent-filter-summary" style="margin-left:auto; font-size:11px; color:var(--text-muted);"></span>
    </div>`;

    // 날짜 상태 복원
    const fR = document.getElementById('srR-from');
    const tR = document.getElementById('srR-to');
    if (fR) fR.value = _srRentUI.priceFrom;
    if (tR) tR.value = _srRentUI.priceTo;
}

window._srRentFilterChange = function() {
    _srRentUI.region    = window._srGetMultiValues('srR-region');
    _srRentUI.grade     = window._srGetMultiValues('srR-grade');
    _srRentUI.sizeBand  = window._srGetMultiValues('srR-size');
    _srRentUI.priceFrom = document.getElementById('srR-from')?.value || '';
    _srRentUI.priceTo   = document.getElementById('srR-to')?.value   || '';
    window._srRenderRent();
};

window._srRentFilterReset = function() {
    ['srR-region','srR-grade','srR-size'].forEach(id => {
        if (_srMultiReg[id]) { _srMultiReg[id].values.clear(); _srMultiRefreshBtn(id); }
        const dd = document.getElementById(`${id}-dropdown`);
        if (dd) dd.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
    });
    _srRentUI.region = _srRentUI.grade = _srRentUI.sizeBand = [];
    _srRentUI.priceFrom = _srRentUI.priceTo = '';
    const fR = document.getElementById('srR-from');
    const tR = document.getElementById('srR-to');
    if (fR) fR.value = '';
    if (tR) tR.value = '';
    window._srRenderRent();
};

// ─────────────────────────────────────────────────────────────
// 3-B. 내부 헬퍼: 빌딩의 기준가 이력 추출 (필터 적용)
// ─────────────────────────────────────────────────────────────

/**
 * 빌딩의 floorPricing을 날짜 필터 후 반환
 * 없으면 building 루트 레벨 임대조건을 단일 항목으로 반환
 */
function _srGetPricings(building, priceFrom, priceTo) {
    const fps = building.floorPricing || [];
    const filtered = srFilterPriceByDate(fps, priceFrom, priceTo);
    if (filtered.length > 0) return filtered;

    // floorPricing 없으면 빌딩 루트 레벨 fallback (날짜 필터 미적용)
    const r = srParsePrice(building.rentPy);
    const d = srParsePrice(building.depositPy);
    const m = srParsePrice(building.maintenancePy);
    if (r || d || m) {
        return [{
            rentPy:        r,
            depositPy:     d,
            maintenancePy: m,
            effectiveDate: '',
            sourceCompany: 'building',
            _isFallback:   true,
        }];
    }
    return [];
}

// ─────────────────────────────────────────────────────────────
// 3-C. KPI 카드
// ─────────────────────────────────────────────────────────────
function _srRentKPI(filtered) {
    const el = document.getElementById('sr-rent-kpi');
    if (!el) return;

    const rentVals = [], depositVals = [], maintVals = [], depositRatios = [];

    filtered.forEach(b => {
        const fps = _srGetPricings(b, _srRentUI.priceFrom, _srRentUI.priceTo);
        fps.forEach(fp => {
            const r = srParsePrice(fp.rentPy);
            const d = srParsePrice(fp.depositPy);
            const m = srParsePrice(fp.maintenancePy);
            if (r) rentVals.push(r);
            if (d) depositVals.push(d);
            if (m) maintVals.push(m);
            if (r && d) depositRatios.push(d / r);
        });
    });

    const fmt = v => v !== null ? Math.round(v / 10000 * 10) / 10 + '만원' : '-';
    const fmtRatio = v => v !== null ? v.toFixed(1) + '개월' : '-';

    const avgRent    = srAvg(rentVals);
    const avgDeposit = srAvg(depositVals);
    const avgMaint   = srAvg(maintVals);
    const avgRatio   = srAvg(depositRatios);

    el.innerHTML = [
        { icon:'💰', label:'평균 임대료',      value: fmt(avgRent),         color:'#1a73e8' },
        { icon:'🏦', label:'평균 보증금',      value: fmt(avgDeposit),      color:'#9333ea' },
        { icon:'🔧', label:'평균 관리비',      value: fmt(avgMaint),        color:'#16a34a' },
        { icon:'📐', label:'평균 보증금 배수', value: fmtRatio(avgRatio),   color:'#d97706' },
    ].map(c => `
      <div style="background:var(--bg-secondary); border:1px solid var(--border-color);
                  border-radius:10px; padding:14px 16px;">
        <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">${c.icon} ${c.label}</div>
        <div style="font-size:20px; font-weight:700; color:${c.color};">${c.value}</div>
        <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">원/평 기준</div>
      </div>`).join('');
}

// ─────────────────────────────────────────────────────────────
// 3-D. 권역×등급 평균 임대가 교차 테이블
// ─────────────────────────────────────────────────────────────
function _srRentCross(filtered) {
    const el = document.getElementById('sr-rent-cross');
    if (!el) return;

    // [region][grade] → { rentSum, depositSum, maintSum, cnt }
    const data = {};
    SR_REGIONS.forEach(r => {
        data[r] = {};
        SR_GRADES.forEach(g => { data[r][g] = { rSum:0, dSum:0, mSum:0, cnt:0 }; });
    });

    filtered.forEach(b => {
        const r   = b._region;
        const g   = b._gradeAuto || 'E';
        const fps = _srGetPricings(b, _srRentUI.priceFrom, _srRentUI.priceTo);
        if (!data[r]) return;
        fps.forEach(fp => {
            const rent = srParsePrice(fp.rentPy);
            const dep  = srParsePrice(fp.depositPy);
            const mnt  = srParsePrice(fp.maintenancePy);
            if (!rent) return;
            data[r][g].rSum += rent;
            if (dep) data[r][g].dSum += dep;
            if (mnt) data[r][g].mSum += mnt;
            data[r][g].cnt++;
        });
    });

    const toMw = v => v > 0 ? (v / 10000).toFixed(1) : null;

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0;">
        <tr>
          <th style="padding:8px 10px; text-align:left; border-bottom:2px solid var(--border-color);">권역</th>
          ${SR_GRADES.map(g => `
            <th style="padding:8px 10px; text-align:center; border-bottom:2px solid var(--border-color);
                       color:${SR_GRADE_COLOR[g]};">${g}</th>`).join('')}
        </tr>
      </thead>
      <tbody>`;

    SR_REGIONS.forEach(r => {
        html += `<tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px 10px; font-weight:700; color:${SR_REGION_COLOR[r]};">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                         background:${SR_REGION_COLOR[r]};margin-right:5px;"></span>${r}
          </td>
          ${SR_GRADES.map(g => {
              const d = data[r][g];
              if (d.cnt === 0)
                  return `<td style="padding:8px 10px; text-align:center; color:var(--text-muted);">-</td>`;
              const avgR = toMw(d.rSum / d.cnt);
              const avgD = d.dSum > 0 ? toMw(d.dSum / d.cnt) : null;
              const avgM = d.mSum > 0 ? toMw(d.mSum / d.cnt) : null;
              const ratio= d.dSum > 0 && d.rSum > 0
                  ? ((d.dSum / d.rSum)).toFixed(1) + '배' : null;
              return `<td style="padding:8px 10px; text-align:center;">
                <div style="font-weight:700; color:${SR_GRADE_COLOR[g]};">${avgR}만</div>
                ${avgD ? `<div style="font-size:10px;color:#9333ea;">보${avgD}만</div>` : ''}
                ${avgM ? `<div style="font-size:10px;color:#16a34a;">관${avgM}만</div>` : ''}
                ${ratio ? `<div style="font-size:10px;color:var(--text-muted);">(${ratio})</div>` : ''}
                <div style="font-size:10px;color:var(--text-muted);">n=${d.cnt}</div>
              </td>`;
          }).join('')}
        </tr>`;
    });

    html += '</tbody></table>';
    el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// 3-E. 분기별 시계열 — 꺾은선 (CSS 스텝바 구현)
// ─────────────────────────────────────────────────────────────
function _srRentTrend(filtered) {
    const el = document.getElementById('sr-rent-trend');
    if (!el) return;

    const metric = document.getElementById('sr-rent-metric')?.value || 'rent';
    const metricKey = metric === 'rent' ? 'rentPy' : metric === 'deposit' ? 'depositPy' : 'maintenancePy';
    const metricLabel = metric === 'rent' ? '임대료' : metric === 'deposit' ? '보증금' : '관리비';

    // { "2025Q1": { CBD: [vals], GBD: [vals], ... } }
    const buckets = {};
    filtered.forEach(b => {
        const r   = b._region;
        const fps = _srGetPricings(b, _srRentUI.priceFrom, _srRentUI.priceTo);
        fps.forEach(fp => {
            const d    = srNormalizeDate(fp.effectiveDate || fp.createdAt || '');
            if (!d) return;
            const qKey = srGetQuarter(d).label;
            const val  = srParsePrice(fp[metricKey]);
            if (!val) return;
            if (!buckets[qKey]) { buckets[qKey] = {}; SR_REGIONS.forEach(rr => buckets[qKey][rr] = []); }
            if (!buckets[qKey][r]) buckets[qKey][r] = [];
            buckets[qKey][r].push(val);
        });
    });

    const qKeys = Object.keys(buckets).sort().slice(-8);
    if (qKeys.length === 0) {
        el.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-muted);">기준가 이력 데이터 없음</div>';
        return;
    }

    // 권역별 분기 평균
    const series = {};
    SR_REGIONS.forEach(r => {
        series[r] = qKeys.map(k => {
            const vals = buckets[k]?.[r] || [];
            return vals.length ? srAvg(vals) : null;
        });
    });

    // 전체 max값 (Y축 스케일)
    const allVals = Object.values(series).flat().filter(v => v !== null);
    if (allVals.length === 0) {
        el.innerHTML = '<div style="padding:24px; text-align:center; color:var(--text-muted);">데이터 없음</div>';
        return;
    }
    const maxVal = Math.max(...allVals);
    const minVal = Math.min(...allVals);
    const range  = maxVal - minVal || 1;
    const H = 160; // 차트 높이 px
    const W_STEP = 100 / Math.max(qKeys.length - 1, 1); // % 단위 x 간격

    // SVG 꺾은선 차트
    const toY = v => H - ((v - minVal) / range * H * 0.85) - H * 0.05;
    const toX = i => i * W_STEP;

    const lines = SR_REGIONS
        .filter(r => series[r].some(v => v !== null))
        .map(r => {
            const pts = series[r]
                .map((v, i) => v !== null ? `${toX(i).toFixed(1)},${toY(v).toFixed(1)}` : null)
                .filter(Boolean);
            if (pts.length < 1) return '';
            const polyline = pts.join(' ');
            const dots = series[r].map((v, i) =>
                v !== null ? `<circle cx="${toX(i).toFixed(1)}%" cy="${toY(v).toFixed(1)}"
                    r="4" fill="${SR_REGION_COLOR[r]}"
                    title="${r} ${qKeys[i]}: ${(v/10000).toFixed(1)}만원">
                    <title>${r} ${qKeys[i]}: ${(v/10000).toFixed(1)}만원</title></circle>` : ''
            ).join('');
            return `
              <polyline points="${pts.map((p,i)=>{
                  const idx = series[r].findIndex((v,j)=>j>=i && v!==null);
                  return p;
              }).join(' ')}"
                  fill="none" stroke="${SR_REGION_COLOR[r]}" stroke-width="2.5"
                  stroke-linejoin="round" stroke-linecap="round"/>
              ${dots}`;
        }).join('');

    // X축 레이블
    const xLabels = qKeys.map((k, i) =>
        `<text x="${toX(i).toFixed(1)}%" y="${H + 14}" text-anchor="middle"
               font-size="10" fill="var(--text-muted)">${k}</text>`
    ).join('');

    // Y축 눈금 (3개)
    const yTicks = [0, 0.5, 1].map(t => {
        const v   = minVal + range * t;
        const y   = toY(v).toFixed(1);
        return `<line x1="0" y1="${y}" x2="100%" y2="${y}"
                    stroke="var(--border-color)" stroke-dasharray="4,4" stroke-width="1"/>
                <text x="-4" y="${y}" text-anchor="end" dominant-baseline="middle"
                      font-size="10" fill="var(--text-muted)">${(v/10000).toFixed(1)}만</text>`;
    }).join('');

    // 범례
    const legend = SR_REGIONS
        .filter(r => series[r].some(v => v !== null))
        .map(r => `
            <span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px;">
              <span style="width:16px;height:3px;background:${SR_REGION_COLOR[r]};display:inline-block;border-radius:2px;"></span>
              ${r}
            </span>`).join('');

    el.innerHTML = `
      <div style="margin-bottom:8px;">${legend}</div>
      <div style="overflow-x:auto;">
        <svg viewBox="-30 -10 ${Math.max(qKeys.length * 80, 300)} ${H + 30}"
             style="width:100%; min-width:${Math.max(qKeys.length * 80, 300)}px; height:${H + 40}px;"
             xmlns="http://www.w3.org/2000/svg">
          ${yTicks}
          ${lines}
          ${xLabels}
        </svg>
      </div>`;
}

// ─────────────────────────────────────────────────────────────
// 3-F. 분기 비교 뷰
// ─────────────────────────────────────────────────────────────
function _srPopulateCmpSelects(filtered) {
    const selA = document.getElementById('sr-cmp-a');
    const selB = document.getElementById('sr-cmp-b');
    if (!selA || !selB) return;

    // 데이터 내 존재하는 분기 목록
    const qSet = new Set();
    filtered.forEach(b => {
        _srGetPricings(b, '', '').forEach(fp => {
            const d = srNormalizeDate(fp.effectiveDate || fp.createdAt || '');
            if (d) qSet.add(srGetQuarter(d).label);
        });
    });
    const qList = [...qSet].sort();

    if (qList.length < 2) {
        selA.innerHTML = selB.innerHTML = '<option value="">분기 없음</option>';
        return;
    }

    const opts = qList.map(q => `<option value="${q}">${q}</option>`).join('');
    selA.innerHTML = opts;
    selB.innerHTML = opts;
    // 기본: 가장 최신 vs 직전
    selA.value = qList[qList.length - 2];
    selB.value = qList[qList.length - 1];
}

window._srRenderRentCompare = function() {
    const el = document.getElementById('sr-rent-compare');
    if (!el) return;

    const qA = document.getElementById('sr-cmp-a')?.value;
    const qB = document.getElementById('sr-cmp-b')?.value;
    if (!qA || !qB) { el.innerHTML = ''; return; }

    const normBuildings = _srGetFilteredNormBuildings();
    const filtered = srApplyFilter(normBuildings, {
        region: _srRentUI.region, grade: _srRentUI.grade, sizeBand: _srRentUI.sizeBand,
    });

    // 권역별 분기 평균 계산
    function qAvg(qLabel, r) {
        const vals = [];
        filtered.forEach(b => {
            if (b._region !== r && r !== '') return;
            _srGetPricings(b, '', '').forEach(fp => {
                const d = srNormalizeDate(fp.effectiveDate || fp.createdAt || '');
                if (!d || srGetQuarter(d).label !== qLabel) return;
                const v = srParsePrice(fp.rentPy);
                if (v) vals.push(v);
            });
        });
        return vals.length ? srAvg(vals) : null;
    }

    const mw = v => v !== null ? (v / 10000).toFixed(1) : '-';
    const diff = (a, b) => {
        if (a === null || b === null) return '';
        const d = b - a;
        const pct = ((d / a) * 100).toFixed(1);
        const clr = d > 0 ? '#dc2626' : d < 0 ? '#1a73e8' : '#6b7280';
        return `<span style="color:${clr}; font-size:11px;">${d>0?'+':''}${(d/10000).toFixed(1)}만 (${d>0?'+':''}${pct}%)</span>`;
    };

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="background:var(--bg-secondary);">
        <tr>
          <th style="padding:8px 10px; text-align:left; border-bottom:2px solid var(--border-color);">권역</th>
          <th style="padding:8px 10px; text-align:right; border-bottom:2px solid var(--border-color); color:#6b7280;">${qA}</th>
          <th style="padding:8px 10px; text-align:right; border-bottom:2px solid var(--border-color); color:#1a73e8;">${qB}</th>
          <th style="padding:8px 10px; text-align:center; border-bottom:2px solid var(--border-color);">증감</th>
        </tr>
      </thead><tbody>`;

    SR_REGIONS.forEach(r => {
        const vA = qAvg(qA, r);
        const vB = qAvg(qB, r);
        html += `<tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:8px 10px; font-weight:700; color:${SR_REGION_COLOR[r]};">${r}</td>
          <td style="padding:8px 10px; text-align:right; color:var(--text-muted);">${mw(vA)}만</td>
          <td style="padding:8px 10px; text-align:right; font-weight:700;">${mw(vB)}만</td>
          <td style="padding:8px 10px; text-align:center;">${diff(vA, vB)}</td>
        </tr>`;
    });

    html += '</tbody></table>';
    el.innerHTML = html;
};

// ─────────────────────────────────────────────────────────────
// 3-G. 보증금 배수 / 관리비 구간 분포
// ─────────────────────────────────────────────────────────────
function _srDepositDist(filtered) {
    const el = document.getElementById('sr-deposit-dist');
    if (!el) return;

    // 보증금 배수 = depositPy / rentPy
    const buckets = { '3개월이하':0, '4~6개월':0, '7~12개월':0, '13~24개월':0, '25개월↑':0 };
    filtered.forEach(b => {
        _srGetPricings(b, _srRentUI.priceFrom, _srRentUI.priceTo).forEach(fp => {
            const r = srParsePrice(fp.rentPy);
            const d = srParsePrice(fp.depositPy);
            if (!r || !d) return;
            const ratio = d / r;
            if      (ratio <= 3)  buckets['3개월이하']++;
            else if (ratio <= 6)  buckets['4~6개월']++;
            else if (ratio <= 12) buckets['7~12개월']++;
            else if (ratio <= 24) buckets['13~24개월']++;
            else                  buckets['25개월↑']++;
        });
    });

    const total = Object.values(buckets).reduce((s,v) => s+v, 0) || 1;
    const colors = ['#1a73e8','#34d399','#fbbf24','#f97316','#9333ea'];
    const maxV = Math.max(...Object.values(buckets), 1);

    el.innerHTML = Object.entries(buckets).map(([k, v], i) => `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:7px;">
        <div style="width:64px; font-size:11px; color:var(--text-muted); text-align:right; flex-shrink:0;">${k}</div>
        <div style="flex:1; background:var(--bg-secondary); border-radius:4px; overflow:hidden; height:16px;">
          <div style="height:100%; width:${(v/maxV*100).toFixed(1)}%; background:${colors[i]}; border-radius:4px;"></div>
        </div>
        <div style="width:56px; font-size:11px; color:var(--text-muted); text-align:right; flex-shrink:0;">
          ${v}건 (${(v/total*100).toFixed(0)}%)
        </div>
      </div>`).join('');
}

function _srMaintDist(filtered) {
    const el = document.getElementById('sr-maint-dist');
    if (!el) return;

    // 관리비 구간 (만원/평 기준)
    const buckets = { '1만이하':0, '1~2만':0, '2~3만':0, '3~4만':0, '4만↑':0 };
    filtered.forEach(b => {
        _srGetPricings(b, _srRentUI.priceFrom, _srRentUI.priceTo).forEach(fp => {
            const m = srParsePrice(fp.maintenancePy);
            if (!m) return;
            const mw = m / 10000;
            if      (mw <= 1)  buckets['1만이하']++;
            else if (mw <= 2)  buckets['1~2만']++;
            else if (mw <= 3)  buckets['2~3만']++;
            else if (mw <= 4)  buckets['3~4만']++;
            else               buckets['4만↑']++;
        });
    });

    const total = Object.values(buckets).reduce((s,v) => s+v, 0) || 1;
    const colors = ['#34d399','#1a73e8','#fbbf24','#f97316','#dc2626'];
    const maxV = Math.max(...Object.values(buckets), 1);

    el.innerHTML = Object.entries(buckets).map(([k, v], i) => `
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:7px;">
        <div style="width:48px; font-size:11px; color:var(--text-muted); text-align:right; flex-shrink:0;">${k}</div>
        <div style="flex:1; background:var(--bg-secondary); border-radius:4px; overflow:hidden; height:16px;">
          <div style="height:100%; width:${(v/maxV*100).toFixed(1)}%; background:${colors[i]}; border-radius:4px;"></div>
        </div>
        <div style="width:56px; font-size:11px; color:var(--text-muted); text-align:right; flex-shrink:0;">
          ${v}건 (${(v/total*100).toFixed(0)}%)
        </div>
      </div>`).join('');
}

// ─────────────────────────────────────────────────────────────
// 3-H. TAB2 메인 렌더
// ─────────────────────────────────────────────────────────────
window._srRenderRent = function() {
    const normBuildings = _srGetFilteredNormBuildings();
    const filtered = srApplyFilter(normBuildings, {
        region:   _srRentUI.region,
        grade:    _srRentUI.grade,
        sizeBand: _srRentUI.sizeBand,
    });

    _srRentFilterBar();
    _srRentKPI(filtered);
    _srRentCross(filtered);
    _srRentTrend(filtered);
    _srPopulateCmpSelects(filtered);
    window._srRenderRentCompare();
    _srDepositDist(filtered);
    _srMaintDist(filtered);

    const summary = document.getElementById('sr-rent-filter-summary');
    if (summary) {
        const parts = [];
        if (_srRentUI.region.length)   parts.push(_srRentUI.region.join(','));
        if (_srRentUI.grade.length)    parts.push(_srRentUI.grade.join(',') + '등급');
        if (_srRentUI.sizeBand.length) parts.push(_srRentUI.sizeBand.join(','));
        if (_srRentUI.priceFrom || _srRentUI.priceTo)
            parts.push(`${_srRentUI.priceFrom||''}~${_srRentUI.priceTo||'현재'}`);
        summary.textContent = parts.length
            ? `필터: ${parts.join(' · ')} (${filtered.length}개 빌딩)`
            : `전체 ${filtered.length}개 빌딩`;
    }
};

// ISSUE-3 loaded

// ═══════════════════════════════════════════════════════════════
// ISSUE-4: TAB3 — 빌딩 현황 / TAB4 — 검색 테이블
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 4-A. TAB3: 등급 분포 바
// ─────────────────────────────────────────────────────────────
function _srGradeBars(buildings) {
    const el = document.getElementById('sr-grade-bars');
    if (!el) return;

    const cnt  = {}; SR_GRADES.forEach(g => { cnt[g] = 0; });
    const area = {}; SR_GRADES.forEach(g => { area[g] = 0; });

    buildings.forEach(b => {
        const g = b._gradeAuto;
        if (!g) return;
        cnt[g]++;
        area[g] += parseFloat(b.grossFloorPy) || 0;
    });

    const maxCnt = Math.max(...Object.values(cnt), 1);

    el.innerHTML = SR_GRADES.map(g => {
        const c   = cnt[g];
        const a   = area[g];
        const w   = (c / maxCnt * 100).toFixed(1);
        const clr = SR_GRADE_COLOR[g];
        return `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <div style="width:36px; font-weight:700; font-size:12px; color:${clr}; flex-shrink:0;">${g}</div>
          <div style="flex:1; background:var(--bg-secondary); border-radius:5px; overflow:hidden;
                      height:20px; position:relative; min-width:0;">
            <div style="height:100%; width:${w}%; background:${clr}; border-radius:5px;"></div>
            <span style="position:absolute; left:8px; top:50%; transform:translateY(-50%);
                         font-size:11px; font-weight:600; color:#fff;
                         text-shadow:0 1px 2px rgba(0,0,0,0.5);">${c}개</span>
          </div>
          <div style="width:80px; font-size:10px; color:var(--text-muted); text-align:right; flex-shrink:0;">
            ${a > 0 ? Math.round(a/1000)/10 + '천평' : '-'}
          </div>
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// 4-B. TAB3: 완공연도 분포 바
// ─────────────────────────────────────────────────────────────
function _srYearBars(buildings) {
    const el = document.getElementById('sr-year-bars');
    if (!el) return;

    const bands = [
        { label: '1990이전', test: y => y > 0 && y < 1990 },
        { label: '1990~99',  test: y => y >= 1990 && y < 2000 },
        { label: '2000~09',  test: y => y >= 2000 && y < 2010 },
        { label: '2010~19',  test: y => y >= 2010 && y < 2020 },
        { label: '2020이후', test: y => y >= 2020 },
        { label: '미상',     test: y => !y || y < 1900 },
    ];
    const colors = ['#94a3b8','#64748b','#60a5fa','#1a73e8','#0f4c81','#e2e8f0'];

    const cnt = bands.map(() => 0);
    buildings.forEach(b => {
        const y = parseInt(b.completionYear || b.specs?.completionYear || 0);
        const idx = bands.findIndex(bnd => bnd.test(y));
        if (idx >= 0) cnt[idx]++;
    });

    const maxCnt = Math.max(...cnt, 1);
    el.innerHTML = bands.map((bnd, i) => {
        const w = (cnt[i] / maxCnt * 100).toFixed(1);
        return `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <div style="width:56px; font-size:11px; color:var(--text-muted); text-align:right; flex-shrink:0;">${bnd.label}</div>
          <div style="flex:1; background:var(--bg-secondary); border-radius:5px; overflow:hidden;
                      height:20px; position:relative; min-width:0;">
            <div style="height:100%; width:${w}%; background:${colors[i]}; border-radius:5px;"></div>
            <span style="position:absolute; left:8px; top:50%; transform:translateY(-50%);
                         font-size:11px; font-weight:600; color:#fff;
                         text-shadow:0 1px 2px rgba(0,0,0,0.5);">${cnt[i]}개</span>
          </div>
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// 4-C. TAB3: 권역×등급 교차 히트맵
// ─────────────────────────────────────────────────────────────
function _srCrossHeatmap(buildings) {
    const el = document.getElementById('sr-cross-table');
    if (!el) return;

    const data = {};
    SR_REGIONS.forEach(r => { data[r] = {}; SR_GRADES.forEach(g => { data[r][g] = 0; }); });

    buildings.forEach(b => {
        const r = b._region;
        const g = b._gradeAuto || 'E';
        if (data[r]) data[r][g]++;
    });

    const allVals = SR_REGIONS.flatMap(r => SR_GRADES.map(g => data[r][g]));
    const maxVal  = Math.max(...allVals, 1);

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0;">
        <tr>
          <th style="padding:7px 10px; text-align:left; border-bottom:2px solid var(--border-color);">권역</th>
          ${SR_GRADES.map(g => `
            <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);
                       color:${SR_GRADE_COLOR[g]};">${g}</th>`).join('')}
          <th style="padding:7px 10px; text-align:right; border-bottom:2px solid var(--border-color);">합계</th>
        </tr>
      </thead><tbody>`;

    SR_REGIONS.forEach(r => {
        const rowTotal = SR_GRADES.reduce((s, g) => s + data[r][g], 0);
        html += `<tr style="border-bottom:1px solid var(--border-color);">
          <td style="padding:7px 10px; font-weight:700; color:${SR_REGION_COLOR[r]};">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;
                         background:${SR_REGION_COLOR[r]};margin-right:5px;"></span>${r}
          </td>
          ${SR_GRADES.map(g => {
              const v   = data[r][g];
              const pct = (v / maxVal * 100).toFixed(0);
              const bg  = v > 0
                  ? `background:${SR_GRADE_COLOR[g]}${Math.round(v/maxVal*180).toString(16).padStart(2,'0')};`
                  : '';
              return `<td style="padding:7px 10px; text-align:center; ${bg} border-radius:4px;">
                ${v > 0 ? `<strong style="color:${v/maxVal>0.5?'#fff':SR_GRADE_COLOR[g]};">${v}</strong>` : '<span style="color:var(--text-muted);">-</span>'}
              </td>`;
          }).join('')}
          <td style="padding:7px 10px; text-align:right; font-weight:700;">${rowTotal}</td>
        </tr>`;
    });

    // 합계 행
    html += `<tr style="background:var(--bg-secondary); font-weight:700; border-top:2px solid var(--border-color);">
      <td style="padding:7px 10px;">합계</td>
      ${SR_GRADES.map(g => {
          const t = SR_REGIONS.reduce((s,r) => s+data[r][g], 0);
          return `<td style="padding:7px 10px; text-align:center;">${t||'-'}</td>`;
      }).join('')}
      <td style="padding:7px 10px; text-align:right;">${buildings.length}</td>
    </tr>`;

    html += '</tbody></table>';
    el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// 4-D. TAB3: PM사별 현황 테이블
// ─────────────────────────────────────────────────────────────
function _srPMTable(buildings) {
    const el = document.getElementById('sr-pm-table');
    if (!el) return;

    // PM사별 집계
    const pmMap = {};
    buildings.forEach(b => {
        const pm  = (b.pm || '').trim() || '(미지정)';
        const rnt = srGetBestRent(b);
        if (!pmMap[pm]) pmMap[pm] = { cnt:0, totalPy:0, vacCnt:0, rentSum:0, rentN:0 };
        pmMap[pm].cnt++;
        pmMap[pm].totalPy += parseFloat(b.grossFloorPy) || 0;
        pmMap[pm].vacCnt  += b._activeVacs.length;
        if (rnt.rentPy) { pmMap[pm].rentSum += rnt.rentPy; pmMap[pm].rentN++; }
    });

    const rows = Object.entries(pmMap)
        .sort((a, b) => b[1].cnt - a[1].cnt);

    if (!rows.length) {
        el.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">데이터 없음</div>';
        return;
    }

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0;">
        <tr>
          <th style="padding:7px 10px; text-align:left; border-bottom:2px solid var(--border-color);">PM사</th>
          <th style="padding:7px 10px; text-align:right; border-bottom:2px solid var(--border-color);">빌딩 수</th>
          <th style="padding:7px 10px; text-align:right; border-bottom:2px solid var(--border-color);">총 연면적(평)</th>
          <th style="padding:7px 10px; text-align:right; border-bottom:2px solid var(--border-color);">공실 건수</th>
          <th style="padding:7px 10px; text-align:right; border-bottom:2px solid var(--border-color);">평균 임대료</th>
        </tr>
      </thead><tbody>`;

    rows.forEach(([pm, s], i) => {
        const avgRent = s.rentN > 0 ? (s.rentSum / s.rentN / 10000).toFixed(1) + '만원' : '-';
        const bg = i % 2 === 1 ? 'background:var(--bg-secondary);' : '';
        html += `
        <tr style="${bg} border-bottom:1px solid var(--border-color);">
          <td style="padding:7px 10px; font-weight:500;">${pm}</td>
          <td style="padding:7px 10px; text-align:right; font-weight:700; color:#1a73e8;">${s.cnt}</td>
          <td style="padding:7px 10px; text-align:right; color:var(--text-muted);">
            ${Math.round(s.totalPy).toLocaleString()}
          </td>
          <td style="padding:7px 10px; text-align:right; color:${s.vacCnt>0?'#dc2626':'var(--text-muted)'};">
            ${s.vacCnt || '-'}
          </td>
          <td style="padding:7px 10px; text-align:right;">${avgRent}</td>
        </tr>`;
    });

    html += '</tbody></table>';
    el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// 4-E. TAB3 메인 렌더
// ─────────────────────────────────────────────────────────────
window._srRenderBuilding = function() {
    const buildings = _srGetFilteredNormBuildings();
    _srGradeBars(buildings);
    _srYearBars(buildings);
    _srCrossHeatmap(buildings);
    _srPMTable(buildings);
};

// ─────────────────────────────────────────────────────────────
// 4-F. TAB4: 검색 테이블 필터 상태
// ─────────────────────────────────────────────────────────────
const _srTableUI = {
    region:    [],   // 복수 선택 배열
    grade:     [],
    sizeBand:  [],
    vacFilter: '',
    pm:        '',   // 히든 처리 (데이터 미완성)
    search:    '',
    sortCol:   'grossFloorPy',
    sortDir:   'desc',
};

// PM사 select 옵션 채우기 (탭 진입 시 1회)
function _srPopulatePMSelect() {
    const sel = document.getElementById('srT-pm');
    if (!sel) return;
    const pmSet = new Set();
    (window.state?.allBuildings || []).forEach(b => {
        const pm = (b.pm || '').trim();
        if (pm) pmSet.add(pm);
    });
    const sorted = [...pmSet].sort();
    const prev = sel.value;
    sel.innerHTML = '<option value="">전체 PM사</option>' +
        sorted.map(p => `<option value="${p}">${p}</option>`).join('');
    if (prev && pmSet.has(prev)) sel.value = prev;
}

window._srTableFilterChange = function() {
    _srTableUI.region    = window._srGetMultiValues('srT-region');
    _srTableUI.grade     = window._srGetMultiValues('srT-grade');
    _srTableUI.sizeBand  = window._srGetMultiValues('srT-size');
    _srTableUI.vacFilter = document.getElementById('srT-vacancy')?.value || '';
    _srTableUI.pm        = '';   // 히든 처리 중
    _srTableUI.search    = document.getElementById('srT-search')?.value  || '';
    _srRenderTableBody();
};

window._srTableFilterReset = function() {
    ['srT-region','srT-grade','srT-size'].forEach(id => {
        if (_srMultiReg[id]) { _srMultiReg[id].values.clear(); _srMultiRefreshBtn(id); }
        const dd = document.getElementById(`${id}-dropdown`);
        if (dd) dd.querySelectorAll('input[type=checkbox]').forEach(cb => cb.checked = false);
    });
    _srTableUI.region = _srTableUI.grade = _srTableUI.sizeBand = [];
    _srTableUI.vacFilter = _srTableUI.pm = _srTableUI.search = '';
    const vacEl    = document.getElementById('srT-vacancy');
    const searchEl = document.getElementById('srT-search');
    if (vacEl)    vacEl.value    = '';
    if (searchEl) searchEl.value = '';
    _srRenderTableBody();
};

// ─────────────────────────────────────────────────────────────
// 4-G. TAB4: 정렬 토글
// ─────────────────────────────────────────────────────────────
window._srTableSort = function(col) {
    if (_srTableUI.sortCol === col) {
        _srTableUI.sortDir = _srTableUI.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        _srTableUI.sortCol = col;
        _srTableUI.sortDir = 'desc';
    }
    _srRenderTableBody();
};

function _sortIcon(col) {
    if (_srTableUI.sortCol !== col) return '<span style="opacity:0.3; font-size:9px;">⇅</span>';
    return _srTableUI.sortDir === 'asc'
        ? '<span style="font-size:9px; color:#1a73e8;">▲</span>'
        : '<span style="font-size:9px; color:#1a73e8;">▼</span>';
}

// ─────────────────────────────────────────────────────────────
// 4-H. TAB4: 테이블 본체 렌더
// ─────────────────────────────────────────────────────────────
// 현재 필터 결과를 외부(Excel 다운로드)에서 참조할 수 있도록 저장
window._srTableCurrentData = [];

function _srRenderTableBody() {
    const el = document.getElementById('sr-building-table');
    if (!el) return;

    const normBuildings = _srGetFilteredNormBuildings();
    let list = srApplyFilter(normBuildings, {
        region:    _srTableUI.region,
        grade:     _srTableUI.grade,
        sizeBand:  _srTableUI.sizeBand,
        vacFilter: _srTableUI.vacFilter,
        pm:        _srTableUI.pm,
        search:    _srTableUI.search,
    });

    // 정렬
    const col = _srTableUI.sortCol;
    const dir = _srTableUI.sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
        let va, vb;
        if (col === 'name')          { va = a.name||''; vb = b.name||''; return dir * va.localeCompare(vb); }
        if (col === 'grossFloorPy')  { va = parseFloat(a.grossFloorPy)||0; vb = parseFloat(b.grossFloorPy)||0; }
        else if (col === 'vacPy')    { va = a._vacancyPy; vb = b._vacancyPy; }
        else if (col === 'vacRate')  { va = a._vacancyRate; vb = b._vacancyRate; }
        else if (col === 'rentPy')   { va = a._bestRent.rentPy||0; vb = b._bestRent.rentPy||0; }
        else if (col === 'completionYear') { va = parseInt(a.completionYear)||0; vb = parseInt(b.completionYear)||0; }
        else                         { va = 0; vb = 0; }
        return dir * (va - vb);
    });

    // 현재 결과 저장 (Excel 다운로드용)
    window._srTableCurrentData = list;

    // 카운트 업데이트
    const countEl = document.getElementById('srT-count');
    if (countEl) countEl.textContent = `${list.length}개 빌딩 (최대 300행 표시)`;

    if (!list.length) {
        el.innerHTML = '<div style="padding:32px; text-align:center; color:var(--text-muted);">조건에 맞는 빌딩 없음</div>';
        return;
    }

    const DISPLAY_MAX = 300;
    const display = list.slice(0, DISPLAY_MAX);

    // 컬럼 정의
    const TH = (label, col, right=false) =>
        `<th onclick="_srTableSort('${col}')"
             style="padding:7px 10px; ${right?'text-align:right;':'text-align:left;'}
                    border-bottom:2px solid var(--border-color); cursor:pointer;
                    white-space:nowrap; user-select:none;">
           ${label} ${_sortIcon(col)}
         </th>`;

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px; min-width:900px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0; z-index:1;">
        <tr>
          ${TH('빌딩명',   'name')}
          ${TH('권역',     '_region')}
          ${TH('등급(입력)', 'gradeInput')}
          ${TH('등급(자동)', '_gradeAuto')}
          ${TH('연면적(평)', 'grossFloorPy', true)}
          ${TH('완공연도',  'completionYear', true)}
          ${TH('PM사',     'pm')}
          ${TH('공실건수',  'vacPy', true)}
          ${TH('공실면적(평)','vacPy', true)}
          ${TH('임대료(만원/평)','rentPy', true)}
          ${TH('보증금(만원/평)','rentPy', true)}
          ${TH('관리비(만원/평)','rentPy', true)}
        </tr>
      </thead><tbody>`;

    display.forEach((b, i) => {
        const gross   = parseFloat(b.grossFloorPy) || 0;
        const vacs    = b._activeVacs;
        const vpy     = b._vacancyPy;
        const br      = b._bestRent;
        const mw      = v => v ? (v/10000).toFixed(1) : '-';
        const bg      = i % 2 === 1 ? 'background:var(--bg-secondary);' : '';
        const clickFn = `window.openStatBuildingDetail && window.openStatBuildingDetail('${b.id}')`;

        html += `
        <tr style="${bg} border-bottom:1px solid var(--border-color); cursor:pointer;"
            onclick="${clickFn}"
            onmouseover="this.style.filter='brightness(0.96)'"
            onmouseout="this.style.filter=''">
          <td style="padding:7px 10px; font-weight:500; max-width:140px; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap;" title="${b.name||''}">${b.name||'-'}</td>
          <td style="padding:7px 10px; text-align:center; font-weight:700;
                     color:${SR_REGION_COLOR[b._region]||'#64748b'};">${b._region}</td>
          <td style="padding:7px 10px; text-align:center; color:var(--text-muted);">${b.grade||'-'}</td>
          <td style="padding:7px 10px; text-align:center; font-weight:700;
                     color:${SR_GRADE_COLOR[b._gradeAuto]||'#94a3b8'};">${b._gradeAuto||'-'}</td>
          <td style="padding:7px 10px; text-align:right; color:var(--text-muted);">
            ${gross ? Math.round(gross).toLocaleString() : '-'}</td>
          <td style="padding:7px 10px; text-align:right; color:var(--text-muted);">
            ${b.completionYear||'-'}</td>
          <td style="padding:7px 10px; max-width:100px; overflow:hidden; text-overflow:ellipsis;
                     white-space:nowrap; color:var(--text-muted);" title="${b.pm||''}">${b.pm||'-'}</td>
          <td style="padding:7px 10px; text-align:right; color:${vacs.length>0?'#dc2626':'var(--text-muted)'};">
            ${vacs.length||'-'}</td>
          <td style="padding:7px 10px; text-align:right; font-weight:${vpy>0?'600':'400'};
                     color:${vpy>0?'#d97706':'var(--text-muted)'};">
            ${vpy>0 ? Math.round(vpy).toLocaleString() : '-'}</td>
          <td style="padding:7px 10px; text-align:right;">${mw(br.rentPy)}</td>
          <td style="padding:7px 10px; text-align:right; color:#9333ea;">${mw(br.depositPy)}</td>
          <td style="padding:7px 10px; text-align:right; color:#16a34a;">${mw(br.maintenancePy)}</td>
        </tr>`;
    });

    if (list.length > DISPLAY_MAX) {
        html += `<tr><td colspan="12" style="padding:10px; text-align:center;
                     color:var(--text-muted); font-size:11px; background:var(--bg-secondary);">
            … 상위 ${DISPLAY_MAX}개만 표시 (전체 ${list.length}개)
        </td></tr>`;
    }

    html += '</tbody></table>';
    el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// 4-I. TAB4 메인 렌더 (탭 진입 시)
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// 4-I. TAB4 필터 행 동적 렌더
// ─────────────────────────────────────────────────────────────
function _srRenderTableFilterRow() {
    const wrap = document.getElementById('sr-table-filter-row');
    if (!wrap) return;

    const regionPicker = _srMultiPicker('srT-region', '전체 권역',
        SR_REGIONS.map(r => [r, r]), window._srTableFilterChange);
    const gradePicker = _srMultiPicker('srT-grade', '전체 등급',
        SR_GRADES.map(g => [g, g]), window._srTableFilterChange);
    const sizePicker = _srMultiPicker('srT-size', '전체 규모', [
        ['대형','대형(2만평↑)'], ['중대형','중대형(1만~2만)'],
        ['중형','중형(5천~1만)'], ['소형','소형(5천↓)'],
    ], window._srTableFilterChange);

    wrap.innerHTML = `
        ${regionPicker}
        ${gradePicker}
        ${sizePicker}
        <select id="srT-vacancy" onchange="_srTableFilterChange()"
            style="padding:5px 10px; border:1px solid var(--border-color); border-radius:6px;
                   background:var(--bg-primary); color:var(--text-primary); font-size:12px; cursor:pointer;">
            <option value="">공실 전체</option>
            <option value="yes">공실 있음</option>
            <option value="no">공실 없음</option>
        </select>
        <!-- srT-pm: 히든 (데이터 미완성) -->
        <input id="srT-search" oninput="_srTableFilterChange()" placeholder="빌딩명 검색..."
            style="padding:5px 10px; border:1px solid var(--border-color); border-radius:6px;
                   background:var(--bg-primary); color:var(--text-primary); font-size:12px; min-width:140px;">
        <button onclick="_srTableFilterReset()"
            style="padding:5px 12px; border:1px solid var(--border-color); border-radius:6px;
                   background:var(--bg-primary); color:var(--text-muted); font-size:12px; cursor:pointer;">
            ↺ 초기화
        </button>
        <button onclick="window._srDownloadExcel && window._srDownloadExcel()"
            style="padding:5px 12px; border:none; border-radius:6px;
                   background:#16a34a; color:#fff; font-size:12px; cursor:pointer; font-weight:600;">
            📥 Excel 다운로드
        </button>
        <span id="srT-count" style="margin-left:auto; font-size:11px; color:var(--text-muted); white-space:nowrap;"></span>`;

    // 상태 복원 (재진입 시)
    const vacEl    = document.getElementById('srT-vacancy');
    const searchEl = document.getElementById('srT-search');
    if (vacEl)    vacEl.value    = _srTableUI.vacFilter;
    if (searchEl) searchEl.value = _srTableUI.search;
}

window._srRenderTable = function() {
    // 필터 행 동적 렌더
    _srRenderTableFilterRow();
    _srRenderTableBody();
};

// ISSUE-4 loaded

// ═══════════════════════════════════════════════════════════════
// ISSUE-5: Excel 다운로드 (SheetJS)
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 5-A. 내부 헬퍼
// ─────────────────────────────────────────────────────────────

/** 파일명용 날짜 문자열 생성 "YYYYMMDD" */
function _srToday() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

/** 필터 옵션을 파일명 접미사로 변환 */
function _srFilenameSuffix(opts = {}) {
    const parts = [];
    if (opts.region)    parts.push(opts.region);
    if (opts.grade)     parts.push(opts.grade);
    if (opts.sizeBand)  parts.push(opts.sizeBand);
    if (opts.dateFrom || opts.dateTo)
        parts.push(`${opts.dateFrom || ''}~${opts.dateTo || ''}`);
    parts.push(_srToday());
    return parts.join('_');
}

/**
 * SheetJS 헤더 스타일 셀 생성
 * xlsx-js-style 없이 순수 SheetJS (xlsx.full.min.js) 사용
 * → 스타일은 지원되지 않으므로 wch(열 너비)만 설정
 */
function _srMakeSheet(rows, colWidths = []) {
    if (!window.XLSX) throw new Error('SheetJS(XLSX) 미로드');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (colWidths.length) {
        ws['!cols'] = colWidths.map(w => ({ wch: w }));
    }
    return ws;
}

// ─────────────────────────────────────────────────────────────
// 5-B. Sheet1 — 빌딩 현황
// ─────────────────────────────────────────────────────────────
function _srSheet1(normBuildings) {
    const header = [
        '빌딩ID', '빌딩명', '권역', '등급(입력)', '등급(자동)', '규모구간',
        '연면적(평)', '기준층(평)', '완공연도', 'PM사', '소유주',
        '기준임대료(원/평)', '기준보증금(원/평)', '기준관리비(원/평)', '기준가기준일', '기준가출처'
    ];
    const rows = [header];

    normBuildings.forEach(b => {
        const br = b._bestRent;
        rows.push([
            b.id,
            b.name || '',
            b._region,
            b.grade || '',
            b._gradeAuto || '',
            b._sizeBand || '',
            parseFloat(b.grossFloorPy) || '',
            parseFloat(b.typicalFloorPy) || '',
            b.completionYear || '',
            b.pm || '',
            b.owner || '',
            br.rentPy        || '',
            br.depositPy     || '',
            br.maintenancePy || '',
            br.effectiveDate || '',
            br.source        || '',
        ]);
    });

    return _srMakeSheet(rows, [20,24,6,8,8,8,10,10,8,20,20,14,14,14,10,16]);
}

// ─────────────────────────────────────────────────────────────
// 5-C. Sheet2 — 공실 현황
// ─────────────────────────────────────────────────────────────
function _srSheet2(normBuildings, dateFrom, dateTo) {
    const header = [
        '빌딩ID', '빌딩명', '권역', '등급(자동)', '연면적(평)',
        '층', '임대면적(평)', '전용면적(평)',
        '임대료(원/평)', '보증금(원/평)', '관리비(원/평)',
        '발행일(YYYY-MM)', '출처', '입주가능일'
    ];
    const rows = [header];

    normBuildings.forEach(b => {
        const vacs = srFilterVacByDate(b._activeVacs, dateFrom, dateTo);
        vacs.forEach(v => {
            rows.push([
                b.id,
                b.name || '',
                b._region,
                b._gradeAuto || '',
                parseFloat(b.grossFloorPy) || '',
                v.floor || '',
                parseFloat(v.rentArea)      || '',
                parseFloat(v.exclusiveArea) || '',
                srParsePrice(v.rentPy)        || '',
                srParsePrice(v.depositPy)     || '',
                srParsePrice(v.maintenancePy) || '',
                srNormalizeDate(v.publishDate),
                v.source      || '',
                v.moveInDate  || '',
            ]);
        });
    });

    return _srMakeSheet(rows, [20,24,6,8,10,8,10,10,14,14,14,12,16,10]);
}

// ─────────────────────────────────────────────────────────────
// 5-D. Sheet3 — 기준가 이력
// ─────────────────────────────────────────────────────────────
function _srSheet3(normBuildings, priceFrom, priceTo) {
    const header = [
        '빌딩ID', '빌딩명', '권역', '등급(자동)', '연면적(평)',
        '구분명', '층범위', '임대면적(평)', '전용면적(평)',
        '임대료(원/평)', '보증금(원/평)', '관리비(원/평)',
        '적용일(YYYY-MM)', '출처유형', '출처사', '공식여부'
    ];
    const rows = [header];

    normBuildings.forEach(b => {
        const fps = srFilterPriceByDate(b.floorPricing || [], priceFrom, priceTo);
        fps.forEach(fp => {
            rows.push([
                b.id,
                b.name || '',
                b._region,
                b._gradeAuto || '',
                parseFloat(b.grossFloorPy) || '',
                fp.label        || '',
                fp.floorRange   || '',
                parseFloat(fp.rentArea)      || '',
                parseFloat(fp.exclusiveArea) || '',
                srParsePrice(fp.rentPy)        || '',
                srParsePrice(fp.depositPy)     || '',
                srParsePrice(fp.maintenancePy) || '',
                srNormalizeDate(fp.effectiveDate || fp.createdAt || ''),
                fp.sourceType    || '',
                fp.sourceCompany || '',
                fp.isOfficial ? 'Y' : '',
            ]);
        });
    });

    return _srMakeSheet(rows, [20,24,6,8,10,12,10,10,10,14,14,14,12,10,16,6]);
}

// ─────────────────────────────────────────────────────────────
// 5-E. Sheet4 — 권역별 통계 요약 (월별 집계)
// ─────────────────────────────────────────────────────────────
function _srSheet4(normBuildings) {
    const header = [
        '기준월', '권역',
        '공실건수', '공실전용면적(평)', '공실임대면적(평)',
        '평균임대료(원/평)', '평균보증금(원/평)', '평균관리비(원/평)', '임대가샘플수'
    ];
    const rows = [header];

    // 월 × 권역 집계
    // { "2025-03": { "CBD": { vacCnt, vacExcl, vacRent, rSum, dSum, mSum, priceN } } }
    const buckets = {};

    normBuildings.forEach(b => {
        const rgn = b._region;

        // 공실 집계 (publishDate 기준)
        b._activeVacs.forEach(v => {
            const d = srNormalizeDate(v.publishDate);
            if (!d) return;
            if (!buckets[d])        buckets[d] = {};
            if (!buckets[d][rgn])   buckets[d][rgn] = { vacCnt:0, vacExcl:0, vacRent:0, rSum:0, dSum:0, mSum:0, priceN:0 };
            buckets[d][rgn].vacCnt++;
            buckets[d][rgn].vacExcl += srVacancyAreaPy(v);
            buckets[d][rgn].vacRent += parseFloat(v.rentArea) || 0;
        });

        // 임대가 집계 (effectiveDate 기준 — 같은 월 버킷에 합산)
        (b.floorPricing || []).forEach(fp => {
            const d = srNormalizeDate(fp.effectiveDate || fp.createdAt || '');
            if (!d) return;
            const r = srParsePrice(fp.rentPy);
            const dv = srParsePrice(fp.depositPy);
            const m  = srParsePrice(fp.maintenancePy);
            if (!r) return;
            if (!buckets[d])        buckets[d] = {};
            if (!buckets[d][rgn])   buckets[d][rgn] = { vacCnt:0, vacExcl:0, vacRent:0, rSum:0, dSum:0, mSum:0, priceN:0 };
            buckets[d][rgn].rSum   += r;
            if (dv) buckets[d][rgn].dSum += dv;
            if (m)  buckets[d][rgn].mSum += m;
            buckets[d][rgn].priceN++;
        });
    });

    // 정렬 후 행 생성
    const months = Object.keys(buckets).sort();
    months.forEach(mon => {
        SR_REGIONS.forEach(rgn => {
            const s = buckets[mon]?.[rgn];
            if (!s) return;
            const avgR = s.priceN > 0 ? Math.round(s.rSum / s.priceN) : '';
            const avgD = s.priceN > 0 && s.dSum > 0 ? Math.round(s.dSum / s.priceN) : '';
            const avgM = s.priceN > 0 && s.mSum > 0 ? Math.round(s.mSum / s.priceN) : '';
            rows.push([
                mon, rgn,
                s.vacCnt  || '',
                s.vacExcl ? Math.round(s.vacExcl) : '',
                s.vacRent ? Math.round(s.vacRent) : '',
                avgR, avgD, avgM,
                s.priceN  || '',
            ]);
        });
    });

    return _srMakeSheet(rows, [10,6,8,14,14,14,14,14,8]);
}

// ─────────────────────────────────────────────────────────────
// 5-F. 메인 다운로드 함수
// ─────────────────────────────────────────────────────────────

/**
 * 현재 TAB4 필터 결과 기준으로 Excel 4시트 생성 후 다운로드
 * TAB4 외 탭에서 호출해도 동작 (window._srTableCurrentData 참조)
 */
window._srDownloadExcel = function() {
    if (typeof XLSX === 'undefined') {
        alert('SheetJS 라이브러리를 불러오지 못했습니다.\n네트워크 연결을 확인해 주세요.');
        return;
    }

    // 다운로드 대상: TAB4 현재 필터 결과, 없으면 전체
    let targetBuildings = window._srTableCurrentData;
    if (!targetBuildings || targetBuildings.length === 0) {
        targetBuildings = _srGetFilteredNormBuildings();
    }

    if (targetBuildings.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    // 현재 필터 옵션 수집 (파일명용)
    const _pickFirst = v => Array.isArray(v) ? (v[0] || '') : (v || '');
    const opts = {
        region:    _pickFirst(_srTableUI.region)   || _pickFirst(_srUI.region)   || '',
        grade:     _pickFirst(_srTableUI.grade)    || _pickFirst(_srUI.grade)    || '',
        sizeBand:  _pickFirst(_srTableUI.sizeBand) || _pickFirst(_srUI.sizeBand) || '',
        dateFrom:  _srUI.dateFrom || '',
        dateTo:    _srUI.dateTo   || '',
    };

    // 날짜 범위 (공실용 / 기준가용)
    const vacFrom   = _srUI.dateFrom       || '';
    const vacTo     = _srUI.dateTo         || '';
    const priceFrom = _srRentUI.priceFrom  || '';
    const priceTo   = _srRentUI.priceTo    || '';

    try {
        // 워크북 생성
        const wb = XLSX.utils.book_new();

        // Sheet1: 빌딩 현황
        const ws1 = _srSheet1(targetBuildings);
        XLSX.utils.book_append_sheet(wb, ws1, '빌딩현황');

        // Sheet2: 공실 현황 (날짜 필터 적용)
        const ws2 = _srSheet2(targetBuildings, vacFrom, vacTo);
        XLSX.utils.book_append_sheet(wb, ws2, '공실현황');

        // Sheet3: 기준가 이력 (날짜 필터 적용)
        const ws3 = _srSheet3(targetBuildings, priceFrom, priceTo);
        XLSX.utils.book_append_sheet(wb, ws3, '기준가이력');

        // Sheet4: 전체 빌딩 기준 월별 통계 (필터 무관)
        const ws4 = _srSheet4(srGetNormBuildings());
        XLSX.utils.book_append_sheet(wb, ws4, '권역별통계요약');

        // 파일명 생성
        const suffix   = _srFilenameSuffix(opts);
        const filename = `CRE_통계_${suffix}.xlsx`;

        // 다운로드
        XLSX.writeFile(wb, filename);

        // 완료 토스트 (portal-utils.js showToast 있으면 사용)
        const msg = `${filename} 다운로드 완료 (빌딩 ${targetBuildings.length}개)`;
        if (typeof window.showToast === 'function') {
            window.showToast(msg, 'success');
        } else {
            console.log('✅', msg);
        }

    } catch (err) {
        console.error('[portal-stats] Excel 다운로드 오류:', err);
        alert(`Excel 생성 중 오류가 발생했습니다.\n${err.message}`);
    }
};

// ─────────────────────────────────────────────────────────────
// 5-G. 모달 푸터에 다운로드 버튼 추가 (전체 데이터 기준)
// ─────────────────────────────────────────────────────────────
// portal.html 푸터의 sr-footer-msg 옆 다운로드 버튼을 활성화
// (ISSUE-2~4의 각 탭 버튼과 별개로, 푸터에서 항상 접근 가능)
(function _srInjectFooterBtn() {
    // DOMContentLoaded 이후 실행 보장
    const tryInject = () => {
        const footer = document.querySelector('#statResearchModal [id="sr-footer-msg"]')?.parentElement;
        if (!footer) return;

        // 이미 추가됐으면 skip
        if (footer.querySelector('#sr-footer-dl-btn')) return;

        const btn = document.createElement('button');
        btn.id = 'sr-footer-dl-btn';
        btn.textContent = '📥 전체 Excel 다운로드';
        btn.style.cssText = `
            padding:6px 14px; border:none; border-radius:6px;
            background:#16a34a; color:#fff; font-size:12px;
            font-weight:600; cursor:pointer; margin-right:8px;`;
        btn.onclick = () => {
            // 전체 빌딩 기준 다운로드 (TAB4 필터 무시)
            const saved = window._srTableCurrentData;
            window._srTableCurrentData = srGetNormBuildings();
            window._srDownloadExcel();
            window._srTableCurrentData = saved;
        };

        // 닫기 버튼 앞에 삽입
        const closeBtn = footer.querySelector('button');
        if (closeBtn) footer.insertBefore(btn, closeBtn);
        else footer.appendChild(btn);
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInject);
    } else {
        // 모달은 동적으로 생성되므로 openStatResearchModal 호출 시 주입
        const _origOpen = window.openStatResearchModal;
        window.openStatResearchModal = function() {
            _origOpen && _origOpen();
            setTimeout(tryInject, 50);
        };
    }
})();

// ISSUE-5 loaded


// ═══════════════════════════════════════════════════════════════
// ISSUE-7: 이상값 감지 엔진 (Anomaly Detection)
// ═══════════════════════════════════════════════════════════════
//
// 감지 유형 5가지:
//   PRICE_RANGE      — 권역+등급 그룹 IQR 기반 가격 이상값
//   UNIT_MISMATCH    — 평당이 아닌 총액 오입력 의심 (임대면적 × 임대료 > 상한)
//   AREA_BASIS       — 같은 출처+발행일 내 임대료 편차 과대 (전용/임대 혼재)
//   MONTH_GAP        — 연속 발행 이력에서 특정 월 데이터 누락
//   BUILDING_MISMATCH— 빌딩 기준가 대비 특정 출처 임대료 과도 이탈 (오매칭)
//
// ⚠️ portal-detail.js의 toWon() 로직 반영:
//   vacancy.rentPy 는 "85,000" 문자열 또는 숫자(원단위) 혼재
//   srParsePrice()로 정규화 후 1000 미만이면 만원 단위 → ×10000 변환
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 7-A. 공통 유틸
// ─────────────────────────────────────────────────────────────

/**
 * portal-detail.js toWon() 동일 로직
 * vacancy.rentPy 등 단위 불명확 값을 원/평 단위로 정규화
 */
function _srToWon(val) {
    const n = parseFloat(String(val || '').replace(/[^\d.]/g, '')) || 0;
    if (n === 0) return 0;
    return n < 1000 ? n * 10000 : n;
}

/**
 * 배열에서 IQR 기반 이상값 경계 계산
 * @returns {{ q1, q3, iqr, lower, upper }}
 */
function _srIQR(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    const q1 = sorted[Math.floor(n * 0.25)];
    const q3 = sorted[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    return {
        q1, q3, iqr,
        lower: q1 - 1.5 * iqr,
        upper: q3 + 1.5 * iqr,
        median: sorted[Math.floor(n / 2)],
    };
}

/**
 * AnomalyResult 객체 생성 헬퍼
 */
function _srAnomaly(building, overrides) {
    return {
        buildingId:   building.id,
        buildingName: building.name || '',
        region:       building._region || srGetRegion(building),
        gradeAuto:    building._gradeAuto || srGradeFromPy(building.grossFloorPy),
        vacancyKey:   null,
        source:       '',
        publishDate:  '',
        field:        '',
        actual:       null,
        expected:     null,
        severity:     'LOW',
        type:         '',
        message:      '',
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────
// 7-B. 규칙 1: PRICE_RANGE — IQR + 절대 상한 이상값
// ─────────────────────────────────────────────────────────────

// 서울 오피스 현실 상한 (원/평)
const SR_PRICE_ABS = {
    rentPy:        2_000_000,  // 임대료 200만원/평 초과 → 이상
    depositPy:    20_000_000,  // 보증금 2000만원/평 초과 → 이상
    maintenancePy:   500_000,  // 관리비 50만원/평 초과 → 이상
};
// 현실 하한 (0 초과 & 이 미만이면 만원 단위 오입력 의심)
const SR_PRICE_MIN = {
    rentPy:        10_000,   // 1만원 미만/평
    depositPy:    100_000,   // 10만원 미만/평
    maintenancePy:  3_000,   // 3천원 미만/평
};

function _srDetectPriceRange(building, groupStats) {
    const results = [];
    const vacs = srActiveVacancies(building);
    if (!vacs.length) return results;

    const key = `${building._region}_${building._gradeAuto}`;
    const stats = groupStats[key] || {};

    const fields = ['rentPy', 'depositPy', 'maintenancePy'];
    const labels = { rentPy:'임대료', depositPy:'보증금', maintenancePy:'관리비' };

    vacs.forEach(v => {
        fields.forEach(field => {
            const raw = v[field];
            if (!raw) return;
            const val = _srToWon(raw);
            if (!val) return;

            // 절대 상한 초과
            if (val > SR_PRICE_ABS[field]) {
                results.push(_srAnomaly(building, {
                    vacancyKey:  v._key,
                    source:      v.source || '',
                    publishDate: srNormalizeDate(v.publishDate),
                    field,
                    actual:      val,
                    expected:    { max: SR_PRICE_ABS[field] },
                    severity:    'HIGH',
                    type:        'PRICE_RANGE',
                    message:     `${labels[field]} ${(val/10000).toFixed(0)}만원/평 — 현실 상한(${(SR_PRICE_ABS[field]/10000).toFixed(0)}만원) 초과. 총액을 평당으로 잘못 입력했을 가능성 있음.`,
                }));
                return;
            }

            // 절대 하한 미만 (0 제외)
            if (val < SR_PRICE_MIN[field]) {
                results.push(_srAnomaly(building, {
                    vacancyKey:  v._key,
                    source:      v.source || '',
                    publishDate: srNormalizeDate(v.publishDate),
                    field,
                    actual:      val,
                    expected:    { min: SR_PRICE_MIN[field] },
                    severity:    'MEDIUM',
                    type:        'PRICE_RANGE',
                    message:     `${labels[field]} ${(val/10000).toFixed(2)}만원/평 — 비정상적으로 낮음. 만원 단위 미변환 가능성 있음.`,
                }));
                return;
            }

            // IQR 이상값 (그룹 통계 있을 때만)
            const iqr = stats[field];
            if (iqr && iqr.iqr > 0) {
                if (val > iqr.upper) {
                    results.push(_srAnomaly(building, {
                        vacancyKey:  v._key,
                        source:      v.source || '',
                        publishDate: srNormalizeDate(v.publishDate),
                        field,
                        actual:      val,
                        expected:    { median: iqr.median, upper: iqr.upper },
                        severity:    val > iqr.upper * 1.5 ? 'HIGH' : 'MEDIUM',
                        type:        'PRICE_RANGE',
                        message:     `${labels[field]} ${(val/10000).toFixed(0)}만원/평 — 동일 권역·등급(${building._region} ${building._gradeAuto}) 중앙값(${(iqr.median/10000).toFixed(0)}만원)보다 ${((val/iqr.median-1)*100).toFixed(0)}% 높음.`,
                    }));
                } else if (val < iqr.lower && iqr.lower > 0) {
                    results.push(_srAnomaly(building, {
                        vacancyKey:  v._key,
                        source:      v.source || '',
                        publishDate: srNormalizeDate(v.publishDate),
                        field,
                        actual:      val,
                        expected:    { median: iqr.median, lower: iqr.lower },
                        severity:    'LOW',
                        type:        'PRICE_RANGE',
                        message:     `${labels[field]} ${(val/10000).toFixed(0)}만원/평 — 동일 권역·등급 하위 이상값 (IQR 하한 ${(iqr.lower/10000).toFixed(0)}만원 미만).`,
                    }));
                }
            }
        });
    });

    return results;
}

// ─────────────────────────────────────────────────────────────
// 7-C. 규칙 2: UNIT_MISMATCH — 총액 오입력 (임대면적 × 임대료 > 상한)
// ─────────────────────────────────────────────────────────────

// 서울 오피스 층당 월 임대료 현실 상한: 300평 × 200만원 = 6억
const SR_TOTAL_RENT_MAX = 600_000_000;  // 6억원/층

function _srDetectUnitMismatch(building) {
    const results = [];
    srActiveVacancies(building).forEach(v => {
        const area = parseFloat(v.rentArea) || parseFloat(v.exclusiveArea) || 0;
        const rent = _srToWon(v.rentPy);
        if (!area || !rent) return;

        const totalMonthly = area * rent;
        if (totalMonthly > SR_TOTAL_RENT_MAX) {
            results.push(_srAnomaly(building, {
                vacancyKey:  v._key,
                source:      v.source || '',
                publishDate: srNormalizeDate(v.publishDate),
                field:       'rentPy',
                actual:      rent,
                expected:    { maxTotal: SR_TOTAL_RENT_MAX },
                severity:    'HIGH',
                type:        'UNIT_MISMATCH',
                message:     `임대면적 ${area}평 × 임대료 ${(rent/10000).toFixed(0)}만원 = 월 총 ${(totalMonthly/100000000).toFixed(1)}억원 → 평당이 아닌 총액 입력 의심.`,
            }));
        }
    });
    return results;
}

// ─────────────────────────────────────────────────────────────
// 7-D. 규칙 3: AREA_BASIS — 같은 출처+발행월 내 임대료 편차 과대
// ─────────────────────────────────────────────────────────────

// 같은 안내문 내 임대료 편차가 50% 이상이면 전용/임대면적 기준 혼재 의심
const SR_INTRA_DOC_CV_THRESHOLD = 0.50;

function _srDetectAreaBasis(building) {
    const results = [];
    const vacs = srActiveVacancies(building);
    if (vacs.length < 2) return results;

    // 출처+발행월 그룹핑
    const groups = {};
    vacs.forEach(v => {
        const r = _srToWon(v.rentPy);
        if (!r) return;
        const key = `${v.source || ''}|${srNormalizeDate(v.publishDate)}`;
        if (!groups[key]) groups[key] = { vacs: [], rents: [], source: v.source || '', publishDate: srNormalizeDate(v.publishDate) };
        groups[key].vacs.push(v);
        groups[key].rents.push(r);
    });

    Object.values(groups).forEach(g => {
        if (g.rents.length < 2) return;
        const avg = g.rents.reduce((s, v) => s + v, 0) / g.rents.length;
        if (!avg) return;
        const max = Math.max(...g.rents);
        const min = Math.min(...g.rents);
        const cv  = (max - min) / avg;

        if (cv >= SR_INTRA_DOC_CV_THRESHOLD) {
            const severity = cv >= 0.8 ? 'HIGH' : 'MEDIUM';
            results.push(_srAnomaly(building, {
                source:      g.source,
                publishDate: g.publishDate,
                field:       'rentPy',
                actual:      { min: min, max: max, cv: cv },
                expected:    { maxCv: SR_INTRA_DOC_CV_THRESHOLD },
                severity,
                type:        'AREA_BASIS',
                message:     `[${g.source} ${g.publishDate}] 같은 안내문 내 임대료 편차 ${(cv*100).toFixed(0)}% — 전용면적/임대면적 기준 혼재 또는 총액 입력 의심. (최소 ${(min/10000).toFixed(0)}만 ~ 최대 ${(max/10000).toFixed(0)}만원/평)`,
            }));
        }
    });

    return results;
}

// ─────────────────────────────────────────────────────────────
// 7-E. 규칙 4: MONTH_GAP — 연속 발행이력 중 특정 월 누락
// ─────────────────────────────────────────────────────────────

function _srDetectMonthGap(building) {
    const results = [];
    const vacs = srActiveVacancies(building);

    // 발행월별 공실건수 집계
    const byMonth = {};
    vacs.forEach(v => {
        const d = srNormalizeDate(v.publishDate);
        if (!d) return;
        byMonth[d] = (byMonth[d] || 0) + 1;
    });

    const months = Object.keys(byMonth).sort();
    if (months.length < 3) return results; // 이력 3개월 미만이면 판단 불가

    // 연속 월 사이 gap 검사
    for (let i = 1; i < months.length; i++) {
        const prev = months[i - 1];
        const curr = months[i];

        const [py, pm] = prev.split('-').map(Number);
        const [cy, cm] = curr.split('-').map(Number);
        const monthDiff = (cy - py) * 12 + (cm - pm);

        if (monthDiff <= 1) continue; // 연속

        const prevCount = byMonth[prev];
        const gap = monthDiff - 1; // 빠진 개월 수

        if (prevCount >= 1 && gap >= 1) {
            const severity = (prevCount >= 5 && gap >= 3) ? 'MEDIUM' : 'LOW';
            results.push(_srAnomaly(building, {
                publishDate: `${prev}~${curr}`,
                field:       'publishDate',
                actual:      { gap, prevCount },
                expected:    { maxGap: 1 },
                severity,
                type:        'MONTH_GAP',
                message:     `${prev}(공실 ${prevCount}건) 이후 ${gap}개월 발행 누락 → ${curr} 재등장. 중간 기간 안내문이 없어 공실이 갑자기 사라진 것처럼 보일 수 있음.`,
            }));
        }
    }

    return results;
}

// ─────────────────────────────────────────────────────────────
// 7-F. 규칙 5: BUILDING_MISMATCH — 기준가 대비 특정 출처 과도 이탈
// ─────────────────────────────────────────────────────────────

// 빌딩 기준가 대비 출처별 평균이 ±70% 이상 이탈하면 오매칭 의심
const SR_MISMATCH_RATIO = 0.70;

function _srDetectBuildingMismatch(building) {
    const results = [];
    const bestRent = srGetBestRent(building);
    const baseRent = bestRent.rentPy;
    if (!baseRent) return results; // 기준가 없으면 비교 불가

    // 출처별 평균 임대료 집계
    const bySource = {};
    srActiveVacancies(building).forEach(v => {
        const r = _srToWon(v.rentPy);
        if (!r) return;
        const src = v.source || '(출처없음)';
        if (!bySource[src]) bySource[src] = { sum: 0, cnt: 0, dates: new Set() };
        bySource[src].sum += r;
        bySource[src].cnt++;
        bySource[src].dates.add(srNormalizeDate(v.publishDate));
    });

    Object.entries(bySource).forEach(([src, s]) => {
        if (s.cnt < 1) return;
        const avg = s.sum / s.cnt;
        const ratio = Math.abs(avg - baseRent) / baseRent;

        if (ratio > SR_MISMATCH_RATIO) {
            results.push(_srAnomaly(building, {
                source:      src,
                publishDate: [...s.dates].sort().join(', '),
                field:       'rentPy',
                actual:      avg,
                expected:    { base: baseRent, tolerance: SR_MISMATCH_RATIO },
                severity:    ratio > 1.5 ? 'HIGH' : 'MEDIUM',
                type:        'BUILDING_MISMATCH',
                message:     `[${src}] 출처 평균 임대료 ${(avg/10000).toFixed(0)}만원/평 — 기준가 ${(baseRent/10000).toFixed(0)}만원 대비 ${(ratio*100).toFixed(0)}% 이탈. 타빌딩 안내문 오매칭 의심.`,
            }));
        }
    });

    return results;
}

// ─────────────────────────────────────────────────────────────
// 7-G. 그룹 통계 사전 계산 (권역+등급별 IQR)
// ─────────────────────────────────────────────────────────────

function _srBuildGroupStats(normBuildings) {
    // { "GBD_A": { rentPy: IQRResult, depositPy: IQRResult, maintenancePy: IQRResult } }
    const raw = {};

    normBuildings.forEach(b => {
        const key = `${b._region}_${b._gradeAuto}`;
        if (!raw[key]) raw[key] = { rentPy: [], depositPy: [], maintenancePy: [] };
        srActiveVacancies(b).forEach(v => {
            ['rentPy', 'depositPy', 'maintenancePy'].forEach(f => {
                const val = _srToWon(v[f]);
                if (val > 0) raw[key][f].push(val);
            });
        });
    });

    const stats = {};
    Object.entries(raw).forEach(([key, fields]) => {
        stats[key] = {};
        Object.entries(fields).forEach(([field, vals]) => {
            if (vals.length >= 4) stats[key][field] = _srIQR(vals);
        });
    });

    return stats;
}

// ─────────────────────────────────────────────────────────────
// 7-H. 메인 감지 함수
// ─────────────────────────────────────────────────────────────

/**
 * 전체 빌딩에 대해 이상값 감지 실행
 * @param {Array} normBuildings  srGetNormBuildings() 결과
 * @returns {AnomalyResult[]}
 */
export function srDetectAnomalies(normBuildings) {
    const groupStats = _srBuildGroupStats(normBuildings);
    const results    = [];

    normBuildings.forEach(b => {
        // 공실 데이터가 없으면 건너뜀
        if (!b._activeVacs || b._activeVacs.length === 0) return;

        results.push(..._srDetectPriceRange(b, groupStats));
        results.push(..._srDetectUnitMismatch(b));
        results.push(..._srDetectAreaBasis(b));
        results.push(..._srDetectMonthGap(b));
        results.push(..._srDetectBuildingMismatch(b));
    });

    // severity 순 정렬: HIGH → MEDIUM → LOW
    const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    results.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

    return results;
}

/**
 * 빌딩 단위 요약: { buildingId → { HIGH, MEDIUM, LOW, total, types } }
 */
export function srSummarizeAnomalies(anomalies) {
    const summary = {};
    anomalies.forEach(a => {
        if (!summary[a.buildingId]) {
            summary[a.buildingId] = {
                buildingId:   a.buildingId,
                buildingName: a.buildingName,
                region:       a.region,
                gradeAuto:    a.gradeAuto,
                HIGH: 0, MEDIUM: 0, LOW: 0, total: 0,
                types: new Set(),
            };
        }
        summary[a.buildingId][a.severity]++;
        summary[a.buildingId].total++;
        summary[a.buildingId].types.add(a.type);
    });

    // types를 배열로 변환
    Object.values(summary).forEach(s => {
        s.types = [...s.types];
    });

    return Object.values(summary).sort((a, b) => {
        // HIGH 많은 순 → total 순
        if (b.HIGH !== a.HIGH) return b.HIGH - a.HIGH;
        return b.total - a.total;
    });
}

// ─────────────────────────────────────────────────────────────
// 7-I. window.srLib 업데이트
// ─────────────────────────────────────────────────────────────
if (window.srLib) {
    window.srLib.srDetectAnomalies  = srDetectAnomalies;
    window.srLib.srSummarizeAnomalies = srSummarizeAnomalies;
}

// ISSUE-7 loaded

// ═══════════════════════════════════════════════════════════════
// ISSUE-8: TAB5 — 이상값 감지 대시보드 UI
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// 8-A. 이상값 캐시 + 필터 상태
// ─────────────────────────────────────────────────────────────
let _srAnomalyCache  = [];   // 마지막 스캔 결과
const _srAnomalyFilterUI = { severity:'', type:'', region:'' };

const SR_ANOMALY_TYPE_LABEL = {
    PRICE_RANGE:       '가격 범위 이상',
    UNIT_MISMATCH:     '단위 오류 (총액 입력)',
    AREA_BASIS:        '면적 기준 혼재',
    MONTH_GAP:         '월 데이터 누락',
    BUILDING_MISMATCH: '빌딩 오매칭 의심',
};
const SR_SEVERITY_COLOR = { HIGH:'#dc2626', MEDIUM:'#d97706', LOW:'#ca8a04' };
const SR_SEVERITY_BG    = { HIGH:'#fee2e2', MEDIUM:'#ffedd5', LOW:'#fefce8' };

// ─────────────────────────────────────────────────────────────
// 8-B. 스캔 실행
// ─────────────────────────────────────────────────────────────
window._srRunAnomalyScan = function() {
    const btn = document.getElementById('sr-anomaly-scan-btn');
    const msg = document.getElementById('sr-anomaly-scan-msg');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 스캔 중...'; }
    if (msg) msg.textContent = '';

    // 탐지는 항상 원본(비필터) 데이터 기준
    const allNorm  = srGetNormBuildings();
    const anomalies = srDetectAnomalies(allNorm);
    _srAnomalyCache = anomalies;

    // 이상값 제외 Set 업데이트 (vacancyKey 있는 항목만)
    _srAnomalyExclude.excludeSet.clear();
    anomalies.forEach(a => {
        if (a.vacancyKey && a.severity !== 'LOW') {   // LOW는 제외 대상에서 뺌
            _srAnomalyExclude.excludeSet.add(`${a.buildingId}::${a.vacancyKey}`);
        }
    });
    _srAnomalyExclude.lastCount = _srAnomalyExclude.excludeSet.size;
    _srUpdateExcludeBanner();

    if (btn) { btn.disabled = false; btn.textContent = '🔍 전체 이상값 스캔'; }

    // 결과 요약
    const high   = anomalies.filter(a => a.severity === 'HIGH').length;
    const medium = anomalies.filter(a => a.severity === 'MEDIUM').length;
    const low    = anomalies.filter(a => a.severity === 'LOW').length;

    if (msg) msg.textContent =
        `총 ${allNorm.length}개 빌딩 스캔 완료 — ${anomalies.length}건 이상값 감지`;

    // severity 뱃지
    const badges = document.getElementById('sr-anomaly-severity-badges');
    if (badges) {
        badges.innerHTML = [
            { label:`🔴 HIGH ${high}`,   bg:'#fee2e2', clr:'#dc2626' },
            { label:`🟠 MEDIUM ${medium}`,bg:'#ffedd5', clr:'#d97706' },
            { label:`🟡 LOW ${low}`,     bg:'#fefce8', clr:'#ca8a04' },
        ].map(b => `<span style="background:${b.bg}; color:${b.clr}; border-radius:6px;
                               padding:4px 10px; font-size:12px; font-weight:700;">${b.label}</span>`
        ).join('');
    }

    _srAnomalyFilterReset();

    // 이상값 제외 체크박스가 켜져 있으면 현재 탭 재렌더
    if (_srAnomalyExclude.enabled) _srRefreshCurrentTab();
};

// ─────────────────────────────────────────────────────────────
// 8-C. 필터 핸들러
// ─────────────────────────────────────────────────────────────
window._srAnomalyFilterChange = function() {
    _srAnomalyFilterUI.severity = document.getElementById('srA-severity')?.value || '';
    _srAnomalyFilterUI.type     = document.getElementById('srA-type')?.value     || '';
    _srAnomalyFilterUI.region   = document.getElementById('srA-region')?.value   || '';
    _srRenderAnomalyTable();
    _srRenderAnomalyBldgTable();
};

window._srAnomalyFilterReset = function() {
    _srAnomalyFilterUI.severity = _srAnomalyFilterUI.type = _srAnomalyFilterUI.region = '';
    ['srA-severity','srA-type','srA-region'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    _srRenderAnomalyTable();
    _srRenderAnomalyBldgTable();
};

function _srGetFilteredAnomalies() {
    return _srAnomalyCache.filter(a => {
        if (_srAnomalyFilterUI.severity && a.severity !== _srAnomalyFilterUI.severity) return false;
        if (_srAnomalyFilterUI.type     && a.type     !== _srAnomalyFilterUI.type)     return false;
        if (_srAnomalyFilterUI.region   && a.region   !== _srAnomalyFilterUI.region)   return false;
        return true;
    });
}

// ─────────────────────────────────────────────────────────────
// 8-D. 이상값 상세 테이블
// ─────────────────────────────────────────────────────────────
function _srRenderAnomalyTable() {
    const el = document.getElementById('sr-anomaly-table');
    if (!el) return;
    const list = _srGetFilteredAnomalies();

    const cntEl = document.getElementById('srA-count');
    if (cntEl) cntEl.textContent = `${list.length}건`;

    if (!list.length) {
        el.innerHTML = `<div style="padding:32px; text-align:center; color:var(--text-muted);">
            ${_srAnomalyCache.length ? '필터 조건에 맞는 이상값 없음' : '🔍 스캔 버튼을 눌러 이상값을 감지하세요.'}
        </div>`;
        return;
    }

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px; min-width:800px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0; z-index:1;">
        <tr>
          <th style="padding:7px 10px; text-align:left; border-bottom:2px solid var(--border-color); white-space:nowrap;">빌딩명</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">권역</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">심각도</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">유형</th>
          <th style="padding:7px 10px; text-align:left; border-bottom:2px solid var(--border-color);">출처</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">발행월</th>
          <th style="padding:7px 10px; text-align:left; border-bottom:2px solid var(--border-color); min-width:240px;">설명</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">이동</th>
        </tr>
      </thead>
      <tbody>`;

    list.forEach((a, i) => {
        const svClr = SR_SEVERITY_COLOR[a.severity] || '#6b7280';
        const svBg  = SR_SEVERITY_BG[a.severity]    || '#f9fafb';
        const typeLabel = SR_ANOMALY_TYPE_LABEL[a.type] || a.type;
        const bg = i % 2 === 1 ? 'background:var(--bg-secondary);' : '';
        const isExcluded = a.vacancyKey && _srAnomalyExclude.excludeSet.has(`${a.buildingId}::${a.vacancyKey}`);

        html += `
        <tr style="${bg} border-bottom:1px solid var(--border-color); ${isExcluded?'opacity:0.55;':''}">
          <td style="padding:7px 10px; font-weight:500; max-width:130px; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap;" title="${a.buildingName}">
            ${isExcluded ? '<span title="통계에서 제외됨" style="margin-right:3px;">🚫</span>' : ''}${a.buildingName}
          </td>
          <td style="padding:7px 10px; text-align:center; font-weight:700;
                     color:${SR_REGION_COLOR[a.region]||'#64748b'};">${a.region}</td>
          <td style="padding:7px 10px; text-align:center;">
            <span style="background:${svBg}; color:${svClr}; border-radius:5px;
                         padding:2px 8px; font-size:11px; font-weight:700;">${a.severity}</span>
          </td>
          <td style="padding:7px 10px; text-align:center; font-size:11px; color:var(--text-muted);
                     max-width:100px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"
              title="${typeLabel}">${typeLabel}</td>
          <td style="padding:7px 10px; color:var(--text-muted); max-width:80px; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap;">${a.source || '-'}</td>
          <td style="padding:7px 10px; text-align:center; color:var(--text-muted); white-space:nowrap;">${a.publishDate || '-'}</td>
          <td style="padding:7px 10px; font-size:11px; color:var(--text-primary); line-height:1.5;">${a.message}</td>
          <td style="padding:7px 10px; text-align:center;">
            <button onclick="_srGoToBuilding('${a.buildingId}')"
                style="padding:4px 10px; background:#eff6ff; border:1px solid #bfdbfe;
                       border-radius:5px; cursor:pointer; font-size:11px; color:#1e40af;
                       white-space:nowrap;">📄 안내문</button>
          </td>
        </tr>`;
    });

    html += '</tbody></table>';
    el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// 8-E. 빌딩별 요약 테이블
// ─────────────────────────────────────────────────────────────
function _srRenderAnomalyBldgTable() {
    const el = document.getElementById('sr-anomaly-bldg-table');
    if (!el) return;

    const list   = _srGetFilteredAnomalies();
    const summary = srSummarizeAnomalies(list);

    if (!summary.length) {
        el.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted);">데이터 없음</div>';
        return;
    }

    let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px;">
      <thead style="background:var(--bg-secondary); position:sticky; top:0;">
        <tr>
          <th style="padding:7px 10px; text-align:left; border-bottom:2px solid var(--border-color);">빌딩명</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">권역</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">등급</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">🔴 HIGH</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">🟠 MED</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">🟡 LOW</th>
          <th style="padding:7px 10px; text-align:right; border-bottom:2px solid var(--border-color);">합계</th>
          <th style="padding:7px 10px; text-align:left; border-bottom:2px solid var(--border-color);">감지 유형</th>
          <th style="padding:7px 10px; text-align:center; border-bottom:2px solid var(--border-color);">이동</th>
        </tr>
      </thead>
      <tbody>`;

    summary.forEach((s, i) => {
        const bg = i % 2 === 1 ? 'background:var(--bg-secondary);' : '';
        const typeLabels = (s.types || []).map(t =>
            SR_ANOMALY_TYPE_LABEL[t]?.slice(0, 6) || t
        ).join(', ');

        html += `
        <tr style="${bg} border-bottom:1px solid var(--border-color);">
          <td style="padding:7px 10px; font-weight:500; max-width:140px; overflow:hidden;
                     text-overflow:ellipsis; white-space:nowrap;" title="${s.buildingName}">
            ${s.buildingName}
          </td>
          <td style="padding:7px 10px; text-align:center; font-weight:700;
                     color:${SR_REGION_COLOR[s.region]||'#64748b'};">${s.region}</td>
          <td style="padding:7px 10px; text-align:center; color:${SR_GRADE_COLOR[s.gradeAuto]||'#94a3b8'}; font-weight:700;">${s.gradeAuto||'-'}</td>
          <td style="padding:7px 10px; text-align:center; font-weight:700;
                     color:${s.HIGH ? '#dc2626' : 'var(--text-muted)'};">${s.HIGH || '-'}</td>
          <td style="padding:7px 10px; text-align:center; font-weight:${s.MEDIUM?'600':'400'};
                     color:${s.MEDIUM ? '#d97706' : 'var(--text-muted)'};">${s.MEDIUM || '-'}</td>
          <td style="padding:7px 10px; text-align:center; color:var(--text-muted);">${s.LOW || '-'}</td>
          <td style="padding:7px 10px; text-align:right; font-weight:700;">${s.total}</td>
          <td style="padding:7px 10px; font-size:11px; color:var(--text-muted);">${typeLabels}</td>
          <td style="padding:7px 10px; text-align:center;">
            <button onclick="_srGoToBuilding('${s.buildingId}')"
                style="padding:4px 10px; background:#eff6ff; border:1px solid #bfdbfe;
                       border-radius:5px; cursor:pointer; font-size:11px; color:#1e40af;">
                📄 안내문
            </button>
          </td>
        </tr>`;
    });

    html += '</tbody></table>';
    el.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────
// 8-F. 빌딩 안내문 탭 이동
// ─────────────────────────────────────────────────────────────
window._srGoToBuilding = function(buildingId) {
    if (!buildingId) return;
    window.closeStatResearchModal();

    const go = () => {
        if (typeof window.openDetail === 'function') {
            window.openDetail(buildingId);
            // 상세패널이 열린 후 안내문 탭으로 전환
            setTimeout(() => {
                if (typeof window.switchToTab === 'function') {
                    window.switchToTab('document');
                }
            }, 150);
        } else if (typeof window.showBuildingDetail === 'function') {
            window.showBuildingDetail(buildingId);
        } else {
            // 지도에서 찾기 fallback
            const b = window.state?.allBuildings?.find(x => x.id === buildingId);
            if (b && typeof window.panToBuilding === 'function') window.panToBuilding(b);
        }
    };

    // 모달 닫힘 애니메이션 후 이동
    setTimeout(go, 100);
};

// ─────────────────────────────────────────────────────────────
// 8-G. TAB5 메인 렌더 진입점
// ─────────────────────────────────────────────────────────────
window._srRenderAnomaly = function() {
    // 이미 스캔 결과가 있으면 그대로 표시, 없으면 안내만
    _srRenderAnomalyTable();
    _srRenderAnomalyBldgTable();
    _srUpdateExcludeBanner();

    // 제외 체크박스 상태 동기화
    const cb = document.getElementById('sr-exclude-anomalies');
    if (cb) cb.checked = _srAnomalyExclude.enabled;
};

// ISSUE-8 loaded

// ═══════════════════════════════════════════════════════════════
// PHASE 6: 월별·회사별 공실률 매트릭스 데이터 레이어
// ───────────────────────────────────────────────────────────────
// 빌딩상세 > 📊 통계 버튼(renderStatsSection in portal-detail.js)이
// 이미 (source × publishDate) 구조로 집계하지만 최신 publishDate 1건만
// 유지하고 월 차원을 버린다. Phase 6 매트릭스 탭은 모든 월을 유지한
// (source × yyyymm) 2차원 그리드가 필요하므로, 해당 집계 로직을 순수
// 함수로 추출해 이 섹션에 신규 export 한다.
//
// 공실률 정의 (한국부동산원 REB 기준):
//   공실률 = Σ vacancy.rentArea / building.grossFloorPy × 100
//   (기본 면적기준: 임대면적 / 옵션: 전용면적)
//
// 평균 임대가 (면적가중):
//   Σ (rentPy × area) / Σ area
// ═══════════════════════════════════════════════════════════════

/**
 * 공실의 면적(평)을 기준별로 반환 — Phase 6 매트릭스용 신규 유틸.
 * 기존 srVacancyAreaPy()는 exclusiveArea 우선이므로 그대로 두고,
 * 매트릭스에서는 한국부동산원 공식 공실률 기준(임대면적)을 기본으로 사용한다.
 *
 * @param {Object} vacancy
 * @param {'rent'|'exclusive'} basis
 *        'rent'      (기본): rentArea 우선 → 없으면 exclusiveArea fallback
 *        'exclusive' (토글): exclusiveArea 우선 → 없으면 rentArea fallback
 * @returns {number}  면적(평) · 둘 다 없으면 0
 */
export function srVacancyAreaByBasis(vacancy, basis = 'rent') {
    const rent = parseFloat(vacancy.rentArea)      || 0;
    const excl = parseFloat(vacancy.exclusiveArea) || 0;
    if (basis === 'exclusive') {
        return excl > 0 ? excl : rent;
    }
    return rent > 0 ? rent : excl;
}

/**
 * 매트릭스 셀(= 공실 리스트)의 집계 통계 계산.
 * portal-detail.js > renderStatsSection() 내부 inline 함수 calcStats()를
 * 순수 함수로 추출·확장. 호환성 유지 위해 기존 renderStatsSection은
 * 건드리지 않고 이 함수는 신규 소비처(Phase 6 매트릭스)에서만 사용한다.
 *
 * @param {Array} vacList  집계 대상 공실 배열
 * @param {number} grossFloorPy  빌딩 연면적(평) · 공실률 분모
 * @param {Object} [opts]
 * @param {'rent'|'exclusive'} [opts.areaBasis='rent']  면적 기준
 * @returns {{
 *   vacancyPyTotal: number,   공실 면적 합계 (선택된 기준)
 *   floorCount:     number,   공실 건수 (레코드 수)
 *   vacancyRate:    number|null,   공실률(%) · 연면적 0 이면 null
 *   simpleAvgRent:  number|null,   임대가 산술평균 · rentPy 없으면 null
 *   weightedAvgRent:number|null,   임대가 면적가중평균 · 데이터 없으면 null
 *   areaBasis:      string         사용된 면적 기준 (추적용)
 * }}
 */
export function srCalcCellStats(vacList, grossFloorPy, opts = {}) {
    const basis = opts.areaBasis || 'rent';
    const list  = Array.isArray(vacList) ? vacList : [];

    const vacancyPyTotal = list.reduce((s, v) => s + srVacancyAreaByBasis(v, basis), 0);
    const floorCount     = list.length;
    const vacancyRate    = grossFloorPy > 0
        ? (vacancyPyTotal / grossFloorPy * 100)
        : null;

    const withRent = list.filter(v => srParsePrice(v.rentPy) > 0);

    let simpleAvgRent = null;
    if (withRent.length > 0) {
        const rentSum = withRent.reduce((s, v) => s + srParsePrice(v.rentPy), 0);
        simpleAvgRent = rentSum / withRent.length;
    }

    let weightedAvgRent = null;
    const withRentAndArea = withRent.filter(v => srVacancyAreaByBasis(v, basis) > 0);
    if (withRentAndArea.length > 0) {
        const weightedSum = withRentAndArea.reduce(
            (s, v) => s + srParsePrice(v.rentPy) * srVacancyAreaByBasis(v, basis),
            0
        );
        const totalWeightArea = withRentAndArea.reduce(
            (s, v) => s + srVacancyAreaByBasis(v, basis),
            0
        );
        if (totalWeightArea > 0) weightedAvgRent = weightedSum / totalWeightArea;
    }

    return {
        vacancyPyTotal,
        floorCount,
        vacancyRate,
        simpleAvgRent,
        weightedAvgRent,
        areaBasis: basis,
    };
}

/**
 * 빌딩 × (발행사, 발행월) 매트릭스 빌더 — Phase 6 데이터 레이어 메인 함수.
 *
 * renderStatsSection()의 그룹핑 로직:
 *   vacancies → _meta 분리 → leasingGuide 합치기 → (source, publishDate) 그룹
 * 을 그대로 재현하되, publishDate를 srNormalizeDate()로 yyyymm 정규화하여
 * (source × yyyymm) 2차원 매트릭스를 만든다.
 *
 * "공실없음(_meta + noVacancy:true)" 선언도 해당 (source, yyyymm) 셀에
 * vacancyRate=0, noVacancy:true 로 포함시킨다 (A안 — 집계에 반영).
 *
 * @param {Object} building
 * @param {Object} [opts]
 * @param {'rent'|'exclusive'} [opts.areaBasis='rent']
 *
 * @returns {{
 *   buildingId:    string,
 *   buildingName:  string,
 *   grossFloorPy:  number,
 *   areaBasis:     string,
 *   sources:       string[],     // 정렬된 발행사 목록
 *   months:        string[],     // 정렬된 yyyymm 목록 ('2025-10' 형식)
 *   cells: {
 *     [key: string]: {           // key = `${source}__${yyyymm}`
 *       source:         string,
 *       yyyymm:         string,
 *       publishDateRaw: string,  // 정규화 전 원본 (가장 최근 발견값)
 *       vacancies:      Array,
 *       noVacancy:      boolean, // _meta 기반 공실없음 선언 여부
 *       vacancyPyTotal: number,
 *       floorCount:     number,
 *       vacancyRate:    number|null,
 *       simpleAvgRent:  number|null,
 *       weightedAvgRent:number|null,
 *       areaBasis:      string,
 *     }
 *   },
 *   unknownCell?: {              // publishDate 또는 source 누락분 (설계 §33 처리)
 *     source:    '(미기재)',
 *     yyyymm:    '(미기재)',
 *     vacancies: Array,
 *     ...stats
 *   }
 * }}
 */
export function srBuildingMatrix(building, opts = {}) {
    const basis = opts.areaBasis || 'rent';

    // ─── 1) 활성 공실 추출 (renderStatsSection과 동일 규칙) ───────────
    // srActiveVacancies는 _meta/deleted/hidden 제외하므로, _meta는 별도 수집.
    const rawVacs = building.vacancies || [];
    const vacancyMetas = {};
    const activeVacs = [];

    rawVacs.forEach(v => {
        if (!v) return;
        if (v._key && v._key.endsWith('_meta')) {
            // _meta: 공실없음 선언 등 메타정보
            const metaKey = (v.source && v.publishDate)
                ? `${v.source}_${v.publishDate}`
                : v._key.replace('_meta', '');
            vacancyMetas[metaKey] = v;
            return;
        }
        if (v.status === 'deleted' || v.hidden === true || v.deleted === true) return;
        activeVacs.push(v);
    });

    // leasingGuideVacancies 합치기 (renderStatsSection Line 2724~2731 동일 로직)
    const lgVacs = building.leasingGuideVacancies || [];
    if (lgVacs.length > 0) {
        lgVacs.forEach(lgv => {
            const exists = activeVacs.some(v =>
                v.floor === lgv.floor &&
                v.source === lgv.source &&
                v.publishDate === lgv.publishDate
            );
            if (!exists) activeVacs.push(lgv);
        });
    }

    const grossFloorPy = parseFloat(building.area?.grossFloorPy || building.grossFloorPy) || 0;

    // ─── 2) (source, yyyymm) 그룹핑 ───────────────────────────────────
    const groups = {};   // key → { source, yyyymm, publishDateRaw, vacancies }
    const sourceSet = new Set();
    const monthSet = new Set();
    const unknownVacs = [];

    activeVacs.forEach(v => {
        const src    = (v.source || '').trim();
        const yyyymm = srNormalizeDate(v.publishDate);

        if (!src || !yyyymm) {
            unknownVacs.push(v);
            return;
        }

        const key = `${src}__${yyyymm}`;
        if (!groups[key]) {
            groups[key] = {
                source:         src,
                yyyymm,
                publishDateRaw: v.publishDate || '',
                vacancies:      [],
                noVacancy:      false,
            };
        }
        groups[key].vacancies.push(v);
        sourceSet.add(src);
        monthSet.add(yyyymm);
    });

    // ─── 3) _meta 기반 "공실없음" 셀 보강 ─────────────────────────────
    //       vacancies 배열에 실제 공실 레코드가 없지만 해당 회사·월에
    //       공실없음 선언이 있는 경우 — 매트릭스에 rate=0 셀로 등장해야 함.
    Object.entries(vacancyMetas).forEach(([metaKey, meta]) => {
        if (!meta.noVacancy) return;
        const src    = (meta.source || metaKey.split('_')[0] || '').trim();
        const yyyymm = srNormalizeDate(meta.publishDate);
        if (!src || !yyyymm) return;

        const key = `${src}__${yyyymm}`;
        if (!groups[key]) {
            groups[key] = {
                source:         src,
                yyyymm,
                publishDateRaw: meta.publishDate || '',
                vacancies:      [],
                noVacancy:      true,
            };
            sourceSet.add(src);
            monthSet.add(yyyymm);
        } else {
            // 이미 셀이 있어도 명시적 공실없음 선언은 플래그로 유지
            groups[key].noVacancy = true;
        }
    });

    // ─── 4) 각 셀 집계 ────────────────────────────────────────────────
    const cells = {};
    Object.entries(groups).forEach(([key, g]) => {
        const stats = srCalcCellStats(g.vacancies, grossFloorPy, { areaBasis: basis });
        cells[key] = { ...g, ...stats };
    });

    // ─── 5) 결과 조립 ─────────────────────────────────────────────────
    const result = {
        buildingId:   building.id || building._id || building.fbId || '',
        buildingName: building.name || building.buildingName || '',
        grossFloorPy,
        areaBasis:    basis,
        sources:      [...sourceSet].sort(),
        months:       [...monthSet].sort(),
        cells,
    };

    if (unknownVacs.length > 0) {
        result.unknownCell = {
            source:         '(미기재)',
            yyyymm:         '(미기재)',
            publishDateRaw: '',
            vacancies:      unknownVacs,
            noVacancy:      false,
            ...srCalcCellStats(unknownVacs, grossFloorPy, { areaBasis: basis }),
        };
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════
// PHASE 2 MVP: 분기 비교 AI 분석 모달
// (2026-04) — 권역별 공실현황 탭 상단 버튼에서 호출
//
// 설계 원칙 (2026-04 Oram 확정):
//   · 기준 분기 (baseline) = 현재 통계 모달의 분기 (_srPersistentExclude.loadedQuarter)
//   · 편집 모달에서 저장된 빌딩셋 · 제외목록 · repMonth 그대로 적용
//   · 비교 대상 분기 하나만 드롭다운에서 선택
//   · 분석 우선순위:
//       1) 동일 빌딩의 공실 변화 (가장 가치 있음)
//       2) 권역별 공실률 집계 변화
//       3) 신규 공실 빌딩 · 해소 빌딩 (빌딩셋 차이)
// ═══════════════════════════════════════════════════════════════

const _SR_COMPARE_API = 'https://portal-dsyl.onrender.com/api/analyze-quarters';
const _SR_CMP_MODAL_ID = 'sr-compare-modal';

const _srCompareState = {
    quartersAvailable: [],   // [{ q: '2026Q1', status: 'draft'|'finalized' }, ...]
    baselineQuarter:   '',   // 현재 통계 모달이 보고 있는 분기 (읽기 전용)
    compareQuarter:    '',   // 비교 대상 분기 (드롭다운)
    includeDraft:      true,
    lastPayload:       null, // raw 데이터 표시용
};

/**
 * statsFilter 루트를 스캔해 분기 목록 로드
 */
async function _srLoadAvailableQuarters() {
    try {
        const { db, ref, get } = await import('./portal-firebase.js');
        const snap = await get(ref(db, 'statsFilter'));
        const root = snap.val() || {};
        const list = Object.keys(root)
            .sort()
            .reverse()
            .map(q => ({
                q,
                status: root[q]?.status === 'finalized' ? 'finalized' : 'draft',
            }));
        _srCompareState.quartersAvailable = list;
        return list;
    } catch (err) {
        console.error('[compare] 분기 목록 로드 실패:', err);
        return [];
    }
}

/**
 * 분기 → 월 범위 ('2026Q1' → ['2026-01','2026-02','2026-03'])
 */
function _srQuarterMonths(q) {
    if (!/^\d{4}Q[1-4]$/.test(q)) return [];
    const yyyy  = q.slice(0, 4);
    const qPart = q.slice(5);
    const ms = { Q1: ['01','02','03'], Q2: ['04','05','06'],
                 Q3: ['07','08','09'], Q4: ['10','11','12'] }[qPart] || [];
    return ms.map(m => `${yyyy}-${m}`);
}

/**
 * 핵심 집계 함수 — "동일 빌딩셋 이중 분기 집계" (옵션 A 방향)
 *
 * baseline: 현재 편집 저장 상태 (_srPersistentExclude 기반)
 * 방식:
 *   1) baseline 빌딩셋 확정 (filters/excluded/vacOnly 적용)
 *   2) baseline 의 repMonths 를 로드
 *   3) 각 빌딩에 대해 두 분기 각각의 "대표 공실 수치" 계산:
 *      - baseline 분기: repMonth 가 있으면 그 월, 없으면 baseline 분기 마지막 월
 *      - 비교 분기: baseline 의 repMonth yyyymm 을 "비교 분기의 대응 월" 로 치환 후 그 월,
 *        치환 월이 비교 분기 범위 밖이면 비교 분기 마지막 월
 *   4) 빌딩별로 vacancyPy 합산 (해당 월의 공실만)
 *   5) 권역별 롤업
 *
 * @param {string} baselineQ  현재 통계 모달 분기
 * @param {string} compareQ   비교 대상 분기
 * @returns {Promise<{ baseline, compare, buildingPairs, diff }>}
 */
async function _srBuildComparePayload(baselineQ, compareQ) {
    const { db, ref, get } = await import('./portal-firebase.js');

    // baseline 의 편집 저장 상태 로드 (현재 메모리 + DB 교차)
    const baseSnap = await get(ref(db, `statsFilter/${baselineQ}`));
    const baseData = baseSnap.val() || {};
    const repMonths = baseData.repMonths || {};
    const baselineFilters = baseData.filters || {};
    const baselineRegs = Array.isArray(baselineFilters.regions) ? [...baselineFilters.regions] : [];
    if (baselineRegs.includes('ETC') && !baselineRegs.includes('Others')) baselineRegs.push('Others');
    const excludedB = new Set(Object.keys(baseData.excludedBuildings || {}));
    const excludedV = new Set(Object.keys(baseData.excludedVacancies || {}));

    // baseline 빌딩셋 확정
    const match = (arr, val) => !arr || !arr.length || arr.includes(val);
    const norm = srGetNormBuildings();
    const baselineBldgs = norm.filter(b => {
        if (!match(baselineFilters.grades, b._gradeAuto)) return false;
        if (!match(baselineRegs,           b._region))    return false;
        if (excludedB.has(b.id))                          return false;
        return true;
    });

    // 월 범위
    const baselineMonths = _srQuarterMonths(baselineQ);
    const compareMonths  = _srQuarterMonths(compareQ);
    const baselineLastMo = baselineMonths[baselineMonths.length - 1];
    const compareLastMo  = compareMonths[compareMonths.length - 1];

    // 빌딩별 이중 집계
    const pairs = [];
    for (const b of baselineBldgs) {
        const gross = parseFloat(b.grossFloorPy) || 0;
        // repMonth 확정
        const rm = repMonths[b.id];
        const baselineRepMo = (rm && typeof rm === 'object' && rm.yyyymm) ? rm.yyyymm
                             : (typeof rm === 'string' ? rm : baselineLastMo);
        // 비교 분기의 "대응 월": baselineRepMo 와 월 포지션이 같은 월
        // 예: baseline 2026Q1, rep='2026-02' → compare 2025Q4 → 대응 = '2025-11' (Q 내 두 번째 달)
        let compareRepMo = compareLastMo;
        if (baselineRepMo) {
            const pos = baselineMonths.indexOf(baselineRepMo);
            if (pos >= 0 && pos < compareMonths.length) {
                compareRepMo = compareMonths[pos];
            }
        }

        // vacancy 필터: baseline 의 excludedV 를 양쪽에 모두 적용 (동일 잣대)
        //   + 해당 월 매칭
        const matchMonth = (vacs, yyyymm) => vacs.filter(v => {
            if (v._key && excludedV.has(`${b.id}__${v._key}`)) return false;
            const pd = String(v.publishDate || v.pd || '').slice(0, 7);
            return pd === yyyymm;
        });
        const baselineVacs = matchMonth(b._activeVacs || [], baselineRepMo);
        const compareVacs  = matchMonth(b._activeVacs || [], compareRepMo);

        const baselinePy = baselineVacs.reduce((s,v) => s + srVacancyAreaPy(v), 0);
        const comparePy  = compareVacs.reduce((s,v)  => s + srVacancyAreaPy(v), 0);

        // vacOnly: baseline 기준으로 양쪽 다 0 이면 스킵
        //   — AI 프롬프트 크기 관리 (baseline 에 공실 있거나 compare 에 공실 있는 건만 유지)
        if (baselineFilters.vacOnly !== false && baselinePy === 0 && comparePy === 0) continue;

        pairs.push({
            id:     b.id,
            name:   b.name,
            region: b._region,
            grade:  b._gradeAuto,
            gross,
            baselineMo: baselineRepMo,
            compareMo:  compareRepMo,
            baseline: { count: baselineVacs.length, py: baselinePy,
                        rate: gross > 0 ? baselinePy / gross * 100 : 0 },
            compare:  { count: compareVacs.length,  py: comparePy,
                        rate: gross > 0 ? comparePy  / gross * 100 : 0 },
        });
    }

    // 권역별 롤업
    const rollup = (side) => {
        const by = {};
        SR_REGIONS.forEach(r => by[r] = { buildings: 0, vacancyCount: 0, vacancyPy: 0, gross: 0 });
        pairs.forEach(p => {
            const bucket = by[p.region];
            if (!bucket) return;
            bucket.buildings++;
            bucket.vacancyCount += p[side].count;
            bucket.vacancyPy    += p[side].py;
            bucket.gross        += p.gross;
        });
        const out = {};
        Object.keys(by).forEach(r => {
            const e = by[r];
            if (e.buildings === 0) return;  // 빈 권역은 제외
            out[r] = {
                buildings:    e.buildings,
                vacancyCount: e.vacancyCount,
                vacancyPy:    Math.round(e.vacancyPy),
                rate:         e.gross > 0 ? +(e.vacancyPy / e.gross * 100).toFixed(2) : 0,
            };
        });
        return out;
    };

    const baselineByRgn = rollup('baseline');
    const compareByRgn  = rollup('compare');

    // 전체 요약
    const sumSide = (side) => {
        const total = pairs.reduce((s,p) => s + p[side].py, 0);
        const gross = pairs.reduce((s,p) => s + p.gross, 0);
        return {
            totalBuildings:       pairs.length,
            buildingsWithVacancy: pairs.filter(p => p[side].py > 0).length,
            totalVacancyCount:    pairs.reduce((s,p) => s + p[side].count, 0),
            totalVacancyPy:       Math.round(total),
            overallRate:          gross > 0 ? +(total / gross * 100).toFixed(2) : 0,
        };
    };
    const baselineSummary = sumSide('baseline');
    const compareSummary  = sumSide('compare');

    // 권역별 delta
    const diffByRegion = {};
    SR_REGIONS.forEach(r => {
        const a = baselineByRgn[r];  // baseline
        const c = compareByRgn[r];   // compare
        if (!a && !c) return;
        const aRate = a?.rate || 0;
        const cRate = c?.rate || 0;
        diffByRegion[r] = {
            // baseline → compare 방향
            baselineRate:   aRate,
            compareRate:    cRate,
            rateDelta:      +(cRate - aRate).toFixed(2),
            buildingDelta:  (c?.buildings || 0) - (a?.buildings || 0),
            pyDelta:        (c?.vacancyPy   || 0) - (a?.vacancyPy  || 0),
        };
    });

    // 빌딩 단위 변화 분류
    //   - newVacancy:    baseline py=0 & compare py>0
    //   - resolvedVacancy: baseline py>0 & compare py=0
    //   - increased:     baseline py>0 & compare py > baseline py
    //   - decreased:     baseline py>0 & compare py < baseline py (>0)
    //   - unchanged:     baseline py == compare py (> 0 만)
    const newVac = [];
    const resolvedVac = [];
    const increased = [];
    const decreased = [];
    pairs.forEach(p => {
        const bP = p.baseline.py, cP = p.compare.py;
        if (bP === 0 && cP > 0) {
            newVac.push(p);
        } else if (bP > 0 && cP === 0) {
            resolvedVac.push(p);
        } else if (bP > 0 && cP > bP) {
            increased.push(p);
        } else if (bP > 0 && cP < bP && cP > 0) {
            decreased.push(p);
        }
    });
    // 각 분류 상위 N 건만 (프롬프트 크기 관리)
    const topBy = (arr, keyFn, limit=10) =>
        arr.map(p => ({
            name:        p.name || '(무명)',
            region:      p.region,
            baselineCnt: p.baseline.count, baselinePy: Math.round(p.baseline.py),
            compareCnt:  p.compare.count,  comparePy:  Math.round(p.compare.py),
        })).sort((a,b) => Math.abs(keyFn(b)) - Math.abs(keyFn(a))).slice(0, limit);

    const byRegionList = (arr) => {
        const by = {};
        arr.forEach(p => {
            if (!by[p.region]) by[p.region] = [];
            by[p.region].push({
                name:        p.name || '(무명)',
                baselineCnt: p.baseline.count, baselinePy: Math.round(p.baseline.py),
                compareCnt:  p.compare.count,  comparePy:  Math.round(p.compare.py),
            });
        });
        Object.keys(by).forEach(r => {
            by[r].sort((a,b) => (b.comparePy - b.baselinePy) - (a.comparePy - a.baselinePy));
            by[r] = by[r].slice(0, 8);
        });
        return by;
    };

    return {
        meta: {
            baselineQuarter: baselineQ,
            compareQuarter:  compareQ,
            direction:       baselineQ < compareQ ? 'forward' : 'backward',  // baseline 이전이면 forward
            baselineStatus:  baseData.status || 'draft',
            totalPairs:      pairs.length,
            filterContext:   _srFormatFilterContext(baselineFilters, baselineRegs, baselineQ, baseData.status),
        },
        baseline: { quarter: baselineQ, summary: baselineSummary, byRegion: baselineByRgn },
        compare:  { quarter: compareQ,  summary: compareSummary,  byRegion: compareByRgn  },
        diff: {
            byRegion:       diffByRegion,
            newVacancy:     byRegionList(newVac),        // 신규 공실 (권역별 상위)
            resolvedVacancy:byRegionList(resolvedVac),   // 해소 (권역별 상위)
            increased:      topBy(increased,  p => p.compare.py - p.baseline.py, 10),
            decreased:      topBy(decreased,  p => p.baseline.py - p.compare.py, 10),
        },
        _rawPairs: pairs,  // 디버그용
    };
}

function _srFormatFilterContext(filters, regs, q, status) {
    const parts = [];
    if (filters.grades?.length)   parts.push(filters.grades.join('/') + '등급');
    if (regs.length && regs.length < SR_REGIONS.length) parts.push(regs.join('/'));
    parts.push(q);
    parts.push(status === 'finalized' ? '최종저장' : '작업중');
    return parts.join(' · ');
}

/**
 * 모달 열기
 */
window._srOpenCompareModal = async function() {
    let modal = document.getElementById(_SR_CMP_MODAL_ID);
    if (!modal) {
        modal = document.createElement('div');
        modal.id = _SR_CMP_MODAL_ID;
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
    <div style="position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:9999;
                display:flex; align-items:center; justify-content:center;"
         onclick="if(event.target===this) _srCloseCompareModal()">
      <div style="background:var(--bg-primary); border-radius:12px; width:min(900px, 90vw);
                  max-height:90vh; overflow:hidden; box-shadow:0 20px 60px rgba(0,0,0,.3);
                  display:flex; flex-direction:column;">
        <div style="padding:16px 20px; border-bottom:1px solid var(--border-color);
                    display:flex; align-items:center; justify-content:space-between;">
          <div style="font-size:16px; font-weight:700; color:var(--text-primary);">
            📊 분기 비교 AI 분석
          </div>
          <button onclick="_srCloseCompareModal()"
            style="border:none; background:transparent; font-size:20px; cursor:pointer;
                   color:var(--text-muted); padding:4px 10px;">✕</button>
        </div>
        <div id="sr-cmp-body" style="padding:20px; overflow-y:auto; flex:1;">
          <div style="text-align:center; padding:40px; color:var(--text-muted);">분기 목록 로딩 중...</div>
        </div>
      </div>
    </div>`;

    // baseline 분기 확정
    _srCompareState.baselineQuarter = _srPersistentExclude.loadedQuarter || '';
    if (!_srCompareState.baselineQuarter) {
        document.getElementById('sr-cmp-body').innerHTML =
            `<div style="color:#ef4444; padding:40px; text-align:center;">
                <b>기준 분기가 설정되지 않았습니다.</b><br><br>
                편집 모달에서 분기를 선택·저장한 후 다시 시도하세요.
             </div>`;
        return;
    }

    const quarters = await _srLoadAvailableQuarters();
    if (quarters.length < 2) {
        document.getElementById('sr-cmp-body').innerHTML =
            `<div style="color:#ef4444; padding:40px; text-align:center;">
                비교할 다른 분기가 없습니다. (저장된 분기 ${quarters.length}개)
             </div>`;
        return;
    }

    // 비교 대상 기본값: baseline 바로 앞(또는 뒤) 분기
    if (!_srCompareState.compareQuarter || _srCompareState.compareQuarter === _srCompareState.baselineQuarter) {
        const others = quarters.filter(x => x.q !== _srCompareState.baselineQuarter);
        _srCompareState.compareQuarter = others[0]?.q || '';
    }

    _srRenderCompareForm();
};

window._srCloseCompareModal = function() {
    const modal = document.getElementById(_SR_CMP_MODAL_ID);
    if (modal) modal.remove();
};

/**
 * 모달 본문 렌더
 */
function _srRenderCompareForm() {
    const body = document.getElementById('sr-cmp-body');
    if (!body) return;

    const baselineQ = _srCompareState.baselineQuarter;
    const baselineInfo = _srCompareState.quartersAvailable.find(x => x.q === baselineQ);
    const baselineBadge = baselineInfo?.status === 'finalized' ? '✅' : '📝';

    const compareOpts = _srCompareState.quartersAvailable
        .filter(q => q.q !== baselineQ)
        .filter(q => _srCompareState.includeDraft || q.status === 'finalized')
        .map(q => {
            const badge = q.status === 'finalized' ? '✅' : '📝';
            const sel = q.q === _srCompareState.compareQuarter ? 'selected' : '';
            return `<option value="${q.q}" ${sel}>${q.q} ${badge} ${q.status}</option>`;
        }).join('');

    body.innerHTML = `
    <!-- 폼 -->
    <div style="background:var(--bg-secondary); border-radius:8px; padding:16px; margin-bottom:16px;">
      <div style="display:flex; gap:12px; align-items:stretch;">
        <!-- 기준 분기 (읽기 전용) -->
        <div style="flex:1; padding:12px; background:var(--bg-primary); border:2px solid #7c3aed;
                    border-radius:8px;">
          <div style="font-size:10px; font-weight:700; color:#7c3aed; margin-bottom:4px; letter-spacing:0.5px;">
            📌 기준 분기 (현재 편집 저장 상태)
          </div>
          <div style="font-size:18px; font-weight:700; color:var(--text-primary);">
            ${baselineQ} ${baselineBadge}
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            편집 모달 저장된 빌딩셋 · 제외목록 · 대표월 적용
          </div>
        </div>

        <!-- 화살표 -->
        <div style="align-self:center; color:var(--text-muted); font-size:24px;">⇄</div>

        <!-- 비교 분기 (선택) -->
        <div style="flex:1; padding:12px; background:var(--bg-primary); border:1px solid var(--border-color);
                    border-radius:8px;">
          <label style="font-size:10px; font-weight:700; color:var(--text-muted); margin-bottom:4px;
                        display:block; letter-spacing:0.5px;">
            비교 대상 분기
          </label>
          <select id="sr-cmp-qB" onchange="_srCompareState.compareQuarter=this.value"
            style="width:100%; padding:6px 10px; border:1px solid var(--border-color); border-radius:6px;
                   background:var(--bg-primary); color:var(--text-primary); font-size:14px; font-weight:600;">
            ${compareOpts}
          </select>
          <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
            동일 빌딩셋 · 동일 제외목록 · 대응월 매칭
          </div>
        </div>
      </div>

      <div style="display:flex; gap:16px; align-items:center; margin-top:12px; padding-top:12px;
                  border-top:1px dashed var(--border-color);">
        <label style="display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer;">
          <input type="checkbox" id="sr-cmp-draft" ${_srCompareState.includeDraft?'checked':''}
            onchange="_srCompareState.includeDraft=this.checked; _srRenderCompareForm()">
          작업중(draft) 분기 포함
        </label>
        <button onclick="_srRunCompareAnalysis()" id="sr-cmp-run-btn"
          style="margin-left:auto; padding:10px 20px; border:none; border-radius:6px;
                 background:linear-gradient(135deg, #7c3aed 0%, #a855f7 100%);
                 color:#fff; font-size:13px; font-weight:700; cursor:pointer;
                 box-shadow:0 2px 6px rgba(124,58,237,.3);">
          🤖 AI 분석하기
        </button>
      </div>
    </div>

    <!-- 결과 영역 -->
    <div id="sr-cmp-result"
      style="min-height:200px; padding:16px; background:var(--bg-primary);
             border:1px solid var(--border-color); border-radius:8px;
             font-size:14px; line-height:1.7; color:var(--text-primary);">
      <div style="color:var(--text-muted); text-align:center; padding:40px;">
        비교 대상 분기를 선택하고 <b>🤖 AI 분석하기</b> 버튼을 누르세요.
      </div>
    </div>

    <!-- Raw 데이터 -->
    <details style="margin-top:12px;">
      <summary style="cursor:pointer; font-size:11px; color:var(--text-muted); user-select:none;">
        🔍 집계 raw 데이터 보기 (개발자용)
      </summary>
      <pre id="sr-cmp-raw"
        style="margin-top:8px; padding:12px; background:var(--bg-secondary); border-radius:6px;
               font-size:11px; overflow:auto; max-height:300px; color:var(--text-muted);">
(분석 실행 후 표시됩니다)
      </pre>
    </details>
    `;
}

/**
 * "AI 분석하기" 핸들러
 */
window._srRunCompareAnalysis = async function() {
    const baselineQ = _srCompareState.baselineQuarter;
    const compareQ  = _srCompareState.compareQuarter;
    if (!baselineQ) { alert('기준 분기가 없습니다.'); return; }
    if (!compareQ)  { alert('비교 대상 분기를 선택해주세요.'); return; }
    if (baselineQ === compareQ) { alert('서로 다른 분기를 선택해주세요.'); return; }

    const btn = document.getElementById('sr-cmp-run-btn');
    const resultEl = document.getElementById('sr-cmp-result');
    const rawEl    = document.getElementById('sr-cmp-raw');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.innerHTML = '⏳ 집계 중...'; }
    resultEl.innerHTML =
        '<div style="color:var(--text-muted); text-align:center; padding:40px;">빌딩 이중 집계 중...</div>';

    try {
        const payload = await _srBuildComparePayload(baselineQ, compareQ);
        _srCompareState.lastPayload = payload;
        if (rawEl) rawEl.textContent = JSON.stringify(payload, null, 2);

        console.log(`[compare] baseline=${baselineQ} compare=${compareQ} · 대상 빌딩 ${payload.meta.totalPairs}개`);

        if (btn) btn.innerHTML = '⏳ AI 분석 중...';
        resultEl.innerHTML =
            `<div style="color:var(--text-muted); font-size:12px; margin-bottom:8px;">
                🤖 Claude Sonnet 4 가 분석 중입니다 · 대상 ${payload.meta.totalPairs}개 빌딩
             </div>
             <div id="sr-cmp-stream" style="white-space:pre-wrap;"></div>`;

        await _srStreamCompareAnalysis(payload, document.getElementById('sr-cmp-stream'));

        if (btn) btn.innerHTML = '🤖 AI 분석하기';
    } catch (err) {
        console.error('[compare] 분석 실패:', err);
        resultEl.innerHTML =
            `<div style="color:#ef4444; padding:20px;">
                <b>오류 발생</b><br><br>${err.message || err}<br><br>
                <small>콘솔(F12)에서 상세 내용 확인 가능합니다.</small>
             </div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
};

/**
 * SSE 스트리밍 수신
 */
async function _srStreamCompareAnalysis(payload, outputEl) {
    const resp = await fetch(_SR_COMPARE_API, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
    });
    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} — ${errText || resp.statusText}`);
    }
    if (!resp.body) throw new Error('응답 body 가 없습니다 (스트리밍 지원 안 됨)');

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer   = '';
    let fullText = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop();

        for (const ev of events) {
            const lines = ev.split('\n');
            let eventType = 'message';
            let dataStr   = '';
            for (const line of lines) {
                if (line.startsWith('event:')) eventType = line.slice(6).trim();
                else if (line.startsWith('data:')) dataStr = line.slice(5).trim();
            }
            if (!dataStr) continue;

            let parsed;
            try { parsed = JSON.parse(dataStr); } catch { continue; }

            if (eventType === 'content' && parsed.text) {
                fullText += parsed.text;
                outputEl.innerHTML = _srMarkdownLite(fullText);
                outputEl.scrollTop = outputEl.scrollHeight;
            } else if (eventType === 'error') {
                throw new Error(parsed.error || '스트리밍 중 오류');
            } else if (eventType === 'done') {
                console.log('[compare] 분석 완료 · usage:', parsed.usage);
            }
        }
    }
}

/**
 * 경량 마크다운 렌더러
 */
function _srMarkdownLite(md) {
    const esc = (s) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = md.split('\n');
    const out = [];
    let inList = false;

    for (const raw of lines) {
        const line = raw.trimEnd();
        if (/^## /.test(line)) {
            if (inList) { out.push('</ul>'); inList = false; }
            out.push(`<h3 style="font-size:15px; font-weight:700; margin:16px 0 8px; color:var(--text-primary);">${esc(line.slice(3))}</h3>`);
        } else if (/^### /.test(line)) {
            if (inList) { out.push('</ul>'); inList = false; }
            out.push(`<h4 style="font-size:13px; font-weight:600; margin:12px 0 6px; color:var(--text-primary);">${esc(line.slice(4))}</h4>`);
        } else if (/^[-*] /.test(line)) {
            if (!inList) { out.push('<ul style="margin:6px 0 6px 20px; padding:0;">'); inList = true; }
            const content = esc(line.slice(2))
                .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
                .replace(/`([^`]+)`/g, '<code style="background:var(--bg-secondary); padding:1px 4px; border-radius:3px; font-size:12px;">$1</code>');
            out.push(`<li style="margin:3px 0;">${content}</li>`);
        } else if (line.trim() === '') {
            if (inList) { out.push('</ul>'); inList = false; }
            out.push('<br>');
        } else {
            if (inList) { out.push('</ul>'); inList = false; }
            const content = esc(line)
                .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
                .replace(/`([^`]+)`/g, '<code style="background:var(--bg-secondary); padding:1px 4px; border-radius:3px; font-size:12px;">$1</code>');
            out.push(`<div style="margin:3px 0;">${content}</div>`);
        }
    }
    if (inList) out.push('</ul>');
    return out.join('');
}

// ═══════════════════════════════════════════════════════════════
// ISSUE-6: 통합 완료
// ═══════════════════════════════════════════════════════════════
console.log(
    '%c✅ portal-stats.js v1.3 로드 완료%c\n' +
    '  TAB1 공실현황 · TAB2 임대조건 · TAB3 빌딩현황 · TAB4 검색테이블\n' +
    '  TAB5 이상값감지(ISSUE-7/8) · Excel다운로드 · 이상값제외 통계\n' +
    '  ✨ PHASE 6: srBuildingMatrix / srCalcCellStats / srVacancyAreaByBasis',
    'color:#1a73e8; font-weight:700;',
    'color:#64748b;'
);
