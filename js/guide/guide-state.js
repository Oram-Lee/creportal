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

// 기본 권역 정의
export const DEFAULT_REGIONS = [
    { code: 'GBD', name: '강남권역', nameEn: 'Gangnam Business District' },
    { code: 'YBD', name: '여의도권역', nameEn: 'Yeouido Business District' },
    { code: 'CBD', name: '도심권역', nameEn: 'Central Business District' },
    { code: 'BBD', name: '분당권역', nameEn: 'Bundang Business District' },
    { code: 'PAN', name: '판교권역', nameEn: 'Pangyo Business District' },
    { code: 'ETC', name: '기타권역', nameEn: 'Others' }
];

// 전역 상태
export const state = {
    currentUser: null,
    allBuildings: [],
    allUsers: [],
    leasingGuides: {},
    starredBuildings: new Set(),
    currentGuide: null,
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
        images: [] // 엔딩 페이지 이미지 배열 (최대 10개)
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
