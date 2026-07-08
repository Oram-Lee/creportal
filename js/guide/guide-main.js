/**
 * Leasing Guide - 메인 진입점
 * 초기화 및 모든 모듈 통합
 */

// Firebase
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getDatabase, ref, get, set, push, update, remove, onValue } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js';
import { getStorage, ref as storageRef, uploadString, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';

// State
import { state, initFirebase, setCurrentUser, setAllBuildings, setLeasingGuides, setCoverSettings, resetCoverSettings } from './guide-state.js?v=5.1';

// Utils
import { showToast, initTheme, toggleTheme, normalizeBuilding } from './guide-utils.js?v=5.1';

// Modules
import { renderGuideList, registerListFunctions } from './guide-list.js?v=5.7';
import { renderToc, registerTocFunctions } from './guide-toc.js?v=5.2';
import { renderCoverEditor, registerCoverFunctions } from './guide-cover.js?v=5.8';
import { renderBuildingEditor, registerBuildingFunctions } from './guide-building.js?v=6.16';
import { registerVacancyFunctions } from './guide-vacancy.js?v=5.14';
import { registerMapFunctions } from './guide-map.js?v=6.1';
import { registerNoteFunctions } from './guide-note.js?v=5.1';
import { registerDividerFunctions } from './guide-divider.js?v=5.1';
import { registerModalFunctions } from './guide-modal.js?v=5.3';
import { registerContactFunctions } from './guide-contact.js?v=5.1';
import { registerPreviewFunctions } from './guide-preview.js?v=5.6';

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
        
        // ★ v6.21: 즐겨찾기 로드 — 포털 저장 방식 2세대 혼재 대응 (합집합)
        //   ① localStorage 'starredBuildings' (포털 현행 저장 방식 — 빌딩 id 배열)
        //   ② Firebase users/{uid}/favorites (그룹 시스템 v4.2 — uid는 노드키/이메일 쉼표치환 등 혼재)
        try {
            state.starredBuildings = new Set();
            
            // ① localStorage (같은 도메인이라 포털과 공유됨)
            try {
                const ls = JSON.parse(localStorage.getItem('starredBuildings') || '[]');
                if (Array.isArray(ls)) ls.forEach(id => id && state.starredBuildings.add(id));
            } catch (_) { /* 파싱 실패 무시 */ }
            const lsCount = state.starredBuildings.size;
            
            // ② Firebase 후보 키들 (전부 조회해 합집합)
            const cu = state.currentUser || {};
            const isValidKey = (k) => k && typeof k === 'string' && !/[.#$\[\]\/]/.test(k);
            const candidates = new Set();
            if (isValidKey(cu.uid)) candidates.add(cu.uid);
            if (isValidKey(cu.id)) candidates.add(cu.id);
            const cuEmail = (cu.email || '').toLowerCase();
            if (cuEmail) {
                const commaKey = cuEmail.replace(/\./g, ',');  // 예: hyelinshin@sni,co,kr 패턴
                if (isValidKey(commaKey)) candidates.add(commaKey);
                const matched = (state.allUsers || []).find(u => (u.email || '').toLowerCase() === cuEmail);
                if (matched && isValidKey(matched.id)) candidates.add(matched.id);
            }
            for (const uid of candidates) {
                try {
                    const favSnapshot = await get(ref(db, `users/${uid}/favorites`));
                    if (favSnapshot.exists()) {
                        Object.keys(favSnapshot.val()).forEach(id => state.starredBuildings.add(id));
                    }
                } catch (_) { /* 개별 경로 실패 무시 */ }
            }
            
            console.log(`⭐ 즐겨찾기 ${state.starredBuildings.size}건 로드 (localStorage: ${lsCount}건, Firebase 후보: ${[...candidates].join(', ') || '없음'})`);
        } catch (favError) {
            console.warn('즐겨찾기 로드 실패 (무시):', favError);
            state.starredBuildings = new Set();
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
