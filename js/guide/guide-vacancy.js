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

import { state, db, ref, get } from './guide-state.js?v=5.5';
import { showToast, formatPrice } from './guide-utils.js?v=5.10';
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

// 타사 공실 그룹 렌더링 (체크=선택(반영 전) / 🟢=이미 반영됨, 관리비·입주시기 포함)
export function renderExternalVacancyGroups(vacancies, selectedVacancies, idx) {
    if (!vacancies || vacancies.length === 0) {
        return '<div class="external-vacancy-empty">타사 공실 정보가 없습니다</div>';
    }

    // 출처+날짜별 그룹핑
    const groups = {};
    vacancies.forEach(v => {
        const key = `${v.source || '기타'}_${v.publishDate || v.date || '미정'}`;
        if (!groups[key]) {
            groups[key] = { source: v.source || '기타', date: v.publishDate || v.date || '미정', items: [] };
        }
        groups[key].items.push(v);
    });

    const sortedGroups = Object.values(groups).sort((a, b) => b.date.localeCompare(a.date));
    const committedIds = (selectedVacancies || []).map(v => v.id);
    const item = state.tocItems[idx];
    const stagedIds = (item?.pendingExternalVacancies || []).map(v => v.id);
    const isSel = (id) => committedIds.includes(id) || stagedIds.includes(id);

    return sortedGroups.map(group => {
        const allSelected = group.items.every(v => isSel(v.id));
        const groupSelCount = group.items.filter(v => isSel(v.id)).length;

        return `
            <div class="external-vacancy-group">
                <div class="external-vacancy-group-header" onclick="toggleSourceGroup(this)">
                    <span class="group-toggle">▶</span>
                    <span class="group-source">${group.source}</span>
                    <span class="group-date">${group.date}</span>
                    <span class="group-count">${group.items.length}건</span>
                    ${groupSelCount > 0 ? `<span class="group-selected-badge" style="font-size:11px; font-weight:700; color:#1d4ed8; background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:1px 8px; margin-left:2px;">선택 ${groupSelCount}</span>` : ''}
                    <button class="btn btn-xs ${allSelected ? 'btn-secondary' : 'btn-primary'}"
                            onclick="event.stopPropagation(); selectAllFromSource(${idx}, '${group.source}', '${group.date}')">
                        ${allSelected ? '전체해제' : '전체선택'}
                    </button>
                </div>
                <div class="external-vacancy-group-body" style="display:none;">
                    ${group.items.map(v => {
                        const isCommitted = committedIds.includes(v.id);
                        const isStaged = stagedIds.includes(v.id) && !isCommitted;
                        const checked = isCommitted || isStaged;
                        const cls = isCommitted ? 'committed' : (isStaged ? 'staged' : '');
                        const depositDisplay = formatPrice(v.depositPy ?? v.deposit ?? '문의');
                        const rentDisplay = formatPrice(v.rentPy ?? v.rent ?? '문의');
                        const maintDisplay = formatPrice(v.maintenancePy ?? v.maintenance ?? '문의');
                        const moveInDisplay = v.moveIn || v.moveInDate || '협의';
                        const badge = isCommitted
                            ? '<span class="ev-badge ev-committed" title="이미 공실 현황에 반영됨">🟢</span>'
                            : (isStaged ? '<span class="ev-badge ev-staged" title="선택됨 (반영 전)">🔵</span>' : '<span class="ev-badge"></span>');
                        return `
                            <div class="external-vacancy-item ${cls}"
                                 onclick="toggleExternalVacancyItem(${idx}, '${v.id}', this)">
                                <input type="checkbox" class="vacancy-checkbox" ${checked ? 'checked' : ''} tabindex="-1" aria-hidden="true">
                                <div class="vacancy-floor">${formatFloorDisplay(v.floor)}</div>
                                <div class="vacancy-area">${formatPrice(v.exclusiveArea || v.area || '-')}/${formatPrice(v.rentArea || v.area || '-')}</div>
                                <div class="vacancy-deposit">${depositDisplay}</div>
                                <div class="vacancy-rent">${rentDisplay}</div>
                                <div class="vacancy-maint">${maintDisplay}</div>
                                <div class="vacancy-movein">${moveInDisplay}</div>
                                ${badge}
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

// ★ 하단 "선택 바구니" 태그 (반영 전 = 파랑, ✕로 선택 해제)
export function renderExternalCartTags(applied, pending, idx) {
    const p = pending || [];
    if (p.length === 0) {
        return '<span style="color:#94a3b8; font-size:11px; padding:4px 0; display:block;">선택한 공실이 없습니다 — 리스트에서 체크하세요</span>';
    }
    const srcLabel = (v) => {
        const sc = v.source || v.company || '';
        const d = v.publishDate || v.date || '';
        return (sc || d) ? `${sc}${sc && d ? ' ' : ''}${d}` : '';
    };
    const tag = (v) => {
        const floor = formatFloorDisplay(v.floor) || v.floorLabel || '-';
        const sc = srcLabel(v);
        return `<span class="ext-cart-tag" style="background:#eff6ff; border:1px solid #bfdbfe; color:#1d4ed8; border-radius:6px; padding:3px 8px; font-size:11px; display:inline-flex; align-items:center; gap:5px; margin:2px;">`
            + `<span style="font-size:10px;">☑</span>`
            + `<span style="font-weight:700;">${floor}</span>`
            + (sc ? `<span style="opacity:.8;">· ${sc}</span>` : '')
            + `<button onclick="removePendingExternal(${idx}, '${v.id}')" title="선택 해제" style="border:none; background:transparent; color:#1d4ed8; cursor:pointer; font-size:12px; line-height:1; padding:0; margin-left:2px;">✕</button>`
            + `</span>`;
    };
    return p.map(tag).join('');
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

// ★ [A1] 출처 그룹 모두 펼치기/접기 토글 (스크롤 과다 해소)
export function expandAllExternalGroups(idx) {
    const container = document.getElementById('extVacancyBody_' + idx);
    if (!container) return;
    const bodies = container.querySelectorAll('.external-vacancy-group-body');
    const btn = document.getElementById('extExpandToggle_' + idx);
    const anyCollapsed = Array.from(bodies).some(b => b.style.display === 'none');
    bodies.forEach(b => {
        b.style.display = anyCollapsed ? 'block' : 'none';
        const tg = b.previousElementSibling && b.previousElementSibling.querySelector('.group-toggle');
        if (tg) tg.textContent = anyCollapsed ? '▼' : '▶';
    });
    if (btn) btn.textContent = anyCollapsed ? '▲ 모두 접기' : '▼ 모두 펼치기';
}

// 개별 공실 클릭/체크 = 선택(반영 전) 토글. 이미 반영된 항목 클릭 시 반영 취소.
export function toggleExternalVacancyItem(idx, vacancyId, element) {
    const item = state.tocItems[idx];
    if (!item) return;
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    if (!item.pendingExternalVacancies) item.pendingExternalVacancies = [];

    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building || !building.vacancies) return;
    const vacancy = building.vacancies.find(v => v.id === vacancyId);
    if (!vacancy) return;

    // 1) 이미 반영됨(committed) → 반영 취소 (공실 현황에서 제거)
    const ci = item.selectedExternalVacancies.findIndex(v => v.id === vacancyId);
    if (ci >= 0) {
        item.selectedExternalVacancies.splice(ci, 1);
        refreshExternalArea(idx);
        return;
    }
    // 2) 선택(staged) 토글
    const pi = item.pendingExternalVacancies.findIndex(v => v.id === vacancyId);
    if (pi >= 0) {
        item.pendingExternalVacancies.splice(pi, 1);
    } else {
        const k = _vacKey(vacancy);
        const dup = item.selectedExternalVacancies.some(v => _vacKey(v) === k)
                 || item.pendingExternalVacancies.some(v => _vacKey(v) === k);
        if (dup) {
            showToast('이미 동일 조건의 공실이 선택되어 있습니다', 'info');
            refreshExternalArea(idx);
            return;
        }
        item.pendingExternalVacancies.push({ ...vacancy, type: 'external' });
    }
    refreshExternalArea(idx);
}

// 출처별 전체 선택/해제 (선택=staged에 모음, 전체해제=staged·committed 모두 제거)
export function selectAllFromSource(idx, source, date) {
    const item = state.tocItems[idx];
    if (!item) return;
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building || !building.vacancies) return;
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    if (!item.pendingExternalVacancies) item.pendingExternalVacancies = [];

    const sourceVacancies = building.vacancies.filter(v =>
        (v.source || '기타') === source &&
        (v.publishDate || v.date || '미정') === date
    );

    const committedIds = new Set(item.selectedExternalVacancies.map(v => v.id));
    const stagedIds = new Set(item.pendingExternalVacancies.map(v => v.id));
    const allSel = sourceVacancies.length > 0 && sourceVacancies.every(v => committedIds.has(v.id) || stagedIds.has(v.id));

    if (allSel) {
        // 전체 해제 (선택 + 반영 모두)
        const ids = new Set(sourceVacancies.map(v => v.id));
        item.pendingExternalVacancies = item.pendingExternalVacancies.filter(v => !ids.has(v.id));
        item.selectedExternalVacancies = item.selectedExternalVacancies.filter(v => !ids.has(v.id));
    } else {
        // 미선택분만 staged에 추가 (내용 기반 중복 제외)
        const existKeys = new Set([...item.selectedExternalVacancies, ...item.pendingExternalVacancies].map(_vacKey));
        sourceVacancies.forEach(v => {
            if (committedIds.has(v.id) || stagedIds.has(v.id)) return;
            const k = _vacKey(v);
            if (existKeys.has(k)) return;
            item.pendingExternalVacancies.push({ ...v, type: 'external' });
            existKeys.add(k); stagedIds.add(v.id);
        });
    }
    refreshExternalArea(idx);
}

// 장바구니 업데이트 (선택된 공실만 표시 - 대기 개념 없음)
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

// 선택(반영 전) 전체 해제 — 이미 반영된 항목은 유지
export function clearExternalCart(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    item.pendingExternalVacancies = [];
    refreshExternalArea(idx);
}

// 타사 공실 필터링 (출처/날짜 셀렉트 → 부분 갱신 + 자동 펼침)
export function filterExternalVacancies(idx) {
    refreshExternalArea(idx);
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
            building.vacancies = Object.entries(vacancyData)
                .map(([id, v]) => ({ id, ...(v && typeof v === 'object' ? v : {}) }))
                .filter(v => {
                    const _s = x => (x === undefined || x === null) ? '' : String(x).trim();
                    const _floor = _s(v.floor);
                    const _area = _s(v.rentArea) || _s(v.exclusiveArea) || _s(v.area);
                    return (_floor && _floor !== '-') || (_area && _area !== '-');
                });
            
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
    const company = document.getElementById('newVacCompany')?.value || '';
    const publishDate = document.getElementById('newVacPublishDate')?.value || '';
    
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
        source: company || '직접입력',
        publishDate: publishDate || '',
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
    if (document.getElementById('newVacCompany')) document.getElementById('newVacCompany').value = '';
    if (document.getElementById('newVacPublishDate')) document.getElementById('newVacPublishDate').value = '';
    
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
    const srcName = (vacancy.source || vacancy.company) || '';
    const srcDate = (vacancy.publishDate || vacancy.date) || '';

    // 공통 인풋 스타일 (기준가 편집과 동일 기준: 채우기 + 넉넉한 패딩 + 라운드 6px)
    const inBase = 'width:100%; box-sizing:border-box; font-size:13px; padding:7px 6px; border:1px solid #2563eb; border-radius:6px; outline:none;';
    const numStyle = inBase + ' text-align:right;';
    const ctrStyle = inBase + ' text-align:center;';

    targetRow.innerHTML = `
        <td><input id="veFloor_${idx}" value="${vacancy.floor || ''}" style="${ctrStyle} min-width:50px;"></td>
        <td><input id="veExcl_${idx}" class="js-comma" inputmode="decimal" value="${vacancy.exclusiveArea || vacancy.area || ''}" style="${numStyle} min-width:60px;"></td>
        <td><input id="veRentArea_${idx}" class="js-comma" inputmode="decimal" value="${vacancy.rentArea || vacancy.area || ''}" style="${numStyle} min-width:60px;"></td>
        <td><input id="veDep_${idx}" class="js-comma" inputmode="decimal" value="${dep}" placeholder="문의" style="${numStyle} min-width:70px;"></td>
        <td><input id="veRent_${idx}" class="js-comma" inputmode="decimal" value="${rent}" placeholder="문의" style="${numStyle} min-width:70px;"></td>
        <td><input id="veMaint_${idx}" class="js-comma" inputmode="decimal" value="${maint}" placeholder="문의" style="${numStyle} min-width:70px;"></td>
        <td><input id="veMoveIn_${idx}" value="${moveIn}" placeholder="협의" style="${ctrStyle} min-width:76px;"></td>
        <td style="font-size:11px; color:#64748b; line-height:1.35;">${srcName || '<span style="color:#cbd5e1;">-</span>'}${srcDate ? '<br><span style="color:#94a3b8;">' + srcDate + '</span>' : ''}</td>
        <td>
            <div class="actions" style="display:flex; gap:4px; white-space:nowrap; justify-content:center;">
                <button onclick="saveVacancyRowEdit(${idx}, '${vacancyId}', '${type}', this)" style="font-size:13px; padding:7px 12px; border-radius:6px; background:#2563eb; color:#fff; border:none; cursor:pointer; font-weight:700;">저장</button>
                <button onclick="cancelVacancyRowEdit(${idx}, '${vacancyId}')" style="font-size:13px; padding:7px 10px; border-radius:6px; background:#f1f5f9; color:#64748b; border:1px solid #e2e8f0; cursor:pointer;">취소</button>
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

    const stripComma = (s) => (s === undefined || s === null) ? s : String(s).replace(/,/g, '');
    const floorVal = document.getElementById(`veFloor_${idx}`)?.value ?? vacancy.floor;
    const exclVal  = stripComma(document.getElementById(`veExcl_${idx}`)?.value ?? '');
    const rentAreaVal = stripComma(document.getElementById(`veRentArea_${idx}`)?.value ?? '');
    const depVal   = stripComma(document.getElementById(`veDep_${idx}`)?.value ?? '');
    const rentVal  = stripComma(document.getElementById(`veRent_${idx}`)?.value ?? '');
    const maintVal = stripComma(document.getElementById(`veMaint_${idx}`)?.value ?? '');
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

// ★ 공실 행 복사 — 원본이 어느 계통이든 복사본은 항상 customVacancies 로 들어간다.
//   타사/타안내문 공실은 원본을 수정할 수 없으므로, 복사본을 직접입력 공실로 만들어야
//   인라인 편집·삭제가 가능하다. usage 는 반드시 보존한다 (리테일 공실이 오피스로 바뀌면 표에서 사라짐).
export function copyVacancyRow(idx, vacancyId, type) {
    const item = state.tocItems[idx];
    if (!item) return;

    let src;
    if (type === 'custom') {
        src = item.customVacancies?.[parseInt(vacancyId.replace('custom_', ''))];
    } else if (type === 'guide') {
        src = item.leasingGuideVacancies?.[parseInt(vacancyId.replace('guide_', ''))];
    } else {
        src = item.selectedExternalVacancies?.find(v => v.id === vacancyId);
    }
    if (!src) {
        showToast('복사할 공실을 찾을 수 없습니다', 'error');
        return;
    }

    const max = window.MAX_VACANCIES_PER_BUILDING || 12;
    const total = (item.customVacancies?.length || 0)
                + (item.selectedExternalVacancies?.length || 0)
                + (item.leasingGuideVacancies?.length || 0);
    if (total >= max) {
        showToast(`최대 공실 개수(${max}개)에 도달했습니다`, 'error');
        return;
    }

    if (!item.customVacancies) item.customVacancies = [];
    const copy = JSON.parse(JSON.stringify(src));
    // 계통 식별자는 표 렌더 시 재계산되므로 제거한다
    delete copy.id;
    delete copy.type;
    copy.sourceType = 'direct';
    copy.createdAt = new Date().toISOString();
    item.customVacancies.push(copy);

    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
    showToast('공실을 복사했습니다', 'success');
}

// ★ v6.2: 타사 공실 — 내용 기반 중복키 (같은 호실이 여러 발행월에 중복 캡처돼도 1건으로 합침: 출처/날짜 제외)
function _vacKey(v) {
    const norm = (x) => (x === undefined || x === null) ? '' : String(x).replace(/[, ]/g, '').trim();
    return [norm(v.floor), norm(v.exclusiveArea ?? v.area), norm(v.rentArea), norm(v.depositPy ?? v.deposit), norm(v.rentPy ?? v.rent)].join('|');
}

// ★ 하단 선택 바구니 UI 부분 갱신 (선택=staged 기준, 반영됨도 안내)
function _refreshExternalCartUI(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    const staged = item.pendingExternalVacancies || [];
    const committed = item.selectedExternalVacancies || [];
    const countEl = document.getElementById('extSelectedCount_' + idx);
    if (countEl) countEl.textContent = staged.length;
    const cartBody = document.getElementById('extCartBody_' + idx);
    if (cartBody) cartBody.innerHTML = renderExternalCartTags(committed, staged, idx);
    const statusEl = document.getElementById('extCartStatus_' + idx);
    if (statusEl) {
        if (staged.length === 0) {
            statusEl.innerHTML = committed.length
                ? '<span style="font-size:11px; color:#16a34a; font-weight:600;">🟢 반영됨 ' + committed.length + '</span>'
                : '<span style="font-size:11px; color:#94a3b8;">공실을 선택하세요</span>';
        } else {
            statusEl.innerHTML = '<span style="font-size:11px; color:#2563eb; font-weight:700;">🔵 선택 ' + staged.length + '</span>'
                + (committed.length ? ' <span style="font-size:11px; color:#16a34a; font-weight:600;">· 🟢 반영됨 ' + committed.length + '</span>' : '')
                + ' <span style="font-size:11px; color:#94a3b8;">— [반영] 누르면 공실 현황에 추가</span>';
        }
    }
}

// ★ 타사 공실 아코디언 + 카트 부분 재렌더 (펼침 보존 → 패널 안 닫힘)
//   + 필터 선택 시 해당 그룹 자동 펼침 + 메인 공실표 즉시 동기화
export function refreshExternalArea(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building) return;
    const body = document.getElementById('extVacancyBody_' + idx);

    // 현재 필터값
    const src = document.getElementById('extSourceFilter_' + idx)?.value || 'all';
    const dt = document.getElementById('extDateFilter_' + idx)?.value || 'all';
    const filterActive = (src !== 'all' || dt !== 'all');

    // 펼친 그룹 캡처 (출처|날짜)
    const expanded = [];
    if (body) {
        body.querySelectorAll('.external-vacancy-group').forEach(g => {
            const b = g.querySelector('.external-vacancy-group-body');
            if (b && b.style.display !== 'none') {
                expanded.push((g.querySelector('.group-source')?.textContent || '') + '|' + (g.querySelector('.group-date')?.textContent || ''));
            }
        });
    }

    // 필터 적용
    let list = [...(building.vacancies || [])];
    if (src !== 'all') list = list.filter(v => (v.source || '기타') === src);
    if (dt !== 'all') list = list.filter(v => (v.publishDate || v.date || '미정') === dt);

    if (body) {
        body.innerHTML = renderExternalVacancyGroups(list, item.selectedExternalVacancies || [], idx);
        body.querySelectorAll('.external-vacancy-group').forEach(g => {
            const key = (g.querySelector('.group-source')?.textContent || '') + '|' + (g.querySelector('.group-date')?.textContent || '');
            // 필터가 걸리면 무조건 펼침, 아니면 이전 펼침 상태 복원
            if (filterActive || expanded.includes(key)) {
                const b = g.querySelector('.external-vacancy-group-body');
                const t = g.querySelector('.group-toggle');
                if (b) b.style.display = '';
                if (t) t.textContent = '▼';
            }
        });
    }
    _refreshExternalCartUI(idx);
    // ★ 메인 "선택된 공실" 표 즉시 반영 (전체 재렌더 없이 tbody만)
    if (typeof window.refreshVacancyListTable === 'function') window.refreshVacancyListTable(idx);
    // ★ 편집화면 프리뷰(A4) 공실표도 즉시 반영
    if (typeof window.refreshPreviewVacancyTable === 'function') window.refreshPreviewVacancyTable(idx);
}

// ★ 전체 재렌더 후 공실 추가 패널 + 타사 탭 복원 (등록 테이블 변경 시)
function _rerenderKeepExternal(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building) return;
    window.renderBuildingEditor(item, building);
    setTimeout(() => {
        const panel = document.getElementById('vacancyAddPanel');
        if (panel) panel.style.display = 'block';
        if (typeof window.switchVacancyAddTab === 'function') window.switchVacancyAddTab('external', idx);
        document.getElementById('extCartPanel_' + idx)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
}

// ★ 선택 바구니에서 단건 해제 (반영 전)
export function removePendingExternal(idx, id) {
    const item = state.tocItems[idx];
    if (!item || !item.pendingExternalVacancies) return;
    item.pendingExternalVacancies = item.pendingExternalVacancies.filter(v => v.id !== id);
    refreshExternalArea(idx);
}

// ★ 반영 취소 (이미 반영된 항목 제거) — 메인 표/리스트 동기화
export function removeAppliedExternal(idx, id) {
    const item = state.tocItems[idx];
    if (!item || !item.selectedExternalVacancies) return;
    item.selectedExternalVacancies = item.selectedExternalVacancies.filter(v => v.id !== id);
    refreshExternalArea(idx);
}

// ★ [반영] 선택(staged) → 공실 현황(committed) 일괄 반영 + 중복 정리
export function applyPendingExternalVacancies(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    if (!item.pendingExternalVacancies || item.pendingExternalVacancies.length === 0) {
        showToast('선택한 공실이 없습니다', 'warning');
        return;
    }
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];

    // id + 내용 기반 이중 중복 제거
    const existIds = new Set(item.selectedExternalVacancies.map(v => v.id));
    const existKeys = new Set(item.selectedExternalVacancies.map(_vacKey));
    let added = 0;
    item.pendingExternalVacancies.forEach(v => {
        const k = _vacKey(v);
        if (!existIds.has(v.id) && !existKeys.has(k)) {
            item.selectedExternalVacancies.push(v);
            existIds.add(v.id); existKeys.add(k);
            added++;
        }
    });
    const skipped = item.pendingExternalVacancies.length - added;
    item.pendingExternalVacancies = [];

    // 리스트(🟢 반영됨 표시) + 카트(비움) + 메인 공실표 동기화
    refreshExternalArea(idx);
    showToast(`${added}건 반영${skipped > 0 ? ` · 중복 ${skipped}건 제외` : ''}`, added > 0 ? 'success' : 'info');
}

// 전역 함수 등록
export function registerVacancyFunctions() {
    window.toggleSourceGroup = toggleSourceGroup;
    window.expandAllExternalGroups = expandAllExternalGroups;
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
    window.copyVacancyRow = copyVacancyRow;
    window.startVacancyRowEdit = startVacancyRowEdit;
    window.saveVacancyRowEdit = saveVacancyRowEdit;
    window.cancelVacancyRowEdit = cancelVacancyRowEdit;
    // 타사 공실 — A안(선택→반영 2단계)
    window.refreshExternalArea = refreshExternalArea;
    window.applyPendingExternalVacancies = applyPendingExternalVacancies;
    window.removePendingExternal = removePendingExternal;
    window.removeAppliedExternal = removeAppliedExternal;
    window.renderExternalCartTags = renderExternalCartTags;
}
