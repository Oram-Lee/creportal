/**
 * CRE Portal - 인증 관리
 */

import { state } from './portal-state.js';
import { db, ref, get } from './portal-firebase.js';
import { showToast } from './portal-utils.js';

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
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appContainer').classList.add('active');
    document.getElementById('userName').textContent = 
        state.currentUser?.name || state.currentUser?.email?.split('@')[0] || '사용자';
}

// 로그인 체크 (페이지 로드 시)
export function checkAuth() {
    const savedUser = localStorage.getItem('crePortalUser');
    if (!savedUser) {
        return false;
    }
    try {
        state.currentUser = JSON.parse(savedUser);
        return true;
    } catch (e) {
        localStorage.removeItem('crePortalUser');
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
