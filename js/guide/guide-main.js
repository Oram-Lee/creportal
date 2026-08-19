/**
 * Leasing Guide - 메인 진입점
 * 초기화 및 모든 모듈 통합
 */

// Firebase — 공용 REST 어댑터 (../portal-firebase.js)
// 사내망 URL 필터가 RTDB 샤드 호스트(s-gke-*.firebasedatabase.app)의 WebSocket을
// 차단하므로 getDatabase() 대신 REST 어댑터를 사용한다. (onValue는 실사용 0건이라 제거)
// Storage는 별도 도메인이라 어댑터가 SDK를 그대로 재export한다. 앱 초기화도 어댑터 내부에서 수행.
import { db, ref, get, set, push, update, remove, storage, storageRef, uploadString, getDownloadURL } from '../portal-firebase.js';

// State
import { state, initFirebase, setCurrentUser, setAllBuildings, setLeasingGuides, setCoverSettings, resetCoverSettings } from './guide-state.js?v=5.4';

// Utils
import { showToast, initTheme, toggleTheme, normalizeBuilding } from './guide-utils.js?v=5.9';

// Modules
import { renderGuideList, registerListFunctions } from './guide-list.js?v=5.11';
import { renderToc, registerTocFunctions } from './guide-toc.js?v=5.5';
import { renderCoverEditor, registerCoverFunctions } from './guide-cover.js?v=5.11';
import { renderBuildingEditor, registerBuildingFunctions } from './guide-building.js?v=6.22';
import { registerVacancyFunctions } from './guide-vacancy.js?v=5.17';
import { registerMapFunctions } from './guide-map.js?v=6.4';
import { registerNoteFunctions } from './guide-note.js?v=5.3';
import { registerDividerFunctions } from './guide-divider.js?v=5.4';
import { registerModalFunctions } from './guide-modal.js?v=5.5';
import { registerContactFunctions } from './guide-contact.js?v=5.3';
import { registerPreviewFunctions } from './guide-preview.js?v=5.10';

// Firebase 참조를 state 모듈에 전달 (db/storage는 어댑터에서 import됨)
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
    
    // 포털 → 안내문 실시간 동기화 수신 시작
    initPortalSync();
    
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

// ========== 포털 → 안내문 실시간 동기화 ==========
// 포털에서 buildings/{id} 를 저장하면 cre_portal_sync 로 브로드캐스트된다.
// 안내문 편집기 탭이 열려 있어도 새로고침 없이 state.allBuildings 가 최신값을 갖도록 한다.
//
// ※ 범위: 빌딩 레코드 동기화까지다. 포털에서 입력한 공실이 편집기 공실표에 새 행으로
//   나타나지는 않는다 — 안내문의 공실 3계통(customVacancies / selectedExternalVacancies /
//   leasingGuideVacancies)은 guideVacancy 노드를 읽지 않기 때문이다. (별도 트랙)
//
// ※ origin:'guide' 는 안내문이 스스로 쏜 메시지다. BroadcastChannel 은 같은 탭의
//   다른 채널 객체에는 배달하므로, 이 가드가 없으면 저장 직후 자기 메시지를 되받아
//   편집 중이던 화면을 다시 그린다.
function applyPortalUpdate(buildingId, data) {
    if (!buildingId || !data) return;
    const idx = state.allBuildings.findIndex(b => b.id === buildingId);
    if (idx < 0) return;   // 목록에 없는 빌딩은 무시 (다음 loadData 때 들어온다)
    state.allBuildings[idx] = { ...state.allBuildings[idx], ...data };

    // 현재 편집 중인 항목이 이 빌딩이면 화면도 갱신
    const item = state.tocItems?.[state.selectedTocIndex];
    if (!item || item.buildingId !== buildingId) return;

    // 인라인 행 편집이 열려 있으면 다시 그리지 않는다 (입력 중이던 값이 날아감)
    if (document.querySelector('[id^="veFloor_"]')) {
        showToast('포털에서 변경된 내용이 있습니다. 편집을 마치면 반영됩니다', 'info');
        return;
    }
    if (typeof window.renderBuildingEditor === 'function') {
        window.renderBuildingEditor(item, state.allBuildings[idx]);
    }
}

function initPortalSync() {
    try {
        const bc = new BroadcastChannel('cre_portal_sync');
        bc.onmessage = (e) => {
            const m = e.data;
            if (!m || m.type !== 'buildingUpdated') return;
            if (m.origin === 'guide') return;   // 자기가 쏜 메시지
            applyPortalUpdate(m.buildingId, m.data);
        };
    } catch (_) { /* BroadcastChannel 미지원 환경 무시 */ }

    // 같은 탭 CustomEvent (iframe 구조 등) — 포털과 동일한 경로
    window.addEventListener('buildingUpdated', (e) => {
        if (e.detail?.buildingId) applyPortalUpdate(e.detail.buildingId, e.detail.data);
    });
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
