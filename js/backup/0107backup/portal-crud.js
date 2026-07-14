/**
 * CRE Portal - CRUD 모듈
 * 렌트롤, 메모, 공실, 기준가, 담당자, 빌딩 등 CRUD 기능
 */

import { state } from './portal-state.js';
import { db, ref, get, set, push, update, remove } from './portal-firebase.js';
import { showToast } from './portal-utils.js';
import { processBuildings, loadData } from './portal-data.js';
import { renderBuildingList, renderTableView } from './portal-ui.js';
import { 
    renderRentrollSection, 
    renderMemoSection, 
    renderPricingSection, 
    renderContactSection,
    renderInfoSection,
    closeDetail,
    openDetail
} from './portal-detail.js';

// ===== 모달 열기/닫기 =====

export function openModal(id) {
    document.getElementById(id).classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export function closeModal(id) {
    document.getElementById(id).classList.remove('show');
    document.getElementById('modalOverlay').classList.remove('show');
}

// ===== 렌트롤 CRUD =====

export function openRentrollModal(id = null) {
    document.getElementById('rentrollForm').reset();
    document.getElementById('rentrollId').value = id || '';
    document.getElementById('rentrollModalTitle').textContent = id ? '렌트롤 수정' : '렌트롤 추가';
    
    if (id) {
        const r = state.dataCache.rentrolls[id] || Object.values(state.dataCache.rentrolls).find(x => x.id === id);
        if (r) {
            document.getElementById('rentrollFloor').value = r.floor || '';
            document.getElementById('rentrollTenant').value = r.tenant?.name || r.tenant || '';
            document.getElementById('rentrollStart').value = r.contract?.startDate || '';
            document.getElementById('rentrollEnd').value = r.contract?.endDate || '';
            document.getElementById('rentrollNote').value = r.note || '';
        }
    }
    document.getElementById('rentrollModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export function editRentroll(id) {
    openRentrollModal(id);
}

export async function deleteRentroll(id) {
    if (!confirm('삭제하시겠습니까?')) return;
    try { 
        await remove(ref(db, `rentrolls/${id}`)); 
        delete state.dataCache.rentrolls[id]; 
        processBuildings(); 
        renderRentrollSection(); 
        showToast('삭제되었습니다', 'success'); 
    } catch (e) { 
        console.error(e);
        showToast('삭제 실패', 'error'); 
    }
}

export async function saveRentroll(formData) {
    const id = formData.id;
    const data = {
        buildingId: state.selectedBuilding.name,
        buildingName: state.selectedBuilding.name,
        floor: formData.floor,
        tenant: { name: formData.tenant },
        contract: { 
            startDate: formData.startDate, 
            endDate: formData.endDate, 
            period: formData.startDate && formData.endDate ? `${formData.startDate}~${formData.endDate}` : '' 
        },
        note: formData.note || '',
        author: state.currentUser?.email,
        createdAt: new Date().toISOString()
    };
    
    try {
        if (id) {
            await update(ref(db, `rentrolls/${id}`), data);
            state.dataCache.rentrolls[id] = { ...state.dataCache.rentrolls[id], ...data };
        } else {
            const nr = push(ref(db, 'rentrolls'));
            data.id = nr.key;
            await set(nr, data);
            state.dataCache.rentrolls[nr.key] = data;
        }
        closeModal('rentrollModal');
        processBuildings();
        renderRentrollSection();
        renderBuildingList();
        showToast('저장되었습니다', 'success');
    } catch (e) {
        showToast('저장 실패', 'error');
    }
}

// ===== 메모 CRUD =====

export function openMemoModal() {
    document.getElementById('memoForm').reset();
    document.getElementById('memoId').value = '';
    document.getElementById('memoModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export function editMemo(id) {
    const m = Object.values(state.dataCache.memos).find(x => x.id === id);
    if (!m) return;
    document.getElementById('memoId').value = id;
    document.getElementById('memoText').value = m.content || '';
    document.getElementById('memoPinned').checked = m.pinned || false;
    document.getElementById('memoShowInGuide').checked = m.showInLeasingGuide || false;
    document.getElementById('memoModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export async function deleteMemo(id) {
    if (!confirm('삭제하시겠습니까?')) return;
    try {
        await remove(ref(db, `memos/${id}`));
        delete state.dataCache.memos[id];
        processBuildings();
        renderMemoSection();
        showToast('삭제되었습니다', 'success');
    } catch (e) {
        showToast('삭제 실패', 'error');
    }
}

export async function saveMemo(formData) {
    const id = formData.id;
    const data = {
        buildingId: state.selectedBuilding.name,
        buildingName: state.selectedBuilding.name,
        content: formData.content,
        pinned: formData.pinned,
        showInLeasingGuide: formData.showInLeasingGuide || false,
        author: state.currentUser?.name || state.currentUser?.email?.split('@')[0],
        createdBy: state.currentUser?.email,
        createdAt: new Date().toISOString()
    };
    
    try {
        if (id) {
            await update(ref(db, `memos/${id}`), data);
            state.dataCache.memos[id] = { ...state.dataCache.memos[id], ...data };
        } else {
            const nr = push(ref(db, 'memos'));
            data.id = nr.key;
            await set(nr, data);
            state.dataCache.memos[nr.key] = data;
        }
        closeModal('memoModal');
        processBuildings();
        renderMemoSection();
        renderBuildingList();
        showToast('저장되었습니다', 'success');
    } catch (e) {
        showToast('저장 실패', 'error');
    }
}

// ===== 인센티브 =====

export function openIncentiveModal() {
    showToast('인센티브 추가 기능 준비중');
}

// ===== 공실 CRUD =====

export function editVacancy(buildingId, vacancyKey) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    const vacancy = building.vacancies.find(v => v._key === vacancyKey);
    if (!vacancy) {
        alert('공실 정보를 찾을 수 없습니다.');
        return;
    }
    
    state.editingVacancy = { buildingId, vacancyKey };
    
    // 모달에 값 채우기
    document.getElementById('editVacancySource').value = vacancy.source || '';
    document.getElementById('editVacancyPublishDate').value = vacancy.publishDate || '';
    document.getElementById('editVacancyFloor').value = vacancy.floor || '';
    document.getElementById('editVacancyRentArea').value = vacancy.rentArea || '';
    document.getElementById('editVacancyExclusiveArea').value = vacancy.exclusiveArea || '';
    document.getElementById('editVacancyDepositPy').value = vacancy.depositPy || '';
    document.getElementById('editVacancyRentPy').value = vacancy.rentPy || '';
    document.getElementById('editVacancyMaintenancePy').value = vacancy.maintenancePy || '';
    document.getElementById('editVacancyMoveInDate').value = vacancy.moveInDate || '';
    
    document.getElementById('vacancyEditModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export async function saveVacancyEdit() {
    const { buildingId, vacancyKey } = state.editingVacancy;
    if (!buildingId || !vacancyKey) return;
    
    try {
        const updatedData = {
            source: document.getElementById('editVacancySource').value,
            publishDate: document.getElementById('editVacancyPublishDate').value,
            floor: document.getElementById('editVacancyFloor').value,
            rentArea: document.getElementById('editVacancyRentArea').value,
            exclusiveArea: document.getElementById('editVacancyExclusiveArea').value,
            depositPy: document.getElementById('editVacancyDepositPy').value,
            rentPy: document.getElementById('editVacancyRentPy').value,
            maintenancePy: document.getElementById('editVacancyMaintenancePy').value,
            moveInDate: document.getElementById('editVacancyMoveInDate').value,
            updatedAt: new Date().toISOString()
        };
        
        await update(ref(db, `buildings/${buildingId}/vacancies/${vacancyKey}`), updatedData);
        
        // 로컬 데이터 업데이트
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building) {
            const vacancy = building.vacancies.find(v => v._key === vacancyKey);
            if (vacancy) {
                Object.assign(vacancy, updatedData);
            }
        }
        
        renderTableView();
        showToast('공실 정보가 수정되었습니다.', 'success');
        closeVacancyModal();
        
    } catch (error) {
        console.error('공실 수정 오류:', error);
        showToast('수정 중 오류가 발생했습니다.', 'error');
    }
}

export async function deleteVacancy(buildingId, vacancyKey) {
    if (!confirm('이 공실 정보를 삭제하시겠습니까?')) return;
    
    try {
        await remove(ref(db, `buildings/${buildingId}/vacancies/${vacancyKey}`));
        
        // 로컬 데이터에서 제거
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building && building.vacancies) {
            building.vacancies = building.vacancies.filter(v => v._key !== vacancyKey);
            building.vacancyCount = building.vacancies.length;
        }
        
        processBuildings();
        renderTableView();
        showToast('공실 정보가 삭제되었습니다.', 'success');
        
    } catch (error) {
        console.error('공실 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다.', 'error');
    }
}

export function closeVacancyModal() {
    document.getElementById('vacancyEditModal').classList.remove('show');
    document.getElementById('modalOverlay').classList.remove('show');
    state.editingVacancy = { buildingId: null, vacancyKey: null };
}

// ===== 기준가 CRUD =====

export function openPricingModal(id = null) {
    const form = document.getElementById('pricingForm');
    form.reset();
    document.getElementById('pricingId').value = id || '';
    document.getElementById('pricingModalTitle').textContent = id ? '기준가 수정' : '기준가 추가';
    
    if (id && state.selectedBuilding) {
        const fp = state.selectedBuilding.floorPricing?.find(p => p.id === id);
        if (fp) {
            document.getElementById('pricingLabel').value = fp.label || '';
            document.getElementById('pricingFloorRange').value = fp.floorRange || '';
            document.getElementById('pricingDepositPy').value = fp.depositPy || '';
            document.getElementById('pricingRentPy').value = fp.rentPy || '';
            document.getElementById('pricingMaintenancePy').value = fp.maintenancePy || '';
            document.getElementById('pricingRentArea').value = fp.rentArea || '';
            document.getElementById('pricingExclusiveArea').value = fp.exclusiveArea || '';
            document.getElementById('pricingEffectiveDate').value = fp.effectiveDate || '';
            document.getElementById('pricingNotes').value = fp.notes || '';
        }
    }
    
    document.getElementById('pricingModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export function editPricing(id) {
    openPricingModal(id);
}

export async function deletePricing(id) {
    if (!confirm('이 기준가를 삭제하시겠습니까?')) return;
    if (!state.selectedBuilding) return;
    
    try {
        await remove(ref(db, `buildings/${state.selectedBuilding.id}/floorPricing/${id}`));
        
        // 로컬 데이터에서 제거
        if (state.selectedBuilding.floorPricing) {
            state.selectedBuilding.floorPricing = state.selectedBuilding.floorPricing.filter(p => p.id !== id);
        }
        
        renderPricingSection();
        renderInfoSection();
        showToast('기준가가 삭제되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('삭제 실패', 'error');
    }
}

export async function savePricing(formData) {
    if (!state.selectedBuilding) return;
    
    const id = formData.id;
    const data = {
        label: formData.label,
        floorRange: formData.floorRange,
        depositPy: formData.depositPy,
        rentPy: formData.rentPy,
        maintenancePy: formData.maintenancePy,
        rentArea: formData.rentArea,
        exclusiveArea: formData.exclusiveArea,
        effectiveDate: formData.effectiveDate,
        notes: formData.notes,
        updatedAt: new Date().toISOString(),
        updatedBy: state.currentUser?.email
    };
    
    try {
        if (id) {
            await update(ref(db, `buildings/${state.selectedBuilding.id}/floorPricing/${id}`), data);
            const idx = state.selectedBuilding.floorPricing?.findIndex(p => p.id === id);
            if (idx >= 0) state.selectedBuilding.floorPricing[idx] = { ...state.selectedBuilding.floorPricing[idx], ...data };
        } else {
            const newRef = push(ref(db, `buildings/${state.selectedBuilding.id}/floorPricing`));
            data.id = newRef.key;
            data.createdAt = new Date().toISOString();
            data.createdBy = state.currentUser?.email;
            await set(newRef, data);
            if (!state.selectedBuilding.floorPricing) state.selectedBuilding.floorPricing = [];
            state.selectedBuilding.floorPricing.push(data);
        }
        
        closeModal('pricingModal');
        renderPricingSection();
        renderInfoSection();
        showToast('기준가가 저장되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('저장 실패', 'error');
    }
}

// ===== 담당자 CRUD =====

export function openContactModal(id = null) {
    const form = document.getElementById('contactForm');
    form.reset();
    document.getElementById('contactId').value = id || '';
    document.getElementById('contactModalTitle').textContent = id ? '담당자 수정' : '담당자 추가';
    
    // 우리 담당자 체크박스 표시
    document.getElementById('contactIsOurManager').checked = false;
    
    if (id && state.selectedBuilding) {
        const c = state.selectedBuilding.contactPoints?.find(p => p.id === id);
        if (c) {
            document.getElementById('contactName').value = c.name || '';
            document.getElementById('contactType').value = c.type || 'other';
            document.getElementById('contactPhone').value = c.phone || '';
            document.getElementById('contactEmail').value = c.email || '';
            document.getElementById('contactCompany').value = c.company || '';
            document.getElementById('contactPosition').value = c.position || '';
            document.getElementById('contactIsPrimary').checked = c.isPrimary || false;
            document.getElementById('contactIsOurManager').checked = c.isOurManager || c.type === 'sni';
            document.getElementById('contactNotes').value = c.notes || '';
        }
    }
    
    document.getElementById('contactModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export function editContact(id) {
    openContactModal(id);
}

export async function deleteContact(id) {
    if (!confirm('이 담당자를 삭제하시겠습니까?')) return;
    if (!state.selectedBuilding) return;
    
    try {
        await remove(ref(db, `buildings/${state.selectedBuilding.id}/contactPoints/${id}`));
        
        if (state.selectedBuilding.contactPoints) {
            state.selectedBuilding.contactPoints = state.selectedBuilding.contactPoints.filter(c => c.id !== id);
        }
        
        renderContactSection();
        showToast('담당자가 삭제되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('삭제 실패', 'error');
    }
}

export async function saveContact(formData) {
    if (!state.selectedBuilding) return;
    
    const id = formData.id;
    const isOurManager = formData.isOurManager;
    const data = {
        name: formData.name,
        type: isOurManager ? 'sni' : formData.type,
        phone: formData.phone,
        email: formData.email,
        company: formData.company,
        position: formData.position,
        isPrimary: formData.isPrimary,
        isOurManager: isOurManager,
        notes: formData.notes,
        updatedAt: new Date().toISOString(),
        updatedBy: state.currentUser?.email
    };
    
    try {
        if (id) {
            await update(ref(db, `buildings/${state.selectedBuilding.id}/contactPoints/${id}`), data);
            const idx = state.selectedBuilding.contactPoints?.findIndex(c => c.id === id);
            if (idx >= 0) state.selectedBuilding.contactPoints[idx] = { ...state.selectedBuilding.contactPoints[idx], ...data };
        } else {
            const newRef = push(ref(db, `buildings/${state.selectedBuilding.id}/contactPoints`));
            data.id = newRef.key;
            data.createdAt = new Date().toISOString();
            data.createdBy = state.currentUser?.email;
            await set(newRef, data);
            if (!state.selectedBuilding.contactPoints) state.selectedBuilding.contactPoints = [];
            state.selectedBuilding.contactPoints.push(data);
        }
        
        closeModal('contactModal');
        renderContactSection();
        showToast('담당자가 저장되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('저장 실패', 'error');
    }
}

// ===== 빌딩 삭제/복원 =====

export function isAdmin() {
    const adminEmails = ['admin@snimgt.com', 'system@snimgt.com'];
    return adminEmails.includes(state.currentUser?.email);
}

export function canDeleteBuilding() {
    return isAdmin();
}

export function handleBuildingDelete() {
    if (!state.selectedBuilding) return;
    
    const isAdminUser = isAdmin() || canDeleteBuilding();
    const actionType = isAdminUser ? 'delete' : 'hide';
    
    const title = document.querySelector('#deleteConfirmModal .modal-title');
    const message = document.getElementById('deleteConfirmMessage');
    const details = document.getElementById('deleteConfirmDetails');
    const btn = document.getElementById('deleteConfirmBtn');
    
    if (actionType === 'delete') {
        title.textContent = '⚠️ 빌딩 완전 삭제';
        title.style.color = '#dc2626';
        message.innerHTML = `<strong>${state.selectedBuilding.name}</strong> 빌딩을 완전히 삭제하시겠습니까?<br><br>이 작업은 되돌릴 수 없습니다.`;
        details.innerHTML = `
            <strong>삭제될 데이터:</strong><br>
            • 빌딩 기본 정보<br>
            • 공실 정보 ${(state.selectedBuilding.vacancies || []).length}건<br>
            • 렌트롤 ${state.selectedBuilding.rentrollCount || 0}건<br>
            • 메모 ${state.selectedBuilding.memoCount || 0}건
        `;
        btn.textContent = '완전 삭제';
        btn.style.background = '#dc2626';
        btn.dataset.action = 'delete';
    } else {
        title.textContent = '🚫 빌딩 숨김 처리';
        title.style.color = '#f59e0b';
        message.innerHTML = `<strong>${state.selectedBuilding.name}</strong> 빌딩을 숨김 처리하시겠습니까?`;
        details.innerHTML = `<strong>📌 숨김 처리 안내:</strong><br>• 데이터는 삭제되지 않습니다`;
        btn.textContent = '숨김 처리';
        btn.style.background = '#f59e0b';
        btn.dataset.action = 'hide';
    }
    
    openModal('deleteConfirmModal');
}

export async function confirmBuildingDelete() {
    if (!state.selectedBuilding) return;
    
    const btn = document.getElementById('deleteConfirmBtn');
    const action = btn.dataset.action;
    
    try {
        if (action === 'delete') {
            await remove(ref(db, `buildings/${state.selectedBuilding.id}`));
            showToast('빌딩이 삭제되었습니다', 'success');
        } else {
            await update(ref(db, `buildings/${state.selectedBuilding.id}`), {
                status: 'hidden',
                hiddenBy: state.currentUser?.email,
                hiddenAt: new Date().toISOString()
            });
            showToast('빌딩이 숨김 처리되었습니다', 'info');
        }
        
        closeModal('deleteConfirmModal');
        closeDetail();
        await loadData();
        
    } catch (err) {
        console.error(err);
        showToast('처리 중 오류가 발생했습니다', 'error');
    }
}

export async function handleBuildingRestore() {
    if (!state.selectedBuilding || !isAdmin()) return;
    
    if (!confirm(`"${state.selectedBuilding.name}" 빌딩을 복원하시겠습니까?`)) return;
    
    try {
        await update(ref(db, `buildings/${state.selectedBuilding.id}`), {
            status: 'active',
            restoredBy: state.currentUser?.email,
            restoredAt: new Date().toISOString()
        });
        
        showToast('빌딩이 복원되었습니다', 'success');
        await loadData();
        openDetail(state.selectedBuilding.id);
        
    } catch (err) {
        console.error(err);
        showToast('복원 중 오류가 발생했습니다', 'error');
    }
}

// ===== 빌딩 노트 =====

export function openBuildingNoteModal() {
    if (!state.selectedBuilding) return;
    document.getElementById('buildingNoteText').value = state.selectedBuilding.notes || '';
    document.getElementById('buildingNoteModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export async function saveBuildingNote(noteText) {
    if (!state.selectedBuilding) return;
    
    try {
        await update(ref(db, `buildings/${state.selectedBuilding.id}`), {
            notes: noteText,
            notesUpdatedAt: new Date().toISOString(),
            notesUpdatedBy: state.currentUser?.email
        });
        
        state.selectedBuilding.notes = noteText;
        closeModal('buildingNoteModal');
        renderInfoSection();
        showToast('빌딩 노트가 저장되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('저장 실패', 'error');
    }
}

// ===== 권역 저장 =====

export async function saveAutoDetectedRegion(region) {
    if (!state.selectedBuilding) return;
    
    try {
        await update(ref(db, `buildings/${state.selectedBuilding.id}`), {
            region: region,
            regionSavedAt: new Date().toISOString()
        });
        
        state.selectedBuilding._raw = state.selectedBuilding._raw || {};
        state.selectedBuilding._raw.region = region;
        
        renderInfoSection();
        showToast('권역이 저장되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('저장 실패', 'error');
    }
}

// ===== 담당자 지정 =====

export function openAssignManagerModal() {
    if (!state.selectedBuilding) return;
    
    const contacts = state.selectedBuilding.contactPoints || [];
    const managerSelect = document.getElementById('assignManagerSelect');
    managerSelect.innerHTML = '<option value="">-- 담당자 선택 --</option>';
    
    const ourManagers = contacts.filter(c => c.isOurManager || c.type === 'sni');
    const otherContacts = contacts.filter(c => !c.isOurManager && c.type !== 'sni');
    
    if (ourManagers.length > 0) {
        const group1 = document.createElement('optgroup');
        group1.label = '🏷️ 우리 담당자 (S&I)';
        ourManagers.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${c.name} (${c.phone})`;
            group1.appendChild(opt);
        });
        managerSelect.appendChild(group1);
    }
    
    if (otherContacts.length > 0) {
        const group2 = document.createElement('optgroup');
        group2.label = '👤 기타 담당자';
        otherContacts.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = `${c.name} (${c.phone})`;
            group2.appendChild(opt);
        });
        managerSelect.appendChild(group2);
    }
    
    // 현재 지정된 담당자 선택
    const assigned = state.selectedBuilding.assignedManager || state.selectedBuilding._raw?.assignedManager;
    if (assigned?.contactId) {
        managerSelect.value = assigned.contactId;
    }
    
    document.getElementById('assignManagerModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export async function saveAssignedManager() {
    if (!state.selectedBuilding) return;
    
    const contactId = document.getElementById('assignManagerSelect').value;
    
    try {
        if (contactId) {
            const contact = state.selectedBuilding.contactPoints?.find(c => c.id === contactId);
            await update(ref(db, `buildings/${state.selectedBuilding.id}`), {
                assignedManager: {
                    contactId: contactId,
                    name: contact?.name,
                    phone: contact?.phone,
                    assignedAt: new Date().toISOString(),
                    assignedBy: state.currentUser?.email
                }
            });
            state.selectedBuilding.assignedManager = { contactId, name: contact?.name, phone: contact?.phone, assignedAt: new Date().toISOString() };
            showToast('담당자가 지정되었습니다', 'success');
        } else {
            await update(ref(db, `buildings/${state.selectedBuilding.id}`), { assignedManager: null });
            state.selectedBuilding.assignedManager = null;
            showToast('담당자 지정이 해제되었습니다', 'info');
        }
        
        closeModal('assignManagerModal');
        renderContactSection();
    } catch (e) {
        console.error(e);
        showToast('저장 실패', 'error');
    }
}

// ===== 전역 함수 등록 =====

export function registerCrudGlobals() {
    // 모달
    window.openModal = openModal;
    window.closeModal = closeModal;
    
    // 렌트롤
    window.openRentrollModal = openRentrollModal;
    window.editRentroll = editRentroll;
    window.deleteRentroll = deleteRentroll;
    
    // 메모
    window.openMemoModal = openMemoModal;
    window.editMemo = editMemo;
    window.deleteMemo = deleteMemo;
    
    // 인센티브
    window.openIncentiveModal = openIncentiveModal;
    
    // 공실
    window.editVacancy = editVacancy;
    window.saveVacancyEdit = saveVacancyEdit;
    window.deleteVacancy = deleteVacancy;
    window.closeVacancyModal = closeVacancyModal;
    
    // 기준가
    window.openPricingModal = openPricingModal;
    window.editPricing = editPricing;
    window.deletePricing = deletePricing;
    
    // 담당자
    window.openContactModal = openContactModal;
    window.editContact = editContact;
    window.deleteContact = deleteContact;
    
    // 빌딩 삭제/복원
    window.handleBuildingDelete = handleBuildingDelete;
    window.confirmBuildingDelete = confirmBuildingDelete;
    window.handleBuildingRestore = handleBuildingRestore;
    
    // 빌딩 노트
    window.openBuildingNoteModal = openBuildingNoteModal;
    
    // 권역 저장
    window.saveAutoDetectedRegion = saveAutoDetectedRegion;
    
    // 담당자 지정
    window.openAssignManagerModal = openAssignManagerModal;
    window.saveAssignedManager = saveAssignedManager;
    
    // 권한
    window.isAdmin = isAdmin;
    window.canDeleteBuilding = canDeleteBuilding;
    
    // Form 이벤트 리스너 설정
    setupFormListeners();
}

// ===== Form Submit 이벤트 리스너 =====

function setupFormListeners() {
    // 렌트롤 폼
    const rentrollForm = document.getElementById('rentrollForm');
    if (rentrollForm) {
        rentrollForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('rentrollId').value;
            const startDate = document.getElementById('rentrollStart').value;
            const endDate = document.getElementById('rentrollEnd').value;
            const data = {
                buildingId: state.selectedBuilding.name,
                buildingName: state.selectedBuilding.name,
                floor: document.getElementById('rentrollFloor').value,
                tenant: { name: document.getElementById('rentrollTenant').value },
                contract: { startDate, endDate, period: startDate && endDate ? `${startDate}~${endDate}` : '' },
                note: document.getElementById('rentrollNote').value || '',
                author: state.currentUser.email,
                createdAt: new Date().toISOString()
            };
            try {
                if (id) {
                    await update(ref(db, `rentrolls/${id}`), data);
                    state.dataCache.rentrolls[id] = { ...state.dataCache.rentrolls[id], ...data };
                } else {
                    const nr = push(ref(db, 'rentrolls'));
                    data.id = nr.key;
                    await set(nr, data);
                    state.dataCache.rentrolls[nr.key] = data;
                }
                closeModal('rentrollModal');
                processBuildings();
                renderRentrollSection();
                renderBuildingList();
                showToast('저장되었습니다', 'success');
            } catch (e) {
                showToast('저장 실패', 'error');
            }
        });
    }
    
    // 메모 폼
    const memoForm = document.getElementById('memoForm');
    if (memoForm) {
        memoForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const id = document.getElementById('memoId').value;
            const data = {
                buildingId: state.selectedBuilding.name,
                buildingName: state.selectedBuilding.name,
                content: document.getElementById('memoText').value,
                pinned: document.getElementById('memoPinned').checked,
                showInLeasingGuide: document.getElementById('memoShowInGuide')?.checked || false,
                author: state.currentUser.name || state.currentUser.email.split('@')[0],
                createdBy: state.currentUser.email,
                createdAt: new Date().toISOString()
            };
            try {
                if (id) {
                    await update(ref(db, `memos/${id}`), data);
                    state.dataCache.memos[id] = { ...state.dataCache.memos[id], ...data };
                } else {
                    const nr = push(ref(db, 'memos'));
                    data.id = nr.key;
                    await set(nr, data);
                    state.dataCache.memos[nr.key] = data;
                }
                closeModal('memoModal');
                processBuildings();
                renderMemoSection();
                renderBuildingList();
                showToast('저장되었습니다', 'success');
            } catch (e) {
                showToast('저장 실패', 'error');
            }
        });
    }
    
    // 기준가 폼
    const pricingForm = document.getElementById('pricingForm');
    if (pricingForm) {
        pricingForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.selectedBuilding) return;
            
            const id = document.getElementById('pricingId').value || 'fp_' + Date.now();
            const floorStart = document.getElementById('pricingFloorStart').value.trim();
            const floorEnd = document.getElementById('pricingFloorEnd').value.trim();
            
            const newPricing = {
                id,
                label: document.getElementById('pricingLabel').value.trim(),
                floorRange: `${floorStart}-${floorEnd}`,
                floorStart: floorStart.toUpperCase().replace('B', '-').replace('F', ''),
                floorEnd: floorEnd.toUpperCase().replace('B', '-').replace('F', ''),
                rentArea: parseFloat(document.getElementById('pricingRentArea').value) || null,
                exclusiveArea: parseFloat(document.getElementById('pricingExclusiveArea').value) || null,
                depositPy: parseFloat(document.getElementById('pricingDeposit').value) || null,
                rentPy: parseFloat(document.getElementById('pricingRent').value) || null,
                maintenancePy: parseFloat(document.getElementById('pricingMaintenance').value) || null,
                effectiveDate: document.getElementById('pricingEffectiveDate').value || null,
                notes: document.getElementById('pricingNotes').value.trim() || null,
                updatedAt: new Date().toISOString(),
                updatedBy: state.currentUser?.email || 'unknown'
            };
            
            try {
                let floorPricing = state.selectedBuilding.floorPricing || [];
                const existingIdx = floorPricing.findIndex(p => p.id === id);
                if (existingIdx >= 0) {
                    floorPricing[existingIdx] = { ...floorPricing[existingIdx], ...newPricing };
                } else {
                    newPricing.createdAt = new Date().toISOString();
                    floorPricing.push(newPricing);
                }
                
                await update(ref(db, `buildings/${state.selectedBuilding.id}`), { floorPricing });
                state.selectedBuilding.floorPricing = floorPricing;
                closeModal('pricingModal');
                renderPricingSection();
                renderInfoSection();
                showToast('저장되었습니다', 'success');
            } catch (err) {
                console.error(err);
                showToast('저장 중 오류가 발생했습니다', 'error');
            }
        });
    }
    
    // 담당자 폼
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.selectedBuilding) return;
            
            const existingId = document.getElementById('contactId').value;
            const isOurManager = document.getElementById('contactIsOurManager')?.checked || false;
            const isPrimary = document.getElementById('contactPrimary').checked;
            const notes = document.getElementById('contactNotes').value.trim() || null;
            
            try {
                let contactPoints = state.selectedBuilding.contactPoints || [];
                
                // 일반 담당자
                const contactId = existingId || 'cp_' + Date.now();
                const contactType = document.getElementById('contactType').value;
                
                const newContact = {
                    id: contactId,
                    name: document.getElementById('contactName').value.trim(),
                    phone: document.getElementById('contactPhone').value.trim(),
                    email: document.getElementById('contactEmail').value.trim() || null,
                    company: document.getElementById('contactCompany').value.trim() || null,
                    type: contactType,
                    isPrimary,
                    isOurManager: false,
                    notes,
                    updatedAt: new Date().toISOString()
                };
                
                // 주 담당자 설정 시 기존 주 담당자 해제
                if (newContact.isPrimary) {
                    contactPoints = contactPoints.map(c => ({ ...c, isPrimary: false }));
                }
                
                const existingIdx = contactPoints.findIndex(c => c.id === contactId);
                if (existingIdx >= 0) {
                    contactPoints[existingIdx] = { ...contactPoints[existingIdx], ...newContact };
                } else {
                    newContact.createdAt = new Date().toISOString();
                    contactPoints.push(newContact);
                }
                
                await update(ref(db, `buildings/${state.selectedBuilding.id}`), { contactPoints });
                state.selectedBuilding.contactPoints = contactPoints;
                closeModal('contactModal');
                renderContactSection();
                showToast('저장되었습니다', 'success');
            } catch (err) {
                console.error(err);
                showToast('저장 중 오류가 발생했습니다', 'error');
            }
        });
    }
    
    // 빌딩 노트 폼
    const buildingNoteForm = document.getElementById('buildingNoteForm');
    if (buildingNoteForm) {
        buildingNoteForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.selectedBuilding) return;
            
            const notes = document.getElementById('buildingNoteText').value.trim();
            try {
                await update(ref(db, `buildings/${state.selectedBuilding.id}`), { notes });
                state.selectedBuilding.notes = notes;
                closeModal('buildingNoteModal');
                renderInfoSection();
                showToast('저장되었습니다', 'success');
            } catch (err) {
                console.error(err);
                showToast('저장 실패', 'error');
            }
        });
    }
    
    // 빌딩 편집 폼
    const buildingEditForm = document.getElementById('buildingEditForm');
    if (buildingEditForm) {
        buildingEditForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!state.selectedBuilding) return;
            
            try {
                const updates = {
                    depositPy: document.getElementById('editDepositPy').value,
                    rentPy: document.getElementById('editRentPy').value,
                    maintenancePy: document.getElementById('editMaintenancePy').value,
                    exclusiveRate: parseFloat(document.getElementById('editExclusiveRate').value) || null,
                    typicalFloorPy: parseFloat(document.getElementById('editTypicalFloorPy').value) || null,
                    typicalFloorLeasePy: parseFloat(document.getElementById('editTypicalFloorLeasePy').value) || null,
                    grade: document.getElementById('editGrade').value,
                    pm: document.getElementById('editPm').value,
                    owner: document.getElementById('editOwner').value,
                    nearbyStation: document.getElementById('editNearbyStation').value,
                    description: document.getElementById('editDescription').value,
                    updatedAt: new Date().toISOString(),
                    updatedBy: state.currentUser?.email
                };
                
                await update(ref(db, `buildings/${state.selectedBuilding.id}`), updates);
                Object.assign(state.selectedBuilding, updates);
                
                closeModal('buildingEditModal');
                renderInfoSection();
                showToast('빌딩 정보가 저장되었습니다', 'success');
            } catch (err) {
                console.error(err);
                showToast('저장 실패', 'error');
            }
        });
    }
}
