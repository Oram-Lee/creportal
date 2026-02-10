/**
 * CRE Portal - CRUD 모듈
 * 렌트롤, 메모, 공실, 기준가, 담당자, 빌딩 등 CRUD 기능
 */

import { state } from './portal-state.js';
import { db, ref, get, set, push, update, remove, storage, storageRef, getDownloadURL } from './portal-firebase.js';
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

// ============================================================
// ★ v4.0: CRUD 후 UI 갱신 헬퍼
// processBuildings() 호출 후 selectedBuilding 재연결 + 목록 갱신
// ============================================================

/**
 * CRUD 작업 후 전체 UI를 갱신하는 통합 헬퍼
 * @param {Function|Function[]} renderFns - 추가로 호출할 렌더 함수(들)
 */
function refreshAfterCrud(renderFns) {
    // 1. allBuildings 재구축 (processBuildings 내부에서 selectedBuilding도 자동 재연결됨)
    processBuildings();
    
    // 2. 빌딩 목록 갱신
    renderBuildingList();
    if (state.currentViewMode === 'list') {
        renderTableView();
    }
    
    // 3. 지도 마커 갱신
    if (state.kakaoMap && state.clusterer && window.updateMapMarkers) {
        window.updateMapMarkers();
    }
    
    // 4. 추가 렌더 함수 실행
    if (renderFns) {
        const fns = Array.isArray(renderFns) ? renderFns : [renderFns];
        fns.forEach(fn => { if (typeof fn === 'function') fn(); });
    }
}

/**
 * buildings 문서를 직접 수정한 경우, dataCache도 동기화
 * (processBuildings는 dataCache에서 빌딩 정보를 읽으므로 반드시 필요)
 * @param {string} buildingId 
 * @param {Object} updates - 변경된 필드들
 */
function syncBuildingCache(buildingId, updates) {
    if (state.dataCache.buildings[buildingId]) {
        Object.assign(state.dataCache.buildings[buildingId], updates);
    }
}

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
        refreshAfterCrud(renderRentrollSection); 
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
        refreshAfterCrud(renderRentrollSection);
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
        refreshAfterCrud(renderMemoSection);
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
        refreshAfterCrud(renderMemoSection);
        showToast('저장되었습니다', 'success');
    } catch (e) {
        showToast('저장 실패', 'error');
    }
}

// ===== 인센티브 =====

export function openIncentiveModal(id = null) {
    if (!state.selectedBuilding) {
        showToast('빌딩을 먼저 선택해주세요', 'error');
        return;
    }
    
    const modal = document.getElementById('incentiveModal');
    const title = document.getElementById('incentiveModalTitle');
    const form = document.getElementById('incentiveForm');
    
    if (!modal || !form) {
        showToast('인센티브 모달을 찾을 수 없습니다', 'error');
        return;
    }
    
    // 폼 초기화
    form.reset();
    document.getElementById('incentiveId').value = '';
    
    if (id) {
        // 수정 모드
        title.textContent = '🎁 인센티브 수정';
        const incentives = state.selectedBuilding.incentives || [];
        const incentive = incentives.find(i => i.id === id);
        
        if (incentive) {
            document.getElementById('incentiveId').value = id;
            document.getElementById('incentiveRentFree').value = incentive.rf || incentive.rentFree || '';
            document.getElementById('incentiveFitOut').value = incentive.fo || incentive.fitOut || '';
            document.getElementById('incentiveTI').value = incentive.ti || '';
            document.getElementById('incentiveCondition').value = incentive.condition || '';
            document.getElementById('incentiveStartDate').value = incentive.startDate || '';
            document.getElementById('incentiveEndDate').value = incentive.endDate || '';
            document.getElementById('incentiveNote').value = incentive.note || '';
        }
    } else {
        // 추가 모드
        title.textContent = '🎁 인센티브 추가';
        
        // 기본값으로 오늘 날짜 설정
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('incentiveStartDate').value = today;
    }
    
    openModal('incentiveModal');
}

export async function saveIncentive(formData) {
    if (!state.selectedBuilding) {
        showToast('빌딩을 선택해주세요', 'error');
        return;
    }
    
    const buildingId = state.selectedBuilding.id;
    const id = formData.id || 'inc_' + Date.now();
    
    const incentiveData = {
        id: id,
        rf: parseFloat(formData.rentFree) || 0,
        rentFree: parseFloat(formData.rentFree) || 0,
        fo: parseFloat(formData.fitOut) || 0,
        fitOut: parseFloat(formData.fitOut) || 0,
        ti: parseFloat(formData.ti) || 0,
        condition: formData.condition || '',
        startDate: formData.startDate || '',
        endDate: formData.endDate || '',
        note: formData.note || '',
        author: state.currentUser?.name || state.currentUser?.email?.split('@')[0] || 'unknown',
        createdBy: state.currentUser?.email || 'unknown',
        createdAt: formData.id ? undefined : new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    
    // createdAt이 undefined면 제거 (수정 시)
    if (!incentiveData.createdAt) {
        delete incentiveData.createdAt;
    }
    
    try {
        let incentives = state.selectedBuilding.incentives || [];
        
        if (formData.id) {
            // 수정
            const idx = incentives.findIndex(i => i.id === formData.id);
            if (idx >= 0) {
                incentiveData.createdAt = incentives[idx].createdAt;
                incentives[idx] = incentiveData;
            }
        } else {
            // 추가
            incentives.push(incentiveData);
        }
        
        // Firebase 업데이트
        await update(ref(db, `buildings/${buildingId}`), { incentives });
        
        // 로컬 상태 업데이트
        state.selectedBuilding.incentives = incentives;
        syncBuildingCache(buildingId, { incentives });
        
        closeModal('incentiveModal');
        refreshAfterCrud(() => window.renderIncentiveSection?.());
        showToast('인센티브가 저장되었습니다', 'success');
        
    } catch (error) {
        console.error('인센티브 저장 오류:', error);
        showToast('저장 중 오류가 발생했습니다', 'error');
    }
}

export async function deleteIncentive(id) {
    if (!state.selectedBuilding) return;
    
    if (!confirm('이 인센티브를 삭제하시겠습니까?')) return;
    
    try {
        const buildingId = state.selectedBuilding.id;
        let incentives = state.selectedBuilding.incentives || [];
        
        incentives = incentives.filter(i => i.id !== id);
        
        await update(ref(db, `buildings/${buildingId}`), { incentives });
        
        state.selectedBuilding.incentives = incentives;
        syncBuildingCache(buildingId, { incentives });
        
        refreshAfterCrud(() => window.renderIncentiveSection?.());
        showToast('삭제되었습니다', 'success');
        
    } catch (error) {
        console.error('인센티브 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
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
        
        // ★ 마이그레이션: vacancies 독립 컬렉션으로 변경됨
        await update(ref(db, `vacancies/${buildingId}/${vacancyKey}`), updatedData);
        
        // 로컬 데이터 업데이트
        if (state.dataCache.vacancies?.[buildingId]?.[vacancyKey]) {
            Object.assign(state.dataCache.vacancies[buildingId][vacancyKey], updatedData);
        }
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building) {
            const vacancy = building.vacancies.find(v => v._key === vacancyKey);
            if (vacancy) {
                Object.assign(vacancy, updatedData);
            }
        }
        
        refreshAfterCrud();
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
        // ★ 마이그레이션: vacancies 독립 컬렉션으로 변경됨
        await remove(ref(db, `vacancies/${buildingId}/${vacancyKey}`));
        
        // 로컬 데이터에서 제거
        if (state.dataCache.vacancies?.[buildingId]) {
            delete state.dataCache.vacancies[buildingId][vacancyKey];
        }
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building && building.vacancies) {
            building.vacancies = building.vacancies.filter(v => v._key !== vacancyKey);
            building.vacancyCount = building.vacancies.length;
        }
        
        refreshAfterCrud();
        showToast('공실 정보가 삭제되었습니다.', 'success');
        
    } catch (error) {
        console.error('공실 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다.', 'error');
    }
}

// ★ 이슈3: 공실 이관 (다른 빌딩으로 옮기기)
export function openTransferVacancyModal(buildingId, vacancyKey, vacancyData) {
    state.transferVacancy = { buildingId, vacancyKey, vacancyData };
    
    // 검색 결과 초기화
    document.getElementById('transferBuildingSearch').value = '';
    document.getElementById('transferBuildingResults').innerHTML = `
        <div style="padding: 20px; text-align: center; color: #666;">
            빌딩명 또는 주소로 검색하세요
        </div>
    `;
    document.getElementById('transferBtn').disabled = true;
    state.transferTargetBuilding = null;
    
    // 현재 공실 정보 표시
    document.getElementById('transferVacancyInfo').innerHTML = `
        <div style="padding: 12px; background: #f1f5f9; border-radius: 8px; font-size: 13px;">
            <div><strong>현재 빌딩:</strong> ${state.selectedBuilding?.name || buildingId}</div>
            <div><strong>층:</strong> ${vacancyData.floor || '-'}</div>
            <div><strong>출처:</strong> ${vacancyData.source || '-'} (${vacancyData.publishDate || '-'})</div>
        </div>
    `;
    
    document.getElementById('vacancyTransferModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

// ★ 이슈3: 빌딩 검색 (이관 대상)
export function searchTransferBuilding() {
    const query = document.getElementById('transferBuildingSearch').value.trim().toLowerCase();
    
    if (query.length < 2) {
        document.getElementById('transferBuildingResults').innerHTML = `
            <div style="padding: 20px; text-align: center; color: #666;">
                2글자 이상 입력하세요
            </div>
        `;
        return;
    }
    
    // 현재 빌딩 제외하고 검색
    const currentBuildingId = state.transferVacancy?.buildingId;
    const results = state.allBuildings.filter(b => 
        b.id !== currentBuildingId && 
        (b.name?.toLowerCase().includes(query) || b.address?.toLowerCase().includes(query))
    ).slice(0, 10);
    
    if (results.length === 0) {
        document.getElementById('transferBuildingResults').innerHTML = `
            <div style="padding: 20px; text-align: center; color: #666;">
                검색 결과가 없습니다
            </div>
        `;
        return;
    }
    
    document.getElementById('transferBuildingResults').innerHTML = results.map(b => `
        <div class="transfer-building-item" 
             onclick="selectTransferBuilding('${b.id}')"
             data-building-id="${b.id}"
             style="padding: 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.2s;">
            <div style="font-weight: 500; color: var(--text-primary);">${b.name}</div>
            <div style="font-size: 12px; color: #666; margin-top: 4px;">${b.address || '-'}</div>
            <div style="font-size: 11px; color: #999; margin-top: 2px;">현재 공실 ${b.vacancyCount || 0}건</div>
        </div>
    `).join('');
    
    // 호버 효과
    document.querySelectorAll('.transfer-building-item').forEach(el => {
        el.onmouseenter = () => el.style.background = '#f1f5f9';
        el.onmouseleave = () => el.style.background = state.transferTargetBuilding?.id === el.dataset.buildingId ? '#dbeafe' : '';
    });
}

// ★ 이슈3: 이관 대상 빌딩 선택
window.selectTransferBuilding = function(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    state.transferTargetBuilding = building;
    
    // 선택 표시
    document.querySelectorAll('.transfer-building-item').forEach(el => {
        el.style.background = el.dataset.buildingId === buildingId ? '#dbeafe' : '';
    });
    
    document.getElementById('transferBtn').disabled = false;
};

// ★ 이슈3: 공실 이관 실행
export async function executeTransferVacancy() {
    const { buildingId: fromBuildingId, vacancyKey, vacancyData } = state.transferVacancy || {};
    const targetBuilding = state.transferTargetBuilding;
    
    if (!fromBuildingId || !vacancyKey || !targetBuilding) {
        showToast('이관 정보가 올바르지 않습니다', 'error');
        return;
    }
    
    if (!confirm(`공실 정보를 "${targetBuilding.name}"으로 이관하시겠습니까?\n\n원본 데이터는 삭제됩니다.`)) {
        return;
    }
    
    try {
        // 1. 새 빌딩에 공실 추가
        const newVacancyData = {
            ...vacancyData,
            buildingName: targetBuilding.name,
            transferredFrom: fromBuildingId,
            transferredAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        delete newVacancyData._key;
        delete newVacancyData._vacancyId;
        
        // 새 vacancyKey 생성
        const newVacancyKey = `${vacancyData.source || 'UNKNOWN'}_${(vacancyData.publishDate || '').replace('.', '_')}_${(vacancyData.floor || 'UNK').replace(/[\/\s]/g, '_')}`;
        
        await set(ref(db, `vacancies/${targetBuilding.id}/${newVacancyKey}`), newVacancyData);
        
        // 2. 원본 삭제
        await remove(ref(db, `vacancies/${fromBuildingId}/${vacancyKey}`));
        
        // 3. ★ dataCache.vacancies 동기화 (processBuildings가 여기서 읽으므로 필수)
        if (state.dataCache.vacancies?.[fromBuildingId]) {
            delete state.dataCache.vacancies[fromBuildingId][vacancyKey];
        }
        if (!state.dataCache.vacancies[targetBuilding.id]) {
            state.dataCache.vacancies[targetBuilding.id] = {};
        }
        state.dataCache.vacancies[targetBuilding.id][newVacancyKey] = newVacancyData;
        
        // 4. allBuildings 로컬 상태 업데이트
        const fromBuilding = state.allBuildings.find(b => b.id === fromBuildingId);
        if (fromBuilding && fromBuilding.vacancies) {
            fromBuilding.vacancies = fromBuilding.vacancies.filter(v => v._key !== vacancyKey);
            fromBuilding.vacancyCount = fromBuilding.vacancies.length;
        }
        
        // 타겟 빌딩 갱신
        if (!targetBuilding.vacancies) targetBuilding.vacancies = [];
        targetBuilding.vacancies.push({ ...newVacancyData, _key: newVacancyKey });
        targetBuilding.vacancyCount = targetBuilding.vacancies.length;
        
        closeTransferVacancyModal();
        refreshAfterCrud();
        
        showToast(`공실 정보가 "${targetBuilding.name}"으로 이관되었습니다.`, 'success');
        
        // 상세 패널 새로고침
        if (state.selectedBuilding?.id === fromBuildingId) {
            window.showBuildingDetail?.(fromBuildingId);
        }
        
    } catch (error) {
        console.error('공실 이관 오류:', error);
        showToast('이관 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

// ★ 이슈3: 이관 모달 닫기
export function closeTransferVacancyModal() {
    document.getElementById('vacancyTransferModal').classList.remove('show');
    document.getElementById('modalOverlay').classList.remove('show');
    state.transferVacancy = null;
    state.transferTargetBuilding = null;
}

// ★ 페이지 매핑 변경 기능
export function openPageMappingModal(buildingId, source, publishDate, currentPageNum, currentImageUrl) {
    state.pageMappingContext = { buildingId, source, publishDate, currentPageNum, currentImageUrl };
    
    // 현재 정보 표시
    document.getElementById('pageMappingCurrentInfo').innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 13px;">
            <div><strong>빌딩:</strong> ${state.selectedBuilding?.name || buildingId}</div>
            <div><strong>출처:</strong> ${source}</div>
            <div><strong>발행일:</strong> ${publishDate}</div>
            <div><strong>현재 페이지:</strong> ${currentPageNum}</div>
        </div>
    `;
    
    // 현재 이미지 미리보기
    if (currentImageUrl) {
        document.getElementById('pageMappingCurrentImage').innerHTML = `
            <img src="${currentImageUrl}" 
                 style="max-width: 100%; max-height: 200px; border-radius: 8px; border: 1px solid var(--border-color);"
                 onerror="this.parentElement.innerHTML='<div style=\\'padding: 20px; color: #666; text-align: center;\\'>이미지 로드 실패</div>'">
        `;
    } else {
        document.getElementById('pageMappingCurrentImage').innerHTML = '<div style="padding: 20px; color: #666; text-align: center;">이미지 없음</div>';
    }
    
    // 입력 필드 초기화
    document.getElementById('newPageNum').value = '';
    document.getElementById('newPageImageUrl').value = '';
    document.getElementById('pageMappingPreview').innerHTML = '';
    
    document.getElementById('pageMappingModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

// 새 페이지 번호로 이미지 URL 생성 및 미리보기
export async function previewNewPage() {
    const { currentImageUrl, source, publishDate } = state.pageMappingContext || {};
    const newPageNum = parseInt(document.getElementById('newPageNum').value);
    
    if (!newPageNum || newPageNum < 1) {
        document.getElementById('pageMappingPreview').innerHTML = '<div style="padding: 12px; color: #666; text-align: center;">페이지 번호를 입력하세요</div>';
        return;
    }
    
    const paddedPageNum = String(newPageNum).padStart(3, '0');
    const safePubDate = (publishDate || '').replace('.', '_');
    const filePath = `leasing-docs/${source}/${safePubDate}/page_${paddedPageNum}.jpg`;
    
    // 로딩 표시
    document.getElementById('pageMappingPreview').innerHTML = `
        <div style="padding: 20px; color: #666; text-align: center;">
            <div style="margin-bottom: 8px;">🔄</div>
            페이지 ${newPageNum} 이미지 로딩 중...
        </div>
    `;
    
    let newImageUrl;
    
    try {
        // Firebase Storage SDK로 download URL 가져오기
        const fileRef = storageRef(storage, filePath);
        newImageUrl = await getDownloadURL(fileRef);
        console.log('Storage URL 가져오기 성공:', newImageUrl);
    } catch (err) {
        console.error('Storage URL 가져오기 실패:', err);
        
        // SDK 실패 시 현재 URL에서 페이지 번호만 교체 시도
        if (currentImageUrl) {
            newImageUrl = currentImageUrl.replace(/page_\d{3}\.jpg/, `page_${paddedPageNum}.jpg`);
        } else {
            document.getElementById('pageMappingPreview').innerHTML = `
                <div style="padding: 20px; color: #dc2626; text-align: center; background: #fef2f2; border-radius: 8px;">
                    ⚠️ 페이지 ${newPageNum} 이미지를 찾을 수 없습니다<br>
                    <span style="font-size: 11px; color: #666;">경로: ${filePath}</span>
                </div>
            `;
            return;
        }
    }
    
    document.getElementById('newPageImageUrl').value = newImageUrl;
    
    document.getElementById('pageMappingPreview').innerHTML = `
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">새 페이지 ${newPageNum} 미리보기:</div>
        <div style="position: relative;">
            <img src="${newImageUrl}" 
                 style="max-width: 100%; max-height: 200px; border-radius: 8px; border: 2px solid var(--accent-color);"
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"
                 onload="this.nextElementSibling.style.display='none';">
            <div style="display: none; padding: 20px; color: #dc2626; text-align: center; background: #fef2f2; border-radius: 8px;">
                ⚠️ 이미지 로드 실패
            </div>
        </div>
    `;
}

// 직접 입력한 URL로 미리보기
export function previewCustomUrl() {
    const customUrl = document.getElementById('newPageImageUrl').value.trim();
    
    if (!customUrl) {
        document.getElementById('pageMappingPreview').innerHTML = '';
        return;
    }
    
    document.getElementById('pageMappingPreview').innerHTML = `
        <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">입력한 URL 미리보기:</div>
        <img src="${customUrl}" 
             style="max-width: 100%; max-height: 200px; border-radius: 8px; border: 2px solid var(--accent-color);"
             onerror="this.parentElement.innerHTML='<div style=\\'padding: 20px; color: #dc2626; text-align: center;\\'>⚠️ 이미지를 불러올 수 없습니다</div>'">
    `;
}

// 페이지 매핑 변경 실행
export async function executePageMappingChange() {
    const { buildingId, source, publishDate, currentPageNum } = state.pageMappingContext || {};
    const newPageNum = parseInt(document.getElementById('newPageNum').value) || null;
    const newImageUrl = document.getElementById('newPageImageUrl').value.trim();
    
    if (!newPageNum && !newImageUrl) {
        showToast('새 페이지 번호 또는 이미지 URL을 입력하세요', 'warning');
        return;
    }
    
    if (!buildingId || !source || !publishDate) {
        showToast('매핑 정보가 올바르지 않습니다', 'error');
        return;
    }
    
    // 해당 빌딩의 해당 source/publishDate 공실 찾기
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building || !building.vacancies) {
        showToast('빌딩 또는 공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    const targetVacancies = building.vacancies.filter(v => 
        v.source === source && v.publishDate === publishDate
    );
    
    if (targetVacancies.length === 0) {
        showToast('해당 조건의 공실 정보가 없습니다', 'error');
        return;
    }
    
    if (!confirm(`${source} ${publishDate}의 공실 ${targetVacancies.length}건의 페이지 매핑을\n${currentPageNum}페이지 → ${newPageNum || '(URL 직접 지정)'}페이지로 변경하시겠습니까?`)) {
        return;
    }
    
    try {
        let successCount = 0;
        
        for (const vacancy of targetVacancies) {
            const vacancyKey = vacancy._key;
            if (!vacancyKey) continue;
            
            const updateData = {
                updatedAt: new Date().toISOString()
            };
            
            if (newPageNum) {
                updateData.pageNum = newPageNum;
            }
            if (newImageUrl) {
                updateData.pageImageUrl = newImageUrl;
            }
            
            await update(ref(db, `vacancies/${buildingId}/${vacancyKey}`), updateData);
            
            // 로컬 데이터 업데이트
            if (newPageNum) vacancy.pageNum = newPageNum;
            if (newImageUrl) vacancy.pageImageUrl = newImageUrl;
            
            successCount++;
        }
        
        closePageMappingModal();
        
        // 상세 패널 새로고침
        if (typeof window.renderDocumentSection === 'function') {
            window.renderDocumentSection();
        }
        
        showToast(`${successCount}건의 공실 페이지 매핑이 변경되었습니다`, 'success');
        
    } catch (error) {
        console.error('페이지 매핑 변경 오류:', error);
        showToast('변경 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

// 페이지 매핑 모달 닫기
export function closePageMappingModal() {
    document.getElementById('pageMappingModal').classList.remove('show');
    document.getElementById('modalOverlay').classList.remove('show');
    state.pageMappingContext = null;
}

// ★ OCR 데이터 삭제 (특정 발간회사/발간일의 공실 전체 삭제)
export async function deleteOcrData(buildingId, source, publishDate) {
    if (!buildingId || !source || !publishDate) {
        showToast('삭제할 데이터 정보가 올바르지 않습니다', 'error');
        return;
    }
    
    // 해당 빌딩의 해당 source/publishDate 공실 찾기
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building || !building.vacancies) {
        showToast('빌딩 또는 공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    const targetVacancies = building.vacancies.filter(v => 
        v.source === source && v.publishDate === publishDate
    );
    
    if (targetVacancies.length === 0) {
        showToast('삭제할 공실 데이터가 없습니다', 'warning');
        return;
    }
    
    // 삭제 확인
    const buildingName = building.name || buildingId;
    if (!confirm(`⚠️ OCR 데이터 삭제 확인\n\n빌딩: ${buildingName}\n출처: ${source}\n발간일: ${publishDate}\n공실 수: ${targetVacancies.length}건\n\n이 데이터를 모두 삭제하시겠습니까?\n(이 작업은 되돌릴 수 없습니다)`)) {
        return;
    }
    
    try {
        let successCount = 0;
        let errorCount = 0;
        
        for (const vacancy of targetVacancies) {
            const vacancyKey = vacancy._key;
            if (!vacancyKey) {
                errorCount++;
                continue;
            }
            
            try {
                await remove(ref(db, `vacancies/${buildingId}/${vacancyKey}`));
                successCount++;
            } catch (err) {
                console.error('공실 삭제 오류:', vacancyKey, err);
                errorCount++;
            }
        }
        
        // 로컬 데이터 업데이트
        building.vacancies = building.vacancies.filter(v => 
            !(v.source === source && v.publishDate === publishDate)
        );
        building.vacancyCount = building.vacancies.length;
        
        // UI 새로고침
        if (typeof window.renderDocumentSection === 'function') {
            window.renderDocumentSection();
        }
        
        showToast(`삭제 완료: 성공 ${successCount}건, 실패 ${errorCount}건`, 'success');
        
    } catch (error) {
        console.error('OCR 데이터 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

// ★ 빌딩의 전체 OCR 데이터 삭제 (모든 발간회사/발간일)
export async function deleteAllOcrDataForBuilding(buildingId) {
    if (!buildingId) {
        showToast('빌딩 정보가 올바르지 않습니다', 'error');
        return;
    }
    
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) {
        showToast('빌딩을 찾을 수 없습니다', 'error');
        return;
    }
    
    const vacancies = building.vacancies || [];
    if (vacancies.length === 0) {
        showToast('삭제할 공실 데이터가 없습니다', 'warning');
        return;
    }
    
    // 출처별 그룹화 정보 표시
    const sourceGroups = {};
    vacancies.forEach(v => {
        const key = `${v.source || 'UNKNOWN'} - ${v.publishDate || '미정'}`;
        sourceGroups[key] = (sourceGroups[key] || 0) + 1;
    });
    
    const groupInfo = Object.entries(sourceGroups)
        .map(([k, v]) => `• ${k}: ${v}건`)
        .join('\n');
    
    if (!confirm(`⚠️ 전체 OCR 데이터 삭제 확인\n\n빌딩: ${building.name}\n총 공실 수: ${vacancies.length}건\n\n${groupInfo}\n\n모든 공실 데이터를 삭제하시겠습니까?\n(이 작업은 되돌릴 수 없습니다)`)) {
        return;
    }
    
    try {
        // vacancies/{buildingId} 전체 삭제
        await remove(ref(db, `vacancies/${buildingId}`));
        
        // 로컬 데이터 업데이트
        building.vacancies = [];
        building.vacancyCount = 0;
        
        // UI 새로고침
        if (typeof window.renderDocumentSection === 'function') {
            window.renderDocumentSection();
        }
        
        showToast(`${vacancies.length}건의 공실 데이터가 삭제되었습니다`, 'success');
        
    } catch (error) {
        console.error('전체 OCR 데이터 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

// ★ OCR 데이터 관리 모달 열기 (전체 데이터)
export function openOcrManageModal() {
    // 전체 빌딩에서 공실 데이터 수집
    const allVacancies = [];
    
    state.allBuildings.forEach(building => {
        if (building.vacancies && building.vacancies.length > 0) {
            building.vacancies.forEach(v => {
                allVacancies.push({
                    ...v,
                    buildingId: building.id,
                    buildingName: building.name || building.id
                });
            });
        }
    });
    
    // 회사별 → 발행연월별 → 빌딩별 그룹핑
    const sourceGroups = {};
    allVacancies.forEach(v => {
        const source = v.source || 'UNKNOWN';
        const period = v.publishDate || '미정';
        const buildingId = v.buildingId;
        const buildingName = v.buildingName;
        
        if (!sourceGroups[source]) sourceGroups[source] = { total: 0, periods: {} };
        sourceGroups[source].total++;
        
        if (!sourceGroups[source].periods[period]) sourceGroups[source].periods[period] = { total: 0, buildings: {} };
        sourceGroups[source].periods[period].total++;
        
        if (!sourceGroups[source].periods[period].buildings[buildingId]) {
            sourceGroups[source].periods[period].buildings[buildingId] = { 
                name: buildingName, 
                vacancies: [] 
            };
        }
        sourceGroups[source].periods[period].buildings[buildingId].vacancies.push(v);
    });
    
    // 모달 내용 생성
    const container = document.getElementById('ocrManageContent');
    
    if (allVacancies.length === 0) {
        container.innerHTML = `
            <div style="padding: 40px; text-align: center; color: #666;">
                <div style="font-size: 48px; margin-bottom: 16px;">📭</div>
                <div>등록된 OCR 데이터가 없습니다</div>
            </div>
        `;
    } else {
        const sourceCount = Object.keys(sourceGroups).length;
        const buildingCount = new Set(allVacancies.map(v => v.buildingId)).size;
        
        let html = `
            <div style="margin-bottom: 16px; padding: 12px; background: #f1f5f9; border-radius: 8px;">
                <div style="font-weight: 600; margin-bottom: 4px;">📊 전체 OCR 데이터 현황</div>
                <div style="font-size: 12px; color: #666; display: flex; gap: 16px;">
                    <span>🏢 ${sourceCount}개 회사</span>
                    <span>🏗️ ${buildingCount}개 빌딩</span>
                    <span>📄 ${allVacancies.length}건 공실</span>
                </div>
            </div>
        `;
        
        // 회사별로 그룹 표시 (공실 수 많은 순)
        const sortedSources = Object.keys(sourceGroups).sort((a, b) => 
            sourceGroups[b].total - sourceGroups[a].total
        );
        
        sortedSources.forEach(source => {
            const sourceData = sourceGroups[source];
            const periodCount = Object.keys(sourceData.periods).length;
            
            html += `
                <div class="ocr-source-group" style="margin-bottom: 12px; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--accent-color); color: white; cursor: pointer;"
                         onclick="toggleOcrGroup(this)">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="toggle-icon" style="transition: transform 0.2s;">▶</span>
                            <span style="font-weight: 600;">🏢 ${source}</span>
                            <span style="font-size: 12px; opacity: 0.9;">(${sourceData.total}건 / ${periodCount}개 발행호)</span>
                        </div>
                        <button onclick="event.stopPropagation(); deleteOcrBySourceAll('${source}')" 
                                style="padding: 4px 10px; background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); border-radius: 4px; cursor: pointer; font-size: 11px;">
                            전체 삭제
                        </button>
                    </div>
                    <div class="ocr-periods" style="display: none; padding: 8px;">
            `;
            
            // 발행연월별로 표시 (최신순)
            const sortedPeriods = Object.keys(sourceData.periods).sort((a, b) => b.localeCompare(a));
            
            sortedPeriods.forEach(period => {
                const periodData = sourceData.periods[period];
                const buildingCount = Object.keys(periodData.buildings).length;
                
                html += `
                    <div style="margin-bottom: 8px; border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden;">
                        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: #f8fafc; cursor: pointer;"
                             onclick="toggleOcrPeriod(this)">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span class="toggle-icon" style="transition: transform 0.2s; font-size: 10px;">▶</span>
                                <span style="font-size: 13px; font-weight: 500;">📅 ${period}</span>
                                <span style="font-size: 11px; color: #666;">(${periodData.total}건 / ${buildingCount}개 빌딩)</span>
                            </div>
                            <div style="display: flex; gap: 4px;">
                                <button onclick="event.stopPropagation(); openBatchEditModal('${source}', '${period}')" 
                                        style="padding: 3px 8px; background: #dbeafe; color: #2563eb; border: none; border-radius: 4px; cursor: pointer; font-size: 10px;"
                                        title="기업명/발행연월 일괄 수정">
                                    ✏️ 수정
                                </button>
                                <button onclick="event.stopPropagation(); deleteOcrBySourcePeriod('${source}', '${period}')" 
                                        style="padding: 3px 8px; background: #fee2e2; color: #dc2626; border: none; border-radius: 4px; cursor: pointer; font-size: 10px;">
                                    삭제
                                </button>
                            </div>
                        </div>
                        <div class="ocr-buildings" style="display: none; padding: 8px; background: white;">
                `;
                
                // 빌딩별로 표시
                Object.entries(periodData.buildings).forEach(([buildingId, buildingData]) => {
                    html += `
                        <div style="margin-bottom: 6px; padding: 8px; background: #f1f5f9; border-radius: 4px;">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                                <span style="font-size: 12px; font-weight: 500;">🏗️ ${buildingData.name}</span>
                                <button onclick="deleteOcrData('${buildingId}', '${source}', '${period}')" 
                                        style="padding: 2px 6px; background: #fee2e2; color: #dc2626; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">
                                    삭제
                                </button>
                            </div>
                            <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                                ${buildingData.vacancies.map(v => `
                                    <span style="padding: 2px 6px; background: white; border: 1px solid #e2e8f0; border-radius: 3px; font-size: 10px; display: inline-flex; align-items: center; gap: 3px;">
                                        ${v.floor || '-'}층
                                        <button onclick="deleteVacancy('${buildingId}', '${v._key}')" 
                                                style="padding: 0 3px; background: none; border: none; cursor: pointer; color: #dc2626; font-size: 9px;"
                                                title="이 공실만 삭제">×</button>
                                    </span>
                                `).join('')}
                            </div>
                        </div>
                    `;
                });
                
                html += `
                        </div>
                    </div>
                `;
            });
            
            html += `
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = html;
    }
    
    document.getElementById('ocrManageModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

// 회사의 전체 OCR 데이터 삭제 (모든 빌딩)
export async function deleteOcrBySourceAll(source) {
    // 해당 회사의 모든 공실 찾기
    const targetData = [];
    
    state.allBuildings.forEach(building => {
        if (building.vacancies) {
            building.vacancies.forEach(v => {
                if (v.source === source && v._key) {
                    targetData.push({ buildingId: building.id, vacancyKey: v._key, building });
                }
            });
        }
    });
    
    if (targetData.length === 0) {
        showToast('삭제할 데이터가 없습니다', 'warning');
        return;
    }
    
    if (!confirm(`⚠️ "${source}" 회사의 전체 OCR 데이터 삭제\n\n총 ${targetData.length}건의 공실을 삭제하시겠습니까?\n(이 작업은 되돌릴 수 없습니다)`)) {
        return;
    }
    
    try {
        let successCount = 0;
        
        for (const item of targetData) {
            await remove(ref(db, `vacancies/${item.buildingId}/${item.vacancyKey}`));
            successCount++;
        }
        
        // 로컬 데이터 업데이트
        state.allBuildings.forEach(building => {
            if (building.vacancies) {
                building.vacancies = building.vacancies.filter(v => v.source !== source);
                building.vacancyCount = building.vacancies.length;
            }
        });
        
        // 모달 새로고침
        openOcrManageModal();
        
        // 상세 패널 새로고침
        if (typeof window.renderDocumentSection === 'function') {
            window.renderDocumentSection();
        }
        
        showToast(`${successCount}건 삭제 완료`, 'success');
        
    } catch (error) {
        console.error('회사별 전체 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

// 회사+발행연월 OCR 데이터 삭제
export async function deleteOcrBySourcePeriod(source, period) {
    const targetData = [];
    
    state.allBuildings.forEach(building => {
        if (building.vacancies) {
            building.vacancies.forEach(v => {
                if (v.source === source && v.publishDate === period && v._key) {
                    targetData.push({ buildingId: building.id, vacancyKey: v._key, building });
                }
            });
        }
    });
    
    if (targetData.length === 0) {
        showToast('삭제할 데이터가 없습니다', 'warning');
        return;
    }
    
    if (!confirm(`⚠️ "${source} - ${period}" OCR 데이터 삭제\n\n총 ${targetData.length}건의 공실을 삭제하시겠습니까?`)) {
        return;
    }
    
    try {
        let successCount = 0;
        
        for (const item of targetData) {
            await remove(ref(db, `vacancies/${item.buildingId}/${item.vacancyKey}`));
            successCount++;
        }
        
        // 로컬 데이터 업데이트
        state.allBuildings.forEach(building => {
            if (building.vacancies) {
                building.vacancies = building.vacancies.filter(v => 
                    !(v.source === source && v.publishDate === period)
                );
                building.vacancyCount = building.vacancies.length;
            }
        });
        
        // 모달 새로고침
        openOcrManageModal();
        
        // 상세 패널 새로고침
        if (typeof window.renderDocumentSection === 'function') {
            window.renderDocumentSection();
        }
        
        showToast(`${successCount}건 삭제 완료`, 'success');
        
    } catch (error) {
        console.error('발행연월별 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

// 회사별 OCR 데이터 삭제 (특정 빌딩 내)
export async function deleteOcrBySource(buildingId, source) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building || !building.vacancies) return;
    
    const targetVacancies = building.vacancies.filter(v => v.source === source);
    
    if (targetVacancies.length === 0) {
        showToast('삭제할 데이터가 없습니다', 'warning');
        return;
    }
    
    if (!confirm(`⚠️ "${source}" 회사의 전체 OCR 데이터 삭제\n\n공실 ${targetVacancies.length}건을 삭제하시겠습니까?`)) {
        return;
    }
    
    try {
        let successCount = 0;
        
        for (const vacancy of targetVacancies) {
            if (vacancy._key) {
                await remove(ref(db, `vacancies/${buildingId}/${vacancy._key}`));
                successCount++;
            }
        }
        
        // 로컬 데이터 업데이트
        building.vacancies = building.vacancies.filter(v => v.source !== source);
        building.vacancyCount = building.vacancies.length;
        
        // 모달 새로고침
        openOcrManageModal();
        
        // 상세 패널 새로고침
        if (typeof window.renderDocumentSection === 'function') {
            window.renderDocumentSection();
        }
        
        showToast(`${successCount}건 삭제 완료`, 'success');
        
    } catch (error) {
        console.error('회사별 OCR 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

// OCR 그룹 토글 (접기/펼치기)
window.toggleOcrGroup = function(element) {
    const periodsDiv = element.nextElementSibling;
    const icon = element.querySelector('.toggle-icon');
    
    if (periodsDiv.style.display === 'none') {
        periodsDiv.style.display = 'block';
        icon.style.transform = 'rotate(90deg)';
    } else {
        periodsDiv.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
    }
};

// 발행연월 그룹 토글
window.toggleOcrPeriod = function(element) {
    const buildingsDiv = element.nextElementSibling;
    const icon = element.querySelector('.toggle-icon');
    
    if (buildingsDiv.style.display === 'none') {
        buildingsDiv.style.display = 'block';
        icon.style.transform = 'rotate(90deg)';
    } else {
        buildingsDiv.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
    }
};

// OCR 관리 모달 닫기
export function closeOcrManageModal() {
    document.getElementById('ocrManageModal').classList.remove('show');
    document.getElementById('modalOverlay').classList.remove('show');
}

// ★ Sprint3-NEW1: 기업명/발행연월 일괄 수정 모달
window.openBatchEditModal = function(oldSource, oldPeriod) {
    // 기존 회사 목록 수집 (중복 제거)
    const allSources = new Set();
    state.allBuildings.forEach(b => {
        if (b.vacancies) b.vacancies.forEach(v => { if (v.source) allSources.add(v.source); });
    });
    
    // 현재 연도 기준 옵션 생성
    const now = new Date();
    const currentYear = now.getFullYear();
    let yearOptions = '';
    for (let y = currentYear + 1; y >= currentYear - 3; y--) {
        const yy = String(y).slice(2);
        for (let m = 12; m >= 1; m--) {
            const mm = String(m).padStart(2, '0');
            const val = `${yy}.${mm}`;
            const sel = val === oldPeriod ? 'selected' : '';
            yearOptions += `<option value="${val}" ${sel}>${val}</option>`;
        }
    }
    
    let sourceOptions = '';
    [...allSources].sort().forEach(s => {
        const sel = s === oldSource ? 'selected' : '';
        sourceOptions += `<option value="${s}" ${sel}>${s}</option>`;
    });
    
    // 해당 그룹의 영향받는 공실 수 계산
    let affectedCount = 0;
    let affectedBuildings = new Set();
    state.allBuildings.forEach(b => {
        if (b.vacancies) b.vacancies.forEach(v => {
            if (v.source === oldSource && v.publishDate === oldPeriod && v._key) {
                affectedCount++;
                affectedBuildings.add(b.id);
            }
        });
    });
    
    const modal = document.createElement('div');
    modal.id = 'batchEditOverlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1010;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
        <div style="background:var(--bg-card,white);border-radius:12px;padding:24px;width:95%;max-width:500px;box-shadow:0 10px 40px rgba(0,0,0,0.3);">
            <h3 style="font-size:16px;font-weight:600;margin-bottom:16px;">✏️ 기업명/발행연월 일괄 수정</h3>
            
            <div style="margin-bottom:16px;padding:12px;background:#f1f5f9;border-radius:8px;font-size:12px;">
                <div><strong>현재:</strong> 🏢 ${oldSource} / 📅 ${oldPeriod}</div>
                <div style="margin-top:4px;color:#666;">영향: ${affectedCount}건 공실 (${affectedBuildings.size}개 빌딩)</div>
            </div>
            
            <div style="margin-bottom:14px;">
                <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">변경할 기업명</label>
                <select id="batchEditSource" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
                    ${sourceOptions}
                </select>
                <input type="text" id="batchEditSourceCustom" placeholder="새 기업명 직접 입력 (비워두면 위 선택값 사용)" 
                       style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;margin-top:6px;box-sizing:border-box;">
            </div>
            
            <div style="margin-bottom:20px;">
                <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px;">변경할 발행연월</label>
                <select id="batchEditPeriod" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;">
                    ${yearOptions}
                </select>
            </div>
            
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button onclick="executeBatchEdit('${oldSource}','${oldPeriod}')" 
                        style="padding:10px 20px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:white;border:none;border-radius:8px;font-weight:600;cursor:pointer;">
                    ✅ 일괄 수정
                </button>
                <button onclick="document.getElementById('batchEditOverlay')?.remove()" 
                        style="padding:10px 20px;background:#f1f5f9;color:#64748b;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;">
                    취소
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

// ★ Sprint3-NEW1: 일괄 수정 실행
window.executeBatchEdit = async function(oldSource, oldPeriod) {
    const customSource = document.getElementById('batchEditSourceCustom').value.trim();
    const newSource = customSource || document.getElementById('batchEditSource').value;
    const newPeriod = document.getElementById('batchEditPeriod').value;
    
    // 변경사항 없으면 종료
    if (newSource === oldSource && newPeriod === oldPeriod) {
        showToast('변경사항이 없습니다', 'warning');
        return;
    }
    
    // 영향받는 공실 수집
    const targets = [];
    state.allBuildings.forEach(b => {
        if (b.vacancies) b.vacancies.forEach(v => {
            if (v.source === oldSource && v.publishDate === oldPeriod && v._key) {
                targets.push({ buildingId: b.id, vacancyKey: v._key, vacancy: v, building: b });
            }
        });
    });
    
    if (targets.length === 0) {
        showToast('수정할 데이터가 없습니다', 'warning');
        return;
    }
    
    const changeDesc = [];
    if (newSource !== oldSource) changeDesc.push(`기업명: ${oldSource} → ${newSource}`);
    if (newPeriod !== oldPeriod) changeDesc.push(`발행연월: ${oldPeriod} → ${newPeriod}`);
    
    if (!confirm(`⚠️ 일괄 수정 확인\n\n${changeDesc.join('\n')}\n\n총 ${targets.length}건의 공실이 수정됩니다.\n계속하시겠습니까?`)) {
        return;
    }
    
    try {
        let successCount = 0;
        
        for (const item of targets) {
            const updates = {};
            if (newSource !== oldSource) updates.source = newSource;
            if (newPeriod !== oldPeriod) updates.publishDate = newPeriod;
            updates.updatedAt = new Date().toISOString();
            
            // Firebase vacancyKey 변경이 필요하면 (source나 period가 key에 포함되어 있으므로)
            // 기존 키: {source}_{period}_{floor}
            // 새 키 생성이 필요
            const oldKey = item.vacancyKey;
            const floor = (item.vacancy.floor || 'UNK').replace(/[\/\s]/g, '_');
            const newKey = `${newSource}_${newPeriod.replace('.', '_')}_${floor}`;
            
            if (oldKey !== newKey) {
                // 키가 변경되면: 새 키로 데이터 복사 후 기존 키 삭제
                const existingData = { ...item.vacancy };
                delete existingData._key;
                Object.assign(existingData, updates);
                
                await set(ref(db, `vacancies/${item.buildingId}/${newKey}`), existingData);
                await remove(ref(db, `vacancies/${item.buildingId}/${oldKey}`));
                
                // 로컬 캐시 업데이트
                if (state.dataCache.vacancies?.[item.buildingId]) {
                    delete state.dataCache.vacancies[item.buildingId][oldKey];
                    state.dataCache.vacancies[item.buildingId][newKey] = existingData;
                }
            } else {
                // 키 변경 불필요 시 update만
                await update(ref(db, `vacancies/${item.buildingId}/${oldKey}`), updates);
            }
            
            successCount++;
        }
        
        // 로컬 데이터 동기화
        state.allBuildings.forEach(b => {
            if (b.vacancies) {
                b.vacancies.forEach(v => {
                    if (v.source === oldSource && v.publishDate === oldPeriod) {
                        if (newSource !== oldSource) v.source = newSource;
                        if (newPeriod !== oldPeriod) v.publishDate = newPeriod;
                    }
                });
            }
        });
        
        // 모달 닫고 새로고침
        document.getElementById('batchEditOverlay')?.remove();
        openOcrManageModal();
        
        showToast(`${successCount}건 일괄 수정 완료`, 'success');
        
    } catch (error) {
        console.error('일괄 수정 오류:', error);
        showToast('일괄 수정 중 오류가 발생했습니다: ' + error.message, 'error');
    }
};

// ★ 주소 수정 모달 열기
export function openAddressEditModal() {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩을 먼저 선택해주세요', 'warning');
        return;
    }
    
    document.getElementById('addressEditBuildingName').value = building.name || '';
    document.getElementById('addressEditCurrent').value = building.address || '';
    document.getElementById('addressEditNew').value = '';
    document.getElementById('addressEditReason').value = '';
    
    document.getElementById('addressEditModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

// 주소 수정 모달 닫기
export function closeAddressEditModal() {
    document.getElementById('addressEditModal').classList.remove('show');
    document.getElementById('modalOverlay').classList.remove('show');
}

// 주소 수정 저장
export async function saveAddressEdit() {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩 정보가 없습니다', 'error');
        return;
    }
    
    const newAddress = document.getElementById('addressEditNew').value.trim();
    const reason = document.getElementById('addressEditReason').value.trim();
    
    if (!newAddress) {
        showToast('새 주소를 입력해주세요', 'warning');
        return;
    }
    
    try {
        showToast('주소 좌표 변환 중...', 'info');
        
        // ★ Kakao Geocoder로 새 주소의 좌표 조회
        let newCoordinates = null;
        
        if (window.kakao && window.kakao.maps && window.kakao.maps.services) {
            const geocoder = new kakao.maps.services.Geocoder();
            
            // Promise로 변환하여 await 사용
            newCoordinates = await new Promise((resolve) => {
                geocoder.addressSearch(newAddress, function(result, status) {
                    if (status === kakao.maps.services.Status.OK && result.length > 0) {
                        resolve({
                            lat: parseFloat(result[0].y),
                            lng: parseFloat(result[0].x)
                        });
                    } else {
                        console.warn('주소 좌표 변환 실패:', status);
                        resolve(null);
                    }
                });
            });
        }
        
        const updateData = {
            address: newAddress,
            addressModified: true,
            addressModifiedAt: new Date().toISOString(),
            addressModifiedBy: state.currentUser?.email || 'unknown',
            addressModifiedReason: reason || null,
            originalAddress: building.address // 원래 주소 보존
        };
        
        // ★ 좌표가 조회되면 함께 업데이트
        if (newCoordinates) {
            updateData.coordinates = newCoordinates;
            updateData.coordinatesModified = true;
            console.log('새 좌표:', newCoordinates);
        }
        
        await update(ref(db, `buildings/${building.id}`), updateData);
        
        // 로컬 데이터 업데이트
        building.address = newAddress;
        building.addressModified = true;
        if (newCoordinates) {
            building.lat = newCoordinates.lat;
            building.lng = newCoordinates.lng;
            building.coordinates = newCoordinates;
            // _raw도 업데이트
            if (building._raw) {
                building._raw.coordinates = newCoordinates;
            }
        }
        
        // allBuildings에서도 업데이트
        const buildingInAll = state.allBuildings.find(b => b.id === building.id);
        if (buildingInAll) {
            buildingInAll.address = newAddress;
            if (newCoordinates) {
                buildingInAll.lat = newCoordinates.lat;
                buildingInAll.lng = newCoordinates.lng;
                buildingInAll.coordinates = newCoordinates;
            }
        }
        
        // UI 업데이트
        document.getElementById('detailSubtitle').textContent = newAddress;
        
        closeAddressEditModal();
        
        if (newCoordinates) {
            showToast('주소와 좌표가 수정되었습니다', 'success');
            
            // ★ 지도 마커 업데이트
            if (window.updateMapMarkers) {
                window.updateMapMarkers();
            }
            
            // ★ 지도 중심 이동 (선택된 빌딩이면)
            if (state.kakaoMap && building.id === state.selectedBuilding?.id) {
                const newCenter = new kakao.maps.LatLng(newCoordinates.lat, newCoordinates.lng);
                state.kakaoMap.setCenter(newCenter);
            }
        } else {
            showToast('주소가 수정되었습니다 (좌표 변환 실패 - 지도 위치는 수동 확인 필요)', 'warning');
        }
        
        // 변경 로그 기록
        try {
            const logRef = push(ref(db, `buildingEditLogs/${building.id}`));
            await set(logRef, {
                field: 'address',
                oldValue: building.originalAddress || building.address,
                newValue: newAddress,
                newCoordinates: newCoordinates || null,
                reason: reason || null,
                editedAt: new Date().toISOString(),
                editedBy: state.currentUser?.email || 'unknown'
            });
        } catch (logErr) {
            console.warn('변경 로그 기록 실패:', logErr);
        }
        
    } catch (error) {
        console.error('주소 수정 오류:', error);
        showToast('수정 중 오류가 발생했습니다: ' + error.message, 'error');
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
    
    // 구분 선택 드롭다운 초기화
    const presetEl = document.getElementById('pricingPreset');
    if (presetEl) presetEl.value = '';
    
    if (id && state.selectedBuilding) {
        const fp = state.selectedBuilding.floorPricing?.find(p => p.id === id);
        if (fp) {
            document.getElementById('pricingLabel').value = fp.label || '';
            
            // floorRange를 floorStart/floorEnd로 분리 (예: "B1-10F" → "B1", "10F")
            if (fp.floorRange) {
                const parts = fp.floorRange.split('-');
                if (parts.length >= 2) {
                    document.getElementById('pricingFloorStart').value = parts[0] || '';
                    document.getElementById('pricingFloorEnd').value = parts.slice(1).join('-') || '';
                } else {
                    document.getElementById('pricingFloorStart').value = fp.floorRange;
                    document.getElementById('pricingFloorEnd').value = fp.floorRange;
                }
            } else if (fp.floorStart || fp.floorEnd) {
                document.getElementById('pricingFloorStart').value = fp.floorStart || '';
                document.getElementById('pricingFloorEnd').value = fp.floorEnd || '';
            }
            
            // 필드 ID를 HTML에 맞게 수정
            document.getElementById('pricingDeposit').value = fp.depositPy || '';
            document.getElementById('pricingRent').value = fp.rentPy || '';
            document.getElementById('pricingMaintenance').value = fp.maintenancePy || '';
            document.getElementById('pricingRentArea').value = fp.rentArea || '';
            document.getElementById('pricingExclusiveArea').value = fp.exclusiveArea || '';
            document.getElementById('pricingEffectiveDate').value = fp.effectiveDate || '';
            document.getElementById('pricingNotes').value = fp.notes || '';
            
            // 구분 선택 드롭다운을 직접입력으로 설정 (기존 데이터 편집 시)
            if (presetEl) presetEl.value = 'custom';
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
        syncBuildingCache(state.selectedBuilding.id, { floorPricing: state.selectedBuilding.floorPricing });
        
        refreshAfterCrud([renderPricingSection, renderInfoSection]);
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
        syncBuildingCache(state.selectedBuilding.id, { floorPricing: state.selectedBuilding.floorPricing });
        refreshAfterCrud([renderPricingSection, renderInfoSection]);
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
        syncBuildingCache(state.selectedBuilding.id, { contactPoints: state.selectedBuilding.contactPoints });
        
        refreshAfterCrud(renderContactSection);
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
        syncBuildingCache(state.selectedBuilding.id, { contactPoints: state.selectedBuilding.contactPoints });
        refreshAfterCrud(renderContactSection);
        showToast('담당자가 저장되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('저장 실패', 'error');
    }
}

// ===== 빌딩 숨기기/삭제/복원 =====

export function isAdmin() {
    const adminEmails = ['admin@snimgt.com', 'system@snimgt.com', 'oramlee@sni.co.kr'];
    return adminEmails.includes(state.currentUser?.email);
}

export function canDeleteBuilding() {
    return isAdmin();
}

// ★ 숨기기 (isHidden 처리 - 데이터 유지)
export function handleBuildingHide() {
    if (!state.selectedBuilding) return;
    
    const title = document.querySelector('#deleteConfirmModal .modal-title');
    const message = document.getElementById('deleteConfirmMessage');
    const details = document.getElementById('deleteConfirmDetails');
    const btn = document.getElementById('deleteConfirmBtn');
    
    title.textContent = '🚫 빌딩 숨기기';
    title.style.color = '#f59e0b';
    message.innerHTML = `<strong>${state.selectedBuilding.name}</strong> 빌딩을 숨김 처리하시겠습니까?`;
    details.innerHTML = `
        <strong>📌 숨김 처리 안내:</strong><br>
        • 지도/리스트/검색에서 표시되지 않습니다<br>
        • Comp List, 임대안내문에서도 검색되지 않습니다<br>
        • 데이터는 삭제되지 않으며, 복원 가능합니다
    `;
    details.style.background = '#fef3c7';
    details.style.borderColor = '#fcd34d';
    details.style.color = '#92400e';
    btn.textContent = '숨김 처리';
    btn.style.background = '#f59e0b';
    btn.dataset.action = 'hide';
    
    openModal('deleteConfirmModal');
}

// ★ 완전 삭제 (Firebase에서 삭제)
export function handleBuildingPermanentDelete() {
    if (!state.selectedBuilding) return;
    
    // 관리자만 완전 삭제 가능
    if (!isAdmin()) {
        showToast('완전 삭제는 관리자만 가능합니다', 'error');
        return;
    }
    
    const title = document.querySelector('#deleteConfirmModal .modal-title');
    const message = document.getElementById('deleteConfirmMessage');
    const details = document.getElementById('deleteConfirmDetails');
    const btn = document.getElementById('deleteConfirmBtn');
    
    title.textContent = '⚠️ 빌딩 완전 삭제';
    title.style.color = '#dc2626';
    message.innerHTML = `<strong>${state.selectedBuilding.name}</strong> 빌딩을 완전히 삭제하시겠습니까?<br><br><span style="color:#dc2626; font-weight:600;">⚠️ 이 작업은 되돌릴 수 없습니다!</span>`;
    details.innerHTML = `
        <strong>🗑️ 삭제될 데이터:</strong><br>
        • 빌딩 기본 정보<br>
        • 공실 정보 ${(state.selectedBuilding.vacancies || []).length}건<br>
        • 렌트롤 ${state.selectedBuilding.rentrollCount || 0}건<br>
        • 메모 ${state.selectedBuilding.memoCount || 0}건<br>
        • 기준가, 담당자, 이미지 등 모든 관련 데이터
    `;
    details.style.background = '#fef2f2';
    details.style.borderColor = '#fecaca';
    details.style.color = '#991b1b';
    btn.textContent = '완전 삭제';
    btn.style.background = '#dc2626';
    btn.dataset.action = 'delete';
    
    openModal('deleteConfirmModal');
}

// 기존 함수 유지 (하위 호환)
export function handleBuildingDelete() {
    handleBuildingHide();
}

export async function confirmBuildingDelete() {
    if (!state.selectedBuilding) return;
    
    const btn = document.getElementById('deleteConfirmBtn');
    const action = btn.dataset.action;
    const buildingId = state.selectedBuilding.id;
    const buildingName = state.selectedBuilding.name;
    
    try {
        if (action === 'delete') {
            // ★ 완전 삭제: 관련 데이터 모두 삭제
            const deletePromises = [];
            
            // 1. 빌딩 기본 정보 삭제
            deletePromises.push(remove(ref(db, `buildings/${buildingId}`)));
            
            // 2. 공실 정보 삭제 (vacancies/{buildingId})
            deletePromises.push(remove(ref(db, `vacancies/${buildingId}`)));
            
            // 3. 렌트롤 삭제 (buildingId 또는 buildingName으로 매칭)
            if (state.dataCache?.rentrolls) {
                Object.entries(state.dataCache.rentrolls).forEach(([key, r]) => {
                    if (r.buildingId === buildingId || r.buildingId === buildingName || r.buildingName === buildingName) {
                        deletePromises.push(remove(ref(db, `rentrolls/${key}`)));
                    }
                });
            }
            
            // 4. 메모 삭제
            if (state.dataCache?.memos) {
                Object.entries(state.dataCache.memos).forEach(([key, m]) => {
                    if (m.buildingId === buildingId || m.buildingId === buildingName || m.buildingName === buildingName) {
                        deletePromises.push(remove(ref(db, `memos/${key}`)));
                    }
                });
            }
            
            // 5. 기준가 삭제
            deletePromises.push(remove(ref(db, `floorPricing/${buildingId}`)));
            
            // 6. 담당자 삭제
            deletePromises.push(remove(ref(db, `contactPoints/${buildingId}`)));
            
            // 7. 인센티브 삭제
            deletePromises.push(remove(ref(db, `incentives/${buildingId}`)));
            
            // 8. 빌딩 편집 로그 삭제
            deletePromises.push(remove(ref(db, `buildingEditLogs/${buildingId}`)));
            
            // 모든 삭제 실행
            await Promise.all(deletePromises);
            
            console.log(`빌딩 "${buildingName}" 및 관련 데이터 완전 삭제 완료`);
            showToast(`"${buildingName}" 빌딩이 완전히 삭제되었습니다`, 'success');
            
        } else {
            // ★ 숨김 처리
            await update(ref(db, `buildings/${buildingId}`), {
                isHidden: true,
                status: 'hidden',
                hiddenBy: state.currentUser?.email,
                hiddenAt: new Date().toISOString()
            });
            showToast(`"${buildingName}" 빌딩이 숨김 처리되었습니다`, 'info');
        }
        
        closeModal('deleteConfirmModal');
        closeDetail();
        await loadData();
        
    } catch (err) {
        console.error('빌딩 삭제/숨김 처리 오류:', err);
        showToast('처리 중 오류가 발생했습니다', 'error');
    }
}

export async function handleBuildingRestore() {
    if (!state.selectedBuilding) return;
    
    if (!confirm(`"${state.selectedBuilding.name}" 빌딩을 복원하시겠습니까?`)) return;
    
    try {
        await update(ref(db, `buildings/${state.selectedBuilding.id}`), {
            isHidden: false,
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
        syncBuildingCache(state.selectedBuilding.id, { notes: noteText });
        closeModal('buildingNoteModal');
        refreshAfterCrud(renderInfoSection);
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
        syncBuildingCache(state.selectedBuilding.id, { region });
        
        refreshAfterCrud(renderInfoSection);
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

// ===== 빌딩 정보 편집 모달 =====

export function openBuildingEditModal() {
    const b = state.selectedBuilding;
    if (!b) {
        showToast('빌딩을 먼저 선택해주세요', 'warning');
        return;
    }
    
    // 기본 정보
    const nameEl = document.getElementById('editBuildingName');
    const gradeEl = document.getElementById('editGrade');
    if (nameEl) nameEl.value = b.name || '';
    if (gradeEl) gradeEl.value = b.grade || '';
    
    // ★ #13: 별칭
    const aliasesEl = document.getElementById('editAliases');
    if (aliasesEl) aliasesEl.value = (b.aliases || []).join(', ');
    
    // 기준층 정보
    const typicalFloorPyEl = document.getElementById('editTypicalFloorPy');
    const typicalFloorLeasePyEl = document.getElementById('editTypicalFloorLeasePy');
    const exclusiveRateEl = document.getElementById('editExclusiveRate');
    if (typicalFloorPyEl) typicalFloorPyEl.value = b.typicalFloorPy || '';
    if (typicalFloorLeasePyEl) typicalFloorLeasePyEl.value = b.typicalFloorLeasePy || '';
    if (exclusiveRateEl) exclusiveRateEl.value = b.exclusiveRate || '';
    
    // 임대조건 (만원 단위로 표시)
    const depositPyEl = document.getElementById('editDepositPy');
    const rentPyEl = document.getElementById('editRentPy');
    const maintenancePyEl = document.getElementById('editMaintenancePy');
    if (depositPyEl) depositPyEl.value = b.depositPy || '';
    if (rentPyEl) rentPyEl.value = b.rentPy || '';
    if (maintenancePyEl) maintenancePyEl.value = b.maintenancePy || '';
    
    // 시설 정보
    const hvacEl = document.getElementById('editHvac');
    const ceilingHeightEl = document.getElementById('editCeilingHeight');
    const floorLoadEl = document.getElementById('editFloorLoad');
    if (hvacEl) hvacEl.value = b.hvac || b.specs?.hvac || '';
    if (ceilingHeightEl) ceilingHeightEl.value = b.ceilingHeight || b.specs?.ceilingHeight || '';
    if (floorLoadEl) floorLoadEl.value = b.floorLoad || b.specs?.floorLoad || '';
    
    // 주차/인근역
    const parkingRatioEl = document.getElementById('editParkingRatio');
    const nearbyStationEl = document.getElementById('editNearbyStation');
    if (parkingRatioEl) parkingRatioEl.value = b.parkingRatio || '';
    if (nearbyStationEl) nearbyStationEl.value = b.nearbyStation || '';
    
    // 관리 정보
    const pmEl = document.getElementById('editPm');
    const ownerEl = document.getElementById('editOwner');
    if (pmEl) pmEl.value = b.pm || '';
    if (ownerEl) ownerEl.value = b.owner || '';
    
    // ★ 채권분석 정보 (LG그룹용)
    const bondStatusEl = document.getElementById('editBondStatus');
    const jointCollateralEl = document.getElementById('editJointCollateral');
    const seniorLienEl = document.getElementById('editSeniorLien');
    const collateralRatioEl = document.getElementById('editCollateralRatio');
    const officialLandPriceEl = document.getElementById('editOfficialLandPrice');
    const landPriceAppliedEl = document.getElementById('editLandPriceApplied');
    
    if (bondStatusEl) bondStatusEl.value = b.bondStatus || '';
    if (jointCollateralEl) jointCollateralEl.value = b.jointCollateral || '';
    if (seniorLienEl) seniorLienEl.value = b.seniorLien || '';
    if (collateralRatioEl) collateralRatioEl.value = b.collateralRatio || '';
    if (officialLandPriceEl) officialLandPriceEl.value = b.officialLandPrice || '';
    if (landPriceAppliedEl) landPriceAppliedEl.value = b.landPriceApplied || '';
    
    // 기타 정보
    const descriptionEl = document.getElementById('editDescription');
    const urlEl = document.getElementById('editUrl');
    if (descriptionEl) descriptionEl.value = b.description || '';
    if (urlEl) urlEl.value = b.url || b.homepage || '';
    
    // 건축물대장 읽기전용 정보 표시
    const readonlyInfoEl = document.getElementById('buildingReadonlyInfo');
    if (readonlyInfoEl) {
        const raw = b._raw || b;
        const floors = raw.floors?.display || b.floors || '-';
        const completionYear = raw.completionYear || b.completionYear || '-';
        const grossFloorSqm = raw.area?.grossFloorSqm || b.grossFloorSqm || '-';
        const parkingTotal = raw.parking?.total || b.parkingTotal || '-';
        const elevators = b.elevators || '-';
        
        readonlyInfoEl.innerHTML = `
            <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px 16px;">
                <div><span style="color: #64748b;">연면적:</span> ${grossFloorSqm ? Number(grossFloorSqm).toLocaleString() + '㎡' : '-'}</div>
                <div><span style="color: #64748b;">규모:</span> ${floors}</div>
                <div><span style="color: #64748b;">준공:</span> ${completionYear}년</div>
                <div><span style="color: #64748b;">주차:</span> ${parkingTotal}대</div>
                <div><span style="color: #64748b;">엘리베이터:</span> ${elevators}</div>
            </div>
        `;
    }
    
    openModal('buildingEditModal');
}

export function registerCrudGlobals() {
    // 모달
    window.openModal = openModal;
    window.closeModal = closeModal;
    
    // 렌트롤
    window.openRentrollModal = openRentrollModal;
    window.editRentroll = editRentroll;
    window.deleteRentroll = deleteRentroll;
    
    // ★ v3.4: 메모 함수는 portal-detail.js에서 등록 (buildings/{id}/memos 방식 사용)
    // window.openMemoModal = openMemoModal;
    // window.editMemo = editMemo;
    // window.deleteMemo = deleteMemo;
    
    // 인센티브
    window.openIncentiveModal = openIncentiveModal;
    window.saveIncentive = saveIncentive;
    window.deleteIncentive = deleteIncentive;
    window.editIncentive = openIncentiveModal;  // editIncentive는 openIncentiveModal과 동일
    
    // 공실
    window.editVacancy = editVacancy;
    window.saveVacancyEdit = saveVacancyEdit;
    window.deleteVacancy = deleteVacancy;
    window.closeVacancyModal = closeVacancyModal;
    
    // ★ 이슈3: 공실 이관
    window.openTransferVacancyModal = openTransferVacancyModal;
    window.searchTransferBuilding = searchTransferBuilding;
    window.executeTransferVacancy = executeTransferVacancy;
    window.closeTransferVacancyModal = closeTransferVacancyModal;
    
    // ★ 페이지 매핑 변경
    window.openPageMappingModal = openPageMappingModal;
    window.previewNewPage = previewNewPage;
    window.previewCustomUrl = previewCustomUrl;
    window.executePageMappingChange = executePageMappingChange;
    window.closePageMappingModal = closePageMappingModal;
    
    // ★ OCR 데이터 삭제
    window.deleteOcrData = deleteOcrData;
    window.deleteAllOcrDataForBuilding = deleteAllOcrDataForBuilding;
    
    // ★ OCR 관리 모달
    window.openOcrManageModal = openOcrManageModal;
    window.closeOcrManageModal = closeOcrManageModal;
    window.deleteOcrBySource = deleteOcrBySource;
    window.deleteOcrBySourceAll = deleteOcrBySourceAll;
    window.deleteOcrBySourcePeriod = deleteOcrBySourcePeriod;
    
    // ★ 주소 수정
    window.openAddressEditModal = openAddressEditModal;
    window.closeAddressEditModal = closeAddressEditModal;
    window.saveAddressEdit = saveAddressEdit;
    
    // 기준가
    window.openPricingModal = openPricingModal;
    window.editPricing = editPricing;
    window.deletePricing = deletePricing;
    
    // 담당자
    window.openContactModal = openContactModal;
    window.editContact = editContact;
    window.deleteContact = deleteContact;
    
    // 빌딩 삭제/숨기기/복원
    window.handleBuildingDelete = handleBuildingDelete;
    window.handleBuildingHide = handleBuildingHide;
    window.handleBuildingPermanentDelete = handleBuildingPermanentDelete;
    window.confirmBuildingDelete = confirmBuildingDelete;
    window.handleBuildingRestore = handleBuildingRestore;
    
    // 빌딩 노트
    window.openBuildingNoteModal = openBuildingNoteModal;
    
    // 권역 저장
    window.saveAutoDetectedRegion = saveAutoDetectedRegion;
    
    // 담당자 지정
    window.openAssignManagerModal = openAssignManagerModal;
    window.saveAssignedManager = saveAssignedManager;
    
    // ★ 빌딩 정보 편집 모달
    window.openBuildingEditModal = openBuildingEditModal;

    // ★ refreshAfterCrud를 window에 노출 (portal.html 인라인 스크립트에서 사용)
    window.refreshAfterCrud = refreshAfterCrud;
    
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
                refreshAfterCrud(renderRentrollSection);
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
            
            // 필수 상태 체크
            if (!state.selectedBuilding) {
                showToast('빌딩을 먼저 선택해주세요', 'error');
                return;
            }
            
            const id = document.getElementById('memoId').value;
            const content = document.getElementById('memoText').value?.trim();
            
            if (!content) {
                showToast('메모 내용을 입력해주세요', 'warning');
                return;
            }
            
            const data = {
                buildingId: state.selectedBuilding.name,
                buildingName: state.selectedBuilding.name,
                content: content,
                pinned: document.getElementById('memoPinned')?.checked || false,
                showInLeasingGuide: document.getElementById('memoShowInGuide')?.checked || false,
                author: state.currentUser?.name || state.currentUser?.email?.split('@')[0] || 'unknown',
                createdBy: state.currentUser?.email || 'unknown',
                createdAt: new Date().toISOString()
            };
            try {
                if (id) {
                    await update(ref(db, `memos/${id}`), data);
                    data.id = id;
                    state.dataCache.memos[id] = { ...state.dataCache.memos[id], ...data };
                    
                    // ★ selectedBuilding.memos 직접 업데이트
                    if (state.selectedBuilding.memos) {
                        const idx = state.selectedBuilding.memos.findIndex(m => m.id === id);
                        if (idx >= 0) {
                            state.selectedBuilding.memos[idx] = { ...state.selectedBuilding.memos[idx], ...data };
                        }
                    }
                } else {
                    const nr = push(ref(db, 'memos'));
                    data.id = nr.key;
                    await set(nr, data);
                    state.dataCache.memos[nr.key] = data;
                    
                    // ★ selectedBuilding.memos에 직접 추가
                    if (!state.selectedBuilding.memos) {
                        state.selectedBuilding.memos = [];
                    }
                    state.selectedBuilding.memos.push(data);
                }
                
                // ★ 메모 개수 배지 업데이트
                const memoCountEl = document.getElementById('memoCount');
                if (memoCountEl && state.selectedBuilding.memos) {
                    memoCountEl.textContent = state.selectedBuilding.memos.length;
                }
                
                closeModal('memoModal');
                refreshAfterCrud(renderMemoSection);
                showToast('저장되었습니다', 'success');
            } catch (err) {
                console.error('메모 저장 오류:', err);
                showToast('저장 실패: ' + (err.message || '알 수 없는 오류'), 'error');
            }
        });
    }
    
    // 인센티브 폼
    const incentiveForm = document.getElementById('incentiveForm');
    if (incentiveForm) {
        incentiveForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = {
                id: document.getElementById('incentiveId').value,
                rentFree: document.getElementById('incentiveRentFree').value,
                fitOut: document.getElementById('incentiveFitOut').value,
                ti: document.getElementById('incentiveTI').value,
                condition: document.getElementById('incentiveCondition').value,
                startDate: document.getElementById('incentiveStartDate').value,
                endDate: document.getElementById('incentiveEndDate').value,
                note: document.getElementById('incentiveNote').value
            };
            
            await saveIncentive(formData);
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
            
            // ★ effectiveDate 기본값: 현재 연월 (YY.MM 형식)
            const now = new Date();
            const defaultEffectiveDate = `${String(now.getFullYear()).slice(-2)}.${String(now.getMonth() + 1).padStart(2, '0')}`;
            
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
                effectiveDate: document.getElementById('pricingEffectiveDate').value || defaultEffectiveDate,  // ★ 기본값 적용
                sourceCompany: 'manual',  // ★ 출처: 수동 입력
                sourceType: 'manual',
                notes: document.getElementById('pricingNotes').value.trim() || null,
                updatedAt: new Date().toISOString(),
                updatedBy: state.currentUser?.email || 'unknown'
            };
            
            try {
                let floorPricing = state.selectedBuilding.floorPricing || [];
                const existingIdx = floorPricing.findIndex(p => p.id === id);
                if (existingIdx >= 0) {
                    // ★ 수정 시 기존 createdAt, sourceCompany 유지
                    newPricing.createdAt = floorPricing[existingIdx].createdAt;
                    newPricing.sourceCompany = floorPricing[existingIdx].sourceCompany || 'manual';
                    newPricing.sourceType = floorPricing[existingIdx].sourceType || 'manual';
                    floorPricing[existingIdx] = { ...floorPricing[existingIdx], ...newPricing };
                } else {
                    newPricing.createdAt = new Date().toISOString();
                    floorPricing.push(newPricing);
                }
                
                await update(ref(db, `buildings/${state.selectedBuilding.id}`), { floorPricing });
                state.selectedBuilding.floorPricing = floorPricing;
                syncBuildingCache(state.selectedBuilding.id, { floorPricing });
                closeModal('pricingModal');
                refreshAfterCrud([renderPricingSection, renderInfoSection]);
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
                syncBuildingCache(state.selectedBuilding.id, { contactPoints });
                closeModal('contactModal');
                refreshAfterCrud(renderContactSection);
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
                syncBuildingCache(state.selectedBuilding.id, { notes });
                closeModal('buildingNoteModal');
                refreshAfterCrud(renderInfoSection);
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
                    // 기본 정보
                    name: document.getElementById('editBuildingName')?.value || state.selectedBuilding.name,
                    grade: document.getElementById('editGrade')?.value || '',
                    
                    // 기준층 정보
                    typicalFloorPy: parseFloat(document.getElementById('editTypicalFloorPy')?.value) || null,
                    typicalFloorLeasePy: parseFloat(document.getElementById('editTypicalFloorLeasePy')?.value) || null,
                    exclusiveRate: parseFloat(document.getElementById('editExclusiveRate')?.value) || null,
                    
                    // 임대조건
                    depositPy: document.getElementById('editDepositPy')?.value || '',
                    rentPy: document.getElementById('editRentPy')?.value || '',
                    maintenancePy: document.getElementById('editMaintenancePy')?.value || '',
                    
                    // 시설 정보
                    hvac: document.getElementById('editHvac')?.value || '',
                    ceilingHeight: document.getElementById('editCeilingHeight')?.value || '',
                    floorLoad: document.getElementById('editFloorLoad')?.value || '',
                    
                    // 주차/인근역
                    parkingRatio: document.getElementById('editParkingRatio')?.value || '',
                    nearbyStation: document.getElementById('editNearbyStation')?.value || '',
                    
                    // 관리 정보
                    pm: document.getElementById('editPm')?.value || '',
                    owner: document.getElementById('editOwner')?.value || '',
                    
                    // ★ 채권분석 정보 (LG그룹용)
                    bondStatus: document.getElementById('editBondStatus')?.value || '',
                    jointCollateral: document.getElementById('editJointCollateral')?.value || '',
                    seniorLien: document.getElementById('editSeniorLien')?.value || '',
                    collateralRatio: document.getElementById('editCollateralRatio')?.value || '',
                    officialLandPrice: document.getElementById('editOfficialLandPrice')?.value || '',
                    landPriceApplied: document.getElementById('editLandPriceApplied')?.value || '',
                    
                    // 기타 정보
                    description: document.getElementById('editDescription')?.value || '',
                    url: document.getElementById('editUrl')?.value || '',
                    
                    // 메타 정보
                    updatedAt: new Date().toISOString(),
                    updatedBy: state.currentUser?.email
                };
                
                // null 값 필터링 (빈 문자열은 유지)
                Object.keys(updates).forEach(key => {
                    if (updates[key] === null) delete updates[key];
                });
                
                await update(ref(db, `buildings/${state.selectedBuilding.id}`), updates);
                Object.assign(state.selectedBuilding, updates);
                syncBuildingCache(state.selectedBuilding.id, updates);
                
                closeModal('buildingEditModal');
                refreshAfterCrud(renderInfoSection);
                showToast('빌딩 정보가 저장되었습니다', 'success');
            } catch (err) {
                console.error(err);
                showToast('저장 실패', 'error');
            }
        });
    }
}
