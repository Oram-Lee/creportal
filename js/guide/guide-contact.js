/**
 * Leasing Guide - 컨택포인트 관리
 * 담당자 배정, 일괄 매핑
 */

import { state, db, ref, get, update } from './guide-state.js';
import { showToast } from './guide-utils.js';
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
            <button class="btn btn-sm btn-primary" onclick="showAddCpDropdown()">+ 담당자 추가</button>
        </div>
        
        <div class="cp-add-dropdown" id="cpAddDropdown" style="display:none;">
            <select id="cpUserSelect" style="flex:1;">
                <option value="">-- 사용자 선택 --</option>
                ${(state.allUsers || []).map(u => `
                    <option value="${u.id}">${u.name || u.email} (${u.position || '직급없음'})</option>
                `).join('')}
            </select>
            <button class="btn btn-sm btn-primary" onclick="addCpToBuilding()">추가</button>
            <button class="btn btn-sm btn-secondary" onclick="document.getElementById('cpAddDropdown').style.display='none'">취소</button>
        </div>
        
        <div class="cp-drag-hint" style="font-size:11px; color:#94a3b8; padding:4px 0 8px; display:${contacts.length > 1 ? 'block' : 'none'};">
            ✋ 드래그하여 순서 변경 가능
        </div>
        
        <div class="cp-list" id="cpDraggableList">
            ${contacts.length === 0 ? `
                <div class="empty-state">등록된 담당자가 없습니다</div>
            ` : contacts.map((c, i) => `
                <div class="cp-item" draggable="true" data-idx="${i}" 
                     style="cursor:grab; user-select:none;"
                     ondragstart="cpDragStart(event, ${i})"
                     ondragover="cpDragOver(event)"
                     ondragenter="cpDragEnter(event)"
                     ondragleave="cpDragLeave(event)"
                     ondrop="cpDrop(event, ${i})"
                     ondragend="cpDragEnd(event)">
                    <div class="cp-drag-handle" style="color:#94a3b8; margin-right:8px; font-size:16px;">⠿</div>
                    <div class="cp-item-info">
                        <span class="cp-name">${c.name || '-'}</span>
                        <span class="cp-position">${c.position || ''}</span>
                        <span class="cp-phone">${c.phone || c.mobile || '-'}</span>
                        <span class="cp-email">${c.email || '-'}</span>
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
    
    // 드래그앤드롭 CSS 추가 (한 번만)
    if (!document.getElementById('cpDragStyle')) {
        const style = document.createElement('style');
        style.id = 'cpDragStyle';
        style.textContent = `
            .cp-item { display: flex; align-items: center; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 6px; margin-bottom: 6px; background: white; transition: all 0.15s; }
            .cp-item:hover { border-color: #3b82f6; background: #f8faff; }
            .cp-item.cp-dragging { opacity: 0.4; border: 2px dashed #3b82f6; }
            .cp-item.cp-drag-over { border: 2px dashed #22c55e; background: #f0fdf4; transform: scale(1.01); }
            .cp-drag-handle { cursor: grab; }
            .cp-item:active .cp-drag-handle { cursor: grabbing; }
        `;
        document.head.appendChild(style);
    }
}

// ★ 드래그앤드롭 상태 변수
let cpDragSrcIdx = null;

export function cpDragStart(event, idx) {
    cpDragSrcIdx = idx;
    event.currentTarget.classList.add('cp-dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(idx));
}

export function cpDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
}

export function cpDragEnter(event) {
    event.preventDefault();
    const item = event.currentTarget.closest('.cp-item');
    if (item) item.classList.add('cp-drag-over');
}

export function cpDragLeave(event) {
    const item = event.currentTarget.closest('.cp-item');
    if (item && !item.contains(event.relatedTarget)) {
        item.classList.remove('cp-drag-over');
    }
}

export async function cpDrop(event, targetIdx) {
    event.preventDefault();
    const item = event.currentTarget.closest('.cp-item');
    if (item) item.classList.remove('cp-drag-over');
    
    if (cpDragSrcIdx === null || cpDragSrcIdx === targetIdx) return;
    
    const building = state.allBuildings.find(b => b.id === cpModalBuildingId);
    if (!building || !building.contactPoints) return;
    
    // 배열에서 항목 이동
    const contacts = [...building.contactPoints];
    const [moved] = contacts.splice(cpDragSrcIdx, 1);
    contacts.splice(targetIdx, 0, moved);
    building.contactPoints = contacts;
    
    // Firebase 저장
    try {
        await update(ref(db, `buildings/${cpModalBuildingId}`), {
            contactPoints: building.contactPoints
        });
        showToast('담당자 순서가 변경되었습니다', 'success');
    } catch (error) {
        console.error('순서 변경 오류:', error);
    }
    
    cpDragSrcIdx = null;
    renderBuildingContacts();
    refreshCurrentPreview(building);
}

export function cpDragEnd(event) {
    event.currentTarget.classList.remove('cp-dragging');
    document.querySelectorAll('.cp-item').forEach(el => el.classList.remove('cp-drag-over'));
    cpDragSrcIdx = null;
}

// 담당자 추가 드롭다운 표시
export function showAddCpDropdown() {
    const dropdown = document.getElementById('cpAddDropdown');
    if (dropdown) dropdown.style.display = 'flex';
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
    window.loadUserBuildings = loadUserBuildings;
    window.updateBulkCount = updateBulkCount;
    window.applyBulkMapping = applyBulkMapping;
    window.removeBulkMapping = removeBulkMapping;
    // ★ 드래그앤드롭
    window.cpDragStart = cpDragStart;
    window.cpDragOver = cpDragOver;
    window.cpDragEnter = cpDragEnter;
    window.cpDragLeave = cpDragLeave;
    window.cpDrop = cpDrop;
    window.cpDragEnd = cpDragEnd;
}
