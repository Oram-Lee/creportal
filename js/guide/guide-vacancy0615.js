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

import { state, db, ref, get } from './guide-state.js?v=5.1';
import { showToast, formatPrice } from './guide-utils.js?v=5.1';
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
    
    // ★ v3.8: pending 상태도 확인
    const item = state.tocItems[idx];
    const pendingIds = (item?.pendingExternalVacancies || []).map(v => v.id);
    
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
        const allAppliedOrPending = group.items.every(v => selectedIds.includes(v.id) || pendingIds.includes(v.id));
        
        return `
            <div class="external-vacancy-group">
                <div class="external-vacancy-group-header" onclick="toggleSourceGroup(this)">
                    <span class="group-toggle">▼</span>
                    <span class="group-source">${group.source}</span>
                    <span class="group-date">${group.date}</span>
                    <span class="group-count">${group.items.length}건</span>
                    <button class="btn btn-xs ${allAppliedOrPending ? 'btn-secondary' : 'btn-primary'}" 
                            onclick="event.stopPropagation(); selectAllFromSource(${idx}, '${group.source}', '${group.date}')">
                        ${allAppliedOrPending ? '전체해제' : '전체선택'}
                    </button>
                </div>
                <div class="external-vacancy-group-body">
                    ${group.items.map(v => {
                        const isApplied = selectedIds.includes(v.id);
                        const isPending = pendingIds.includes(v.id);
                        // ★ 금액 포맷팅 적용
                        const priceDisplay = formatPrice(v.rentPy || v.rent || '문의');
                        const depositDisplay = formatPrice(v.depositPy || v.deposit || '');
                        return `
                            <div class="external-vacancy-item ${isApplied ? 'selected' : ''} ${isPending ? 'pending' : ''}" 
                                 onclick="toggleExternalVacancyItem(${idx}, '${v.id}', this)">
                                <input type="checkbox" class="vacancy-checkbox" ${(isApplied || isPending) ? 'checked' : ''} onclick="event.stopPropagation();">
                                <div class="vacancy-floor">${formatFloorDisplay(v.floor)}</div>
                                <div class="vacancy-area">${formatPrice(v.rentArea || v.area || '-')}/${formatPrice(v.exclusiveArea || v.area || '-')}평</div>
                                <div class="vacancy-deposit">${depositDisplay}</div>
                                <div class="vacancy-price">${priceDisplay}</div>
                                ${isApplied ? '<span style="font-size:9px; color:#16a34a; margin-left:auto;">✓적용</span>' : ''}
                                ${isPending ? '<span style="font-size:9px; color:#d97706; margin-left:auto;">⏳대기</span>' : ''}
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

// ★ v3.8: pending 배열 관리 (반영 버튼 확인 단계)
function ensurePendingArray(item) {
    if (!item.pendingExternalVacancies) item.pendingExternalVacancies = [];
}

// 개별 공실 선택/해제 (체크박스 연동 → pending에만 저장)
export function toggleExternalVacancyItem(idx, vacancyId, element) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    ensurePendingArray(item);
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building || !building.vacancies) return;
    
    const vacancy = building.vacancies.find(v => v.id === vacancyId);
    if (!vacancy) return;
    
    // ★ 이미 적용된 건 즉시 해제 허용 (기존 동작 유지)
    const appliedIdx = item.selectedExternalVacancies.findIndex(v => v.id === vacancyId);
    if (appliedIdx >= 0) {
        item.selectedExternalVacancies.splice(appliedIdx, 1);
        if (element) {
            element.classList.remove('selected', 'pending');
            const cb = element.querySelector('.vacancy-checkbox');
            if (cb) cb.checked = false;
        }
        updateExternalCart(idx);
        return;
    }
    
    // ★ pending에서 토글
    const pendingIdx = item.pendingExternalVacancies.findIndex(v => v.id === vacancyId);
    const checkbox = element?.querySelector('.vacancy-checkbox');
    
    if (pendingIdx >= 0) {
        // pending에서 제거
        item.pendingExternalVacancies.splice(pendingIdx, 1);
        if (element) element.classList.remove('pending');
        if (checkbox) checkbox.checked = false;
    } else {
        // pending에 추가
        item.pendingExternalVacancies.push({ ...vacancy, type: 'external' });
        if (element) element.classList.add('pending');
        if (checkbox) checkbox.checked = true;
    }
    
    updatePendingUI(idx);
}

// 출처별 전체 선택/해제 (pending에 저장)
export function selectAllFromSource(idx, source, date) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building || !building.vacancies) return;
    
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    ensurePendingArray(item);
    
    // 해당 출처+날짜의 공실들
    const sourceVacancies = building.vacancies.filter(v => 
        (v.source || '기타') === source && 
        (v.publishDate || v.date || '미정') === date
    );
    
    // 이미 적용된 건 제외
    const appliedIds = item.selectedExternalVacancies.map(v => v.id);
    const pendingIds = item.pendingExternalVacancies.map(v => v.id);
    const targetVacancies = sourceVacancies.filter(v => !appliedIds.includes(v.id));
    
    const allInPending = targetVacancies.every(v => pendingIds.includes(v.id));
    
    if (allInPending) {
        // 전체 해제 (pending에서)
        item.pendingExternalVacancies = item.pendingExternalVacancies.filter(v => 
            !targetVacancies.find(tv => tv.id === v.id)
        );
    } else {
        // 전체 선택 (pending에)
        targetVacancies.forEach(v => {
            if (!pendingIds.includes(v.id)) {
                item.pendingExternalVacancies.push({ ...v, type: 'external' });
            }
        });
    }
    
    // UI 갱신
    window.renderBuildingEditor(item, building);
}

// ★ v3.8: pending UI만 업데이트 (전체 리렌더 없이 장바구니 영역만)
export function updatePendingUI(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const pendingCount = item.pendingExternalVacancies?.length || 0;
    const appliedCount = item.selectedExternalVacancies?.length || 0;
    
    // 장바구니 헤더 업데이트
    const cartHeader = document.querySelector('.external-vacancy-cart-header span');
    if (cartHeader) {
        cartHeader.textContent = `✓ 적용됨 (${appliedCount})${pendingCount > 0 ? ` / 대기 (${pendingCount})` : ''}`;
    }
    
    // pending 반영 버튼 영역
    const pendingBar = document.getElementById('extPendingBar');
    if (pendingBar) {
        if (pendingCount > 0) {
            pendingBar.style.display = 'flex';
            pendingBar.innerHTML = `
                <span style="font-size:12px; color:#d97706; font-weight:600;">⏳ ${pendingCount}건 대기 중</span>
                <div style="display:flex; gap:4px;">
                    <button class="btn btn-sm" onclick="cancelPendingExternal(${idx})" 
                        style="background:#f3f4f6; color:#6b7280; border:1px solid #d1d5db; font-size:11px; padding:3px 8px;">취소</button>
                    <button class="btn btn-sm btn-primary" onclick="applyPendingExternalVacancies(${idx})" 
                        style="background:#2563eb; color:white; font-size:11px; padding:3px 10px; font-weight:600;">✓ 반영</button>
                </div>
            `;
        } else {
            pendingBar.style.display = 'none';
        }
    }
}

// ★ v3.8: pending → selected 실제 반영
export function applyPendingExternalVacancies(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    if (!item.pendingExternalVacancies || item.pendingExternalVacancies.length === 0) {
        showToast('반영할 공실이 없습니다', 'warning');
        return;
    }
    
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    
    // pending → selected로 이동 (중복 방지)
    const existingIds = item.selectedExternalVacancies.map(v => v.id);
    item.pendingExternalVacancies.forEach(v => {
        if (!existingIds.includes(v.id)) {
            item.selectedExternalVacancies.push(v);
        }
    });
    
    const appliedCount = item.pendingExternalVacancies.length;
    item.pendingExternalVacancies = [];
    
    // 전체 UI 갱신 (공실 테이블 포함)
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) {
        window.renderBuildingEditor(item, building);
    }
    
    showToast(`${appliedCount}건 공실이 반영되었습니다`, 'success');
}

// ★ v3.8: pending 취소
export function cancelPendingExternal(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.pendingExternalVacancies = [];
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) {
        window.renderBuildingEditor(item, building);
    }
}

// 장바구니 업데이트 (applied만 표시, pending은 updatePendingUI에서)
export function updateExternalCart(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    // ★ 적용된 공실 → 전체 리렌더 (공실 테이블 반영)
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

// 장바구니 초기화 (적용됨 + 대기 모두)
export function clearExternalCart(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.selectedExternalVacancies = [];
    item.pendingExternalVacancies = [];
    
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
        sourceType: 'direct',
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

// ★ 인라인 행 편집 시작 (테이블 행 → input 필드 전환)
export function startVacancyRowEdit(idx, vacancyId, type, btn) {
    const row = document.getElementById(`vacRow_${idx}_${vacancyId.replace(/[^a-zA-Z0-9_]/g, '_')}`);
    // id에 특수문자가 있을 수 있으므로 data-vacid로 찾기
    const allRows = document.querySelectorAll(`[data-vacid="${vacancyId}"]`);
    const targetRow = allRows.length > 0 ? allRows[0] : null;
    if (!targetRow) return;

    const item = state.tocItems[idx];
    if (!item) return;
    let vacancy;
    if (type === 'custom') {
        const vacIdx = parseInt(vacancyId.replace('custom_', ''));
        vacancy = item.customVacancies?.[vacIdx];
    } else if (type === 'guide') {
        const vacIdx = parseInt(vacancyId.replace('guide_', ''));
        vacancy = item.leasingGuideVacancies?.[vacIdx];
    } else {
        vacancy = item.selectedExternalVacancies?.find(v => v.id === vacancyId);
    }
    if (!vacancy) return;

    const dep = vacancy.deposit ?? vacancy.depositPy ?? '';
    const rent = vacancy.rent ?? vacancy.rentPy ?? '';
    const maint = vacancy.maintenance ?? vacancy.maintenancePy ?? '';
    const moveIn = vacancy.moveIn ?? vacancy.moveInDate ?? '';

    targetRow.innerHTML = `
        <td><input id="veFloor_${idx}" value="${vacancy.floor || ''}" style="width:48px; font-size:11px; border:1px solid #93c5fd; border-radius:4px; padding:2px 4px;"></td>
        <td><input id="veExcl_${idx}" value="${vacancy.exclusiveArea || vacancy.area || ''}" style="width:56px; font-size:11px; border:1px solid #93c5fd; border-radius:4px; padding:2px 4px;"></td>
        <td><input id="veRentArea_${idx}" value="${vacancy.rentArea || vacancy.area || ''}" style="width:56px; font-size:11px; border:1px solid #93c5fd; border-radius:4px; padding:2px 4px;"></td>
        <td><input id="veDep_${idx}" value="${dep}" placeholder="문의" style="width:60px; font-size:11px; border:1px solid #93c5fd; border-radius:4px; padding:2px 4px;"></td>
        <td><input id="veRent_${idx}" value="${rent}" placeholder="문의" style="width:60px; font-size:11px; border:1px solid #93c5fd; border-radius:4px; padding:2px 4px;"></td>
        <td><input id="veMaint_${idx}" value="${maint}" placeholder="문의" style="width:60px; font-size:11px; border:1px solid #93c5fd; border-radius:4px; padding:2px 4px;"></td>
        <td><input id="veMoveIn_${idx}" value="${moveIn}" style="width:60px; font-size:11px; border:1px solid #93c5fd; border-radius:4px; padding:2px 4px;"></td>
        <td>
            <div class="actions">
                <button class="btn btn-sm btn-primary" onclick="saveVacancyRowEdit(${idx}, '${vacancyId}', '${type}', this)" style="font-size:11px; padding:2px 6px;">💾</button>
                <button class="btn btn-sm btn-secondary" onclick="cancelVacancyRowEdit(${idx}, '${vacancyId}')" style="font-size:11px; padding:2px 6px;">✕</button>
            </div>
        </td>
    `;
    targetRow.style.background = '#eff6ff';
}

// ★ 인라인 행 편집 저장
export function saveVacancyRowEdit(idx, vacancyId, type, btn) {
    const item = state.tocItems[idx];
    if (!item) return;
    let vacancy;
    if (type === 'custom') {
        const vacIdx = parseInt(vacancyId.replace('custom_', ''));
        vacancy = item.customVacancies?.[vacIdx];
    } else if (type === 'guide') {
        const vacIdx = parseInt(vacancyId.replace('guide_', ''));
        vacancy = item.leasingGuideVacancies?.[vacIdx];
    } else {
        vacancy = item.selectedExternalVacancies?.find(v => v.id === vacancyId);
    }
    if (!vacancy) return;

    const floorVal = document.getElementById(`veFloor_${idx}`)?.value ?? vacancy.floor;
    const exclVal  = document.getElementById(`veExcl_${idx}`)?.value ?? '';
    const rentAreaVal = document.getElementById(`veRentArea_${idx}`)?.value ?? '';
    const depVal   = document.getElementById(`veDep_${idx}`)?.value;
    const rentVal  = document.getElementById(`veRent_${idx}`)?.value;
    const maintVal = document.getElementById(`veMaint_${idx}`)?.value;
    const moveInVal = document.getElementById(`veMoveIn_${idx}`)?.value ?? '';

    // 빈 문자열 → '문의' 처리
    vacancy.floor = floorVal;
    vacancy.exclusiveArea = exclVal;
    vacancy.area = rentAreaVal;
    vacancy.rentArea = rentAreaVal;
    vacancy.deposit = depVal !== '' ? depVal : '문의';
    vacancy.depositPy = vacancy.deposit;
    vacancy.rent = rentVal !== '' ? rentVal : '문의';
    vacancy.rentPy = vacancy.rent;
    vacancy.maintenance = maintVal !== '' ? maintVal : '문의';
    vacancy.maintenancePy = vacancy.maintenance;
    vacancy.moveIn = moveInVal;
    vacancy.moveInDate = moveInVal;

    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
    showToast('공실 정보가 수정되었습니다', 'success');
}

// ★ 인라인 행 편집 취소
export function cancelVacancyRowEdit(idx, vacancyId) {
    const item = state.tocItems[idx];
    if (!item) return;
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
}

// 공실 수정 (레거시 호환 - prompt 방식 유지)
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
    window.startVacancyRowEdit = startVacancyRowEdit;
    window.saveVacancyRowEdit = saveVacancyRowEdit;
    window.cancelVacancyRowEdit = cancelVacancyRowEdit;
    // ★ v3.8: pending 관련
    window.applyPendingExternalVacancies = applyPendingExternalVacancies;
    window.cancelPendingExternal = cancelPendingExternal;
    window.updatePendingUI = updatePendingUI;
    
    // ★ v3.8: pending 상태 CSS 주입
    if (!document.getElementById('pendingVacancyCSS')) {
        const style = document.createElement('style');
        style.id = 'pendingVacancyCSS';
        style.textContent = `
            .external-vacancy-item.pending {
                background: #fffbeb !important;
                border-left: 3px solid #f59e0b !important;
            }
            .external-vacancy-item.pending .vacancy-checkbox {
                accent-color: #f59e0b;
            }
        `;
        document.head.appendChild(style);
    }
}
