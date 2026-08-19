/**
 * Leasing Guide - 컨택포인트 관리
 * 담당자 배정, 일괄 매핑
 */

import { state, db, ref, get, update } from './guide-state.js?v=5.5';
import { showToast } from './guide-utils.js?v=5.10';
// renderBuildingEditor는 window 객체를 통해 호출 (순환 의존성 방지)

// 모달 상태
let cpModalBuildingId = null;
let cpTab = 'building';
let cpSelectedUser = null;

// 컨택포인트 미리보기 렌더링
export function renderContactPointsPreview(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building || !building.contactPoints || building.contactPoints.length === 0) {
        return '<tr><td colspan="3" style="color:#94a3b8;">담당자 미등록</td></tr>';
    }
    
    return building.contactPoints.map(c => {
        const nameDisplay = c.name ? (c.position ? `${c.name}(${c.position})` : c.name) : '-';
        const phoneDisplay = c.phone || c.mobile || '-';
        const emailDisplay = c.email || '-';
        return `
            <tr>
                <td>${nameDisplay}</td>
                <td>${phoneDisplay}</td>
                <td>${emailDisplay}</td>
            </tr>
        `;
    }).join('');
}

// 컨택포인트 모달 열기
export async function openContactPointModal(buildingId) {
    cpModalBuildingId = buildingId;
    cpTab = 'building';
    cpSelectedUser = null;
    
    const modal = document.getElementById('contactPointModal');
    if (modal) {
        modal.classList.add('show');
        renderBuildingContacts();
    }
}

// 모달 닫기
export function closeContactPointModal() {
    const modal = document.getElementById('contactPointModal');
    if (modal) modal.classList.remove('show');
    cpModalBuildingId = null;
}

// 변경사항 저장
export async function saveContactPointChanges() {
    closeContactPointModal();
    showToast('담당자 변경이 저장되었습니다', 'success');
}

// 탭 전환
export function switchCpTab(tab) {
    cpTab = tab;
    document.querySelectorAll('.cp-tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.cp-tab[data-tab="${tab}"]`)?.classList.add('active');
    
    if (tab === 'building') {
        renderBuildingContacts();
    } else {
        renderBulkLists();
    }
}

// 빌딩별 담당자 렌더링
function renderBuildingContacts() {
    const container = document.getElementById('cpModalContent');
    if (!container) return;
    
    const building = state.allBuildings.find(b => b.id === cpModalBuildingId);
    if (!building) {
        container.innerHTML = '<div class="empty-state">빌딩을 찾을 수 없습니다</div>';
        return;
    }
    
    const contacts = building.contactPoints || [];
    
    container.innerHTML = `
        <div class="cp-building-info">
            <div class="cp-building-name">🏢 ${building.name || '빌딩명'}</div>
            <div style="display:flex; gap:6px;">
                <button class="btn btn-sm btn-primary" onclick="showAddCpDropdown('user')">+ 사용자 선택</button>
                <button class="btn btn-sm btn-secondary" onclick="showAddCpDropdown('manual')">+ 직접 입력</button>
            </div>
        </div>
        
        <!-- 사용자 선택 드롭다운 -->
        <div class="cp-add-dropdown" id="cpAddDropdown" style="display:none;">
            <div id="cpAddModeUser">
                <select id="cpUserSelect" style="flex:1;">
                    <option value="">-- 사용자 선택 --</option>
                    ${(state.allUsers || []).map(u => `
                        <option value="${u.id}">${u.name || u.email} (${u.position || '직급없음'})</option>
                    `).join('')}
                </select>
                <button class="btn btn-sm btn-primary" onclick="addCpToBuilding()">추가</button>
                <button class="btn btn-sm btn-secondary" onclick="document.getElementById('cpAddDropdown').style.display='none'">취소</button>
            </div>
            <div id="cpAddModeManual" style="display:none; flex-direction:column; gap:6px;">
                <div style="display:flex; gap:6px;">
                    <input id="cpManualName" type="text" placeholder="이름" style="flex:1; padding:4px 8px; border:1px solid var(--border-color); border-radius:4px; font-size:12px;">
                    <input id="cpManualPosition" type="text" placeholder="직함 (선택)" style="flex:1; padding:4px 8px; border:1px solid var(--border-color); border-radius:4px; font-size:12px;">
                </div>
                <div style="display:flex; gap:6px;">
                    <input id="cpManualPhone" type="text" placeholder="연락처" style="flex:1; padding:4px 8px; border:1px solid var(--border-color); border-radius:4px; font-size:12px;">
                    <input id="cpManualEmail" type="text" placeholder="이메일" style="flex:1; padding:4px 8px; border:1px solid var(--border-color); border-radius:4px; font-size:12px;">
                </div>
                <div style="display:flex; gap:6px; justify-content:flex-end;">
                    <button class="btn btn-sm btn-primary" onclick="addManualCpToBuilding()">추가</button>
                    <button class="btn btn-sm btn-secondary" onclick="document.getElementById('cpAddDropdown').style.display='none'">취소</button>
                </div>
            </div>
        </div>
        
        <div class="cp-list" id="cpDragList">
            ${contacts.length === 0 ? `
                <div class="empty-state">등록된 담당자가 없습니다</div>
            ` : contacts.map((c, i) => `
                <div class="cp-item" draggable="true" data-idx="${i}"
                     style="cursor:grab;"
                     ondragstart="cpDragStart(event,${i})"
                     ondragover="cpDragOver(event)"
                     ondragenter="cpDragEnter(event)"
                     ondragleave="cpDragLeave(event)"
                     ondrop="cpDrop(event,${i})"
                     ondragend="cpDragEnd(event)">
                    <div style="display:flex; align-items:center; gap:8px; flex:1;">
                        <span style="color:#94a3b8; font-size:14px; cursor:grab;">⠿</span>
                        <div class="cp-item-info">
                            <span class="cp-name">${c.name || '-'}</span>
                            <span class="cp-position">${c.position || ''}</span>
                            <span class="cp-phone">${c.phone || c.mobile || '-'}</span>
                            <span class="cp-email">${c.email || '-'}</span>
                        </div>
                    </div>
                    <div class="cp-item-actions">
                        <button class="btn btn-xs btn-secondary" onclick="moveCpOrder(${i}, -1)" ${i === 0 ? 'disabled' : ''}>↑</button>
                        <button class="btn btn-xs btn-secondary" onclick="moveCpOrder(${i}, 1)" ${i === contacts.length - 1 ? 'disabled' : ''}>↓</button>
                        <button class="btn btn-xs btn-danger" onclick="removeCpFromBuilding(${i})">×</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
    
    // 드래그앤드롭 이벤트 바인딩
    bindCpDragEvents();
}

// 드래그 상태
let cpDragFromIdx = null;

function bindCpDragEvents() { /* 이벤트는 인라인으로 처리 */ }

export function cpDragStart(e, idx) {
    cpDragFromIdx = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.style.opacity = '0.5';
}
export function cpDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
}
export function cpDragEnter(e) {
    e.currentTarget.style.background = 'var(--bg-secondary, #f1f5f9)';
    e.currentTarget.style.borderTop = '2px solid var(--primary, #3b82f6)';
}
export function cpDragLeave(e) {
    e.currentTarget.style.background = '';
    e.currentTarget.style.borderTop = '';
}
export async function cpDrop(e, toIdx) {
    e.preventDefault();
    e.currentTarget.style.background = '';
    e.currentTarget.style.borderTop = '';
    if (cpDragFromIdx === null || cpDragFromIdx === toIdx) return;
    
    const building = state.allBuildings.find(b => b.id === cpModalBuildingId);
    if (!building || !building.contactPoints) return;
    
    const cp = building.contactPoints.splice(cpDragFromIdx, 1)[0];
    building.contactPoints.splice(toIdx, 0, cp);
    
    try {
        await update(ref(db, `buildings/${cpModalBuildingId}`), { contactPoints: building.contactPoints });
    } catch(err) { console.error(err); }
    
    cpDragFromIdx = null;
    renderBuildingContacts();
    refreshCurrentPreview(building);
}
export function cpDragEnd(e) {
    e.currentTarget.style.opacity = '';
    cpDragFromIdx = null;
}

export async function addManualCpToBuilding() {
    const name = document.getElementById('cpManualName')?.value?.trim();
    const position = document.getElementById('cpManualPosition')?.value?.trim();
    const phone = document.getElementById('cpManualPhone')?.value?.trim();
    const email = document.getElementById('cpManualEmail')?.value?.trim();
    
    if (!name) { showToast('이름을 입력하세요', 'error'); return; }
    
    const building = state.allBuildings.find(b => b.id === cpModalBuildingId);
    if (!building) return;
    if (!building.contactPoints) building.contactPoints = [];
    
    building.contactPoints.push({ name, position, phone, mobile: phone, email, isManual: true });
    
    try {
        await update(ref(db, `buildings/${cpModalBuildingId}`), { contactPoints: building.contactPoints });
        showToast('담당자가 추가되었습니다', 'success');
    } catch(err) { console.error(err); }
    
    document.getElementById('cpAddDropdown').style.display = 'none';
    renderBuildingContacts();
    refreshCurrentPreview(building);
}

// 담당자 추가 드롭다운 표시
export function showAddCpDropdown(mode = 'user') {
    const dropdown = document.getElementById('cpAddDropdown');
    if (!dropdown) return;
    dropdown.style.display = 'flex';
    dropdown.style.flexDirection = 'column';
    const modeUser = document.getElementById('cpAddModeUser');
    const modeManual = document.getElementById('cpAddModeManual');
    if (modeUser) modeUser.style.display = mode === 'user' ? 'flex' : 'none';
    if (modeManual) modeManual.style.display = mode === 'manual' ? 'flex' : 'none';
}

// 담당자 추가
export async function addCpToBuilding() {
    const select = document.getElementById('cpUserSelect');
    const userId = select?.value;
    
    if (!userId) {
        showToast('사용자를 선택하세요', 'error');
        return;
    }
    
    const user = (state.allUsers || []).find(u => u.id === userId);
    if (!user) return;
    
    const building = state.allBuildings.find(b => b.id === cpModalBuildingId);
    if (!building) return;
    
    if (!building.contactPoints) building.contactPoints = [];
    
    // 중복 체크
    if (building.contactPoints.find(c => c.userId === userId)) {
        showToast('이미 등록된 담당자입니다', 'error');
        return;
    }
    
    building.contactPoints.push({
        userId: userId,
        name: user.name || user.email?.split('@')[0] || '-',
        position: user.position || '',
        phone: user.phone || '',
        mobile: user.mobile || '',
        email: user.email || ''
    });
    
    // Firebase 저장
    try {
        await update(ref(db, `buildings/${cpModalBuildingId}`), {
            contactPoints: building.contactPoints
        });
        showToast('담당자가 추가되었습니다', 'success');
    } catch (error) {
        console.error('담당자 추가 오류:', error);
    }
    
    renderBuildingContacts();
    document.getElementById('cpAddDropdown').style.display = 'none';
    
    // 프리뷰 갱신
    refreshCurrentPreview(building);
}

// 담당자 제거
export async function removeCpFromBuilding(idx) {
    const building = state.allBuildings.find(b => b.id === cpModalBuildingId);
    if (!building || !building.contactPoints) return;
    
    building.contactPoints.splice(idx, 1);
    
    // Firebase 저장
    try {
        await update(ref(db, `buildings/${cpModalBuildingId}`), {
            contactPoints: building.contactPoints
        });
        showToast('담당자가 제거되었습니다', 'success');
    } catch (error) {
        console.error('담당자 제거 오류:', error);
    }
    
    renderBuildingContacts();
    refreshCurrentPreview(building);
}

// 담당자 순서 변경
export async function moveCpOrder(idx, direction) {
    const building = state.allBuildings.find(b => b.id === cpModalBuildingId);
    if (!building || !building.contactPoints) return;
    
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= building.contactPoints.length) return;
    
    const temp = building.contactPoints[idx];
    building.contactPoints[idx] = building.contactPoints[newIdx];
    building.contactPoints[newIdx] = temp;
    
    // Firebase 저장
    try {
        await update(ref(db, `buildings/${cpModalBuildingId}`), {
            contactPoints: building.contactPoints
        });
    } catch (error) {
        console.error('순서 변경 오류:', error);
    }
    
    renderBuildingContacts();
    refreshCurrentPreview(building);
}

// 현재 프리뷰 갱신
function refreshCurrentPreview(building) {
    if (state.selectedTocIndex >= 0) {
        const item = state.tocItems[state.selectedTocIndex];
        if (item && item.buildingId === building.id) {
            window.renderBuildingEditor(item, building);
        }
    }
}

// ========== 일괄 매핑 ==========

function renderUserSelect() {
    return `
        <select id="bulkUserSelect">
            <option value="">-- 사용자 선택 --</option>
            ${(state.allUsers || []).map(u => `
                <option value="${u.id}">${u.name || u.email} (${u.position || '직급없음'})</option>
            `).join('')}
        </select>
    `;
}

// 사용자 선택 시 해당 사용자의 빌딩 목록 로드
export async function loadUserBuildings() {
    const userId = document.getElementById('bulkUserSelect')?.value;
    cpSelectedUser = userId;
    
    if (!userId) {
        document.getElementById('bulkMappingArea').innerHTML = '<div class="empty-state">사용자를 선택하세요</div>';
        return;
    }
    
    // 해당 사용자가 담당인 빌딩 목록
    const userBuildings = state.allBuildings.filter(b => 
        b.contactPoints?.some(c => c.userId === userId)
    );
    
    // 현재 안내문의 빌딩 목록
    const guideBuildings = state.tocItems
        .filter(i => i.type === 'building')
        .map(i => {
            const building = state.allBuildings.find(b => b.id === i.buildingId);
            return building;
        })
        .filter(Boolean);
    
    renderBulkLists(userBuildings, guideBuildings);
}

// 일괄 매핑 UI 렌더링
function renderBulkLists(userBuildings = [], guideBuildings = []) {
    const container = document.getElementById('cpModalContent');
    if (!container) return;
    
    // 현재 안내문의 빌딩 목록
    const guideBuildingsList = state.tocItems
        .filter(i => i.type === 'building')
        .map(i => state.allBuildings.find(b => b.id === i.buildingId))
        .filter(Boolean);
    
    container.innerHTML = `
        <div class="bulk-mapping-container">
            <div class="bulk-user-select">
                <label>담당자 선택</label>
                ${renderUserSelect()}
                <button class="btn btn-sm btn-primary" onclick="loadUserBuildings()">조회</button>
            </div>
            
            <div class="bulk-mapping-area" id="bulkMappingArea">
                <div class="empty-state">사용자를 선택 후 조회하세요</div>
            </div>
            
            <div class="bulk-guide-buildings">
                <label>현재 안내문 빌딩 (${guideBuildingsList.length}개)</label>
                <div class="building-chip-list">
                    ${guideBuildingsList.map(b => `
                        <span class="building-chip">
                            <input type="checkbox" id="bulk_${b.id}" value="${b.id}">
                            <label for="bulk_${b.id}">${b.name || '이름없음'}</label>
                        </span>
                    `).join('')}
                </div>
                <div class="bulk-actions">
                    <button class="btn btn-sm btn-secondary" onclick="updateBulkCount()">선택 확인</button>
                    <button class="btn btn-sm btn-primary" onclick="applyBulkMapping()">일괄 적용</button>
                    <button class="btn btn-sm btn-danger" onclick="removeBulkMapping()">일괄 제거</button>
                </div>
            </div>
        </div>
    `;
}

// 선택 개수 업데이트
export function updateBulkCount() {
    const checked = document.querySelectorAll('.building-chip input:checked').length;
    showToast(`${checked}개 빌딩 선택됨`, 'info');
}

// 일괄 적용
export async function applyBulkMapping() {
    const userId = document.getElementById('bulkUserSelect')?.value;
    if (!userId) {
        showToast('담당자를 선택하세요', 'error');
        return;
    }
    
    const user = (state.allUsers || []).find(u => u.id === userId);
    if (!user) return;
    
    const checkedInputs = document.querySelectorAll('.building-chip input:checked');
    if (checkedInputs.length === 0) {
        showToast('적용할 빌딩을 선택하세요', 'error');
        return;
    }
    
    let successCount = 0;
    
    for (const input of checkedInputs) {
        const buildingId = input.value;
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (!building) continue;
        
        if (!building.contactPoints) building.contactPoints = [];
        
        // 중복 체크
        if (building.contactPoints.find(c => c.userId === userId)) continue;
        
        building.contactPoints.push({
            userId: userId,
            name: user.name || user.email?.split('@')[0] || '-',
            position: user.position || '',
            phone: user.phone || '',
            mobile: user.mobile || '',
            email: user.email || ''
        });
        
        try {
            await update(ref(db, `buildings/${buildingId}`), {
                contactPoints: building.contactPoints
            });
            successCount++;
        } catch (error) {
            console.error('일괄 적용 오류:', error);
        }
    }
    
    showToast(`${successCount}개 빌딩에 담당자가 추가되었습니다`, 'success');
    
    // 체크박스 해제
    checkedInputs.forEach(input => input.checked = false);
}

// 일괄 제거
export async function removeBulkMapping() {
    const userId = document.getElementById('bulkUserSelect')?.value;
    if (!userId) {
        showToast('담당자를 선택하세요', 'error');
        return;
    }
    
    const checkedInputs = document.querySelectorAll('.building-chip input:checked');
    if (checkedInputs.length === 0) {
        showToast('제거할 빌딩을 선택하세요', 'error');
        return;
    }
    
    if (!confirm(`선택한 ${checkedInputs.length}개 빌딩에서 담당자를 제거하시겠습니까?`)) {
        return;
    }
    
    let successCount = 0;
    
    for (const input of checkedInputs) {
        const buildingId = input.value;
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (!building || !building.contactPoints) continue;
        
        const beforeCount = building.contactPoints.length;
        building.contactPoints = building.contactPoints.filter(c => c.userId !== userId);
        
        if (building.contactPoints.length < beforeCount) {
            try {
                await update(ref(db, `buildings/${buildingId}`), {
                    contactPoints: building.contactPoints
                });
                successCount++;
            } catch (error) {
                console.error('일괄 제거 오류:', error);
            }
        }
    }
    
    showToast(`${successCount}개 빌딩에서 담당자가 제거되었습니다`, 'success');
    
    // 체크박스 해제
    checkedInputs.forEach(input => input.checked = false);
}

// 전역 함수 등록
export function registerContactFunctions() {
    window.renderContactPointsPreview = renderContactPointsPreview;
    window.openContactPointModal = openContactPointModal;
    window.closeContactPointModal = closeContactPointModal;
    window.saveContactPointChanges = saveContactPointChanges;
    window.switchCpTab = switchCpTab;
    window.showAddCpDropdown = showAddCpDropdown;
    window.addCpToBuilding = addCpToBuilding;
    window.removeCpFromBuilding = removeCpFromBuilding;
    window.moveCpOrder = moveCpOrder;
    window.addManualCpToBuilding = addManualCpToBuilding;
    window.cpDragStart = cpDragStart;
    window.cpDragOver = cpDragOver;
    window.cpDragEnter = cpDragEnter;
    window.cpDragLeave = cpDragLeave;
    window.cpDrop = cpDrop;
    window.cpDragEnd = cpDragEnd;
    window.loadUserBuildings = loadUserBuildings;
    window.updateBulkCount = updateBulkCount;
    window.applyBulkMapping = applyBulkMapping;
    window.removeBulkMapping = removeBulkMapping;
}
