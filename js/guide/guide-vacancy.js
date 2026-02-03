/**
 * Leasing Guide - 공실 관리
 * 직접 입력, 타사 공실 연동, 안내문 공실 연동
 * 
 * v2.2 수정사항:
 * - 다중 선택 UI 개선 (체크박스 스타일)
 * - 금액 포맷팅 적용 (콤마 자동 추가)
 * - 검색 버튼 제거, 자동 로드
 * 
 * v3.7 수정사항:
 * - 층 표기 정규화 함수 추가 (FF 중복 방지)
 * - 전용면적/임대면적 분리 표시
 */

import { state, db, ref, get } from './guide-state.js';
import { showToast, formatPrice } from './guide-utils.js';
// renderBuildingEditor는 window 객체를 통해 호출 (순환 의존성 방지)

// ★ v3.7: 층 표기 정규화 함수 (FF 중복 방지)
function formatFloorDisplay(floor) {
    if (!floor || floor === '-') return '-';
    
    let str = String(floor).trim().toUpperCase();
    
    // "B1", "B2" 등 지하층 형식
    if (/^B\d+$/.test(str)) return str;
    
    // "12F", "3F" 등 이미 F가 붙은 형식 → 그대로 반환 (FF 방지)
    if (/^\d+F$/.test(str)) return str;
    
    // "B1F" → "B1" (지하층에 F가 붙은 경우 제거)
    if (/^B\d+F$/.test(str)) return str.replace('F', '');
    
    // "12층", "3층" 등 한글 층 → "12F", "3F"
    if (/^\d+층$/.test(str)) return str.replace('층', 'F');
    
    // "지하1층", "지하2층" → "B1", "B2"
    const basementMatch = str.match(/지하\s*(\d+)\s*층?/);
    if (basementMatch) return 'B' + basementMatch[1];
    
    // 숫자만 있는 경우 → "12F"
    if (/^\d+$/.test(str)) return str + 'F';
    
    // 그 외의 경우 그대로 반환
    return str;
}

// ========== 타사 공실 헬퍼 함수 ==========

// 고유 출처 목록 HTML
export function getUniqueSourcesHtml(vacancies) {
    const sources = [...new Set(vacancies.map(v => v.source || '기타'))];
    return sources.map(s => `<option value="${s}">${s}</option>`).join('');
}

// 고유 날짜 목록 HTML
export function getUniqueDatesHtml(vacancies) {
    const dates = [...new Set(vacancies.map(v => v.publishDate || v.date || '미정'))];
    return dates.sort((a, b) => b.localeCompare(a)).map(d => `<option value="${d}">${d}</option>`).join('');
}

// 타사 공실 그룹 렌더링 (다중 선택 + 금액 포맷팅)
export function renderExternalVacancyGroups(vacancies, selectedVacancies, idx) {
    if (!vacancies || vacancies.length === 0) {
        return '<div class="external-vacancy-empty">타사 공실 정보가 없습니다</div>';
    }
    
    // 출처+날짜별 그룹핑
    const groups = {};
    vacancies.forEach(v => {
        const key = `${v.source || '기타'}_${v.publishDate || v.date || '미정'}`;
        if (!groups[key]) {
            groups[key] = {
                source: v.source || '기타',
                date: v.publishDate || v.date || '미정',
                items: []
            };
        }
        groups[key].items.push(v);
    });
    
    // 그룹을 날짜 역순으로 정렬
    const sortedGroups = Object.values(groups).sort((a, b) => b.date.localeCompare(a.date));
    
    return sortedGroups.map(group => {
        const selectedIds = (selectedVacancies || []).map(v => v.id);
        const allSelected = group.items.every(v => selectedIds.includes(v.id));
        const someSelected = group.items.some(v => selectedIds.includes(v.id));
        
        return `
            <div class="external-vacancy-group">
                <div class="external-vacancy-group-header" onclick="toggleSourceGroup(this)">
                    <span class="group-toggle">▼</span>
                    <span class="group-source">${group.source}</span>
                    <span class="group-date">${group.date}</span>
                    <span class="group-count">${group.items.length}건</span>
                    <button class="btn btn-xs ${allSelected ? 'btn-secondary' : 'btn-primary'}" 
                            onclick="event.stopPropagation(); selectAllFromSource(${idx}, '${group.source}', '${group.date}')">
                        ${allSelected ? '전체해제' : '전체선택'}
                    </button>
                </div>
                <div class="external-vacancy-group-body">
                    ${group.items.map(v => {
                        const isSelected = selectedIds.includes(v.id);
                        // ★ 금액 포맷팅 적용
                        const priceDisplay = formatPrice(v.rentPy || v.rent || '문의');
                        const depositDisplay = formatPrice(v.depositPy || v.deposit || '');
                        return `
                            <div class="external-vacancy-item ${isSelected ? 'selected' : ''}" 
                                 onclick="toggleExternalVacancyItem(${idx}, '${v.id}', this)">
                                <input type="checkbox" class="vacancy-checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation();">
                                <div class="vacancy-floor">${formatFloorDisplay(v.floor)}</div>
                                <div class="vacancy-area">${formatPrice(v.rentArea || v.area || '-')}/${formatPrice(v.exclusiveArea || v.area || '-')}평</div>
                                <div class="vacancy-deposit">${depositDisplay}</div>
                                <div class="vacancy-price">${priceDisplay}</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        `;
    }).join('');
}

// 선택된 공실 장바구니 렌더링 (금액 포맷팅 적용)
export function renderExternalCartItems(selectedVacancies, idx) {
    if (!selectedVacancies || selectedVacancies.length === 0) {
        return '<div class="cart-empty">선택된 공실이 없습니다</div>';
    }
    
    return selectedVacancies.map(v => `
        <div class="cart-item">
            <div class="cart-item-info">
                <span class="cart-floor">${formatFloorDisplay(v.floor)}</span>
                <span class="cart-area">${formatPrice(v.rentArea || v.area || '-')}/${formatPrice(v.exclusiveArea || v.area || '-')}평</span>
                <span class="cart-price">${formatPrice(v.rentPy || v.rent || '문의')}</span>
            </div>
            <button class="cart-remove" onclick="removeFromExternalCart(${idx}, '${v.id}')">×</button>
        </div>
    `).join('');
}

// 그룹 토글
export function toggleSourceGroup(header) {
    const body = header.nextElementSibling;
    const toggle = header.querySelector('.group-toggle');
    if (body.style.display === 'none') {
        body.style.display = 'block';
        toggle.textContent = '▼';
    } else {
        body.style.display = 'none';
        toggle.textContent = '▶';
    }
}

// 개별 공실 선택/해제 (체크박스 연동)
export function toggleExternalVacancyItem(idx, vacancyId, element) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building || !building.vacancies) return;
    
    const vacancy = building.vacancies.find(v => v.id === vacancyId);
    if (!vacancy) return;
    
    const existingIdx = item.selectedExternalVacancies.findIndex(v => v.id === vacancyId);
    const checkbox = element.querySelector('.vacancy-checkbox');
    
    if (existingIdx >= 0) {
        // 이미 선택됨 → 해제
        item.selectedExternalVacancies.splice(existingIdx, 1);
        element.classList.remove('selected');
        if (checkbox) checkbox.checked = false;
    } else {
        // 선택 안됨 → 추가
        item.selectedExternalVacancies.push({
            ...vacancy,
            type: 'external'
        });
        element.classList.add('selected');
        if (checkbox) checkbox.checked = true;
    }
    
    updateExternalCart(idx);
}

// 출처별 전체 선택/해제
export function selectAllFromSource(idx, source, date) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building || !building.vacancies) return;
    
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    
    // 해당 출처+날짜의 공실들
    const sourceVacancies = building.vacancies.filter(v => 
        (v.source || '기타') === source && 
        (v.publishDate || v.date || '미정') === date
    );
    
    const selectedIds = item.selectedExternalVacancies.map(v => v.id);
    const allSelected = sourceVacancies.every(v => selectedIds.includes(v.id));
    
    if (allSelected) {
        // 전체 해제
        item.selectedExternalVacancies = item.selectedExternalVacancies.filter(v => 
            !sourceVacancies.find(sv => sv.id === v.id)
        );
    } else {
        // 전체 선택
        sourceVacancies.forEach(v => {
            if (!selectedIds.includes(v.id)) {
                item.selectedExternalVacancies.push({
                    ...v,
                    type: 'external'
                });
            }
        });
    }
    
    // UI 갱신
    window.renderBuildingEditor(item, building);
}

// 장바구니 업데이트
export function updateExternalCart(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const cartBody = document.getElementById('extCartBody');
    const cartHeader = document.querySelector('.external-vacancy-cart-header span');
    
    if (cartBody) {
        cartBody.innerHTML = renderExternalCartItems(item.selectedExternalVacancies, idx);
    }
    if (cartHeader) {
        cartHeader.textContent = `선택한 공실 (${item.selectedExternalVacancies?.length || 0})`;
    }
    
    // 프리뷰 테이블도 갱신
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) {
        window.renderBuildingEditor(item, building);
    }
}

// 장바구니에서 제거
export function removeFromExternalCart(idx, vacancyId) {
    const item = state.tocItems[idx];
    if (!item || !item.selectedExternalVacancies) return;
    
    item.selectedExternalVacancies = item.selectedExternalVacancies.filter(v => v.id !== vacancyId);
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) {
        window.renderBuildingEditor(item, building);
    }
}

// 장바구니 초기화
export function clearExternalCart(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.selectedExternalVacancies = [];
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) {
        window.renderBuildingEditor(item, building);
    }
}

// 타사 공실 필터링
export function filterExternalVacancies(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building || !building.vacancies) return;
    
    const sourceFilter = document.getElementById('extSourceFilter')?.value || 'all';
    const dateFilter = document.getElementById('extDateFilter')?.value || 'all';
    
    let filtered = [...building.vacancies];
    
    if (sourceFilter !== 'all') {
        filtered = filtered.filter(v => (v.source || '기타') === sourceFilter);
    }
    if (dateFilter !== 'all') {
        filtered = filtered.filter(v => (v.publishDate || v.date || '미정') === dateFilter);
    }
    
    const body = document.getElementById('extVacancyBody');
    if (body) {
        body.innerHTML = renderExternalVacancyGroups(filtered, item.selectedExternalVacancies, idx);
    }
}

// 타사 공실 검색 (Firebase Realtime DB)
export async function searchExternalVacancies(idx, buildingId) {
    showToast('공실 정보를 검색합니다...', 'info');
    
    try {
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (!building) return;
        
        // Firebase Realtime Database에서 공실 데이터 검색
        const vacancyRef = ref(db, `vacancies/${buildingId}`);
        const snapshot = await get(vacancyRef);
        
        if (snapshot.exists()) {
            const vacancyData = snapshot.val();
            // 배열로 변환
            building.vacancies = Object.entries(vacancyData).map(([id, v]) => ({
                id,
                ...v
            }));
            
            showToast(`${building.vacancies.length}개의 공실 정보를 찾았습니다`, 'success');
        } else {
            building.vacancies = [];
            showToast('등록된 공실 정보가 없습니다', 'warning');
        }
        
        // UI 갱신
        const item = state.tocItems[idx];
        if (item) {
            window.renderBuildingEditor(item, building);
        }
        
    } catch (error) {
        console.error('공실 검색 오류:', error);
        showToast('공실 정보 검색 중 오류가 발생했습니다', 'error');
    }
}

// ========== 직접 공실 입력 ==========

// 공실 추가 패널 토글
export function openVacancyAddPanel(idx) {
    const panel = document.getElementById('vacancyAddPanel');
    if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    }
}

// ★ 수정: 공실 입력 모드 전환 (guide 탭 추가)
export function switchAddVacancyMode(mode) {
    document.querySelectorAll('.vacancy-add-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    // 모든 탭 콘텐츠 숨기기
    const directEl = document.getElementById('addVacancyDirect');
    const externalEl = document.getElementById('addVacancyExternal');
    const guideEl = document.getElementById('addVacancyGuide');
    
    if (directEl) directEl.style.display = mode === 'direct' ? 'block' : 'none';
    if (externalEl) externalEl.style.display = mode === 'external' ? 'block' : 'none';
    if (guideEl) guideEl.style.display = mode === 'guide' ? 'block' : 'none';
}

// 직접 공실 추가
export function addDirectVacancy(idx) {
    const floor = document.getElementById('newVacFloor')?.value;
    const exclusiveArea = document.getElementById('newVacExclusive')?.value || '';
    const area = document.getElementById('newVacArea')?.value;
    const deposit = document.getElementById('newVacDeposit')?.value || '문의';
    const rent = document.getElementById('newVacRent')?.value || '문의';
    const maintenance = document.getElementById('newVacMaintenance')?.value || '문의';
    const moveIn = document.getElementById('newVacMoveIn')?.value || '-';
    
    if (!floor) {
        showToast('층을 입력하세요', 'error');
        return;
    }
    
    const item = state.tocItems[idx];
    if (!item) return;
    
    if (!item.customVacancies) item.customVacancies = [];
    
    item.customVacancies.push({ 
        floor, 
        exclusiveArea: exclusiveArea || area, 
        area, 
        rentArea: area,
        deposit, 
        rent, 
        maintenance,
        moveIn,
        createdAt: new Date().toISOString()
    });
    
    // 입력 필드 초기화
    document.getElementById('newVacFloor').value = '';
    document.getElementById('newVacExclusive').value = '';
    document.getElementById('newVacArea').value = '';
    document.getElementById('newVacDeposit').value = '';
    document.getElementById('newVacRent').value = '';
    document.getElementById('newVacMaintenance').value = '';
    document.getElementById('newVacMoveIn').value = '';
    
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
    showToast('공실이 추가되었습니다', 'success');
}

// 공실 수정
export function editVacancyItem(idx, vacancyId, type) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    let vacancy;
    if (type === 'custom') {
        const vacIdx = parseInt(vacancyId.replace('custom_', ''));
        vacancy = item.customVacancies?.[vacIdx];
    } else if (type === 'guide') {
        // ★ 추가: guide 타입 처리
        const vacIdx = parseInt(vacancyId.replace('guide_', ''));
        vacancy = item.leasingGuideVacancies?.[vacIdx];
    } else {
        vacancy = item.selectedExternalVacancies?.find(v => v.id === vacancyId);
    }
    
    if (!vacancy) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 간단한 프롬프트로 수정 (나중에 모달로 개선 가능)
    const newFloor = prompt('층:', vacancy.floor || '');
    if (newFloor === null) return;
    
    const newArea = prompt('면적(평):', vacancy.area || vacancy.rentArea || '');
    if (newArea === null) return;
    
    const newDeposit = prompt('보증금:', vacancy.deposit || vacancy.depositPy || '');
    if (newDeposit === null) return;
    
    const newRent = prompt('임대료:', vacancy.rent || vacancy.rentPy || '');
    if (newRent === null) return;
    
    const newMoveIn = prompt('입주시기:', vacancy.moveIn || vacancy.moveInDate || '');
    if (newMoveIn === null) return;
    
    // 업데이트
    vacancy.floor = newFloor;
    vacancy.area = newArea;
    vacancy.rentArea = newArea;
    vacancy.deposit = newDeposit;
    vacancy.depositPy = newDeposit;
    vacancy.rent = newRent;
    vacancy.rentPy = newRent;
    vacancy.moveIn = newMoveIn;
    vacancy.moveInDate = newMoveIn;
    
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
    showToast('공실 정보가 수정되었습니다', 'success');
}

// ★ 수정: 공실 삭제 (guide 타입 추가)
export function removeSelectedVacancy(idx, vacancyId, type) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    if (type === 'custom') {
        const vacIdx = parseInt(vacancyId.replace('custom_', ''));
        if (item.customVacancies) {
            item.customVacancies.splice(vacIdx, 1);
        }
    } else if (type === 'guide') {
        // ★ 추가: guide 타입 처리
        const vacIdx = parseInt(vacancyId.replace('guide_', ''));
        if (item.leasingGuideVacancies) {
            item.leasingGuideVacancies.splice(vacIdx, 1);
        }
    } else {
        if (item.selectedExternalVacancies) {
            item.selectedExternalVacancies = item.selectedExternalVacancies.filter(v => v.id !== vacancyId);
        }
    }
    
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
    showToast('공실이 삭제되었습니다', 'success');
}

// 전역 함수 등록
export function registerVacancyFunctions() {
    window.toggleSourceGroup = toggleSourceGroup;
    window.toggleExternalVacancyItem = toggleExternalVacancyItem;
    window.selectAllFromSource = selectAllFromSource;
    window.removeFromExternalCart = removeFromExternalCart;
    window.clearExternalCart = clearExternalCart;
    window.filterExternalVacancies = filterExternalVacancies;
    window.searchExternalVacancies = searchExternalVacancies;
    window.openVacancyAddPanel = openVacancyAddPanel;
    window.switchAddVacancyMode = switchAddVacancyMode;
    window.addDirectVacancy = addDirectVacancy;
    window.editVacancyItem = editVacancyItem;
    window.removeSelectedVacancy = removeSelectedVacancy;
}
