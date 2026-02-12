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

// 건축물대장 필드 매핑 (building-register.html 구조에 맞춤)
// Firebase 저장 경로와 표시 라벨, API에서 추출하는 방법 정의
const LEDGER_FIELD_MAP = {
    // 루트 레벨 필드
    completionYear: { 
        label: '준공년도', 
        path: 'completionYear',
        extract: (info) => info.useAprDay ? info.useAprDay.substring(0, 4) : null,
        getCurrent: (b) => b.completionYear
    },
    
    // floors 객체 필드
    'floors/above': { 
        label: '지상층수', 
        path: 'floors/above',
        extract: (info) => info.grndFlrCnt ? parseInt(info.grndFlrCnt) : null,
        getCurrent: (b) => b.floors?.above
    },
    'floors/below': { 
        label: '지하층수', 
        path: 'floors/below',
        extract: (info) => info.ugrndFlrCnt ? parseInt(info.ugrndFlrCnt) : null,
        getCurrent: (b) => b.floors?.below
    },
    'floors/display': { 
        label: '층수 표시', 
        path: 'floors/display',
        extract: (info) => {
            const above = info.grndFlrCnt || 0;
            const below = info.ugrndFlrCnt || 0;
            if (above || below) {
                return `지하${below}층/지상${above}층`;
            }
            return null;
        },
        getCurrent: (b) => b.floors?.display || b.floors
    },
    
    // area 객체 필드
    'area/grossFloorSqm': { 
        label: '연면적(㎡)', 
        path: 'area/grossFloorSqm',
        extract: (info) => info.totArea ? Math.round(info.totArea) : null,
        getCurrent: (b) => b.area?.grossFloorSqm || b.grossFloorSqm
    },
    'area/grossFloorPy': { 
        label: '연면적(평)', 
        path: 'area/grossFloorPy',
        extract: (info) => info.totArea ? Math.round(info.totArea / 3.3058) : null,
        getCurrent: (b) => b.area?.grossFloorPy || b.grossFloorPy
    },
    'area/landArea': { 
        label: '대지면적(㎡)', 
        path: 'area/landArea',
        extract: (info) => info.platArea ? Math.round(info.platArea) : null,
        getCurrent: (b) => b.area?.landArea || b.landArea
    },
    'area/buildingArea': { 
        label: '건축면적(㎡)', 
        path: 'area/buildingArea',
        extract: (info) => info.archArea ? Math.round(info.archArea) : null,
        getCurrent: (b) => b.area?.buildingArea || b.buildingArea
    },
    
    // specs 객체 필드
    'specs/passengerElevator': { 
        label: '승용 엘리베이터', 
        path: 'specs/passengerElevator',
        extract: (info) => info.rideUseElvtCnt ? parseInt(info.rideUseElvtCnt) : null,
        getCurrent: (b) => b.specs?.passengerElevator || b.passengerElevator
    },
    'specs/freightElevator': { 
        label: '비상용 엘리베이터', 
        path: 'specs/freightElevator',
        extract: (info) => info.emgenUseElvtCnt ? parseInt(info.emgenUseElvtCnt) : null,
        getCurrent: (b) => b.specs?.freightElevator || b.freightElevator
    },
    'specs/structure': { 
        label: '구조', 
        path: 'specs/structure',
        extract: (info) => info.strctCdNm || null,
        getCurrent: (b) => b.specs?.structure || b.structure
    },
    'specs/buildingUse': { 
        label: '건물용도', 
        path: 'specs/buildingUse',
        extract: (info) => info.mainPurpose || null,
        getCurrent: (b) => b.specs?.buildingUse || b.buildingUse
    },
    
    // parking 객체 필드
    'parking/total': { 
        label: '주차대수', 
        path: 'parking/total',
        extract: (info) => info.totPkngCnt ? parseInt(info.totPkngCnt) : null,
        getCurrent: (b) => b.parking?.total || b.parkingTotal
    },
    
    // 비율 정보 (루트 레벨)
    vlRat: { 
        label: '용적률(%)', 
        path: 'vlRat',
        extract: (info) => info.vlRat ? parseFloat(info.vlRat).toFixed(2) : null,
        getCurrent: (b) => b.vlRat || b.floorAreaRatio
    },
    bcRat: { 
        label: '건폐율(%)', 
        path: 'bcRat',
        extract: (info) => info.bcRat ? parseFloat(info.bcRat).toFixed(2) : null,
        getCurrent: (b) => b.bcRat || b.buildingCoverageRatio
    },
    
    // 주용도 (루트 레벨에도 저장)
    mainPurpose: { 
        label: '주용도', 
        path: 'mainPurpose',
        extract: (info) => info.mainPurpose || null,
        getCurrent: (b) => b.mainPurpose || b.specs?.buildingUse || b.buildingUse
    }
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
        console.log('건축물대장 buildingInfo:', info);
        console.log('=== API 응답 주요 필드 ===');
        console.log('연면적(totArea):', info?.totArea);
        console.log('대지면적(platArea):', info?.platArea);
        console.log('건축면적(archArea):', info?.archArea);
        console.log('지상층수(grndFlrCnt):', info?.grndFlrCnt);
        console.log('지하층수(ugrndFlrCnt):', info?.ugrndFlrCnt);
        console.log('용적률(vlRat):', info?.vlRat);
        console.log('건폐율(bcRat):', info?.bcRat);
        console.log('주용도(mainPurpose):', info?.mainPurpose);
        console.log('구조(strctCdNm):', info?.strctCdNm);
        console.log('주차(totPkngCnt):', info?.totPkngCnt);
        console.log('승용EV(rideUseElvtCnt):', info?.rideUseElvtCnt);
        console.log('비상EV(emgenUseElvtCnt):', info?.emgenUseElvtCnt);
        
        if (!info) {
            showToast('건축물대장 상세 정보가 없습니다', 'warning');
            return;
        }
        
        // 변경사항 수집 (새로운 필드 매핑 사용)
        const changes = [];
        const updateData = {};
        
        for (const [fieldKey, fieldConfig] of Object.entries(LEDGER_FIELD_MAP)) {
            const newValue = fieldConfig.extract(info);
            if (newValue === null || newValue === undefined) continue;
            
            // getCurrent 함수로 현재 값 가져오기
            const currentValue = fieldConfig.getCurrent(b);
            const newValueStr = String(newValue);
            const currentValueStr = currentValue !== null && currentValue !== undefined ? String(currentValue) : '';
            
            // 값이 다르거나 비어있으면 업데이트 대상
            if (!currentValueStr || currentValueStr !== newValueStr) {
                changes.push({
                    field: fieldKey,
                    path: fieldConfig.path,
                    label: fieldConfig.label,
                    oldValue: currentValueStr || '-',
                    newValue: newValueStr
                });
                updateData[fieldConfig.path] = newValue;
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
                            <input type="checkbox" id="ledgerFieldPortal_${idx}" data-path="${c.path}" checked style="width: 18px; height: 18px; cursor: pointer;">
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
    
    // 선택된 필드만 추출 (Firebase 경로 형식 사용)
    const firebaseUpdates = {};
    let selectedCount = 0;
    
    document.querySelectorAll('#ledgerChangesListPortal input[type="checkbox"]:checked').forEach(cb => {
        const path = cb.dataset.path;  // 'floors/above', 'area/grossFloorSqm' 등
        if (path && updateData[path] !== undefined) {
            firebaseUpdates[path] = updateData[path];
            selectedCount++;
        }
    });
    
    if (selectedCount === 0) {
        showToast('적용할 항목을 선택해주세요', 'warning');
        return;
    }
    
    // floors/above 또는 floors/below가 있으면 floors/display도 자동 추가
    if (firebaseUpdates['floors/above'] !== undefined || firebaseUpdates['floors/below'] !== undefined) {
        const above = firebaseUpdates['floors/above'] ?? updateData['floors/above'] ?? state.selectedBuilding?.floors?.above ?? 0;
        const below = firebaseUpdates['floors/below'] ?? updateData['floors/below'] ?? state.selectedBuilding?.floors?.below ?? 0;
        firebaseUpdates['floors/display'] = `지하${below}층/지상${above}층`;
        console.log('floors/display 자동 생성:', firebaseUpdates['floors/display']);
    }
    
    try {
        // 갱신 정보 추가
        firebaseUpdates.lastLedgerUpdateAt = new Date().toISOString();
        firebaseUpdates.lastLedgerUpdateBy = state.currentUser?.email || 'unknown';
        
        console.log('=== 건축물대장 저장 시작 ===');
        console.log('빌딩 ID:', buildingId);
        console.log('Firebase 저장 데이터:', JSON.stringify(firebaseUpdates, null, 2));
        
        // Firebase 업데이트 (경로 형식으로 중첩 객체 업데이트)
        await update(ref(db, `buildings/${buildingId}`), firebaseUpdates);
        console.log('Firebase 저장 성공!');
        
        // 로컬 상태 업데이트 헬퍼 함수
        const applyUpdatesToObject = (obj) => {
            if (!obj) return;
            for (const [path, value] of Object.entries(firebaseUpdates)) {
                if (path.includes('/')) {
                    const [parent, child] = path.split('/');
                    if (!obj[parent] || typeof obj[parent] !== 'object' || Array.isArray(obj[parent])) {
                        obj[parent] = {};
                    }
                    obj[parent][child] = value;
                } else {
                    obj[path] = value;
                }
            }
        };
        
        // 1. state.selectedBuilding 업데이트
        applyUpdatesToObject(state.selectedBuilding);
        console.log('state.selectedBuilding 업데이트 완료');
        
        // 2. state.selectedBuilding._raw 업데이트
        if (state.selectedBuilding._raw) {
            applyUpdatesToObject(state.selectedBuilding._raw);
            console.log('state.selectedBuilding._raw 업데이트 완료');
        }
        
        // 3. state.buildings 배열에서 해당 빌딩 업데이트
        if (state.buildings && Array.isArray(state.buildings)) {
            const buildingIndex = state.buildings.findIndex(b => b.id === buildingId);
            if (buildingIndex !== -1) {
                applyUpdatesToObject(state.buildings[buildingIndex]);
                console.log('state.buildings[' + buildingIndex + '] 업데이트 완료');
            } else {
                console.log('state.buildings에서 빌딩을 찾지 못함');
            }
        } else {
            console.log('state.buildings가 없거나 배열이 아님');
        }
        
        // 4. state.allBuildings가 있으면 업데이트
        if (state.allBuildings && Array.isArray(state.allBuildings)) {
            const allBuildingIndex = state.allBuildings.findIndex(b => b.id === buildingId);
            if (allBuildingIndex !== -1) {
                applyUpdatesToObject(state.allBuildings[allBuildingIndex]);
                console.log('state.allBuildings[' + allBuildingIndex + '] 업데이트 완료');
            }
        }
        
        console.log('=== 건축물대장 저장 완료 ===');
        console.log('저장된 state.selectedBuilding:', state.selectedBuilding);
        
        // UI 새로고침
        if (typeof renderInfoSection === 'function') {
            renderInfoSection();
        }
        
        closeLedgerModalPortal();
        showToast(`${selectedCount}개 항목이 갱신되었습니다 ✅`, 'success');
        
    } catch (error) {
        console.error('=== 건축물대장 저장 오류 ===');
        console.error('오류 내용:', error);
        console.error('오류 메시지:', error.message);
        showToast('정보 저장 중 오류가 발생했습니다', 'error');
    }
};

// ===== 빌딩 정보 편집 =====
// ★ v4.1: portal-detail.js로 이동됨 (openBuildingEditModal, saveBuildingEdit)

// ===== 전역 함수 등록 =====

export function registerMiscGlobals() {
    window.createLeasingGuide = createLeasingGuide;
    window.exportSelected = exportSelected;
    window.refreshBuildingLedger = refreshBuildingLedger;
    // ★ v4.1: openBuildingEditModal, saveBuildingEdit는 portal-detail.js에서 등록
    // 건축물대장 관련 함수들은 위에서 window에 직접 등록됨
    // (closeLedgerModalPortal, toggleLedgerSelectAllPortal, applyLedgerChangesPortal)
}
