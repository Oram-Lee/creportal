/**
 * CRE Portal - 전역 상태 관리
 * 모든 모듈에서 공유하는 상태 객체
 */

export const state = {
    // 사용자
    currentUser: null,
    
    // 빌딩 데이터
    allBuildings: [],
    filteredBuildings: [],
    viewportBuildings: [],
    selectedBuilding: null,
    
    // 카카오맵
    kakaoMap: null,
    clusterer: null,
    markers: [],
    customOverlays: [],
    
    // 뷰 상태
    currentViewMode: 'map',
    currentListTab: 'all',
    
    // 필터
    activeFilters: {
        region: [],
        areaMin: null,
        areaMax: null,
        rentMin: null,
        rentMax: null,
        exclusiveMin: null,
        exclusiveMax: null,
        hasRentroll: false,
        hasMemo: false,
        hasIncentive: false,
        hasVacancy: true,
        leasingGuideOnly: false
    },
    
    // 임대안내문 포함 빌딩 ID 목록
    leasingGuideBuildings: new Set(),
    
    // 데이터 캐시
    dataCache: {
        buildings: {},
        rentrolls: {},
        memos: {},
        incentives: {},
        managements: {},
        documents: {},
        users: {}
    },
    
    // 즐겨찾기
    starredBuildings: new Set(),
    
    // 선택 상태
    selectedOurManagers: [],
    expandedBuildingId: null,
    selectedVacancies: new Set(),
    selectedRentrollDate: null,
    selectedDocSource: 'all',
    selectedDocPeriod: 'all',
    
    // 편집 상태
    editingVacancy: { buildingId: null, vacancyKey: null },
    
    // 미리보기 상태
    previewState: {
        currentPage: 0,
        totalPages: 0,
        imageUrls: [],
        source: '',
        publishDate: ''
    },
    currentZoom: 1,
    
    // 건축물대장 비교
    ledgerCompareData: { old: {}, new: {}, diffs: [] }
};

// API URL
export const API_BASE_URL = 'https://portal-dsyl.onrender.com';

// 상태 초기화 함수
export function resetFilters() {
    state.activeFilters = {
        region: [],
        areaMin: null,
        areaMax: null,
        rentMin: null,
        rentMax: null,
        exclusiveMin: null,
        exclusiveMax: null,
        hasRentroll: false,
        hasMemo: false,
        hasIncentive: false,
        hasVacancy: true
    };
}

export function resetPreviewState() {
    state.previewState = {
        currentPage: 0,
        totalPages: 0,
        imageUrls: [],
        source: '',
        publishDate: ''
    };
    state.currentZoom = 1;
}
