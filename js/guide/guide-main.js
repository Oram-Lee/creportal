/**
 * Leasing Guide - 메인 진입점
 * 초기화 및 모든 모듈 통합
 */

// Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, get, set, push, update, remove, onValue } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { getStorage, ref as storageRef, uploadString, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';

// State
import { state, initFirebase, setCurrentUser, setAllBuildings, setLeasingGuides, setCoverSettings, resetCoverSettings } from './guide-state.js';

// Utils
import { showToast, initTheme, toggleTheme, normalizeBuilding } from './guide-utils.js';

// Modules
import { renderGuideList, registerListFunctions } from './guide-list.js';
import { renderToc, registerTocFunctions } from './guide-toc.js';
import { renderCoverEditor, registerCoverFunctions } from './guide-cover.js';
import { renderBuildingEditor, registerBuildingFunctions } from './guide-building.js';
import { registerVacancyFunctions } from './guide-vacancy.js';
import { registerMapFunctions } from './guide-map.js';
import { registerNoteFunctions } from './guide-note.js';
import { registerDividerFunctions } from './guide-divider.js';
import { registerModalFunctions } from './guide-modal.js';
import { registerContactFunctions } from './guide-contact.js';
import { registerPreviewFunctions } from './guide-preview.js';

// Firebase 설정
const firebaseConfig = {
    apiKey: "AIzaSyDHH-u0Hqs8oZEZe6cGNnwimXGpIaG0P0g",
    authDomain: "cre-unified.firebaseapp.com",
    databaseURL: "https://cre-unified-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "cre-unified",
    storageBucket: "cre-unified.firebasestorage.app",
    messagingSenderId: "665289244827",
    appId: "1:665289244827:web:fd2c0b6f04d0e6c9cacd46"
};

// Firebase 초기화
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const storage = getStorage(app);

// Firebase 참조를 state 모듈에 전달
initFirebase({ db, ref, get, set, push, update, remove, storage, storageRef, uploadString, getDownloadURL });

// 전역 변수 (호환성)
window.db = db;
window.ref = ref;
window.get = get;
window.set = set;
window.push = push;
window.update = update;
window.remove = remove;
window.storage = storage;
window.storageRef = storageRef;
window.uploadString = uploadString;
window.getDownloadURL = getDownloadURL;

// ========== 초기화 ==========
export async function init() {
    // 테마 초기화
    initTheme();
    
    // 로그인 체크
    const currentUser = JSON.parse(localStorage.getItem('crePortalUser'));
    if (!currentUser) {
        window.location.href = 'portal.html';
        return;
    }
    setCurrentUser(currentUser);
    
    // 사용자 정보 UI 업데이트
    const userNameEl = document.getElementById('userName');
    if (userNameEl) {
        userNameEl.textContent = currentUser.name || currentUser.email || '사용자';
    }
    const userRoleEl = document.getElementById('userRole');
    if (userRoleEl) {
        userRoleEl.textContent = currentUser.role || 'user';
    }
    
    // 전역 함수 등록
    registerAllFunctions();
    
    // 데이터 로드
    await loadData();
    
    // 목록 렌더링
    renderGuideList();
    
    console.log('Leasing Guide 초기화 완료');
}

// 전역 함수 등록
function registerAllFunctions() {
    // 각 모듈의 전역 함수 등록
    registerListFunctions();
    registerTocFunctions();
    registerCoverFunctions();
    registerBuildingFunctions();
    registerVacancyFunctions();
    registerMapFunctions();
    registerNoteFunctions();
    registerDividerFunctions();
    registerModalFunctions();
    registerContactFunctions();
    registerPreviewFunctions();
    
    // 공통 함수
    window.showToast = showToast;
    window.toggleTheme = toggleTheme;
    window.logout = logout;
}

// ========== 데이터 로드 ==========
async function loadData() {
    try {
        // 빌딩 데이터
        const buildingsSnapshot = await get(ref(db, 'buildings'));
        if (buildingsSnapshot.exists()) {
            const data = buildingsSnapshot.val();
            const buildings = Object.entries(data).map(([id, b]) => {
                const building = { id, ...b };
                normalizeBuilding(building);
                return building;
            });
            setAllBuildings(buildings);
        }
        
        // 임대안내문 데이터
        const guidesSnapshot = await get(ref(db, 'leasingGuides'));
        if (guidesSnapshot.exists()) {
            setLeasingGuides(guidesSnapshot.val());
        }
        
        // 사용자 데이터 (컨택포인트용)
        const usersSnapshot = await get(ref(db, 'users'));
        if (usersSnapshot.exists()) {
            state.allUsers = Object.entries(usersSnapshot.val()).map(([id, u]) => ({ id, ...u }));
        }
        
    } catch (error) {
        console.error('데이터 로드 오류:', error);
        showToast('데이터 로드 중 오류가 발생했습니다', 'error');
    }
}

// ========== 로그아웃 ==========
function logout() {
    localStorage.removeItem('crePortalUser');
    window.location.href = 'portal.html';
}

// DOM 로드 시 초기화
document.addEventListener('DOMContentLoaded', init);

// 전역 노출 (호환성)
window.init = init;
