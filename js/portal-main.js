/**
 * CRE Portal - 메인 초기화
 * 모든 모듈을 로드하고 전역 변수를 설정
 * 
 * v4.0 성능 최적화 (2026-02-04):
 * - ★ initApp() 순서 변경: 지도 먼저 → 데이터 비동기 로드
 * - ★ 로딩 인디케이터 추가 (데이터 로드 중 사용자 피드백)
 * - ★ 성능 타이머 추가 (console에서 병목 확인 가능)
 */

// 모듈 import
import { state, API_BASE_URL } from './portal-state.js';
import { db, ref, get, set, push, update, remove } from './portal-firebase.js';
import { showToast, formatNumber, formatPyPrice, debounce, detectRegion, autoSetRegion, formatFloors, formatStation, isRecentlyUpdated } from './portal-utils.js';
import { handleLogin, handleLogout, showApp, checkAuth, hasPermission } from './portal-auth.js';
import { loadData, processBuildings } from './portal-data.js?v=4.0';
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

// ★ v4.0: 로딩 인디케이터 표시/숨기기
function showLoadingOverlay() {
    let overlay = document.getElementById('dataLoadingOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dataLoadingOverlay';
        overlay.innerHTML = `
            <div style="position:fixed; bottom:24px; left:50%; transform:translateX(-50%); z-index:9999;
                        background:rgba(30,41,59,0.9); color:#fff; padding:12px 28px; border-radius:30px;
                        font-size:14px; font-weight:500; display:flex; align-items:center; gap:10px;
                        box-shadow:0 4px 20px rgba(0,0,0,0.3); backdrop-filter:blur(8px);
                        font-family:'Noto Sans KR',sans-serif;">
                <div style="width:18px;height:18px;border:2px solid rgba(255,255,255,0.3);
                            border-top-color:#fff;border-radius:50%;
                            animation:spin 0.7s linear infinite;"></div>
                <span id="loadingText">데이터를 불러오는 중...</span>
            </div>
        `;
        document.body.appendChild(overlay);
    }
    overlay.style.display = '';
}

function hideLoadingOverlay() {
    const overlay = document.getElementById('dataLoadingOverlay');
    if (overlay) overlay.style.display = 'none';
}

function updateLoadingText(text) {
    const el = document.getElementById('loadingText');
    if (el) el.textContent = text;
}

// 앱 초기화
export async function initApp() {
    const t0 = performance.now();
    console.log('🚀 CRE Portal 초기화 시작...');
    
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
    
    // 로그인 성공 → 즉시 앱 화면 표시
    showApp();
    
    console.log(`  ✅ 앱 표시 완료 (+${Math.round(performance.now() - t0)}ms)`);
    
    // ★ v4.0: 즐겨찾기, 검색, UI 이벤트 — 비차단 즉시 실행
    loadStarredBuildings();
    setupSearchListener();
    setupUIListeners();
    
    // ★ v4.0: 카카오맵 먼저 초기화 (빈 지도라도 즉시 표시)
    initKakaoMap();
    console.log(`  ✅ 카카오맵 초기화 완료 (+${Math.round(performance.now() - t0)}ms)`);
    
    // ★ v4.0: Drawing / CompList도 미리 초기화 (지도 위 컨트롤)
    initDrawing();
    initCompList();
    
    // ★ v4.0: 데이터 로드 (로딩 인디케이터와 함께 비동기 실행)
    showLoadingOverlay();
    
    try {
        await loadData();
        console.log(`  ✅ 데이터 로드 + 처리 완료 (+${Math.round(performance.now() - t0)}ms)`);
    } catch (err) {
        console.error('데이터 로드 실패:', err);
    } finally {
        hideLoadingOverlay();
    }
    
    console.log(`🏁 CRE Portal 초기화 완료 — 총 ${Math.round(performance.now() - t0)}ms`);
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
