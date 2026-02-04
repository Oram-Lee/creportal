/**
 * CRE Portal - 인증 관리
 * 
 * v4.0 (2026-02-04):
 * - ★ 로그인 화면 깜빡임(FOAC) 방지
 *   - 모듈 로드 즉시 localStorage 확인하여 CSS 클래스 주입
 *   - 인증 여부에 따라 loginScreen/appContainer 즉시 제어
 *   - ES 모듈 지연 로딩으로 인한 화면 깜빡임 완전 제거
 */

import { state } from './portal-state.js';
import { db, ref, get } from './portal-firebase.js';
import { showToast } from './portal-utils.js';

// ============================================================
// ★ v4.0: 모듈 로드 즉시 실행 — 깜빡임 방지 CSS 주입
// ES 모듈도 파싱 시점에 top-level 코드가 실행되므로
// initApp()보다 먼저 화면 상태를 결정할 수 있음
// ============================================================
(function preauthCheck() {
    const savedUser = localStorage.getItem('crePortalUser');
    
    // 즉시 CSS 주입으로 올바른 화면만 표시
    const style = document.createElement('style');
    style.id = 'preauth-flicker-guard';
    style.textContent = savedUser
        ? `
            /* 인증됨: 로그인 화면 즉시 숨김 */
            #loginScreen { display: none !important; }
          `
        : `
            /* 미인증: 앱 컨테이너 즉시 숨김 */
            #appContainer { opacity: 0; pointer-events: none; }
          `;
    
    // head가 있으면 head에, 없으면 documentElement에 추가
    (document.head || document.documentElement).appendChild(style);
})();

// 로그인 처리
export async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    
    if (!email || !password) {
        showToast('이메일과 비밀번호를 입력하세요', 'error');
        return;
    }
    
    try {
        const usersSnap = await get(ref(db, 'users'));
        if (!usersSnap.exists()) {
            showToast('사용자 데이터가 없습니다', 'error');
            return;
        }
        
        let foundUser = null;
        usersSnap.forEach(child => {
            const u = child.val();
            if (u.email === email && u.password === password) {
                foundUser = { id: child.key, ...u };
            }
        });
        
        if (foundUser) {
            state.currentUser = foundUser;
            localStorage.setItem('crePortalUser', JSON.stringify(foundUser));
            showApp();
            showToast(`환영합니다, ${foundUser.name || foundUser.email}님!`, 'success');
        } else {
            showToast('이메일 또는 비밀번호가 올바르지 않습니다', 'error');
        }
    } catch (e) {
        console.error('Login error:', e);
        showToast('로그인 중 오류가 발생했습니다', 'error');
    }
}

// 로그아웃
export function handleLogout() {
    state.currentUser = null;
    localStorage.removeItem('crePortalUser');
    location.reload();
}

// 앱 표시
export function showApp() {
    // ★ v4.0: preauth guard CSS 제거 (showApp 이후에는 불필요)
    const guard = document.getElementById('preauth-flicker-guard');
    if (guard) guard.remove();
    
    document.getElementById('loginScreen').style.display = 'none';
    
    const appContainer = document.getElementById('appContainer');
    appContainer.classList.add('active');
    appContainer.style.opacity = '';
    appContainer.style.pointerEvents = '';
    
    document.getElementById('userName').textContent = 
        state.currentUser?.name || state.currentUser?.email?.split('@')[0] || '사용자';
}

// 로그인 체크 (페이지 로드 시)
export function checkAuth() {
    const savedUser = localStorage.getItem('crePortalUser');
    if (!savedUser) {
        // ★ v4.0: 미인증 시 preauth guard 제거하고 로그인 화면 표시
        const guard = document.getElementById('preauth-flicker-guard');
        if (guard) guard.remove();
        return false;
    }
    try {
        state.currentUser = JSON.parse(savedUser);
        return true;
    } catch (e) {
        localStorage.removeItem('crePortalUser');
        const guard = document.getElementById('preauth-flicker-guard');
        if (guard) guard.remove();
        return false;
    }
}

// 권한 체크
export function hasPermission(permission) {
    if (!state.currentUser) return false;
    const role = state.currentUser.role || 'viewer';
    
    const permissions = {
        admin: ['view', 'edit', 'delete', 'manage'],
        editor: ['view', 'edit'],
        viewer: ['view']
    };
    
    return permissions[role]?.includes(permission) || false;
}

// 삭제 권한 체크
export function canDeleteBuilding() {
    return hasPermission('delete');
}

// 관리자 체크
export function isAdmin() {
    return state.currentUser?.role === 'admin';
}

// window에 등록 (HTML onclick 호환)
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.hasPermission = hasPermission;
window.canDeleteBuilding = canDeleteBuilding;
window.isAdmin = isAdmin;
