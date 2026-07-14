/**
 * CRE Portal - 필터링 기능
 */

import { state, resetFilters } from './portal-state.js';
import { showToast, debounce } from './portal-utils.js';

// 필터 적용
export function applyFilter(type) {
    const dd = document.getElementById(`filter${type.charAt(0).toUpperCase() + type.slice(1)}`);
    
    if (type === 'region') {
        state.activeFilters.region = [...dd.querySelectorAll('.filter-option.selected')]
            .map(e => e.dataset.value);
    } else if (type === 'area') {
        state.activeFilters.areaMin = parseFloat(document.getElementById('areaMin').value) || null;
        state.activeFilters.areaMax = parseFloat(document.getElementById('areaMax').value) || null;
        state.activeFilters.vacancyAreaMin = parseFloat(document.getElementById('vacancyAreaMin')?.value) || null;
        state.activeFilters.vacancyAreaMax = parseFloat(document.getElementById('vacancyAreaMax')?.value) || null;
    } else if (type === 'rent') {
        state.activeFilters.rentMin = parseFloat(document.getElementById('rentMin').value) || null;
        state.activeFilters.rentMax = parseFloat(document.getElementById('rentMax').value) || null;
    } else if (type === 'efficiency') {
        state.activeFilters.effMin = parseFloat(document.getElementById('effMin').value) || null;
        state.activeFilters.effMax = parseFloat(document.getElementById('effMax').value) || null;
    } else if (type === 'incentive') {
        const selected = dd.querySelector('.filter-option.selected');
        state.activeFilters.incentiveFilter = selected ? selected.dataset.value : null;
    }
    
    dd.classList.remove('show');
    updateFilterChipState();
    applyFilters();
}

// 필터 클리어
export function clearFilter(type) {
    if (type === 'region') {
        state.activeFilters.region = [];
        document.querySelectorAll('#filterRegion .filter-option').forEach(e => e.classList.remove('selected'));
    } else if (type === 'area') {
        state.activeFilters.areaMin = state.activeFilters.areaMax = null;
        state.activeFilters.vacancyAreaMin = state.activeFilters.vacancyAreaMax = null;
        document.getElementById('areaMin').value = '';
        document.getElementById('areaMax').value = '';
        if (document.getElementById('vacancyAreaMin')) document.getElementById('vacancyAreaMin').value = '';
        if (document.getElementById('vacancyAreaMax')) document.getElementById('vacancyAreaMax').value = '';
    } else if (type === 'rent') {
        state.activeFilters.rentMin = state.activeFilters.rentMax = null;
        document.getElementById('rentMin').value = '';
        document.getElementById('rentMax').value = '';
    } else if (type === 'efficiency') {
        state.activeFilters.effMin = state.activeFilters.effMax = null;
        document.getElementById('effMin').value = '';
        document.getElementById('effMax').value = '';
    } else if (type === 'incentive') {
        state.activeFilters.incentiveFilter = null;
        document.querySelectorAll('#filterIncentive .filter-option').forEach(e => e.classList.remove('selected'));
    }
    
    updateFilterChipState();
    applyFilters();
}

// 퀵 필터 토글
export function quickFilter(type) {
    state.activeFilters[type] = !state.activeFilters[type];
    
    document.querySelectorAll('.quick-filter').forEach(el => {
        if (el.textContent.includes('렌트롤')) el.classList.toggle('active', state.activeFilters.hasRentroll);
        if (el.textContent.includes('메모')) el.classList.toggle('active', state.activeFilters.hasMemo);
        if (el.textContent.includes('인센티브')) el.classList.toggle('active', state.activeFilters.hasIncentive);
    });
    
    applyFilters();
}

// 공실 필터 토글
export function toggleVacancyFilter(checked) {
    state.activeFilters.hasVacancy = checked;
    applyFilters();
    showToast(checked ? '공실 있는 빌딩만 표시' : '전체 빌딩 표시');
}

// 임대안내문 필터 토글
export function toggleLeasingGuideFilter(checked) {
    state.activeFilters.leasingGuideOnly = checked;
    applyFilters();
    showToast(checked ? '📄 우리 안내문 포함 빌딩만 표시' : '전체 빌딩 표시');
}

// 모든 필터 초기화
export function resetAllFilters() {
    state.activeFilters = {
        region: [],
        areaMin: null,
        areaMax: null,
        vacancyAreaMin: null,
        vacancyAreaMax: null,
        rentMin: null,
        rentMax: null,
        effMin: null,
        effMax: null,
        incentiveFilter: null,
        hasRentroll: false,
        hasMemo: false,
        hasIncentive: false,
        hasVacancy: true,
        completionYearMin: null,
        completionYearMax: null,
        leasingGuideOnly: false
    };
    
    document.getElementById('searchInput').value = '';
    document.getElementById('hasVacancyCheck').checked = true;
    const lgCheck = document.getElementById('leasingGuideCheck');
    if (lgCheck) lgCheck.checked = false;
    document.querySelectorAll('.filter-option').forEach(o => o.classList.remove('selected'));
    document.querySelectorAll('.filter-range input').forEach(i => i.value = '');
    document.querySelectorAll('.quick-filter').forEach(el => el.classList.remove('active'));
    
    updateFilterChipState();
    applyFilters();
    showToast('필터 초기화');
}

// 필터 칩 상태 업데이트
export function updateFilterChipState() {
    document.querySelectorAll('.filter-chip[data-filter]').forEach(chip => {
        const t = chip.dataset.filter;
        let active = false;
        
        if (t === 'region') active = state.activeFilters.region.length > 0;
        else if (t === 'area') active = state.activeFilters.areaMin || state.activeFilters.areaMax || 
                                        state.activeFilters.vacancyAreaMin || state.activeFilters.vacancyAreaMax;
        else if (t === 'rent') active = state.activeFilters.rentMin || state.activeFilters.rentMax;
        else if (t === 'efficiency') active = state.activeFilters.effMin || state.activeFilters.effMax;
        else if (t === 'incentive') active = state.activeFilters.incentiveFilter;
        
        chip.classList.toggle('active', active);
    });
}

// 필터 적용 (실제 필터링 로직)
export function applyFilters() {
    const q = document.getElementById('searchInput').value.toLowerCase().replace(/\s/g, '');

    // ★ 통합 파이프라인: 정렬바(portal.html)의 공실드롭다운 / 리서치 / 정렬 값을 함께 읽어
    //   하나의 funnel로 처리한다. (탭 전환·정렬도 applyListSort가 이 함수로 위임 → 검색/필터/정렬이
    //   모든 경로에서 일관되게 유지됨)
    const _vacFilter = document.getElementById('listVacancyFilter')?.value || 'all';
    const _researchOnly = document.getElementById('listResearchFilter')?.checked || false;
    const _sortBy = document.getElementById('listSortBy')?.value || 'area_desc';

    state.filteredBuildings = state.allBuildings.filter(b => {
        // 검색어
        if (q) {
            const searchStr = [b.name, b.address, b.addressJibun, b.nearbyStation]
                .filter(Boolean).join('').toLowerCase().replace(/\s/g, '');
            if (!searchStr.includes(q)) return false;
        }
        
        // 권역
        if (state.activeFilters.region.length > 0 && !state.activeFilters.region.includes(b.region)) return false;
        
        // 연면적
        const area = parseFloat(String(b.grossFloorPy || '').replace(/[^\d.]/g, '')) || 0;
        if (state.activeFilters.areaMin && area < state.activeFilters.areaMin) return false;
        if (state.activeFilters.areaMax && area > state.activeFilters.areaMax) return false;
        
        // 공실 전용면적
        if (state.activeFilters.vacancyAreaMin || state.activeFilters.vacancyAreaMax) {
            const vacancies = b.vacancies || [];
            const hasMatchingVacancy = vacancies.some(v => {
                const vArea = parseFloat(String(v.exclusiveArea || '').replace(/[^\d.]/g, '')) || 0;
                if (vArea === 0) return false;
                if (state.activeFilters.vacancyAreaMin && vArea < state.activeFilters.vacancyAreaMin) return false;
                if (state.activeFilters.vacancyAreaMax && vArea > state.activeFilters.vacancyAreaMax) return false;
                return true;
            });
            if (!hasMatchingVacancy) return false;
        }
        
        // 임대료
        const rentPy = parseFloat(String(b.rentPy || '').replace(/[^\d.]/g, '')) || 0;
        if (state.activeFilters.rentMin && rentPy < state.activeFilters.rentMin) return false;
        if (state.activeFilters.rentMax && rentPy > state.activeFilters.rentMax) return false;
        
        // 전용률
        const effRate = parseFloat(String(b.exclusiveRate || '').replace(/[^\d.]/g, '')) || 0;
        if (state.activeFilters.effMin && effRate < state.activeFilters.effMin) return false;
        if (state.activeFilters.effMax && effRate > state.activeFilters.effMax) return false;
        
        // 인센티브 필터
        if (state.activeFilters.incentiveFilter === 'hasIncentive' && !b.hasIncentive) return false;
        if (state.activeFilters.incentiveFilter === 'noIncentive' && b.hasIncentive) return false;
        
        // 준공연도
        if (state.activeFilters.completionYearMin || state.activeFilters.completionYearMax) {
            const year = parseInt(String(b.completionYear || '').replace(/[^\d]/g, '')) || 0;
            if (state.activeFilters.completionYearMin && year < state.activeFilters.completionYearMin) return false;
            if (state.activeFilters.completionYearMax && year > state.activeFilters.completionYearMax) return false;
        }
        
        // 퀵필터
        if (state.activeFilters.hasRentroll && b.rentrollCount === 0) return false;
        if (state.activeFilters.hasMemo && b.memoCount === 0) return false;
        if (state.activeFilters.hasIncentive && !b.hasIncentive) return false;

        // 공실 유무 — 드롭다운(listVacancyFilter)이 '전체'가 아니면 우선,
        //   '전체'면 "공실 있는 빌딩만" 체크박스(activeFilters.hasVacancy)로 폴백.
        //   (두 컨트롤이 AND로 충돌해 0건이 되는 문제 방지 + 기본 동작 보존)
        if (_vacFilter === 'hasVacancy') {
            if ((b.vacancies || []).filter(v => !v._key?.endsWith('_meta')).length === 0) return false;
        } else if (_vacFilter === 'noVacancy') {
            if ((b.vacancies || []).filter(v => !v._key?.endsWith('_meta')).length > 0) return false;
        } else if (state.activeFilters.hasVacancy && (!b.vacancies || b.vacancies.length === 0)) {
            return false;
        }

        // 🔬 리서치 필터 (정렬바 체크박스) — 통합
        if (_researchOnly && b.isResearchTarget !== true) return false;

        // 임대안내문 포함 빌딩 필터
        if (state.activeFilters.leasingGuideOnly && !state.leasingGuideBuildings.has(b.id)) return false;
        
        return true;
    });

    // ── 정렬 (listSortBy) — 통합 ──
    //   NEW 빌딩 최상위 → hidden 최하위 → 선택한 정렬 기준
    state.filteredBuildings.sort((a, b) => {
        if (a.isNew && !b.isNew) return -1;
        if (!a.isNew && b.isNew) return 1;
        if (a.status === 'hidden' && b.status !== 'hidden') return 1;
        if (a.status !== 'hidden' && b.status === 'hidden') return -1;
        if (_sortBy === 'research') {
            const d = (a.isResearchTarget ? 0 : 1) - (b.isResearchTarget ? 0 : 1);
            if (d !== 0) return d;
            return (parseFloat(b.grossFloorPy) || 0) - (parseFloat(a.grossFloorPy) || 0);
        }
        if (_sortBy === 'area_desc') {
            return (parseFloat(b.grossFloorPy) || 0) - (parseFloat(a.grossFloorPy) || 0) || (a.name || '').localeCompare(b.name || '');
        } else if (_sortBy === 'area_asc') {
            return (parseFloat(a.grossFloorPy) || 0) - (parseFloat(b.grossFloorPy) || 0) || (a.name || '').localeCompare(b.name || '');
        } else if (_sortBy === 'name_asc') {
            return (a.name || '').localeCompare(b.name || '');
        }
        return 0;
    });
    
    // 렌더링
    // ★ 지도영역(viewport) 탭이면 viewportBuildings를 재계산해야 검색/필터 결과가
    //   리스트에 즉시 반영된다. (renderBuildingList는 viewport 탭일 때 viewportBuildings를
    //   그리는데, 그 값은 지도 idle 때만 갱신되므로 filteredBuildings만 바꾸면 화면이 안 변함)
    //   updateViewportBuildings 내부에서 renderBuildingList + updateMapMarkers를 호출한다.
    if (state.currentListTab === 'viewport' && window.updateViewportBuildings) {
        window.updateViewportBuildings();
    } else {
        if (window.renderBuildingList) window.renderBuildingList();
        if (window.updateMapMarkers) window.updateMapMarkers();
    }
    if (state.currentViewMode === 'list' && window.renderTableView) window.renderTableView();
}

// 검색 이벤트 설정
export function setupSearchListener() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(applyFilters, 300));
    }
}

// ===== 상세 필터 =====

export function openDetailFilter() {
    document.getElementById('detailFilterModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
    
    // 현재 필터값 로드 (공실 체크박스 상태도 동기화)
    document.getElementById('dfCompletionMin').value = state.activeFilters.completionYearMin || '';
    document.getElementById('dfCompletionMax').value = state.activeFilters.completionYearMax || '';
    document.getElementById('dfHasVacancy').checked = state.activeFilters.hasVacancy || false;
    document.getElementById('dfHasRentroll').checked = state.activeFilters.hasRentroll || false;
    document.getElementById('dfHasMemo').checked = state.activeFilters.hasMemo || false;
    document.getElementById('dfHasIncentive').checked = state.activeFilters.hasIncentive || false;
}

export function applyDetailFilter() {
    state.activeFilters.completionYearMin = parseInt(document.getElementById('dfCompletionMin').value) || null;
    state.activeFilters.completionYearMax = parseInt(document.getElementById('dfCompletionMax').value) || null;
    state.activeFilters.hasVacancy = document.getElementById('dfHasVacancy').checked;
    state.activeFilters.hasRentroll = document.getElementById('dfHasRentroll').checked;
    state.activeFilters.hasMemo = document.getElementById('dfHasMemo').checked;
    state.activeFilters.hasIncentive = document.getElementById('dfHasIncentive').checked;
    
    // 공실 있는 빌딩만 체크박스와 동기화
    const hasVacancyCheck = document.getElementById('hasVacancyCheck');
    if (hasVacancyCheck) {
        hasVacancyCheck.checked = state.activeFilters.hasVacancy;
    }
    
    closeDetailFilter();
    applyFilters();
    showToast('상세 필터 적용됨');
}

export function resetDetailFilter() {
    document.getElementById('dfCompletionMin').value = '';
    document.getElementById('dfCompletionMax').value = '';
    document.getElementById('dfHasVacancy').checked = false;
    document.getElementById('dfHasRentroll').checked = false;
    document.getElementById('dfHasMemo').checked = false;
    document.getElementById('dfHasIncentive').checked = false;
    
    // 메인 공실 체크박스도 동기화 (초기화 시)
    // 참고: 적용 버튼을 눌러야 실제 필터에 반영됨
}

export function closeDetailFilter() {
    document.getElementById('detailFilterModal').classList.remove('show');
    document.getElementById('modalOverlay').classList.remove('show');
}

// window에 등록
window.applyFilter = applyFilter;
window.clearFilter = clearFilter;
window.quickFilter = quickFilter;
window.toggleVacancyFilter = toggleVacancyFilter;
window.resetAllFilters = resetAllFilters;
window.applyFilters = applyFilters;
window.openDetailFilter = openDetailFilter;
window.applyDetailFilter = applyDetailFilter;
window.resetDetailFilter = resetDetailFilter;
window.closeDetailFilter = closeDetailFilter;
