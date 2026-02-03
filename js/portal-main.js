/**
 * CRE Portal - 메인 초기화
 * 모든 모듈을 로드하고 전역 변수를 설정
 */

// 모듈 import
import { state, API_BASE_URL } from './portal-state.js';
import { db, ref, get, set, push, update, remove } from './portal-firebase.js';
import { showToast, formatNumber, formatPyPrice, debounce, detectRegion, autoSetRegion, formatFloors, formatStation, isRecentlyUpdated } from './portal-utils.js';
import { handleLogin, handleLogout, showApp, checkAuth, hasPermission } from './portal-auth.js';
import { loadData, processBuildings } from './portal-data.js?v=3.7';
import { initKakaoMap, updateMapMarkers, updateViewportBuildings, zoomIn, zoomOut, resetMap, panToBuilding, openKakaoMap } from './portal-map.js';
import { applyFilter, clearFilter, quickFilter, toggleVacancyFilter, toggleLeasingGuideFilter, resetAllFilters, applyFilters, setupSearchListener } from './portal-filter.js';
import { renderBuildingList, renderTableView, selectBuildingFromList, loadStarredBuildings, toggleBuildingExpand, setViewMode, setListTab, toggleTheme, updateSelectedCount, renderVacancyBadge, renderRentrollBadge, renderMemoBadge, renderIncentiveBadge, renderDocumentSelect, renderVacancyTable, toggleStar, setupUIListeners } from './portal-ui.js';
import { registerDetailGlobals } from './portal-detail.js?v=3.9';
import { registerPopupGlobals } from './portal-popup.js';
import { registerCrudGlobals, isAdmin, canDeleteBuilding } from './portal-crud.js?v=3.5';
import { registerPreviewGlobals } from './portal-preview.js';
import { registerMiscGlobals } from './portal-misc.js?v=3.5';
// 🆕 다각형 검색 모듈
import { initDrawing, setDrawingMode, clearDrawing, toggleDrawingTools } from './portal-drawing.js';
// 🆕 Comp List 모듈
import { initCompList, addBuildingToCompList, addBuildingsToCompList, toggleFloatingPanel } from './portal-complist.js';

// 전역 변수 노출 (기존 코드 호환성)
// 이 변수들은 state 객체의 참조를 통해 접근됨
window.state = state;
window.db = db;
window.ref = ref;
window.get = get;
window.set = set;
window.push = push;
window.update = update;
window.remove = remove;
window.API_BASE_URL = API_BASE_URL;

// 유틸리티 함수 노출
window.formatNumber = formatNumber;
window.formatPyPrice = formatPyPrice;
window.formatFloors = formatFloors;
window.formatStation = formatStation;
window.isRecentlyUpdated = isRecentlyUpdated;
window.detectRegion = detectRegion;
window.autoSetRegion = autoSetRegion;
window.debounce = debounce;

// state 속성 getter/setter 정의 (전역 변수 호환성)
Object.defineProperties(window, {
    currentUser: {
        get: () => state.currentUser,
        set: (v) => state.currentUser = v
    },
    allBuildings: {
        get: () => state.allBuildings,
        set: (v) => state.allBuildings = v
    },
    filteredBuildings: {
        get: () => state.filteredBuildings,
        set: (v) => state.filteredBuildings = v
    },
    viewportBuildings: {
        get: () => state.viewportBuildings,
        set: (v) => state.viewportBuildings = v
    },
    selectedBuilding: {
        get: () => state.selectedBuilding,
        set: (v) => state.selectedBuilding = v
    },
    kakaoMap: {
        get: () => state.kakaoMap,
        set: (v) => state.kakaoMap = v
    },
    clusterer: {
        get: () => state.clusterer,
        set: (v) => state.clusterer = v
    },
    markers: {
        get: () => state.markers,
        set: (v) => state.markers = v
    },
    customOverlays: {
        get: () => state.customOverlays,
        set: (v) => state.customOverlays = v
    },
    currentViewMode: {
        get: () => state.currentViewMode,
        set: (v) => state.currentViewMode = v
    },
    currentListTab: {
        get: () => state.currentListTab,
        set: (v) => state.currentListTab = v
    },
    activeFilters: {
        get: () => state.activeFilters,
        set: (v) => state.activeFilters = v
    },
    dataCache: {
        get: () => state.dataCache,
        set: (v) => state.dataCache = v
    },
    starredBuildings: {
        get: () => state.starredBuildings,
        set: (v) => state.starredBuildings = v
    },
    selectedOurManagers: {
        get: () => state.selectedOurManagers,
        set: (v) => state.selectedOurManagers = v
    },
    expandedBuildingId: {
        get: () => state.expandedBuildingId,
        set: (v) => state.expandedBuildingId = v
    },
    selectedVacancies: {
        get: () => state.selectedVacancies,
        set: (v) => state.selectedVacancies = v
    },
    selectedRentrollDate: {
        get: () => state.selectedRentrollDate,
        set: (v) => state.selectedRentrollDate = v
    },
    selectedDocSource: {
        get: () => state.selectedDocSource,
        set: (v) => state.selectedDocSource = v
    },
    selectedDocPeriod: {
        get: () => state.selectedDocPeriod,
        set: (v) => state.selectedDocPeriod = v
    },
    editingVacancy: {
        get: () => state.editingVacancy,
        set: (v) => state.editingVacancy = v
    },
    previewState: {
        get: () => state.previewState,
        set: (v) => state.previewState = v
    },
    currentZoom: {
        get: () => state.currentZoom,
        set: (v) => state.currentZoom = v
    },
    ledgerCompareData: {
        get: () => state.ledgerCompareData,
        set: (v) => state.ledgerCompareData = v
    }
});

// 앱 초기화
export async function initApp() {
    console.log('CRE Portal 초기화 시작...');
    
    // 전역 함수 등록
    registerDetailGlobals();
    registerPopupGlobals();
    registerCrudGlobals();
    registerPreviewGlobals();
    registerMiscGlobals();
    
    // 테마 적용
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const themeBtn = document.querySelector('.theme-btn');
    if (themeBtn) themeBtn.textContent = savedTheme === 'dark' ? '☀️' : '🌙';
    
    // 로그인 체크
    if (!checkAuth()) {
        // 로그인 화면 표시
        document.getElementById('loginScreen').style.display = 'flex';
        document.getElementById('appContainer').classList.remove('active');
        console.log('로그인 필요');
        return;
    }
    
    // 로그인 성공
    showApp();
    
    // 즐겨찾기 로드
    loadStarredBuildings();
    
    // 검색 이벤트 설정
    setupSearchListener();
    
    // UI 이벤트 설정
    setupUIListeners();
    
    // 데이터 로드
    await loadData();
    
    // 카카오맵 초기화
    initKakaoMap();
    
    // 🆕 다각형 검색 초기화
    initDrawing();
    
    // 🆕 Comp List 초기화
    initCompList();
    
    console.log('CRE Portal 초기화 완료');
}

// DOMContentLoaded 이벤트 리스너
document.addEventListener('DOMContentLoaded', () => {
    // 로그인 화면에서 Enter 키 처리
    const passwordInput = document.getElementById('loginPassword');
    if (passwordInput) {
        passwordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') handleLogin();
        });
    }
});

// window에 initApp 노출
window.initApp = initApp;

// 필터 함수 전역 노출
window.toggleVacancyFilter = toggleVacancyFilter;
window.toggleLeasingGuideFilter = toggleLeasingGuideFilter;
window.applyFilter = applyFilter;
window.clearFilter = clearFilter;
window.resetAllFilters = resetAllFilters;

// 🆕 다각형 검색 함수 전역 노출
window.toggleDrawingTools = toggleDrawingTools;
window.setDrawingMode = setDrawingMode;
window.clearDrawing = clearDrawing;

// 자동 초기화 (모듈 로드 후)
initApp().catch(console.error);
