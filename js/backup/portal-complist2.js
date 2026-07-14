/**
 * CRE Portal - Comp List 모듈 (Redesigned)
 * - 전체 화면 엑셀 스타일 마법사
 * - 인라인 빌딩 검색
 * - 인라인 공실 추가/삭제/편집
 * - 필수값 검증
 */

import { state } from './portal-state.js';
import { db, ref, get, set, push, update, remove } from './portal-firebase.js';
import { showToast, formatNumber } from './portal-utils.js';

// ============================================================
// ★ 공통 헬퍼 함수
// ============================================================

// 외관 이미지 URL 추출 (모든 경로 통합 확인)
function getExteriorUrl(bd) {
    if (bd.exteriorImage) return bd.exteriorImage;
    if (bd.mainImage) return bd.mainImage;
    const ext = bd.images?.exterior;
    if (ext) {
        if (Array.isArray(ext)) {
            const first = ext[0];
            if (!first) return '';
            if (typeof first === 'string') return first;
            if (first.url) return first.url;
        } else if (typeof ext === 'string') return ext;
        else if (ext.url) return ext.url;
    }
    const extImgs = bd.exteriorImages;
    if (extImgs && Array.isArray(extImgs) && extImgs.length > 0) {
        const first = extImgs[0];
        if (typeof first === 'string') return first;
        if (first?.url) return first.url;
    }
    return '';
}

// 원 단위 변환 (만원 단위 → 원 단위 정규화)
function toWon(value) {
    const num = parseFloat(value) || 0;
    if (num === 0) return 0;
    return num < 1000 ? num * 10000 : num;
}

// ============================================================
// Comp List 상태
// ============================================================

export const compListState = {
    currentList: { buildings: [] },
    savedLists: [],
    isFloatingPanelOpen: false,
    isManagePageOpen: false,
    draft: { title: '', type: 'general', buildings: [] },
    selectedBuildingIds: new Set(),
    isSelectionMode: false,
    // 마법사용 상태
    searchQuery: '',
    searchResults: []
};

// ============================================================
// 빌딩 담기/빼기
// ============================================================

// 층 문자열에서 숫자 추출 (예: "10F" → 10, "B1" → -1)
function parseFloorNumber(floorStr) {
    if (!floorStr) return null;
    const str = String(floorStr).toUpperCase().trim();
    
    // 지하층 처리
    const basementMatch = str.match(/B(\d+)/);
    if (basementMatch) {
        return -parseInt(basementMatch[1]);
    }
    
    // 일반층 처리
    const floorMatch = str.match(/(\d+)/);
    if (floorMatch) {
        return parseInt(floorMatch[1]);
    }
    
    return null;
}

// 층이 범위에 포함되는지 확인
function isFloorInRange(floorNum, rangeStr) {
    if (!rangeStr || floorNum === null) return false;
    
    const str = String(rangeStr).toUpperCase().trim();
    
    // 범위 형식 파싱 (예: "15F~20F", "B1~B3")
    const rangeMatch = str.match(/([B]?\d+)[F]?\s*[~\-]\s*([B]?\d+)[F]?/i);
    if (rangeMatch) {
        const start = parseFloorNumber(rangeMatch[1]);
        const end = parseFloorNumber(rangeMatch[2]);
        if (start !== null && end !== null) {
            const min = Math.min(start, end);
            const max = Math.max(start, end);
            return floorNum >= min && floorNum <= max;
        }
    }
    
    // 전층/기준층 처리
    if (str.includes('전층') || str.includes('전체') || str.includes('기준')) {
        return true;
    }
    
    // 단일 층 매칭
    const singleFloor = parseFloorNumber(str);
    if (singleFloor !== null) {
        return floorNum === singleFloor;
    }
    
    return false;
}

// 층에 맞는 기준가 찾기
function findMatchingFloorPricing(floorPricingList, floorStr) {
    if (!floorPricingList || !Array.isArray(floorPricingList) || floorPricingList.length === 0) {
        return null;
    }
    
    const floorNum = parseFloorNumber(floorStr);
    if (floorNum === null) return null;
    
    for (const fp of floorPricingList) {
        if (isFloorInRange(floorNum, fp.floorRange)) {
            return fp;
        }
    }
    
    return null;
}

// 공실에 기준가 자동 적용
function applyFloorPricingToVacancy(vacancy, floorPricing) {
    if (!vacancy || !floorPricing || !Array.isArray(floorPricing)) return vacancy;
    
    const matched = findMatchingFloorPricing(floorPricing, vacancy.floor);
    if (!matched) return vacancy;
    
    // 값이 없거나 0인 경우에만 기준가 적용
    return {
        ...vacancy,
        depositPy: vacancy.depositPy || matched.depositPy || 0,
        rentPy: vacancy.rentPy || matched.rentPy || 0,
        maintenancePy: vacancy.maintenancePy || matched.maintenancePy || 0,
        // 면적도 없으면 기준가에서 가져오기
        rentArea: vacancy.rentArea || matched.rentArea || 0,
        exclusiveArea: vacancy.exclusiveArea || matched.exclusiveArea || 0,
        // 기준가 출처 표시
        _pricingSource: matched.label || '기준가'
    };
}

export function addBuildingToCompList(building, vacancies = []) {
    const exists = compListState.currentList.buildings.find(b => b.buildingId === building.id);
    
    // floorPricing 포함하여 buildingData 구성
    const buildingData = {
        ...building,
        floorPricing: building.floorPricing || []
    };
    
    // 공실에 기준가 자동 적용
    const processedVacancies = vacancies.map(v => 
        applyFloorPricingToVacancy(v, buildingData.floorPricing)
    );
    
    // 기준가 적용된 공실 수 계산
    const pricingAppliedCount = processedVacancies.filter(v => v._pricingSource).length;
    
    if (exists) {
        // 기존 공실에 새 공실 추가
        if (processedVacancies.length > 0) {
            exists.vacancies = [...exists.vacancies, ...processedVacancies];
        }
        // buildingData도 업데이트 (floorPricing이 새로 추가되었을 수 있음)
        exists.buildingData = buildingData;
        
        const pricingMsg = pricingAppliedCount > 0 ? ` (${pricingAppliedCount}개 기준가 적용)` : '';
        showToast(`${building.name} 공실 업데이트${pricingMsg}`, 'info');
    } else {
        compListState.currentList.buildings.push({
            buildingId: building.id,
            buildingName: building.name,
            buildingData: buildingData,
            vacancies: processedVacancies,
            addedAt: new Date().toISOString()
        });
        
        // 기준가 정보 표시
        const fpCount = buildingData.floorPricing?.length || 0;
        let msg = `${building.name} 추가됨`;
        if (fpCount > 0) msg += ` (기준가 ${fpCount}개)`;
        if (pricingAppliedCount > 0) msg += ` - ${pricingAppliedCount}개 공실에 적용`;
        showToast(msg, 'success');
    }
    
    updateFloatingButton();
    saveCurrentListToStorage();
    renderFloatingPanel();
}

export function addBuildingsToCompList(buildings) {
    let addedCount = 0;
    
    buildings.forEach(b => {
        if (!compListState.currentList.buildings.find(item => item.buildingId === b.id)) {
            // floorPricing 포함
            const buildingData = {
                ...b,
                floorPricing: b.floorPricing || []
            };
            
            compListState.currentList.buildings.push({
                buildingId: b.id,
                buildingName: b.name,
                buildingData: buildingData,
                vacancies: [],
                addedAt: new Date().toISOString()
            });
            addedCount++;
        }
    });
    
    if (addedCount > 0) {
        showToast(`${addedCount}개 빌딩 추가됨`, 'success');
        updateFloatingButton();
        saveCurrentListToStorage();
    } else {
        showToast('이미 모두 추가된 빌딩입니다', 'info');
    }
}

export function removeBuildingFromCompList(buildingId) {
    const index = compListState.currentList.buildings.findIndex(b => b.buildingId === buildingId);
    
    if (index > -1) {
        const removed = compListState.currentList.buildings.splice(index, 1)[0];
        showToast(`${removed.buildingName} 제거됨`, 'info');
        updateFloatingButton();
        saveCurrentListToStorage();
        renderFloatingPanel();
    }
}

export function clearCompList() {
    compListState.currentList.buildings = [];
    updateFloatingButton();
    saveCurrentListToStorage();
    renderFloatingPanel();
    showToast('Comp List 비움', 'info');
}

// ============================================================
// 선택 모드 (체크박스)
// ============================================================

export function toggleSelectionMode() {
    compListState.isSelectionMode = !compListState.isSelectionMode;
    compListState.selectedBuildingIds.clear();
    
    const btn = document.getElementById('selectionModeBtn');
    const bar = document.getElementById('selectionActionBar');
    
    if (compListState.isSelectionMode) {
        btn?.classList.add('active');
        bar.style.display = 'flex';
        renderBuildingCheckboxes();
    } else {
        btn?.classList.remove('active');
        bar.style.display = 'none';
        document.querySelectorAll('.building-checkbox').forEach(el => el.remove());
        document.querySelectorAll('.marker-container').forEach(el => el.classList.remove('selected'));
    }
}

export function toggleBuildingSelection(buildingId) {
    if (compListState.selectedBuildingIds.has(buildingId)) {
        compListState.selectedBuildingIds.delete(buildingId);
    } else {
        compListState.selectedBuildingIds.add(buildingId);
    }
    updateSelectionUI();
}

export function toggleSelectAll() {
    const allIds = (state.filteredBuildings || []).map(b => b.id);
    if (compListState.selectedBuildingIds.size === allIds.length) {
        compListState.selectedBuildingIds.clear();
    } else {
        allIds.forEach(id => compListState.selectedBuildingIds.add(id));
    }
    updateSelectionUI();
}

function updateSelectionUI() {
    const count = compListState.selectedBuildingIds.size;
    document.querySelector('.selection-count').textContent = count > 0 ? `${count}개 선택됨` : '빌딩을 선택하세요';
    
    document.querySelectorAll('.building-checkbox input').forEach(cb => {
        cb.checked = compListState.selectedBuildingIds.has(cb.dataset.buildingId);
    });
    
    document.querySelectorAll('.marker-container').forEach(el => {
        el.classList.toggle('selected', compListState.selectedBuildingIds.has(el.dataset.buildingId));
    });
}

export function addSelectedToCompList() {
    const buildings = (state.filteredBuildings || []).filter(b => compListState.selectedBuildingIds.has(b.id));
    if (buildings.length > 0) {
        addBuildingsToCompList(buildings);
        toggleSelectionMode();
    } else {
        showToast('선택된 빌딩이 없습니다', 'warning');
    }
}

export function renderBuildingCheckboxes() {
    document.querySelectorAll('.building-checkbox').forEach(el => el.remove());
    
    document.querySelectorAll('.marker-container').forEach(marker => {
        const id = marker.dataset.buildingId;
        if (!id) return;
        
        const cb = document.createElement('div');
        cb.className = 'building-checkbox';
        cb.innerHTML = `<input type="checkbox" data-building-id="${id}" ${compListState.selectedBuildingIds.has(id) ? 'checked' : ''}>`;
        cb.querySelector('input').onchange = () => toggleBuildingSelection(id);
        marker.appendChild(cb);
    });
}

// ============================================================
// 로컬 스토리지
// ============================================================

function saveCurrentListToStorage() {
    try {
        localStorage.setItem('cre_complist_current', JSON.stringify(compListState.currentList));
    } catch (e) { console.warn('저장 실패:', e); }
}

function loadCurrentListFromStorage() {
    try {
        const saved = localStorage.getItem('cre_complist_current');
        if (saved) compListState.currentList = JSON.parse(saved);
    } catch (e) { console.warn('로드 실패:', e); }
}

// ============================================================
// Firebase CRUD
// ============================================================

export async function saveCompList(data) {
    try {
        const compListRef = push(ref(db, 'compLists'));
        await set(compListRef, {
            id: compListRef.key,
            title: data.title,
            type: data.type,
            status: 'completed',
            buildings: data.buildings.map((b, idx) => ({
                buildingId: b.buildingId,
                buildingName: b.buildingName,
                order: idx + 1,
                vacancies: b.vacancies || []
            })),
            createdBy: {
                id: state.currentUser?.id || '',
                name: state.currentUser?.name || state.currentUser?.email || '',
                email: state.currentUser?.email || ''
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        
        clearCompList();
        showToast('Comp List 저장 완료', 'success');
        return compListRef.key;
    } catch (e) {
        console.error('저장 실패:', e);
        showToast('저장 실패', 'error');
        return null;
    }
}

export async function loadCompLists() {
    try {
        const snapshot = await get(ref(db, 'compLists'));
        const data = snapshot.val() || {};
        compListState.savedLists = Object.values(data).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return compListState.savedLists;
    } catch (e) {
        console.error('로드 실패:', e);
        return [];
    }
}

export async function deleteCompList(compListId) {
    if (!confirm('삭제하시겠습니까?')) return false;
    try {
        await remove(ref(db, `compLists/${compListId}`));
        compListState.savedLists = compListState.savedLists.filter(c => c.id !== compListId);
        showToast('삭제됨', 'success');
        renderManagePage();
        return true;
    } catch (e) {
        showToast('삭제 실패', 'error');
        return false;
    }
}

// ============================================================
// 플로팅 버튼 & 패널
// ============================================================

export function updateFloatingButton() {
    const btn = document.getElementById('compListFloatingBtn');
    if (!btn) return;
    
    const count = compListState.currentList.buildings.length;
    btn.innerHTML = `📋 나의 Comp List ${count > 0 ? `<span class="complist-badge">(${count})</span>` : ''}`;
    
    if (count > 0) {
        btn.classList.add('has-items');
    } else {
        btn.classList.remove('has-items');
    }
}

export function toggleFloatingPanel() {
    compListState.isFloatingPanelOpen = !compListState.isFloatingPanelOpen;
    const panel = document.getElementById('compListFloatingPanel');
    
    if (panel) {
        panel.style.display = compListState.isFloatingPanelOpen ? 'block' : 'none';
        if (compListState.isFloatingPanelOpen) {
            renderFloatingPanel();
        }
    }
}

export function renderFloatingPanel() {
    const panel = document.getElementById('compListFloatingPanel');
    if (!panel) return;
    
    const buildings = compListState.currentList.buildings;
    
    panel.innerHTML = `
        <div class="complist-panel-header">
            <h4>📋 나의 Comp List</h4>
            <button onclick="toggleCompListPanel()" class="complist-close-btn">×</button>
        </div>
        <div class="complist-panel-content">
            ${buildings.length === 0 ? `
                <div class="complist-empty">
                    <p>담긴 빌딩이 없습니다</p>
                    <p style="font-size:12px;color:#888;">지도/검색에서 빌딩 선택</p>
                </div>
            ` : `
                <div class="complist-items">
                    ${buildings.map(b => `
                        <div class="complist-item">
                            <div class="complist-item-info">
                                <div class="complist-item-name" onclick="openDetail('${b.buildingId}')">${b.buildingName}</div>
                                <div class="complist-item-meta">${b.vacancies.length > 0 ? `공실 ${b.vacancies.length}개` : '공실 없음'}</div>
                            </div>
                            <div class="complist-item-actions">
                                <button onclick="removeFromCompList('${b.buildingId}')" class="complist-action-btn" title="제거">🗑️</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `}
        </div>
        <div class="complist-panel-footer">
            ${buildings.length > 0 ? `
                <button onclick="clearCompList()" class="btn btn-secondary btn-sm">비우기</button>
                <button onclick="openCompListWizard()" class="btn btn-primary btn-sm">만들기</button>
            ` : ''}
        </div>
    `;
}

// ============================================================
// 새로운 전체화면 마법사
// ============================================================

export function openCompListWizard() {
    if (compListState.currentList.buildings.length === 0) {
        showToast('빌딩을 먼저 추가하세요', 'warning');
        return;
    }
    
    // draft 초기화 - 깊은 복사
    compListState.draft = {
        title: '',
        type: 'general',
        buildings: JSON.parse(JSON.stringify(compListState.currentList.buildings))
    };
    compListState.searchQuery = '';
    compListState.searchResults = [];
    
    renderFullscreenWizard();
    document.getElementById('compListWizardModal').style.display = 'flex';
}

export function closeCompListWizard() {
    document.getElementById('compListWizardModal').style.display = 'none';
}

export function renderFullscreenWizard() {
    const content = document.getElementById('compListWizardContent');
    if (!content) return;
    
    const { draft, searchQuery, searchResults } = compListState;
    const buildings = draft.buildings;
    
    content.innerHTML = `
        <div class="wizard-fullscreen">
            <!-- 상단 헤더 -->
            <div class="wizard-top-bar">
                <div class="wizard-top-left">
                    <input type="text" id="wizardTitleInput" class="wizard-title-input" 
                           value="${draft.title}" 
                           placeholder="Comp List 제목을 입력하세요..."
                           oninput="updateWizardDraft('title', this.value)">
                </div>
                <div class="wizard-top-center">
                    <div class="wizard-type-buttons">
                        <button class="type-btn ${draft.type === 'general' ? 'active' : ''}" onclick="updateWizardDraft('type', 'general')">📊 일반용</button>
                        <button class="type-btn ${draft.type === 'lg' ? 'active' : ''}" onclick="updateWizardDraft('type', 'lg')">🏢 LG그룹용</button>
                    </div>
                </div>
                <div class="wizard-top-right">
                    <span class="building-count-badge">빌딩 ${buildings.length}개</span>
                </div>
            </div>
            
            <!-- 빌딩 검색 영역 -->
            <div class="wizard-search-area">
                <div class="search-input-container">
                    <input type="text" id="wizardSearchInput" class="wizard-search-input"
                           placeholder="🔍 빌딩명 또는 주소 검색하여 추가..."
                           value="${searchQuery}"
                           oninput="searchBuildingsForWizard(this.value)"
                           onfocus="this.parentElement.classList.add('focused')"
                           onblur="setTimeout(() => this.parentElement.classList.remove('focused'), 200)">
                    ${searchResults.length > 0 ? `
                        <div class="search-results-dropdown">
                            ${searchResults.map(b => `
                                <div class="search-result-item" onmousedown="addBuildingFromSearchResult('${b.id}')">
                                    <span class="result-name">${b.name}</span>
                                    <span class="result-addr">${b.address || ''}</span>
                                </div>
                            `).join('')}
                        </div>
                    ` : searchQuery.length >= 2 ? `
                        <div class="search-results-dropdown">
                            <div class="search-no-result">검색 결과가 없습니다</div>
                        </div>
                    ` : ''}
                </div>
            </div>
            
            <!-- 엑셀 스타일 테이블 -->
            <div class="wizard-table-wrapper">
                <table class="wizard-excel-table">
                    <thead>
                        <tr>
                            <th class="col-no">No.</th>
                            <th class="col-order">순서</th>
                            <th class="col-name">빌딩명</th>
                            <th class="col-addr">주소</th>
                            <th class="col-floor">공실층</th>
                            <th class="col-num">임대면적</th>
                            <th class="col-num">전용면적</th>
                            <th class="col-num">보증금/평</th>
                            <th class="col-num">임대료/평</th>
                            <th class="col-num">관리비/평</th>
                            <th class="col-date">입주시기</th>
                            <th class="col-add">공실</th>
                            <th class="col-vacancy-del">삭제</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${buildings.length === 0 ? `
                            <tr><td colspan="13" class="empty-table-msg">위 검색창에서 빌딩을 추가하세요</td></tr>
                        ` : buildings.map((b, idx) => renderBuildingRowsNew(b, idx)).join('')}
                    </tbody>
                </table>
            </div>
            
            <!-- 하단 버튼 -->
            <div class="wizard-bottom-bar">
                <button onclick="closeCompListWizard()" class="btn btn-secondary">취소</button>
                <button onclick="saveAndDownloadCompList()" class="btn btn-primary">💾 저장 및 다운로드</button>
            </div>
        </div>
    `;
}

function renderBuildingRowsNew(building, buildingIdx) {
    const b = building;
    const bd = b.buildingData || {};
    const vacancies = b.vacancies || [];
    const totalBuildings = compListState.draft.buildings.length;
    
    // 숫자 파싱 헬퍼 (콤마 제거)
    const parseNum = (val) => {
        if (!val || val === '-') return null;
        const num = parseFloat(String(val).replace(/,/g, ''));
        return isNaN(num) ? null : num;
    };
    
    // 숫자 포맷팅
    const fmtNum = (val) => {
        const num = parseNum(val);
        return num !== null ? num.toLocaleString() : '-';
    };
    
    let html = '';
    
    if (vacancies.length === 0) {
        // 공실 없는 빌딩
        html = `
            <tr class="building-row" data-building-id="${b.buildingId}">
                <td class="col-no">${buildingIdx + 1}</td>
                <td class="col-order">
                    <div class="order-buttons">
                        <button onclick="moveWizardBuilding(${buildingIdx}, -1)" ${buildingIdx === 0 ? 'disabled' : ''} class="order-btn">▲</button>
                        <button onclick="moveWizardBuilding(${buildingIdx}, 1)" ${buildingIdx === totalBuildings - 1 ? 'disabled' : ''} class="order-btn">▼</button>
                    </div>
                </td>
                <td class="col-name">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <button onclick="removeWizardBuilding('${b.buildingId}')" class="btn-delete-inline" title="빌딩 삭제">🗑️</button>
                        <span>${b.buildingName}</span>
                    </div>
                </td>
                <td class="col-addr">${bd.address || '-'}</td>
                <td class="col-floor">-</td>
                <td class="col-num">-</td>
                <td class="col-num">-</td>
                <td class="col-num">-</td>
                <td class="col-num">-</td>
                <td class="col-num">-</td>
                <td class="col-date">-</td>
                <td class="col-add"><button onclick="toggleVacancyForm('${b.buildingId}')" class="btn-add-vacancy">공실추가</button></td>
                <td class="col-vacancy-del">-</td>
            </tr>
            <tr class="vacancy-form-row" id="vacancyFormRow_${b.buildingId}" style="display:none;">
                <td colspan="13" style="padding:0;">
                    ${renderInlineVacancyForm(b.buildingId)}
                </td>
            </tr>
        `;
    } else {
        // 공실 있는 빌딩
        const rowCount = vacancies.length;
        
        vacancies.forEach((v, vIdx) => {
            const isFirst = vIdx === 0;
            
            html += `
                <tr class="building-row ${vIdx > 0 ? 'vacancy-sub-row' : ''}" data-building-id="${b.buildingId}" data-vacancy-idx="${vIdx}">
                    ${isFirst ? `
                        <td class="col-no" rowspan="${rowCount}">${buildingIdx + 1}</td>
                        <td class="col-order" rowspan="${rowCount}">
                            <div class="order-buttons">
                                <button onclick="moveWizardBuilding(${buildingIdx}, -1)" ${buildingIdx === 0 ? 'disabled' : ''} class="order-btn">▲</button>
                                <button onclick="moveWizardBuilding(${buildingIdx}, 1)" ${buildingIdx === totalBuildings - 1 ? 'disabled' : ''} class="order-btn">▼</button>
                            </div>
                        </td>
                        <td class="col-name" rowspan="${rowCount}">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <button onclick="removeWizardBuilding('${b.buildingId}')" class="btn-delete-inline" title="빌딩 삭제">🗑️</button>
                                <span>${b.buildingName}</span>
                            </div>
                        </td>
                        <td class="col-addr" rowspan="${rowCount}">${bd.address || '-'}</td>
                    ` : ''}
                    <td class="col-floor">${v.floor || '-'}</td>
                    <td class="col-num">${fmtNum(v.rentArea)}</td>
                    <td class="col-num">${fmtNum(v.exclusiveArea)}</td>
                    <td class="col-num">${fmtNum(v.depositPy)}</td>
                    <td class="col-num rent-value">${fmtNum(v.rentPy)}</td>
                    <td class="col-num">${fmtNum(v.maintenancePy)}</td>
                    <td class="col-date">${v.moveIn || v.moveInDate || '-'}</td>
                    ${isFirst ? `
                        <td class="col-add" rowspan="${rowCount}"><button onclick="toggleVacancyForm('${b.buildingId}')" class="btn-add-vacancy">공실추가</button></td>
                    ` : ''}
                    <td class="col-vacancy-del"><button onclick="removeWizardVacancy('${b.buildingId}', ${vIdx})" class="btn-del-vacancy-row">삭제</button></td>
                </tr>
            `;
        });
        
        // 공실 추가 폼
        html += `
            <tr class="vacancy-form-row" id="vacancyFormRow_${b.buildingId}" style="display:none;">
                <td colspan="13" style="padding:0;">
                    ${renderInlineVacancyForm(b.buildingId)}
                </td>
            </tr>
        `;
    }
    
    return html;
}

function renderInlineVacancyForm(buildingId) {
    // 해당 빌딩의 기준가 목록 가져오기
    const building = compListState.draft.buildings.find(b => b.buildingId === buildingId);
    const floorPricing = building?.buildingData?.floorPricing || [];
    const hasPricing = floorPricing.length > 0;
    const isMultiple = floorPricing.length > 1;
    
    // ★ 해당 빌딩의 기존 공실 목록 가져오기 (state.allBuildings에서)
    const sourceBuilding = (state.allBuildings || []).find(b => b.id === buildingId);
    const existingVacancies = sourceBuilding?.vacancies || [];
    const hasExistingVacancies = existingVacancies.length > 0;
    
    // 이미 추가된 공실 키 목록 (중복 방지용 - _key 기준)
    const addedKeys = new Set((building?.vacancies || []).map(v => v._key || `${v.floor}_${v.source}_${v.publishDate}`));
    // 아직 추가되지 않은 기존 공실만 필터링
    const availableVacancies = existingVacancies.filter(v => {
        const key = v._key || `${v.floor}_${v.source}_${v.publishDate}`;
        return !addedKeys.has(key);
    });
    const hasAvailableVacancies = availableVacancies.length > 0;
    
    // 숫자 파싱 헬퍼 (콤마 제거)
    const parseNum = (val) => {
        if (!val) return '';
        const num = parseFloat(String(val).replace(/,/g, ''));
        return isNaN(num) ? '' : formatNumber(num);
    };
    
    return `
        <div class="inline-vacancy-form">
            ${hasAvailableVacancies ? `
            <!-- 입력 모드 탭 -->
            <div style="display: flex; gap: 0; margin-bottom: 8px;">
                <button type="button" id="vacancyTab_select_${buildingId}" onclick="switchVacancyInputMode('${buildingId}', 'select')"
                        style="padding: 6px 14px; background: #2563eb; color: white; border: none; border-radius: 4px 0 0 4px; font-size: 12px; font-weight: 600; cursor: pointer;">
                    📋 기존 공실 (${availableVacancies.length})
                </button>
                <button type="button" id="vacancyTab_manual_${buildingId}" onclick="switchVacancyInputMode('${buildingId}', 'manual')"
                        style="padding: 6px 14px; background: #e5e7eb; color: #374151; border: none; border-radius: 0 4px 4px 0; font-size: 12px; cursor: pointer;">
                    ✏️ 수동 입력
                </button>
            </div>
            
            <!-- 기존 공실 선택 영역 -->
            <div id="vacancyMode_select_${buildingId}" class="vacancy-mode-panel">
                <div style="max-height: 180px; overflow-y: auto; border: 1px solid #e5e7eb; border-radius: 6px; background: #fafafa;">
                    ${availableVacancies.map((v, idx) => {
                        const rentVal = parseNum(v.rentPy);
                        const mgmtVal = parseNum(v.maintenancePy);
                        const sourceInfo = v.source ? `${v.source}` + (v.publishDate ? ` ${v.publishDate}` : '') : '';
                        return `
                        <div onclick="selectExistingVacancy('${buildingId}', ${idx})"
                             style="padding: 8px 12px; border-bottom: 1px solid #e5e7eb; cursor: pointer; display: flex; justify-content: space-between; align-items: center; gap: 8px;"
                             onmouseover="this.style.background='#dbeafe'" onmouseout="this.style.background='transparent'">
                            <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                                <span style="font-weight: 700; font-size: 13px; color: #1e40af; min-width: 36px;">${v.floor || '-'}</span>
                                <span style="font-size: 12px; color: #374151;">${v.rentArea || '-'}평</span>
                                <span style="font-size: 12px; color: #6b7280;">(전용 ${v.exclusiveArea || '-'})</span>
                                <span style="font-size: 12px; color: #059669; font-weight: 500;">${rentVal ? rentVal + '원' : '-'}</span>
                                <span style="font-size: 11px; color: #6b7280;">${mgmtVal ? '관리비 ' + mgmtVal : ''}</span>
                                <span style="font-size: 11px; color: #9ca3af;">${v.moveInDate || v.moveIn || ''}</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="font-size: 10px; color: #6b7280; background: #f3f4f6; padding: 2px 6px; border-radius: 3px; white-space: nowrap;">${sourceInfo}</span>
                                <span style="color: #2563eb; font-weight: 700;">+</span>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>
            
            <!-- 수동 입력 영역 (숨김) -->
            <div id="vacancyMode_manual_${buildingId}" class="vacancy-mode-panel" style="display: none;">
            ` : ''}
            
            ${hasPricing ? `
            <div class="pricing-selector-row" style="background: linear-gradient(135deg, #fef9c3 0%, #fde68a 100%); padding: 10px 16px; margin-bottom: 12px; border-radius: 8px; border: 1px solid #fbbf24;">
                <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                    <span style="font-size: 12px; font-weight: 600; color: #92400e;">💰 기준가 적용:</span>
                    ${isMultiple ? `
                        <select id="vf_pricingSelect_${buildingId}" 
                                onchange="applySelectedPricing('${buildingId}')"
                                style="padding: 6px 12px; border: 1px solid #fbbf24; border-radius: 6px; background: white; font-size: 12px; min-width: 200px;">
                            <option value="">-- 기준가 선택 (${floorPricing.length}개) --</option>
                            ${floorPricing.map((fp, idx) => `
                                <option value="${idx}">
                                    ${fp.label || fp.floorRange || '기준가 ' + (idx + 1)} : ${formatNumber(fp.rentPy || 0)}원/평
                                </option>
                            `).join('')}
                        </select>
                        <span style="font-size: 11px; color: #a16207;">💡 층 입력 시 자동 매칭</span>
                    ` : `
                        <span style="font-size: 12px; color: #78350f; padding: 6px 12px; background: white; border-radius: 6px; border: 1px solid #fbbf24;">
                            ${floorPricing[0].label || '기준가'}: ${formatNumber(floorPricing[0].rentPy || 0)}원/평
                        </span>
                        <button type="button" onclick="applyPricingByIndex('${buildingId}', 0)" 
                                style="padding: 6px 12px; background: #f59e0b; color: white; border: none; border-radius: 6px; font-size: 11px; cursor: pointer;">
                            적용
                        </button>
                    `}
                </div>
            </div>
            ` : ''}
            <div class="form-grid">
                <div class="form-field">
                    <label>공실층 <span class="required">*</span></label>
                    <input type="text" id="vf_floor_${buildingId}" placeholder="예: 10F" 
                           ${hasPricing && isMultiple ? `onblur="autoMatchPricing('${buildingId}')"` : ''}>
                </div>
                <div class="form-field">
                    <label>임대면적</label>
                    <input type="number" id="vf_rentArea_${buildingId}" placeholder="평">
                </div>
                <div class="form-field">
                    <label>전용면적</label>
                    <input type="number" id="vf_exclusiveArea_${buildingId}" placeholder="평">
                </div>
                <div class="form-field">
                    <label>보증금/평 ${hasPricing ? '<span style="font-size:9px;color:#f59e0b;">⭐기준가</span>' : ''}</label>
                    <input type="number" id="vf_depositPy_${buildingId}" placeholder="원">
                </div>
                <div class="form-field">
                    <label>임대료/평 <span class="required">*</span> ${hasPricing ? '<span style="font-size:9px;color:#f59e0b;">⭐</span>' : ''}</label>
                    <input type="number" id="vf_rentPy_${buildingId}" placeholder="원">
                </div>
                <div class="form-field">
                    <label>관리비/평 ${hasPricing ? '<span style="font-size:9px;color:#f59e0b;">⭐</span>' : ''}</label>
                    <input type="number" id="vf_maintenancePy_${buildingId}" placeholder="원">
                </div>
                <div class="form-field">
                    <label>입주시기</label>
                    <input type="text" id="vf_moveIn_${buildingId}" placeholder="즉시">
                </div>
            </div>
            <div class="form-buttons">
                <button type="button" onclick="toggleVacancyForm('${buildingId}')" class="btn btn-secondary btn-sm">취소</button>
                <button type="button" onclick="saveWizardVacancy('${buildingId}')" class="btn btn-primary btn-sm">추가</button>
            </div>
            
            ${hasAvailableVacancies ? `
            </div><!-- 수동 입력 영역 닫기 -->
            ` : ''}
        </div>
    `;
}

// 공실 입력 모드 전환 (선택 / 수동)
export function switchVacancyInputMode(buildingId, mode) {
    const selectPanel = document.getElementById(`vacancyMode_select_${buildingId}`);
    const manualPanel = document.getElementById(`vacancyMode_manual_${buildingId}`);
    const selectTab = document.getElementById(`vacancyTab_select_${buildingId}`);
    const manualTab = document.getElementById(`vacancyTab_manual_${buildingId}`);
    
    if (mode === 'select') {
        if (selectPanel) selectPanel.style.display = 'block';
        if (manualPanel) manualPanel.style.display = 'none';
        if (selectTab) {
            selectTab.style.background = '#2563eb';
            selectTab.style.color = 'white';
        }
        if (manualTab) {
            manualTab.style.background = '#e5e7eb';
            manualTab.style.color = '#374151';
        }
    } else {
        if (selectPanel) selectPanel.style.display = 'none';
        if (manualPanel) manualPanel.style.display = 'block';
        if (selectTab) {
            selectTab.style.background = '#e5e7eb';
            selectTab.style.color = '#374151';
        }
        if (manualTab) {
            manualTab.style.background = '#2563eb';
            manualTab.style.color = 'white';
        }
    }
}

// 기존 공실 선택하여 바로 추가
export function selectExistingVacancy(buildingId, vacancyIdx) {
    const sourceBuilding = (state.allBuildings || []).find(b => b.id === buildingId);
    const existingVacancies = sourceBuilding?.vacancies || [];
    
    // 이미 추가된 공실 제외하고 인덱스 계산 (_key 기준)
    const building = compListState.draft.buildings.find(b => b.buildingId === buildingId);
    const addedKeys = new Set((building?.vacancies || []).map(v => v._key || `${v.floor}_${v.source}_${v.publishDate}`));
    const availableVacancies = existingVacancies.filter(v => {
        const key = v._key || `${v.floor}_${v.source}_${v.publishDate}`;
        return !addedKeys.has(key);
    });
    
    const selectedVacancy = availableVacancies[vacancyIdx];
    if (!selectedVacancy) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 숫자 파싱 헬퍼 (콤마 제거)
    const parseNumValue = (val) => {
        if (!val) return '';
        const num = parseFloat(String(val).replace(/,/g, ''));
        return isNaN(num) ? '' : num;
    };
    
    // 기준가 자동 적용
    const floorPricing = building?.buildingData?.floorPricing || [];
    const processedVacancy = applyFloorPricingToVacancy(selectedVacancy, floorPricing);
    
    // 공실 추가 (출처 정보 포함)
    if (!building.vacancies) building.vacancies = [];
    building.vacancies.push({
        floor: processedVacancy.floor || '',
        rentArea: parseNumValue(processedVacancy.rentArea) || parseNumValue(processedVacancy.areaPy) || '',
        exclusiveArea: parseNumValue(processedVacancy.exclusiveArea) || '',
        depositPy: parseNumValue(processedVacancy.depositPy) || '',
        rentPy: parseNumValue(processedVacancy.rentPy) || '',
        maintenancePy: parseNumValue(processedVacancy.maintenancePy) || '',
        moveIn: processedVacancy.moveInDate || processedVacancy.moveIn || '즉시',
        source: processedVacancy.source || '',
        publishDate: processedVacancy.publishDate || '',
        _key: processedVacancy._key || '',
        _pricingSource: processedVacancy._pricingSource || ''
    });
    
    showToast(`${selectedVacancy.floor || '공실'} 추가됨 (${selectedVacancy.source || ''} ${selectedVacancy.publishDate || ''})`, 'success');
    
    // 폼 닫고 테이블 다시 렌더링
    toggleVacancyForm(buildingId);
    renderFullscreenWizard();
}

// ============================================================
// 마법사 기능 함수들
// ============================================================

export function updateWizardDraft(key, value) {
    compListState.draft[key] = value;
    
    // 유형 버튼 UI 업데이트
    if (key === 'type') {
        document.querySelectorAll('.type-btn').forEach(btn => {
            btn.classList.remove('active');
            if ((value === 'general' && btn.textContent.includes('일반')) ||
                (value === 'lg' && btn.textContent.includes('LG'))) {
                btn.classList.add('active');
            }
        });
    }
}

export function searchBuildingsForWizard(query) {
    compListState.searchQuery = query;
    
    if (!query || query.length < 2) {
        compListState.searchResults = [];
        renderFullscreenWizard();
        return;
    }
    
    const q = query.toLowerCase();
    const allBuildings = state.allBuildings || [];
    const addedIds = new Set(compListState.draft.buildings.map(b => b.buildingId));
    
    compListState.searchResults = allBuildings
        .filter(b => {
            if (addedIds.has(b.id)) return false;
            const name = (b.name || '').toLowerCase();
            const addr = (b.address || '').toLowerCase();
            return name.includes(q) || addr.includes(q);
        })
        .slice(0, 8);
    
    renderFullscreenWizard();
    
    // 검색창에 포커스 유지
    setTimeout(() => {
        const input = document.getElementById('wizardSearchInput');
        if (input) {
            input.focus();
            input.setSelectionRange(query.length, query.length);
        }
    }, 0);
}

export function addBuildingFromSearchResult(buildingId) {
    const building = (state.allBuildings || []).find(b => b.id === buildingId);
    if (!building) return;
    
    if (compListState.draft.buildings.find(b => b.buildingId === buildingId)) {
        showToast('이미 추가된 빌딩입니다', 'info');
        return;
    }
    
    compListState.draft.buildings.push({
        buildingId: building.id,
        buildingName: building.name,
        buildingData: building,
        vacancies: [],
        addedAt: new Date().toISOString()
    });
    
    compListState.searchQuery = '';
    compListState.searchResults = [];
    
    showToast(`${building.name} 추가됨`, 'success');
    renderFullscreenWizard();
}

export function removeWizardBuilding(buildingId) {
    const idx = compListState.draft.buildings.findIndex(b => b.buildingId === buildingId);
    if (idx > -1) {
        const removed = compListState.draft.buildings.splice(idx, 1)[0];
        showToast(`${removed.buildingName} 제거됨`, 'info');
        renderFullscreenWizard();
    }
}

export function moveWizardBuilding(fromIdx, direction) {
    const toIdx = fromIdx + direction;
    if (toIdx < 0 || toIdx >= compListState.draft.buildings.length) return;
    
    const temp = compListState.draft.buildings[fromIdx];
    compListState.draft.buildings[fromIdx] = compListState.draft.buildings[toIdx];
    compListState.draft.buildings[toIdx] = temp;
    
    renderFullscreenWizard();
}

// ============================================================
// 기준가 선택/적용 함수들
// ============================================================

/**
 * 드롭다운에서 선택한 기준가 적용
 */
export function applySelectedPricing(buildingId) {
    const select = document.getElementById(`vf_pricingSelect_${buildingId}`);
    if (!select) return;
    
    const selectedIdx = select.value;
    if (selectedIdx === '') return;
    
    applyPricingByIndex(buildingId, parseInt(selectedIdx));
}

/**
 * 인덱스로 기준가 적용 (입력 필드에 값 채우기)
 */
export function applyPricingByIndex(buildingId, pricingIdx) {
    const building = compListState.draft.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const floorPricing = building.buildingData?.floorPricing || [];
    if (pricingIdx < 0 || pricingIdx >= floorPricing.length) return;
    
    const fp = floorPricing[pricingIdx];
    
    // 입력 필드에 값 채우기
    const depositInput = document.getElementById(`vf_depositPy_${buildingId}`);
    const rentInput = document.getElementById(`vf_rentPy_${buildingId}`);
    const maintInput = document.getElementById(`vf_maintenancePy_${buildingId}`);
    
    if (depositInput && fp.depositPy) depositInput.value = fp.depositPy;
    if (rentInput && fp.rentPy) rentInput.value = fp.rentPy;
    if (maintInput && fp.maintenancePy) maintInput.value = fp.maintenancePy;
    
    // 드롭다운이 있으면 선택 상태로
    const select = document.getElementById(`vf_pricingSelect_${buildingId}`);
    if (select) select.value = pricingIdx;
    
    showToast(`${fp.label || fp.floorRange || '기준가'} 적용됨 (임대료 ${formatNumber(fp.rentPy)}원/평)`, 'info');
}

/**
 * 층 입력 시 자동으로 맞는 기준가 매칭
 * - 그룹사용에서 같은 빌딩의 여러 층에 각각 다른 기준가 적용
 */
export function autoMatchPricing(buildingId) {
    const floorInput = document.getElementById(`vf_floor_${buildingId}`);
    if (!floorInput) return;
    
    const floor = floorInput.value.trim();
    if (!floor) return;
    
    const building = compListState.draft.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const floorPricing = building.buildingData?.floorPricing || [];
    if (floorPricing.length === 0) return;
    
    // 층에 맞는 기준가 찾기
    const floorNum = parseFloorNumber(floor);
    if (floorNum === null) return;
    
    for (let i = 0; i < floorPricing.length; i++) {
        const fp = floorPricing[i];
        if (isFloorInRange(floorNum, fp.floorRange)) {
            // 매칭된 기준가 적용
            applyPricingByIndex(buildingId, i);
            return;
        }
    }
    
    // 매칭되는 기준가 없으면 첫 번째 기준가 제안
    if (floorPricing.length === 1) {
        applyPricingByIndex(buildingId, 0);
    }
}

export function toggleVacancyForm(buildingId) {
    const row = document.getElementById(`vacancyFormRow_${buildingId}`);
    if (row) {
        const isVisible = row.style.display !== 'none';
        row.style.display = isVisible ? 'none' : 'table-row';
        
        if (!isVisible) {
            // 폼 열 때 첫 입력 필드에 포커스
            const firstInput = document.getElementById(`vf_floor_${buildingId}`);
            if (firstInput) firstInput.focus();
        }
    }
}

export function saveWizardVacancy(buildingId) {
    const building = compListState.draft.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    // 입력값 수집
    const floor = document.getElementById(`vf_floor_${buildingId}`)?.value?.trim();
    const rentPyStr = document.getElementById(`vf_rentPy_${buildingId}`)?.value?.trim();
    
    // 필수값 검증
    if (!floor) {
        showToast('공실층을 입력해주세요', 'warning');
        document.getElementById(`vf_floor_${buildingId}`)?.focus();
        return;
    }
    
    if (!rentPyStr || isNaN(parseFloat(rentPyStr))) {
        showToast('임대료를 입력해주세요', 'warning');
        document.getElementById(`vf_rentPy_${buildingId}`)?.focus();
        return;
    }
    
    const rentPy = parseFloat(rentPyStr);
    const depositPyStr = document.getElementById(`vf_depositPy_${buildingId}`)?.value?.trim();
    const maintenancePyStr = document.getElementById(`vf_maintenancePy_${buildingId}`)?.value?.trim();
    
    const now = new Date();
    building.vacancies.push({
        id: `v_${Date.now()}`,
        floor: floor,
        rentArea: parseFloat(document.getElementById(`vf_rentArea_${buildingId}`)?.value) || 0,
        exclusiveArea: parseFloat(document.getElementById(`vf_exclusiveArea_${buildingId}`)?.value) || 0,
        depositPy: depositPyStr ? formatNumber(parseFloat(depositPyStr)) : '',
        rentPy: formatNumber(rentPy),
        maintenancePy: maintenancePyStr ? formatNumber(parseFloat(maintenancePyStr)) : '',
        moveInDate: document.getElementById(`vf_moveIn_${buildingId}`)?.value?.trim() || '즉시',
        source: '사용자 직접입력',
        publishDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        addedBy: {
            id: state.currentUser?.id || '',
            name: state.currentUser?.name || state.currentUser?.email || '',
            addedAt: now.toISOString()
        }
    });
    
    showToast(`${floor} 공실 추가됨`, 'success');
    renderFullscreenWizard();
}

export function removeWizardVacancy(buildingId, vacancyIdx) {
    const building = compListState.draft.buildings.find(b => b.buildingId === buildingId);
    if (building && building.vacancies[vacancyIdx]) {
        building.vacancies.splice(vacancyIdx, 1);
        showToast('공실 삭제됨', 'info');
        renderFullscreenWizard();
    }
}

// ============================================================
// 저장 및 다운로드
// ============================================================

export async function saveAndDownloadCompList() {
    const { draft } = compListState;
    
    // 제목 검증
    if (!draft.title.trim()) {
        showToast('Comp List 제목을 입력해주세요', 'warning');
        document.getElementById('wizardTitleInput')?.focus();
        return;
    }
    
    // 빌딩 검증
    if (draft.buildings.length === 0) {
        showToast('빌딩을 추가해주세요', 'warning');
        return;
    }
    
    // Firebase 저장
    const savedId = await saveCompList(draft);
    
    if (savedId) {
        // 엑셀 다운로드
        await downloadCompListExcel(draft);
        closeCompListWizard();
    }
}

// ============================================================
// 엑셀 다운로드
// ============================================================

export async function downloadCompListExcel(data) {
    const isLG = data.type === 'lg';
    
    // ExcelJS 로드
    if (!window.ExcelJS) {
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.3.0/exceljs.min.js';
        document.head.appendChild(script);
        await new Promise(r => script.onload = r);
    }
    
    // LG용은 별도 함수로 분기
    if (isLG) {
        return downloadCompListExcelLG(data);
    }
    
    // ============================================================
    // 일반용 Comp List 생성
    // ============================================================
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('후보지');
    const buildings = data.buildings || [];
    
    // 열 문자 변환 함수 (무제한 열 지원: D=4, E=5, ... Z=26, AA=27, ...)
    const getColumnLetter = (colNum) => {
        let letter = '';
        let temp = colNum;
        while (temp > 0) {
            let mod = (temp - 1) % 26;
            letter = String.fromCharCode(65 + mod) + letter;
            temp = Math.floor((temp - 1) / 26);
        }
        return letter;
    };
    
    // ============================================================
    // 빌딩+공실 조합 평탄화 (핵심 변경)
    // ============================================================
    const flattenedEntries = [];
    buildings.forEach(b => {
        const vacancies = b.vacancies || [];
        if (vacancies.length === 0) {
            // 공실이 없는 빌딩도 포함 (빈 공실로)
            flattenedEntries.push({ building: b, vacancy: null });
        } else {
            // 공실마다 별도 열 생성
            vacancies.forEach(v => {
                flattenedEntries.push({ building: b, vacancy: v });
            });
        }
    });
    
    const entryCount = flattenedEntries.length; // 무제한
    
    // ============================================================
    // 1. 열 너비 설정 (무제한)
    // ============================================================
    const buildingColWidth = entryCount <= 5 ? 26 : (entryCount <= 10 ? 22 : (entryCount <= 15 ? 18 : 15));
    const columns = [
        { width: 2.67 },    // A
        { width: 13.22 },   // B
        { width: 24.56 },   // C
    ];
    for (let i = 0; i < entryCount; i++) {
        columns.push({ width: buildingColWidth });
    }
    sheet.columns = columns;
    
    // ============================================================
    // 2. 행 높이 설정
    // ============================================================
    sheet.getRow(1).height = 17;
    sheet.getRow(2).height = 50;
    sheet.getRow(3).height = 17;
    sheet.getRow(4).height = 17;
    sheet.getRow(5).height = 190;
    sheet.getRow(6).height = 80;
    sheet.getRow(9).height = 60;
    for (let i = 7; i <= 55; i++) {
        if (i !== 9) sheet.getRow(i).height = 17;
    }
    
    // ============================================================
    // 3. 셀 병합
    // ============================================================
    sheet.mergeCells('B3:C4');
    sheet.mergeCells('B5:C5');
    sheet.mergeCells('B6:C6');
    sheet.mergeCells('B7:B18');
    sheet.mergeCells('B19:B20');
    sheet.mergeCells('B21:B23');
    sheet.mergeCells('B25:B31');
    sheet.mergeCells('B32:B39');
    sheet.mergeCells('B40:B44');
    sheet.mergeCells('B46:B50');
    
    // ============================================================
    // 4. B열 카테고리 설정
    // ============================================================
    const setCategoryCell = (cellRef, value, bgColor) => {
        const cell = sheet.getCell(cellRef);
        cell.value = value;
        cell.font = { name: 'Noto Sans KR', size: 9, bold: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    };
    
    // PRESENT TO
    const b3 = sheet.getCell('B3');
    b3.value = 'PRESENT TO :';
    b3.font = { name: 'Noto Sans KR', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    b3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C2A2A' } };
    b3.alignment = { horizontal: 'center', vertical: 'middle' };
    b3.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    
    // ★ 외관사진 영역 (행5, 로고 대신)
    const b5 = sheet.getCell('B5');
    b5.value = '외관사진';
    b5.font = { name: 'Noto Sans KR', size: 9, bold: true };
    b5.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F2FE' } };
    b5.alignment = { horizontal: 'center', vertical: 'middle' };
    b5.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    
    // ★ 외관사진 이미지 삽입 (D열~)
    flattenedEntries.forEach((entry, idx) => {
        const col = getColumnLetter(4 + idx);
        const bd = entry.building.buildingData || {};
        const imageUrl = getExteriorUrl(bd);
        
        const imgCell = sheet.getCell(`${col}5`);
        imgCell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        
        if (imageUrl && imageUrl.startsWith('data:image')) {
            try {
                const base64Data = imageUrl.split(',')[1];
                const extension = imageUrl.includes('png') ? 'png' : 'jpeg';
                const imageId = workbook.addImage({ base64: base64Data, extension });
                sheet.addImage(imageId, {
                    tl: { col: 3 + idx, row: 4 },  // 0-indexed: D=col3, 행5=row4
                    br: { col: 4 + idx, row: 5 },
                    editAs: 'oneCell'
                });
            } catch (e) {
                console.error('이미지 삽입 실패:', e);
                imgCell.value = '-';
            }
        } else if (imageUrl) {
            imgCell.value = '이미지 있음';
        } else {
            imgCell.value = '-';
        }
    });
    
    // 카테고리들
    setCategoryCell('B6', '빌딩개요/일반', 'FFFFFFFF');
    setCategoryCell('B7', '빌딩 현황', 'FFFFFFFF');
    setCategoryCell('B19', '빌딩 세부현황', 'FFFFFFFF');
    setCategoryCell('B21', '주차 관련', 'FFFFFFFF');
    setCategoryCell('B25', '임차 제안', 'FFF9D6AE');
    setCategoryCell('B32', '임대 기준', 'FFD9ECF2');
    setCategoryCell('B40', '임대기준 조정', 'FFD9ECF2');
    setCategoryCell('B46', '예상비용', 'FFFBCF3A');
    
    // ============================================================
    // 5. C열 항목명 설정
    // ============================================================
    const cColumnLabels = {
        7: '주소 지번', 8: '도로명 주소', 9: '위치', 10: '빌딩 규모', 11: '준공연도',
        12: '전용률 (%)', 13: '기준층 임대면적 (m²)', 14: '기준층 임대면적 (평)',
        15: '기준층 전용면적 (m²)', 16: '기준층 전용면적 (평)', 17: '엘레베이터', 18: '냉난방 방식',
        19: '건물용도', 20: '구조', 21: '주차 대수 정보', 22: '주차비', 23: '주차 대수',
        25: '최적 임차 층수', 26: '입주 가능 시기', 27: '거래유형',
        28: '임대면적 (m²)', 29: '전용면적 (m²)', 30: '임대면적 (평)', 31: '전용면적 (평)',
        32: '월 평당 보증금', 33: '월 평당 임대료', 34: '월 평당 관리비', 35: '월 평당 지출비용',
        36: '총 보증금', 37: '월 임대료 총액', 38: '월 관리비 총액', 39: '월 전용면적당 지출비용',
        40: '보증금', 41: '렌트프리 (개월/년)', 42: '평균 임대료', 43: '관리비', 44: 'NOC',
        46: '보증금', 47: '평균 월 임대료', 48: '평균 월 관리비', 49: '월 (임대료 + 관리비)', 50: '연 실제 부담 고정금액'
    };
    
    Object.entries(cColumnLabels).forEach(([row, label]) => {
        const cell = sheet.getCell(`C${row}`);
        cell.value = label;
        cell.font = { name: 'Noto Sans KR', size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    });
    
    // ============================================================
    // 5-1. 데이터 포맷팅 헬퍼 함수
    // ============================================================
    
    // 빌딩 규모 (floors/scale) 포맷팅
    const formatBuildingScale = (bd) => {
        // floors 객체인 경우
        if (bd.floors && typeof bd.floors === 'object') {
            return bd.floors.display || `지하${bd.floors.below || 0}층/지상${bd.floors.above || 0}층`;
        }
        // scale 객체인 경우
        if (bd.scale && typeof bd.scale === 'object') {
            return bd.scale.display || `지하${bd.scale.below || 0}층/지상${bd.scale.above || 0}층`;
        }
        // grndFlrCnt, ugrdFlrCnt 필드가 있는 경우
        if (bd.grndFlrCnt || bd.ugrdFlrCnt) {
            return `지하${bd.ugrdFlrCnt || 0}층/지상${bd.grndFlrCnt || 0}층`;
        }
        // 문자열인 경우 그대로 반환
        return bd.scale || bd.floors || '';
    };
    
    // 엘리베이터 포맷팅
    const formatElevator = (bd) => {
        // specs 객체에서 가져오기
        if (bd.specs?.passengerElevator || bd.specs?.freightElevator) {
            const passenger = bd.specs.passengerElevator || 0;
            const freight = bd.specs.freightElevator || 0;
            return `승용 ${passenger}대 비상용 ${freight}대`;
        }
        // 개별 필드에서 가져오기
        if (bd.passengerElevator || bd.freightElevator || bd.rideUseElvtCnt || bd.emgenUseElvtCnt) {
            const passenger = bd.passengerElevator || bd.rideUseElvtCnt || 0;
            const freight = bd.freightElevator || bd.emgenUseElvtCnt || 0;
            if (passenger || freight) {
                return `승용 ${passenger}대 비상용 ${freight}대`;
            }
        }
        // elevators 또는 elevator 필드
        const elevatorVal = bd.elevators || bd.elevator;
        if (elevatorVal && typeof elevatorVal === 'object') {
            return elevatorVal.display || '';
        }
        return elevatorVal || '';
    };
    
    // 주차 정보 포맷팅
    const formatParkingInfo = (bd) => {
        // parking 객체인 경우
        if (bd.parking && typeof bd.parking === 'object') {
            if (bd.parking.display) return bd.parking.display;
            if (bd.parking.total) {
                let result = `총 ${bd.parking.total}대`;
                if (bd.parking.ratio) result += ` (${bd.parking.ratio})`;
                if (bd.parking.operation) result += ` ${bd.parking.operation}`;
                return result;
            }
        }
        // parkingInfo 객체인 경우
        if (bd.parkingInfo && typeof bd.parkingInfo === 'object') {
            if (bd.parkingInfo.display) return bd.parkingInfo.display;
            if (bd.parkingInfo.total) {
                let result = `총 ${bd.parkingInfo.total}대`;
                if (bd.parkingInfo.ratio) result += ` (${bd.parkingInfo.ratio})`;
                return result;
            }
        }
        // totPkngCnt 필드가 있는 경우
        if (bd.totPkngCnt) {
            return `총 ${bd.totPkngCnt}대`;
        }
        // 문자열인 경우
        return bd.parkingInfo || bd.parking || '';
    };
    
    // 주차 대수 포맷팅
    const formatParkingTotal = (bd) => {
        if (bd.parking?.total) return bd.parking.total;
        if (bd.parkingInfo?.total) return bd.parkingInfo.total;
        return bd.parkingTotal || bd.parkingSpaces || bd.totPkngCnt || '';
    };
    
    // ============================================================
    // 6. 빌딩+공실 데이터 입력 (D열~, 무제한)
    // ============================================================
    const setDataCell = (cellRef, value, numFmt = null, align = 'center') => {
        const cell = sheet.getCell(cellRef);
        cell.value = value;
        cell.font = { name: 'Noto Sans KR', size: 9 };
        cell.alignment = { horizontal: align, vertical: 'middle', wrapText: true };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        if (numFmt) cell.numFmt = numFmt;
    };
    
    const setFormulaCell = (cellRef, formula, numFmt = null) => {
        const cell = sheet.getCell(cellRef);
        cell.value = { formula };
        cell.font = { name: 'Noto Sans KR', size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        if (numFmt) cell.numFmt = numFmt;
    };
    
    flattenedEntries.forEach((entry, idx) => {
        const col = getColumnLetter(4 + idx); // D=4, E=5, ...
        const b = entry.building;
        const bd = b.buildingData || {};
        const v = entry.vacancy || {}; // 공실 정보 (없으면 빈 객체)
        
        // 빌딩명 헤더 (4행) - 공실층 정보 포함
        const headerCell = sheet.getCell(`${col}4`);
        const floorInfo = v.floor ? ` (${v.floor})` : '';
        headerCell.value = b.buildingName + floorInfo;
        headerCell.font = { name: 'Noto Sans KR', size: 9, bold: true };
        headerCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCCCCC' } };
        headerCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        headerCell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        
        // 빌딩개요 (6행)
        setDataCell(`${col}6`, bd.description || '', null, 'left');
        
        // 빌딩 현황 (7-18행)
        setDataCell(`${col}7`, bd.addressJibun || bd.address || '');
        setDataCell(`${col}8`, bd.address || '');
        setDataCell(`${col}9`, bd.nearestStation || bd.station || '');
        setDataCell(`${col}10`, formatBuildingScale(bd));
        setDataCell(`${col}11`, bd.completionYear || '');
        
        // 전용률 (12행)
        const dedicatedRate = bd.dedicatedRate || bd.exclusiveRate || 0;
        setDataCell(`${col}12`, dedicatedRate ? dedicatedRate / 100 : '', dedicatedRate ? '0.00%' : null);
        
        // 면적 정보 (13-16행)
        const baseFloorAreaM2 = bd.typicalFloorM2 || (bd.typicalFloorPy ? bd.typicalFloorPy * 3.305785 : 0);
        const baseFloorAreaPy = bd.typicalFloorPy || bd.baseFloorAreaPy || 0;
        const exclusiveAreaM2 = bd.exclusiveAreaM2 || (baseFloorAreaPy * (dedicatedRate / 100) * 3.305785);
        const exclusiveAreaPy = bd.exclusiveAreaPy || (baseFloorAreaPy * (dedicatedRate / 100));
        
        setDataCell(`${col}13`, baseFloorAreaM2 || '', baseFloorAreaM2 ? '#,##0.000' : null);
        setDataCell(`${col}14`, baseFloorAreaPy || '', baseFloorAreaPy ? '#,##0.000' : null);
        setDataCell(`${col}15`, exclusiveAreaM2 || '', exclusiveAreaM2 ? '#,##0.000' : null);
        setDataCell(`${col}16`, exclusiveAreaPy || '', exclusiveAreaPy ? '#,##0.000' : null);
        
        // 빌딩 세부현황 (17-20행)
        setDataCell(`${col}17`, formatElevator(bd));
        setDataCell(`${col}18`, bd.hvac || bd.heatingCooling || '');
        setDataCell(`${col}19`, bd.buildingUse || bd.usage || '');
        setDataCell(`${col}20`, bd.structure || '');
        
        // 주차 관련 (21-23행)
        setDataCell(`${col}21`, formatParkingInfo(bd));
        setDataCell(`${col}22`, bd.parkingFee || bd.parking?.fee || '');
        setDataCell(`${col}23`, formatParkingTotal(bd));
        
        // 임차 제안 (25-31행) - 공실 정보 활용
        setDataCell(`${col}25`, v.floor || '-');
        setDataCell(`${col}26`, v.moveInDate || v.moveIn || '-');
        setDataCell(`${col}27`, '-');
        
        // 면적 입력 (평 기준, m²는 수식으로)
        // 공실 없으면 기본값 100/50, 수식은 항상 유지
        const rentAreaPy = parseFloat(v.rentArea) || 100;
        const exclusiveAreaPyVacancy = parseFloat(v.exclusiveArea) || 50;
        
        setFormulaCell(`${col}28`, `ROUNDDOWN(${col}30*3.305785,3)`, '#,##0.000');
        setFormulaCell(`${col}29`, `ROUNDDOWN(${col}31*3.305785,3)`, '#,##0.000');
        setDataCell(`${col}30`, rentAreaPy, '#,##0.000');
        setDataCell(`${col}31`, exclusiveAreaPyVacancy, '#,##0.000');
        
        // 임대 기준 (32-39행)
        // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화
        const depositPy = toWon(v.depositPy);
        const rentPy = toWon(v.rentPy);
        const maintenancePy = toWon(v.maintenancePy);
        
        setDataCell(`${col}32`, depositPy || '', depositPy ? '₩#,##0' : null);
        setDataCell(`${col}33`, rentPy || '', rentPy ? '₩#,##0' : null);
        setDataCell(`${col}34`, maintenancePy || '', maintenancePy ? '₩#,##0' : null);
        setFormulaCell(`${col}35`, `${col}33+${col}34`, '₩#,##0');
        setFormulaCell(`${col}36`, `${col}32*${col}30`, '₩#,##0');
        setFormulaCell(`${col}37`, `${col}33*${col}30`, '₩#,##0');
        setFormulaCell(`${col}38`, `${col}34*${col}30`, '₩#,##0');
        setFormulaCell(`${col}39`, `IFERROR((${col}37+${col}38)/${col}31,0)`, '₩#,##0');
        
        // 임대기준 조정 (40-44행) - 수식 항상 유지
        setFormulaCell(`${col}40`, `${col}32`, '₩#,##0');
        setDataCell(`${col}41`, 0); // RF 개월 (사용자 입력용)
        setFormulaCell(`${col}42`, `${col}33-((${col}33*${col}41)/12)`, '₩#,##0');
        setFormulaCell(`${col}43`, `${col}34`, '₩#,##0');
        setFormulaCell(`${col}44`, `IFERROR(((${col}42+${col}43)*(${col}30/${col}31)),0)`, '₩#,##0');
        
        // 예상비용 (46-50행) - 수식 항상 유지
        setFormulaCell(`${col}46`, `${col}40*${col}30`, '₩#,##0');
        setFormulaCell(`${col}47`, `${col}42*${col}30`, '₩#,##0');
        setFormulaCell(`${col}48`, `${col}43*${col}30`, '₩#,##0');
        setFormulaCell(`${col}49`, `${col}47+${col}48`, '₩#,##0');
        setFormulaCell(`${col}50`, `${col}49*12`, '₩#,##0');
    });
    
    // ============================================================
    // 7. 용어 설명
    // ============================================================
    sheet.getCell('B52').value = '용어 설명';
    sheet.getCell('B52').font = { name: 'Noto Sans KR', size: 10, bold: true };
    sheet.getCell('B53').value = 'NOC : Net Operating Cost의 약자로 임대료와 관리비를 합친 부동산 순 운영 비용';
    sheet.getCell('B54').value = '렌트프리 : 임대료만 면제 (관리비, 보증금 有)';
    sheet.getCell('B55').value = '프리렌트 : 임대료 + 관리비 면제 (보증금 有)';
    [53, 54, 55].forEach(row => {
        sheet.getCell(`B${row}`).font = { name: 'Noto Sans KR', size: 10 };
        sheet.getCell(`B${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
    });
    
    // ============================================================
    // 8. 다운로드
    // ============================================================
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CompList_${data.title || '후보지'}_${new Date().toISOString().slice(0,10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('✅ Comp List 엑셀 다운로드 완료', 'success');
}

// ============================================================
// LG용 Comp List 엑셀 생성
// ============================================================
async function downloadCompListExcelLG(data) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('COMP');
    const buildings = data.buildings || [];
    
    // 열 문자 변환 함수
    const getColumnLetter = (colNum) => {
        let letter = '';
        let temp = colNum;
        while (temp > 0) {
            let mod = (temp - 1) % 26;
            letter = String.fromCharCode(65 + mod) + letter;
            temp = Math.floor((temp - 1) / 26);
        }
        return letter;
    };
    
    const buildingCount = buildings.length;
    
    // ============================================================
    // 1. 열 너비 설정 (빌딩당 3열: E-G, H-J, K-M, ...)
    // ============================================================
    const columns = [
        { width: 9.375 },   // A
        { width: 4.5 },     // B
        { width: 9.375 },   // C
        { width: 13 },      // D
    ];
    // 각 빌딩당 3열 추가
    for (let i = 0; i < buildingCount; i++) {
        columns.push({ width: 10.625 }); // 층
        columns.push({ width: 13 });     // 전용
        columns.push({ width: 13 });     // 임대
    }
    sheet.columns = columns;
    
    // ============================================================
    // 2. 행 높이 설정
    // ============================================================
    for (let i = 1; i <= 85; i++) {
        sheet.getRow(i).height = 15;
    }
    // ★ 건물 외관 이미지 영역 높이 (complist-page.js 기준)
    for (let r = 9; r <= 17; r++) {
        sheet.getRow(r).height = 18;
    }
    sheet.getRow(19).height = 30;
    sheet.getRow(20).height = 30;
    sheet.getRow(26).height = 40.5;
    sheet.getRow(53).height = 35.25;
    sheet.getRow(54).height = 21.75;
    sheet.getRow(56).height = 12;
    sheet.getRow(62).height = 33;
    // ★ 평면도 이미지 영역 높이
    for (let r = 63; r <= 71; r++) {
        sheet.getRow(r).height = 18;
    }
    sheet.getRow(72).height = 30;
    sheet.getRow(83).height = 33.75;
    
    // ============================================================
    // 3. 헤더 영역 (1-4행)
    // ============================================================
    const buildingNames = buildings.map(b => b.buildingName).join(', ');
    const lastCol = getColumnLetter(4 + buildingCount * 3); // D + 빌딩수*3
    
    sheet.mergeCells(`A1:${lastCol}1`);
    sheet.mergeCells(`A2:${lastCol}2`);
    sheet.mergeCells(`A3:${lastCol}3`);
    sheet.mergeCells(`A4:${lastCol}4`);
    
    const a1 = sheet.getCell('A1');
    a1.value = `임차제안: ${buildingNames}`;
    a1.font = { name: 'Noto Sans KR', size: 14, bold: true };
    a1.alignment = { horizontal: 'left', vertical: 'top' };
    
    sheet.getCell('A2').value = '- 규모: 전용 0000PY 이상';
    sheet.getCell('A3').value = '- 계약기간: 2025.00.00~2025.00.00';
    sheet.getCell('A4').value = '- 위치: 0000역 인근';
    [2, 3, 4].forEach(row => {
        sheet.getCell(`A${row}`).font = { name: 'Noto Sans KR', size: 10 };
        sheet.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
    });
    
    // ============================================================
    // 4. A열 섹션 라벨
    // ============================================================
    const sectionLabels = {
        6: { text: '위치', color: 'FFFCE4D6' },      // 주황 80%
        7: { text: '제안', color: 'FFA6A6A6' },      // 검정 35%
        9: { text: '건물 외관', color: 'FFE0E0E0' },
        18: { text: '기초\n정보', color: 'FFE0E0E0' },
        26: { text: '채권\n분석', color: 'FFE0E0E0' },
        33: { text: '현재 공실', color: 'FFE0E0E0' },
        40: { text: '제안', color: 'FFE0E0E0' },
        45: { text: '기준층\n임대기준', color: 'FFFFF2CC' },
        48: { text: '실질\n임대기준', color: 'FFE2EFDA' },
        50: { text: '비용검토', color: 'FFE0E0E0' },
        56: { text: '공사기간\nFAVOR', color: 'FFE0E0E0' },
        59: { text: '주차현황', color: 'FFE0E0E0' },
        63: { text: '평면도', color: 'FFE0E0E0' },
        72: { text: '기타', color: 'FFE0E0E0' }
    };
    
    Object.entries(sectionLabels).forEach(([row, info]) => {
        const cell = sheet.getCell(`A${row}`);
        cell.value = info.text;
        cell.font = { name: 'Noto Sans KR', size: 10, bold: true };
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: info.color } };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    });
    
    // ============================================================
    // 5. B열 항목 라벨
    // ============================================================
    const bLabels = {
        18: '주   소', 19: '위   치', 20: '준공일', 21: '규  모', 22: '연면적',
        23: '기준층 전용면적', 24: '전용률', 25: '대지면적',
        26: '소유자 (임대인)', 27: '채권담보 설정여부', 28: '공동담보 총 대지지분',
        29: '선순위 담보 총액', 30: '공시지가 대비 담보율', 31: '개별공시지가(25년 1월 기준)', 32: '토지가격 적용',
        40: '계약기간', 41: '입주가능 시기', 42: '제안 층', 43: '전용면적', 44: '임대면적',
        45: '보증금', 46: '임대료', 47: '관리비',
        48: '실질 임대료(RF만 반영)', 49: '연간 무상임대 (R.F)',
        50: '보증금', 51: '월 임대료', 52: '월 관리비', 53: '관리비 내역',
        54: '월납부액', 55: '(21개월 기준) 총 납부 비용',
        56: '인테리어 기간 (F.O)', 57: '인테리어지원금 (T.I)',
        59: '총 주차대수', 60: '무료주차 조건(임대면적)', 61: '무료주차 제공대수', 62: '유료주차(VAT별도)',
        63: '평면도', 73: '특이사항'
    };
    
    Object.entries(bLabels).forEach(([row, label]) => {
        const cell = sheet.getCell(`B${row}`);
        cell.value = label;
        cell.font = { name: 'Noto Sans KR', size: 10 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        
        // 특수 배경색
        if (row >= 45 && row <= 47) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
        } else if (row >= 48 && row <= 49) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
        }
    });
    
    // C열 특수 라벨
    sheet.getCell('C30').value = '공시지가 대비 담보율';
    sheet.getCell('C32').value = '토지가격 적용';
    
    // ============================================================
    // 6. 셀 병합 (고정 영역)
    // ============================================================
    // A열 섹션 병합
    sheet.mergeCells('A9:D17');
    sheet.mergeCells('A18:A25');
    sheet.mergeCells('A26:A32');
    sheet.mergeCells('A33:D39');
    sheet.mergeCells('A40:A44');
    sheet.mergeCells('A45:A47');
    sheet.mergeCells('A48:A49');
    sheet.mergeCells('A50:A55');
    sheet.mergeCells('A56:A58');
    sheet.mergeCells('A59:A62');
    // ★ 평면도와 기타(특이사항) 분리 (complist-page.js 기준)
    sheet.mergeCells('A63:D71');  // 평면도
    // A72: 기타 라벨 (단독)
    sheet.mergeCells('B72:D72');  // 특이사항 라벨
    
    // B열 라벨 병합
    const bMerges = [
        'B18:D18', 'B19:D19', 'B20:D20', 'B21:D21', 'B22:D22',
        'B23:D23', 'B24:D24', 'B25:D25', 'B26:D26', 'B27:D27',
        'B28:D28', 'B29:D29', 'B31:D31', 'C30:D30', 'C32:D32',
        'B40:D40', 'B41:D41', 'B42:D42', 'B43:D43', 'B44:D44',
        'B45:D45', 'B46:D46', 'B47:D47', 'B48:D48', 'B49:D49',
        'B50:D50', 'B51:D51', 'B52:D52', 'B53:D53', 'B54:D54',
        'B55:D55', 'B56:D56', 'B57:D58', 'B59:D59', 'B60:D60',
        'B61:D61', 'B62:D62'
    ];
    // ★ 평면도(B63:D71)와 특이사항(B72:D72)은 별도 처리됨 (A열 병합에서 설정)
    bMerges.forEach(range => {
        try { sheet.mergeCells(range); } catch(e) {}
    });
    
    // ============================================================
    // 7. 빌딩별 데이터 입력 (E열부터 시작, 빌딩당 3열)
    // ============================================================
    buildings.forEach((b, bIdx) => {
        const startColNum = 5 + bIdx * 3; // E=5, H=8, K=11, ...
        const col1 = getColumnLetter(startColNum);     // 층/주요값
        const col2 = getColumnLetter(startColNum + 1); // 전용
        const col3 = getColumnLetter(startColNum + 2); // 임대
        
        const bd = b.buildingData || {};
        const vacancies = b.vacancies || [];
        
        // 빌딩별 셀 병합
        sheet.mergeCells(`${col1}6:${col3}6`);
        sheet.mergeCells(`${col1}7:${col3}7`);
        sheet.mergeCells(`${col1}8:${col3}8`);
        sheet.mergeCells(`${col1}9:${col3}17`);
        
        const dataRowMerges = [18,19,20,21,22,23,24,25,26,27,29,30,31,32,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,59,60,61,62];
        dataRowMerges.forEach(row => {
            try { sheet.mergeCells(`${col1}${row}:${col3}${row}`); } catch(e) {}
        });
        sheet.mergeCells(`${col1}57:${col3}58`);
        sheet.mergeCells(`${col1}63:${col3}72`);
        sheet.mergeCells(`${col1}73:${col3}83`);
        
        // 빌딩명 (6행) - 녹색 80%
        const nameCell = sheet.getCell(`${col1}6`);
        nameCell.value = b.buildingName;
        nameCell.font = { name: 'Noto Sans KR', size: 12, bold: true };
        nameCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC6EFCE' } };
        nameCell.alignment = { horizontal: 'center', vertical: 'middle' };
        nameCell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        
        // 7행 - 검정 35%
        const cell7 = sheet.getCell(`${col1}7`);
        cell7.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA6A6A6' } };
        cell7.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        
        // 8행 - 파랑 80%
        const cell8 = sheet.getCell(`${col1}8`);
        cell8.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDEBF7' } };
        cell8.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        
        // ★ 건물 외관 이미지 삽입 (행 9-17)
        const extImageUrl = getExteriorUrl(bd);
        if (extImageUrl && extImageUrl.startsWith('data:image')) {
            try {
                const base64Data = extImageUrl.split(',')[1];
                const extension = extImageUrl.includes('png') ? 'png' : 'jpeg';
                const imageId = workbook.addImage({ base64: base64Data, extension });
                sheet.addImage(imageId, {
                    tl: { col: 4 + bIdx * 3, row: 8 },   // 0-indexed
                    br: { col: 7 + bIdx * 3, row: 17 },
                    editAs: 'oneCell'
                });
            } catch (e) {
                sheet.getCell(`${col1}9`).value = '-';
            }
        } else if (extImageUrl) {
            sheet.getCell(`${col1}9`).value = '이미지 있음';
        } else {
            sheet.getCell(`${col1}9`).value = '-';
        }
        
        // 헬퍼 함수
        const setCell = (cellRef, value, opts = {}) => {
            const cell = sheet.getCell(cellRef);
            cell.value = value;
            cell.font = { name: 'Noto Sans KR', size: 9, ...opts.font };
            cell.alignment = { horizontal: opts.align || 'center', vertical: 'middle', wrapText: true };
            cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
            if (opts.numFmt) cell.numFmt = opts.numFmt;
            if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
        };
        
        const setFormula = (cellRef, formula, numFmt = null) => {
            const cell = sheet.getCell(cellRef);
            cell.value = { formula: formula.startsWith('=') ? formula.slice(1) : formula };
            cell.font = { name: 'Noto Sans KR', size: 9 };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
            if (numFmt) cell.numFmt = numFmt;
        };
        
        // 기초정보 (18-25행) - ★ complist-page.js 기준으로 필드명 통일
        setCell(`${col1}18`, bd.address || '');
        setCell(`${col1}19`, bd.nearestStation || bd.station || '');
        setCell(`${col1}20`, bd.completionYear || '');
        setCell(`${col1}21`, typeof bd.scale === 'object' ? (bd.scale?.display || `지하${bd.scale?.below || 0}층/지상${bd.scale?.above || 0}층`) : (typeof bd.floors === 'object' ? (bd.floors?.display || `지하${bd.floors?.below || 0}층/지상${bd.floors?.above || 0}층`) : (bd.scale || bd.floors || '')));
        // ★ 연면적: grossFloorPy 사용 + '평' suffix
        const grossFloorPyVal = bd.grossFloorPy || bd.totalArea || '';
        setCell(`${col1}22`, grossFloorPyVal ? `${grossFloorPyVal}평` : '');
        setCell(`${col1}23`, bd.typicalFloorPy ? `${bd.typicalFloorPy}평` : '');
        // ★ 전용률: exclusiveRate 우선 사용 + % 포맷
        const exclusiveRateVal = bd.exclusiveRate || bd.dedicatedRate || '';
        if (exclusiveRateVal) {
            const numVal = parseFloat(exclusiveRateVal);
            setCell(`${col1}24`, numVal ? (numVal > 1 ? numVal.toFixed(2) + '%' : (numVal * 100).toFixed(2) + '%') : '');
        } else {
            setCell(`${col1}24`, '');
        }
        // ★ 대지면적 + '평' suffix
        const landAreaVal = bd.landArea || '';
        setCell(`${col1}25`, landAreaVal ? `${landAreaVal}평` : '');
        
        // 채권분석 (26-32행) - ★ Firebase 데이터 반영 (complist-page.js 기준)
        setCell(`${col1}26`, bd.owner || '', { fill: 'FFFFFBEB' });
        setCell(`${col1}27`, bd.bondStatus || '', { fill: 'FFFFFBEB' });
        setCell(`${col1}28`, bd.jointCollateral || '', { fill: 'FFFFFBEB' });
        setCell(`${col1}29`, bd.seniorLien || '', { fill: 'FFFFFBEB' });
        setCell(`${col1}30`, bd.collateralRatio || '', { fill: 'FFFFFBEB' });
        setCell(`${col1}31`, bd.officialLandPrice || '', { fill: 'FFFFFBEB' });
        setCell(`${col1}32`, bd.landPriceApplied || '', { fill: 'FFFFFBEB' });
        
        // 공실 테이블 헤더 (33행)
        setCell(`${col1}33`, '층', { font: { bold: true }, fill: 'FFD9D9D9' });
        setCell(`${col2}33`, '전용', { font: { bold: true }, fill: 'FFD9D9D9' });
        setCell(`${col3}33`, '임대', { font: { bold: true }, fill: 'FFD9D9D9' });
        
        // 공실 데이터 (34-38행, 최대 5개)
        for (let vIdx = 0; vIdx < 5; vIdx++) {
            const row = 34 + vIdx;
            const v = vacancies[vIdx];
            if (v) {
                setCell(`${col1}${row}`, v.floor || '');
                setCell(`${col2}${row}`, parseFloat(v.exclusiveArea) || '', { numFmt: '#,##0.00' });
                setCell(`${col3}${row}`, parseFloat(v.rentArea) || '', { numFmt: '#,##0.00' });
            } else {
                setCell(`${col1}${row}`, '');
                setCell(`${col2}${row}`, '');
                setCell(`${col3}${row}`, '');
            }
        }
        
        // 소계 (39행)
        setCell(`${col1}39`, '소계', { font: { bold: true } });
        setFormula(`${col2}39`, `SUM(${col2}34:${col2}38)`, '#,##0.00');
        setFormula(`${col3}39`, `SUM(${col3}34:${col3}38)`, '#,##0.00');
        
        // 제안 (40-44행)
        setCell(`${col1}40`, '');
        setCell(`${col1}41`, '');
        setCell(`${col1}42`, '');
        // 전용면적, 임대면적은 첫번째 공실 또는 소계 참조
        setFormula(`${col1}43`, `${col2}34`);
        setFormula(`${col1}44`, `${col3}34`);
        
        // 기준층 임대기준 (45-47행) - ★ toWon() 원 단위 정규화
        const v0 = vacancies[0] || {};
        setCell(`${col1}45`, toWon(v0.depositPy) || 750000, { numFmt: '₩#,##0', fill: 'FFFFF2CC' });
        setCell(`${col1}46`, toWon(v0.rentPy) || 75000, { numFmt: '₩#,##0', fill: 'FFFFF2CC' });
        setCell(`${col1}47`, toWon(v0.maintenancePy) || 37000, { numFmt: '₩#,##0', fill: 'FFFFF2CC' });
        
        // 실질 임대기준 (48-49행)
        setFormula(`${col1}48`, `${col1}46*(12-${col1}49)/12`, '#,##0.00');
        setCell(`${col1}49`, 0, { fill: 'FFE2EFDA' }); // RF 개월 (사용자 입력)
        
        // 비용검토 (50-55행)
        setFormula(`${col1}50`, `${col1}45*${col1}44`, '#,##0');
        setFormula(`${col1}51`, `${col1}46*${col1}44`, '#,##0');
        setFormula(`${col1}52`, `${col1}47*${col1}44`, '#,##0');
        setCell(`${col1}53`, '');
        setFormula(`${col1}54`, `${col1}51+${col1}52`, '#,##0');
        setFormula(`${col1}55`, `${col1}54*21`, '#,##0');
        
        // 공사기간 FAVOR (56-58행)
        setCell(`${col1}56`, '미제공');
        setCell(`${col1}57`, '미제공');
        
        // 주차현황 (59-62행)
        const parkingDisplay = typeof bd.parking === 'object' 
            ? (bd.parking?.display || (bd.parking?.total ? `총 ${bd.parking.total}대` : ''))
            : (typeof bd.parkingInfo === 'object' 
                ? (bd.parkingInfo?.display || (bd.parkingInfo?.total ? `총 ${bd.parkingInfo.total}대` : ''))
                : (bd.parkingInfo || bd.parking || ''));
        setCell(`${col1}59`, bd.parkingTotal || parkingDisplay || '-');
        setCell(`${col1}60`, parseFloat(bd.freeParkingCondition) || 50, { fill: 'FFFFF2CC' });
        setFormula(`${col1}61`, `${col1}44/${col1}60`, '#,##0.0');
        setCell(`${col1}62`, bd.paidParking || bd.parkingFee || bd.parking?.fee || '-', { fill: 'FFFFFBEB' });
        
        // ★ 평면도 이미지 (행 63-72)
        const floorPlanImages = bd.floorPlanImages || bd.images?.floorPlan || [];
        const fpImageUrl = floorPlanImages.length > 0 ? 
            (typeof floorPlanImages[0] === 'string' ? floorPlanImages[0] : floorPlanImages[0]?.url) : '';
        
        if (fpImageUrl && fpImageUrl.startsWith('data:image')) {
            try {
                const base64Data = fpImageUrl.split(',')[1];
                const extension = fpImageUrl.includes('png') ? 'png' : 'jpeg';
                const imageId = workbook.addImage({ base64: base64Data, extension });
                sheet.addImage(imageId, {
                    tl: { col: 4 + bIdx * 3, row: 62 },  // 0-indexed
                    br: { col: 7 + bIdx * 3, row: 72 },
                    editAs: 'oneCell'
                });
            } catch (e) {
                sheet.getCell(`${col1}63`).value = '평면도 없음';
            }
        } else if (fpImageUrl) {
            sheet.getCell(`${col1}63`).value = '평면도 있음';
        } else {
            sheet.getCell(`${col1}63`).value = '평면도 없음';
        }
        
        // ★ 특이사항 (행 73-83)
        sheet.getCell(`${col1}73`).value = bd.remarks || bd.specialNotes || '';
        sheet.getCell(`${col1}73`).alignment = { horizontal: 'left', vertical: 'top', wrapText: true };
    });
    
    // ★ 특이사항 라벨
    const a72 = sheet.getCell('A72');
    a72.value = '기타';
    a72.font = { name: 'Noto Sans KR', size: 10, bold: true };
    a72.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    a72.alignment = { horizontal: 'center', vertical: 'middle' };
    a72.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    
    const b72 = sheet.getCell('B72');
    b72.value = '특이사항';
    b72.font = { name: 'Noto Sans KR', size: 10 };
    b72.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    b72.alignment = { horizontal: 'center', vertical: 'middle' };
    b72.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
    
    // 빌딩별 특이사항 셀 병합
    buildings.forEach((b, bIdx) => {
        const startColNum = 5 + bIdx * 3;
        const c1 = getColumnLetter(startColNum);
        const c3 = getColumnLetter(startColNum + 2);
        try { sheet.mergeCells(`${c1}72:${c3}72`); } catch(e) {}
    });
    
    // ============================================================
    // 8. 하단 주석 (84-85행)
    // ============================================================
    sheet.mergeCells(`A84:${lastCol}84`);
    sheet.mergeCells(`A85:${lastCol}85`);
    
    sheet.getCell('A84').value = '1) 실질임대료(Rent Free 반영한 임대가)  / 2) 월 납부액 = 월 실질임대료 + 월관리비 (초기년도 기준으로 인상률 미반영)';
    sheet.getCell('A85').value = '3) 연간납부비용 = 연임대료 + 연관리비 (초기년도 기준으로 인상률 미반영, 보증금 미반영)  4) RF : Rent Free (임대료 무상, 관리비 부과)  5) FO : Fit-out (인테리어공사기간(무상 임대료 무상, 관리비 부과)';
    
    [84, 85].forEach(row => {
        sheet.getCell(`A${row}`).font = { name: 'Noto Sans KR', size: 9 };
        sheet.getCell(`A${row}`).alignment = { horizontal: 'left', vertical: 'middle' };
    });
    
    // ============================================================
    // 9. 다운로드
    // ============================================================
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `LG_CompList_${buildings.length}개빌딩_${new Date().toISOString().slice(0,10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('✅ LG Comp List 엑셀 다운로드 완료', 'success');
}

// 저장된 Comp List 다운로드
export async function downloadSavedCompList(compListId) {
    const compList = compListState.savedLists.find(c => c.id === compListId);
    if (!compList) {
        showToast('Comp List를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 빌딩 데이터 보강
    const buildingsWithData = await Promise.all(compList.buildings.map(async b => {
        const building = (state.allBuildings || []).find(ab => ab.id === b.buildingId);
        return {
            ...b,
            buildingData: building || {}
        };
    }));
    
    await downloadCompListExcel({
        ...compList,
        buildings: buildingsWithData
    });
}

// ============================================================
// 관리 페이지 (별도 페이지로 이동)
// ============================================================

export async function openManagePage() {
    // 별도 페이지로 이동
    window.location.href = 'complist.html';
}

export function closeManagePage() {
    // 더 이상 사용되지 않음 (호환성 유지)
}

export function renderManagePage() {
    // 더 이상 사용되지 않음 (호환성 유지)
}

export function viewCompListDetail(compListId) {
    // 별도 페이지로 이동 (URL 파라미터로 compListId 전달)
    window.location.href = `complist.html?id=${compListId}`;
}

export function closeDetailModal() {
    // 더 이상 사용되지 않음 (호환성 유지)
}

// ============================================================
// 초기화 & 전역 등록
// ============================================================

export function initCompList() {
    loadCurrentListFromStorage();
    updateFloatingButton();
    console.log('Comp List 모듈 초기화 완료');
}

// 전역 등록
window.addBuildingToCompList = addBuildingToCompList;
window.addBuildingsToCompList = addBuildingsToCompList;
window.removeFromCompList = removeBuildingFromCompList;
window.clearCompList = clearCompList;
window.toggleCompListPanel = toggleFloatingPanel;
window.openCompListWizard = openCompListWizard;
window.closeCompListWizard = closeCompListWizard;
window.updateWizardDraft = updateWizardDraft;
window.searchBuildingsForWizard = searchBuildingsForWizard;
window.addBuildingFromSearchResult = addBuildingFromSearchResult;
window.removeWizardBuilding = removeWizardBuilding;
window.moveWizardBuilding = moveWizardBuilding;
window.toggleVacancyForm = toggleVacancyForm;
window.saveWizardVacancy = saveWizardVacancy;
window.switchVacancyInputMode = switchVacancyInputMode;
window.selectExistingVacancy = selectExistingVacancy;
window.removeWizardVacancy = removeWizardVacancy;
window.applySelectedPricing = applySelectedPricing;
window.applyPricingByIndex = applyPricingByIndex;
window.autoMatchPricing = autoMatchPricing;
window.saveAndDownloadCompList = saveAndDownloadCompList;
window.downloadCompListExcel = downloadCompListExcel;
window.compListState = compListState;
window.toggleSelectionMode = toggleSelectionMode;
window.toggleBuildingSelection = toggleBuildingSelection;
window.toggleSelectAll = toggleSelectAll;
window.addSelectedToCompList = addSelectedToCompList;
window.renderBuildingCheckboxes = renderBuildingCheckboxes;
window.openManagePage = openManagePage;
window.closeManagePage = closeManagePage;
window.renderManagePage = renderManagePage;
window.downloadSavedCompList = downloadSavedCompList;
window.viewCompListDetail = viewCompListDetail;
window.closeDetailModal = closeDetailModal;
window.loadCompLists = loadCompLists;
window.deleteCompList = deleteCompList;
window.saveCompList = saveCompList;
window.updateFloatingButton = updateFloatingButton;
window.renderFloatingPanel = renderFloatingPanel;
