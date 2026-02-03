/**
 * CRE Portal - 기타 기능 모듈
 * 건축물대장 갱신, 내보내기, 임대안내문 생성 등
 */

import { state, API_BASE_URL } from './portal-state.js';
import { db, ref, update } from './portal-firebase.js';
import { showToast } from './portal-utils.js';
import { renderInfoSection } from './portal-detail.js';

// ===== 임대안내문 생성 =====

export function createLeasingGuide() {
    if (!state.selectedBuilding) {
        showToast('빌딩을 먼저 선택해주세요', 'error');
        return;
    }
    
    // 임대안내문 페이지로 이동 (빌딩 ID 전달)
    window.location.href = `leasing-guide.html?building=${state.selectedBuilding.id}`;
}

// ===== 선택 내보내기 =====

export function exportSelected() {
    if (state.selectedVacancies.size === 0) {
        showToast('선택된 공실이 없습니다', 'error');
        return;
    }
    showToast(`${state.selectedVacancies.size}건 내보내기 준비중...`, 'info');
    // TODO: Excel 내보내기 기능 구현
}

// ===== 건축물대장 갱신 =====

// 건축물대장 API URL (building-register.html과 동일)
const LEDGER_API_URL = 'https://portal-dsyl.onrender.com';

// 건축물대장 필드 매핑
const LEDGER_FIELD_MAP = {
    completionYear: { label: '준공년도', extract: (info) => info.useAprDay ? info.useAprDay.substring(0, 4) : null },
    floorsAbove: { label: '지상층수', extract: (info) => info.grndFlrCnt },
    floorsBelow: { label: '지하층수', extract: (info) => info.ugrndFlrCnt },
    floors: { label: '층수', extract: (info) => {
        const above = info.grndFlrCnt || 0;
        const below = info.ugrndFlrCnt || 0;
        if (above || below) {
            return `지하${below}층/지상${above}층`;
        }
        return null;
    }},
    grossFloorSqm: { label: '연면적(㎡)', extract: (info) => info.totArea ? Math.round(info.totArea) : null },
    grossFloorPy: { label: '연면적(평)', extract: (info) => info.totArea ? Math.round(info.totArea / 3.3058) : null },
    landAreaSqm: { label: '대지면적(㎡)', extract: (info) => info.platArea ? Math.round(info.platArea) : null },
    landArea: { label: '대지면적(평)', extract: (info) => info.platArea ? Math.round(info.platArea / 3.3058) : null },
    buildingAreaSqm: { label: '건축면적(㎡)', extract: (info) => info.archArea ? Math.round(info.archArea) : null },
    buildingArea: { label: '건축면적(평)', extract: (info) => info.archArea ? Math.round(info.archArea / 3.3058) : null },
    passengerElevator: { label: '승용 엘리베이터', extract: (info) => info.rideUseElvtCnt },
    freightElevator: { label: '비상용 엘리베이터', extract: (info) => info.emgenUseElvtCnt },
    parkingTotal: { label: '주차대수', extract: (info) => info.totPkngCnt },
    structure: { label: '구조', extract: (info) => info.strctCdNm },
    buildingUse: { label: '건물용도', extract: (info) => info.mainPurpsCdNm }
};

export async function refreshBuildingLedger() {
    if (!state.selectedBuilding) {
        showToast('빌딩을 선택해주세요', 'error');
        return;
    }
    
    const b = state.selectedBuilding;
    const address = b.address || b.addressJibun || '';
    
    if (!address) {
        showToast('주소 정보가 없습니다', 'error');
        return;
    }
    
    showToast('건축물대장 정보를 조회 중...', 'info');
    
    try {
        const response = await fetch(`${LEDGER_API_URL}/api/building-register/search?address=${encodeURIComponent(address)}`);
        const data = await response.json();
        
        console.log('건축물대장 API 응답:', data);
        
        if (!data.success || !data.results || data.results.length === 0) {
            showToast('건축물대장 정보를 찾을 수 없습니다', 'warning');
            return;
        }
        
        // 첫 번째 결과 사용 (또는 빌딩명이 일치하는 결과 찾기)
        let selectedResult = data.results[0];
        
        // 빌딩명으로 매칭 시도
        if (data.results.length > 1 && b.name) {
            const matched = data.results.find(r => {
                const resultName = r.buildingName || r.buildingInfo?.buildingName || '';
                return resultName.includes(b.name) || b.name.includes(resultName);
            });
            if (matched) selectedResult = matched;
        }
        
        const info = selectedResult.buildingInfo;
        if (!info) {
            showToast('건축물대장 상세 정보가 없습니다', 'warning');
            return;
        }
        
        // 변경사항 수집
        const changes = [];
        const updateData = {};
        
        for (const [fieldKey, fieldConfig] of Object.entries(LEDGER_FIELD_MAP)) {
            const newValue = fieldConfig.extract(info);
            if (newValue === null || newValue === undefined) continue;
            
            const currentValue = b[fieldKey];
            const newValueStr = String(newValue);
            const currentValueStr = currentValue ? String(currentValue) : '';
            
            // 값이 다르거나 비어있으면 업데이트 대상
            if (!currentValueStr || currentValueStr !== newValueStr) {
                changes.push({
                    field: fieldKey,
                    label: fieldConfig.label,
                    oldValue: currentValueStr || '-',
                    newValue: newValueStr
                });
                updateData[fieldKey] = newValue;
            }
        }
        
        if (changes.length === 0) {
            showToast('모든 정보가 최신 상태입니다 ✅', 'success');
            return;
        }
        
        // 변경사항 확인 모달 표시
        showLedgerCompareModalPortal(changes, updateData, b.id);
        
    } catch (error) {
        console.error('건축물대장 조회 오류:', error);
        showToast('건축물대장 조회 중 오류가 발생했습니다', 'error');
    }
}

// 건축물대장 비교 모달 표시 (portal.html용)
function showLedgerCompareModalPortal(changes, updateData, buildingId) {
    // 기존 모달이 있으면 제거
    let modal = document.getElementById('ledgerUpdateModalPortal');
    if (modal) modal.remove();
    
    // 모달 생성
    modal = document.createElement('div');
    modal.id = 'ledgerUpdateModalPortal';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 10001; display: flex; align-items: center; justify-content: center;';
    
    modal.innerHTML = `
        <div style="background: white; border-radius: 12px; width: 90%; max-width: 500px; max-height: 80vh; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
            <div style="padding: 16px 20px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: white; display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; font-size: 16px;">🔄 건축물대장 정보 갱신</h3>
                <button onclick="closeLedgerModalPortal()" style="background: none; border: none; color: white; font-size: 20px; cursor: pointer;">×</button>
            </div>
            <div style="padding: 16px 20px; max-height: 50vh; overflow-y: auto;">
                <div style="padding: 10px 14px; background: #dbeafe; border-radius: 8px; margin-bottom: 16px; font-size: 13px; color: #1e40af;">
                    💡 ${changes.length}개 항목이 변경되었습니다. 적용할 항목을 선택하세요.
                </div>
                <div id="ledgerChangesListPortal">
                    ${changes.map((c, idx) => `
                        <div style="display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px;">
                            <input type="checkbox" id="ledgerFieldPortal_${idx}" data-field="${c.field}" checked style="width: 18px; height: 18px; cursor: pointer;">
                            <div style="flex: 1;">
                                <div style="font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">${c.label}</div>
                                <div style="display: flex; align-items: center; gap: 8px; font-size: 12px;">
                                    <span style="color: #ef4444; text-decoration: line-through;">${c.oldValue}</span>
                                    <span style="color: #9ca3af;">→</span>
                                    <span style="color: #10b981; font-weight: 600;">${c.newValue}</span>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div style="padding: 12px 20px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; background: #f9fafb;">
                <label style="font-size: 12px; color: #6b7280; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="checkbox" id="ledgerSelectAllPortal" checked onchange="toggleLedgerSelectAllPortal(this.checked)">
                    전체 선택
                </label>
                <div style="display: flex; gap: 8px;">
                    <button onclick="closeLedgerModalPortal()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; font-size: 13px;">취소</button>
                    <button onclick="applyLedgerChangesPortal('${buildingId}')" style="padding: 8px 16px; border: none; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; font-size: 13px; font-weight: 500;">적용</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 클릭으로 닫기
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeLedgerModalPortal();
    });
    
    // 데이터 저장
    window._ledgerUpdateDataPortal = updateData;
    window._ledgerChangesPortal = changes;
}

// 모달 닫기
window.closeLedgerModalPortal = function() {
    const modal = document.getElementById('ledgerUpdateModalPortal');
    if (modal) modal.remove();
    window._ledgerUpdateDataPortal = null;
    window._ledgerChangesPortal = null;
};

// 전체 선택/해제
window.toggleLedgerSelectAllPortal = function(checked) {
    document.querySelectorAll('#ledgerChangesListPortal input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
    });
};

// 변경사항 적용
window.applyLedgerChangesPortal = async function(buildingId) {
    const updateData = window._ledgerUpdateDataPortal;
    const changes = window._ledgerChangesPortal;
    
    if (!updateData || !changes) {
        showToast('적용할 데이터가 없습니다', 'error');
        return;
    }
    
    // 선택된 필드만 추출
    const selectedFields = {};
    let selectedCount = 0;
    
    document.querySelectorAll('#ledgerChangesListPortal input[type="checkbox"]:checked').forEach(cb => {
        const field = cb.dataset.field;
        if (field && updateData[field] !== undefined) {
            selectedFields[field] = updateData[field];
            selectedCount++;
        }
    });
    
    if (selectedCount === 0) {
        showToast('적용할 항목을 선택해주세요', 'warning');
        return;
    }
    
    try {
        // Firebase 업데이트
        selectedFields.lastLedgerUpdateAt = new Date().toISOString();
        selectedFields.lastLedgerUpdateBy = state.currentUser?.email || 'unknown';
        
        await update(ref(db, `buildings/${buildingId}`), selectedFields);
        
        // 로컬 상태 업데이트
        Object.assign(state.selectedBuilding, selectedFields);
        if (state.selectedBuilding._raw) {
            Object.assign(state.selectedBuilding._raw, selectedFields);
        }
        
        // UI 새로고침
        if (typeof renderInfoSection === 'function') {
            renderInfoSection();
        }
        
        closeLedgerModalPortal();
        showToast(`${selectedCount}개 항목이 갱신되었습니다 ✅`, 'success');
        
    } catch (error) {
        console.error('건축물대장 정보 저장 오류:', error);
        showToast('정보 저장 중 오류가 발생했습니다', 'error');
    }
};

// ===== 빌딩 정보 편집 =====

export function openBuildingEditModal() {
    if (!state.selectedBuilding) return;
    
    const b = state.selectedBuilding;
    
    // 폼에 현재 값 채우기
    document.getElementById('editDepositPy').value = b.depositPy || '';
    document.getElementById('editRentPy').value = b.rentPy || '';
    document.getElementById('editMaintenancePy').value = b.maintenancePy || '';
    document.getElementById('editExclusiveRate').value = b.exclusiveRate || '';
    document.getElementById('editTypicalFloorPy').value = b.typicalFloorPy || '';
    document.getElementById('editTypicalFloorLeasePy').value = b.typicalFloorLeasePy || '';
    document.getElementById('editGrade').value = b.grade || '';
    document.getElementById('editPm').value = b.pm || '';
    document.getElementById('editOwner').value = b.owner || '';
    document.getElementById('editNearbyStation').value = b.nearbyStation || '';
    document.getElementById('editDescription').value = b.description || '';
    
    document.getElementById('buildingEditModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

export async function saveBuildingEdit(formData) {
    if (!state.selectedBuilding) return;
    
    try {
        const updates = {
            depositPy: formData.depositPy,
            rentPy: formData.rentPy,
            maintenancePy: formData.maintenancePy,
            exclusiveRate: parseFloat(formData.exclusiveRate) || null,
            typicalFloorPy: parseFloat(formData.typicalFloorPy) || null,
            typicalFloorLeasePy: parseFloat(formData.typicalFloorLeasePy) || null,
            grade: formData.grade,
            pm: formData.pm,
            owner: formData.owner,
            nearbyStation: formData.nearbyStation,
            description: formData.description,
            updatedAt: new Date().toISOString(),
            updatedBy: state.currentUser?.email
        };
        
        await update(ref(db, `buildings/${state.selectedBuilding.id}`), updates);
        
        // 로컬 데이터 업데이트
        Object.assign(state.selectedBuilding, updates);
        
        document.getElementById('buildingEditModal').classList.remove('show');
        document.getElementById('modalOverlay').classList.remove('show');
        
        renderInfoSection();
        showToast('빌딩 정보가 저장되었습니다', 'success');
    } catch (e) {
        console.error(e);
        showToast('저장 실패', 'error');
    }
}

// ===== 전역 함수 등록 =====

export function registerMiscGlobals() {
    window.createLeasingGuide = createLeasingGuide;
    window.exportSelected = exportSelected;
    window.refreshBuildingLedger = refreshBuildingLedger;
    window.selectAllLedgerValues = selectAllLedgerValues;
    window.applyLedgerChanges = applyLedgerChanges;
    window.openBuildingEditModal = openBuildingEditModal;
}
