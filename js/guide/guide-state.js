/**
 * Leasing Guide - 상태 관리
 * 전역 상태와 Firebase 참조를 관리합니다.
 */

// Firebase 참조 (초기화 시 설정됨)
export let db = null;
export let ref = null;
export let get = null;
export let set = null;
export let push = null;
export let update = null;
export let remove = null;

// Firebase Storage 참조
export let storage = null;
export let storageRef = null;
export let uploadString = null;
export let getDownloadURL = null;

// 기본 권역 정의 (2026-08: PAN 폐지 → BBD(분당·판교)로 통합)
export const DEFAULT_REGIONS = [
    { code: 'GBD', name: '강남권역', nameEn: 'Gangnam Business District' },
    { code: 'YBD', name: '여의도권역', nameEn: 'Yeouido Business District' },
    { code: 'CBD', name: '도심권역', nameEn: 'Central Business District' },
    { code: 'BBD', name: '분당권역', nameEn: 'Bundang Business District' },
    { code: 'MBD', name: '마곡업무지구', nameEn: 'Magok Business District' },
    { code: 'ETC', name: '기타권역', nameEn: 'Others' }
];

// ★ 문서 타입 (2026-08: 리테일 임대안내문 도입)
//   'office' | 'retail' — 기존 안내문은 값이 없으므로 항상 'office'로 폴백한다.
//   문서 고유 속성이므로 localStorage(saveSettingsToLocal)에는 저장하지 않는다.
//   (저장하면 다음에 여는 다른 안내문에 타입이 승계되어 오염됨)
export const GUIDE_TYPES = ['office', 'retail'];

// 전역 상태
export const state = {
    currentUser: null,
    allBuildings: [],
    allUsers: [],
    leasingGuides: {},
    starredBuildings: new Set(),
    currentGuide: null,
    // ★ 문서 타입 (기본 'office')
    guideType: 'office',
    // ★ 리테일 월 총액 절삭 단위 (문서 기본값) — 0=원 | 1000=천원 | 10000=만원
    //   장표(item.retailRoundUnit)에 값이 있으면 그쪽이 우선한다.
    //   guideType과 같은 문서 고유 속성이므로 localStorage에는 저장하지 않는다.
    retailRoundUnit: 0,
    tocItems: [],
    selectedTocIndex: -1,
    coverSettings: {
        template: 'tpl-sni',
        title: 'Leasing Information',
        subtitle: '',
        logoImage: null,
        logoPosition: 'right',
        slogan: 'Best Space For A Better Life'
    },
    // 커스텀 권역 (사용자 정의)
    customRegions: [],
    // ★ 권역 순서 (드래그앤드롭으로 사용자 정의, null이면 기본순서)
    regionOrder: null,
    // ★ 권역 별칭 (임대안내문에서만 표시되는 이름)
    regionAliases: {},
    // 엔딩 페이지 설정
    endingSettings: {
        enabled: true,
        headline1: '사람을 먼저 생각하는,',
        headline2: '고객의 미래를 위하는,',
        headline3: '공간을 혁신하는,',
        companyName: '에스앤아이 코퍼레이션',
        description1: '공간에 대한 전문성과 혁신은 고객을 위한 것이어야 합니다',
        description2: '우리는 공간에 대한 최고의 전문성과 앞선 기술력을 바탕으로',
        description3: '고객의 비즈니스 성공을 지원하고 품격 있는 시간을 제공합니다',
        description4: '사람이 없는 공간은 공허하고 무의미하기에',
        description5: '우리는 언제나 사람을 먼저 생각하는 공간을 만들어 가겠습니다',
        thankYouText: 'THANK YOU',
        closingText: '고객이 신뢰할 수 있는 관리를 수행하겠습니다',
        slogan: '공간에 가치를 더하는 공/간/관/리/전/문/가',
        accentColor: '#ec4899',
        images: [] // 엔딩 페이지 이미지 배열 (최대 8개 — 출력 장표 2x4 그리드)
    },
    // 빌딩 추가 모달
    buildingCart: [],
    cartViewMode: 'all',
    selectedCartRegion: 'all',
    // 컨택포인트 모달
    cpModalBuildingId: null,
    cpTab: 'building',
    cpSelectedUser: null,
    // 카카오맵 인스턴스
    kakaoMapInstances: {},
    // 미리보기
    previewPages: [],
    previewCurrentPage: 0,
    previewGuideTitle: ''
};

// ★ 공실표 컬럼 세트 (문서 타입별) — 3개 화면이 공유하는 단일 정의
//   leasing-guide-print.html 은 ES 모듈이 아니라 import가 불가능하므로 동일 정의를
//   인라인 복제한다. 수정 시 반드시 양쪽을 함께 고칠 것. (원본은 이 파일)
//   ※ office 의 print 컬럼 순서가 editor 와 반대(임대/전용)인 것은 기존 동작이며,
//     오피스 출력 회귀 방지를 위해 의도적으로 그대로 둔다.
export const VACANCY_COLUMNS = {
    office: {
        unitNote: '면적: 평 | 금액: 원/평',
        unitNotePrint: '(면적:평 | 금액:원/평)',
        editor: ['해당층', '전용 면적', '임대 면적', '보증금', '임대료', '관리비', '입주 시기'],
        print: ['층', '임대', '전용', '보증금', '임대료', '관리비', '입주']
    },
    retail: {
        unitNote: '단위: 평',
        unitNotePrint: '(단위:평)',
        editor: ['매장층', '전용면적', '임대면적', '입주시기'],
        print: ['매장층', '전용면적', '임대면적', '입주시기']
    }
};

// ★ 문서 타입에 맞는 공실만 추리기
//   usage 가 없는 기존 데이터는 전부 'office' — 누락 0건이 되어야 한다.
export function filterVacanciesByType(list, type) {
    const t = (type === 'retail') ? 'retail' : 'office';
    return (list || []).filter(v => (((v && v.usage) || 'office') === t));
}

// ★ 리테일 월 총액(원) = 단가(원/평) × 임대면적(평)
//   면적 폴백: rentArea → area → exclusiveArea. 환산 불가면 null (호출부가 원문/문의로 처리)
export function retailMonthlyTotal(unitPrice, v) {
    const num = x => {
        if (x === undefined || x === null || x === '') return null;
        const p = parseFloat(String(x).replace(/,/g, ''));
        return isNaN(p) ? null : p;
    };
    const price = num(unitPrice);
    if (price === null) return null;
    const area = num(v?.rentArea) ?? num(v?.area) ?? num(v?.exclusiveArea);
    if (area === null || area <= 0) return null;
    return Math.round(price * area);
}

// ★ 리테일 월 총액 절삭 단위 — 표시 전용. 저장값(원/평)은 건드리지 않는다.
export const RETAIL_ROUND_UNITS = [
    { value: 0,     label: '원',   short: '원 단위' },
    { value: 1000,  label: '천원', short: '천원 단위' },
    { value: 10000, label: '만원', short: '만원 단위' }
];

const _validRoundUnit = (u) => (u === 0 || u === 1000 || u === 10000) ? u : null;

// 장표(item) 값이 있으면 우선, 없으면 문서 기본값, 그래도 없으면 원 단위
export function getRetailRoundUnit(item) {
    const byItem = _validRoundUnit(item?.retailRoundUnit);
    if (byItem !== null) return byItem;
    const byDoc = _validRoundUnit(state.retailRoundUnit);
    return byDoc !== null ? byDoc : 0;
}

export function setRetailRoundUnit(unit) {
    state.retailRoundUnit = _validRoundUnit(unit) ?? 0;
}

// 반올림 (내림이 아니다 — 14,832,700 → 만원 단위 → 14,830,000)
export function roundToUnit(n, unit) {
    if (n === null || n === undefined) return n;
    const u = _validRoundUnit(unit);
    if (!u) return n;
    return Math.round(n / u) * u;
}

// ★ 리테일 RENT 표 행 데이터 — 층별 다행, 금액은 월 총액(원)
//   보증금은 값이 하나도 없으면 컬럼 자체를 숨긴다 (showDeposit=false)
//   roundUnit: 표시용 절삭 단위. 생략하면 절삭 없음 (기존 호출부 회귀 방지)
export function buildRetailRentRows(vacancies, roundUnit) {
    const r = n => roundToUnit(retailMonthlyTotal(n.price, n.v), roundUnit);
    const rows = (vacancies || []).map(v => ({
        floor: v.floor,
        deposit: r({ price: v.deposit ?? v.depositPy, v }),
        rent: r({ price: v.rent ?? v.rentPy, v }),
        maintenance: r({ price: v.maintenance ?? v.maintenancePy, v })
    }));
    return { rows, showDeposit: rows.some(r2 => r2.deposit !== null) };
}

// Firebase 초기화 함수
export function initFirebase(firebaseRefs) {
    db = firebaseRefs.db;
    ref = firebaseRefs.ref;
    get = firebaseRefs.get;
    set = firebaseRefs.set;
    push = firebaseRefs.push;
    update = firebaseRefs.update;
    remove = firebaseRefs.remove;
    
    // Storage
    storage = firebaseRefs.storage;
    storageRef = firebaseRefs.storageRef;
    uploadString = firebaseRefs.uploadString;
    getDownloadURL = firebaseRefs.getDownloadURL;
}

// 상태 getter/setter
export function setCurrentUser(user) {
    state.currentUser = user;
}

export function setAllBuildings(buildings) {
    state.allBuildings = buildings;
}

export function setLeasingGuides(guides) {
    state.leasingGuides = guides;
}

export function setCurrentGuide(guide) {
    state.currentGuide = guide;
}

// ★ 문서 타입 getter/setter — 읽는 쪽은 반드시 getGuideType()을 경유한다
export function getGuideType() {
    return state.guideType === 'retail' ? 'retail' : 'office';
}

export function setGuideType(type) {
    state.guideType = (type === 'retail') ? 'retail' : 'office';
}

export function setTocItems(items) {
    state.tocItems = items;
}

export function setSelectedTocIndex(idx) {
    state.selectedTocIndex = idx;
}

export function setCoverSettings(settings) {
    state.coverSettings = settings;
}

export function resetCoverSettings() {
    state.coverSettings = {
        template: 'tpl-sni',
        title: 'Leasing Information',
        subtitle: '',
        logoImage: null,
        logoPosition: 'right',
        slogan: 'Best Space For A Better Life'
    };
}

// 커스텀 권역 관련
export function setCustomRegions(regions) {
    state.customRegions = regions;
}

export function addCustomRegion(region) {
    state.customRegions.push(region);
}

export function removeCustomRegion(code) {
    state.customRegions = state.customRegions.filter(r => r.code !== code);
}

// 모든 권역 가져오기 (기본 + 커스텀)
export function getAllRegions() {
    return [...DEFAULT_REGIONS, ...state.customRegions];
}

// ★ 권역 순서 관련 함수들
export function setRegionOrder(order) {
    state.regionOrder = order;
    saveSettingsToLocal();
}

export function resetRegionOrder() {
    state.regionOrder = null;
    saveSettingsToLocal();
}

export function getRegionOrder() {
    if (state.regionOrder && Array.isArray(state.regionOrder)) {
        // 커스텀 순서에 없는 새 권역이 추가되었을 수 있으므로 보완
        const baseCodes = DEFAULT_REGIONS.map(r => r.code);
        const customCodes = (state.customRegions || []).map(r => r.code);
        const allCodes = [...baseCodes, ...customCodes];
        const missing = allCodes.filter(c => !state.regionOrder.includes(c));
        return [...state.regionOrder.filter(c => allCodes.includes(c)), ...missing];
    }
    const customCodes = (state.customRegions || []).map(r => r.code);
    return [...DEFAULT_REGIONS.map(r => r.code), ...customCodes];
}

// 권역 코드로 권역 정보 가져오기
export function getRegionInfo(code) {
    const all = getAllRegions();
    return all.find(r => r.code === code) || { code, name: code, nameEn: code };
}

// ★ 권역 별칭 관련 함수들
export function setRegionAliases(aliases) {
    state.regionAliases = aliases || {};
}

export function setRegionAlias(code, alias) {
    if (!state.regionAliases) state.regionAliases = {};
    state.regionAliases[code] = alias;
    saveSettingsToLocal();
}

export function removeRegionAlias(code) {
    if (state.regionAliases) {
        delete state.regionAliases[code];
        saveSettingsToLocal();
    }
}

export function getRegionAlias(code) {
    return state.regionAliases?.[code] || null;
}

// ★ 권역 표시명 가져오기 (별칭이 있으면 별칭, 없으면 기본명)
export function getRegionDisplayName(code) {
    const alias = getRegionAlias(code);
    if (alias && alias.displayName) {
        return alias.displayName;
    }
    const region = getRegionInfo(code);
    return region.name;
}

export function getRegionDisplayNameEn(code) {
    const alias = getRegionAlias(code);
    if (alias && alias.displayNameEn) {
        return alias.displayNameEn;
    }
    const region = getRegionInfo(code);
    return region.nameEn;
}

// 엔딩 설정 관련
export function setEndingSettings(settings) {
    state.endingSettings = { ...state.endingSettings, ...settings };
    // localStorage에 자동 저장
    saveSettingsToLocal();
}

export function resetEndingSettings() {
    state.endingSettings = {
        enabled: true,
        headline1: '사람을 먼저 생각하는,',
        headline2: '고객의 미래를 위하는,',
        headline3: '공간을 혁신하는,',
        companyName: '에스앤아이 코퍼레이션',
        description1: '공간에 대한 전문성과 혁신은 고객을 위한 것이어야 합니다',
        description2: '우리는 공간에 대한 최고의 전문성과 앞선 기술력을 바탕으로',
        description3: '고객의 비즈니스 성공을 지원하고 품격 있는 시간을 제공합니다',
        description4: '사람이 없는 공간은 공허하고 무의미하기에',
        description5: '우리는 언제나 사람을 먼저 생각하는 공간을 만들어 가겠습니다',
        thankYouText: 'THANK YOU',
        closingText: '고객이 신뢰할 수 있는 관리를 수행하겠습니다',
        slogan: '공간에 가치를 더하는 공/간/관/리/전/문/가',
        accentColor: '#ec4899',
        images: []
    };
    saveSettingsToLocal();
}

// ========== localStorage 저장/로드 ==========
const STORAGE_KEY = 'cre_leasing_guide_settings';

// 설정을 localStorage에 저장
export function saveSettingsToLocal() {
    try {
        const dataToSave = {
            coverSettings: state.coverSettings,
            endingSettings: state.endingSettings,
            customRegions: state.customRegions,
            regionAliases: state.regionAliases,
            regionOrder: state.regionOrder,
            savedAt: new Date().toISOString()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
        console.log('[State] 설정 저장됨:', new Date().toLocaleTimeString());
    } catch (e) {
        console.error('[State] localStorage 저장 실패:', e);
    }
}

// localStorage에서 설정 로드
export function loadSettingsFromLocal() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const data = JSON.parse(saved);
            if (data.coverSettings) {
                state.coverSettings = { ...state.coverSettings, ...data.coverSettings };
            }
            if (data.endingSettings) {
                state.endingSettings = { ...state.endingSettings, ...data.endingSettings };
            }
            if (data.customRegions) {
                state.customRegions = data.customRegions;
            }
            if (data.regionAliases) {
                state.regionAliases = data.regionAliases;
            }
            if (data.regionOrder) {
                state.regionOrder = data.regionOrder;
            }
            console.log('[State] 설정 로드됨:', data.savedAt);
            return true;
        }
    } catch (e) {
        console.error('[State] localStorage 로드 실패:', e);
    }
    return false;
}

// localStorage 설정 삭제
export function clearLocalSettings() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        console.log('[State] 설정 삭제됨');
    } catch (e) {
        console.error('[State] localStorage 삭제 실패:', e);
    }
}

// coverSettings 변경 시 자동 저장
export function updateCoverSettingsAndSave(settings) {
    state.coverSettings = { ...state.coverSettings, ...settings };
    saveSettingsToLocal();
}
