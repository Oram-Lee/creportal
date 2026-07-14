/**
 * CRE Portal - UI 렌더링 함수들
 * 기존 코드와의 호환성을 위해 state 객체의 속성을 전역 변수로 노출
 */

import { state } from './portal-state.js';
import { formatNumber, formatFloors, formatStation, isRecentlyUpdated } from './portal-utils.js';

// 전역 변수 별칭 (기존 코드 호환성)
// 주의: 이 변수들은 state와 동기화되어야 함
window.portalState = state;

// Getter 함수들 (state 접근용)
export const getAllBuildings = () => state.allBuildings;
export const getFilteredBuildings = () => state.filteredBuildings;
export const getSelectedBuilding = () => state.selectedBuilding;
export const getStarredBuildings = () => state.allBuildings.filter(b => state.starredBuildings.has(b.id));

// 빌딩 리스트 렌더링
export function renderBuildingList() {
    const container = document.getElementById('buildingList');
    const { currentListTab, viewportBuildings, filteredBuildings, selectedBuilding, starredBuildings } = state;
    
    let list = currentListTab === 'viewport' ? viewportBuildings : 
               currentListTab === 'starred' ? getStarredBuildings() : filteredBuildings;
    
    // 관심 탭일 때 다른 UI
    if (currentListTab === 'starred') {
        renderStarredList(container, list);
        return;
    }
    
    document.getElementById('buildingCount').textContent = formatNumber(list.length) + '개';
    
    if (list.length === 0) {
        container.innerHTML = '<div class="empty-state">검색 결과가 없습니다</div>';
        return;
    }
    
    container.innerHTML = list.slice(0, 100).map(b => {
        const isHidden = b.status === 'hidden';
        return `
        <div class="list-item ${selectedBuilding?.id === b.id ? 'active' : ''} ${b.isNew ? 'is-new' : ''} ${isHidden ? 'is-hidden' : ''}" data-id="${b.id}" style="${isHidden ? 'opacity: 0.6; border-left: 3px solid #f59e0b;' : ''}">
            <div class="list-item-header">
                <div class="name" onclick="selectBuildingFromList('${b.id}')">
                    ${isHidden ? '<span style="font-size:10px;padding:2px 6px;background:#fef3c7;color:#92400e;border-radius:4px;margin-right:4px;">🚫히든</span>' : ''}
                    ${b.isNew ? '<span class="new-tag">NEW</span>' : ''}
                    ${b.name || '이름 없음'}
                </div>
                <button class="star-btn ${starredBuildings.has(b.id) ? 'starred' : ''}" onclick="event.stopPropagation(); toggleStar('${b.id}')" title="즐겨찾기">
                    ${starredBuildings.has(b.id) ? '★' : '☆'}
                </button>
            </div>
            <div class="address" onclick="selectBuildingFromList('${b.id}')">${b.address || '-'}</div>
            ${isHidden ? `<div style="font-size:10px;color:#92400e;margin-top:4px;">숨김: ${(b.hiddenBy || '').split('@')[0]} (${b.hiddenAt ? new Date(b.hiddenAt).toLocaleDateString('ko-KR') : ''})</div>` : ''}
            <div class="badges" onclick="selectBuildingFromList('${b.id}')">
                ${b.region ? `<span class="badge badge-region">${b.region}</span>` : ''}
                ${state.leasingGuideBuildings.has(b.id) ? `<span class="badge" style="background:linear-gradient(135deg, #667eea, #764ba2);color:white;">우리안내문</span>` : ''}
                ${b.vacancies?.length > 0 ? `<span class="badge" style="background:#3b82f6;color:white;">공실 ${b.vacancies.length > 99 ? '99+' : b.vacancies.length}</span>` : ''}
                ${b.grossFloorPy ? `<span class="badge badge-area">${formatNumber(b.grossFloorPy)}평</span>` : ''}
                ${b.rentrollCount > 0 ? `<span class="badge badge-rentroll">렌트롤 ${b.rentrollCount}</span>` : ''}
                ${b.memoCount > 0 ? `<span class="badge badge-memo">메모 ${b.memoCount}</span>` : ''}
                ${b.hasIncentive ? `<span class="badge badge-incentive">인센티브</span>` : ''}
            </div>
            ${b.rentPy ? `<div class="price" onclick="selectBuildingFromList('${b.id}')">임대료 ${b.rentPy}/평</div>` : ''}
        </div>
        `;
    }).join('');
}

// 리스트에서 빌딩 선택
export function selectBuildingFromList(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (building && building.lat && building.lng) {
        window.panToBuilding(building, true);
    }
    window.openDetail(buildingId);
}

// 즐겨찾기 리스트 렌더링
export function renderStarredList(container, list) {
    const starredCount = state.starredBuildings.size;
    document.getElementById('buildingCount').textContent = starredCount + '개';
    
    if (starredCount === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div style="font-size:40px;margin-bottom:12px;">⭐</div>
                <p>즐겨찾기한 빌딩이 없습니다</p>
                <p style="font-size:12px;color:var(--text-muted);margin-top:8px;">빌딩명 옆의 ☆를 클릭하여 추가하세요</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = `
        <div class="starred-header">
            <label class="select-all-check">
                <input type="checkbox" id="selectAllStarred" onchange="toggleSelectAllStarred(this.checked)">
                <span>전체 선택</span>
            </label>
            <button class="btn btn-danger btn-sm" onclick="removeSelectedStarred()" id="removeStarredBtn" disabled>
                선택 삭제
            </button>
        </div>
        <div class="starred-list">
            ${list.map(b => `
                <div class="starred-card" data-id="${b.id}" onclick="openDetail('${b.id}')" style="cursor: pointer;">
                    <input type="checkbox" class="starred-check" data-id="${b.id}" onchange="updateStarredSelection()" onclick="event.stopPropagation()">
                    <div class="starred-card-content">
                        <div class="starred-name">${b.name || '이름없음'}</div>
                        <div class="starred-info">${b.address || ''}</div>
                        <div class="starred-badges">
                            ${b.region ? `<span class="badge badge-region">${b.region}</span>` : ''}
                            ${b.hasVacancy ? `<span class="badge badge-vacancy">공실 ${b.vacancies?.length || 0}</span>` : ''}
                        </div>
                    </div>
                    <button class="star-btn starred" onclick="event.stopPropagation(); toggleStar('${b.id}')" title="즐겨찾기 해제">★</button>
                </div>
            `).join('')}
        </div>
    `;
}

// 즐겨찾기 토글
export function toggleStar(buildingId) {
    if (state.starredBuildings.has(buildingId)) {
        state.starredBuildings.delete(buildingId);
    } else {
        state.starredBuildings.add(buildingId);
    }
    saveStarredBuildings();
    renderBuildingList();
    if (state.currentViewMode === 'list') renderTableView();
}

// 즐겨찾기 저장
export function saveStarredBuildings() {
    localStorage.setItem('starredBuildings', JSON.stringify([...state.starredBuildings]));
}

// 즐겨찾기 로드
export function loadStarredBuildings() {
    try {
        const saved = localStorage.getItem('starredBuildings');
        if (saved) {
            state.starredBuildings = new Set(JSON.parse(saved));
        }
    } catch (e) {
        console.error('Failed to load starred buildings:', e);
    }
}

// 테이블 뷰 렌더링
export function renderTableView() {
    const container = document.getElementById('buildingListView');
    const { filteredBuildings, expandedBuildingId, starredBuildings } = state;
    
    document.getElementById('tableCount').textContent = formatNumber(filteredBuildings.length);
    updateSelectedCount();
    
    container.innerHTML = filteredBuildings.slice(0, 200).map((b, i) => {
        const isExpanded = expandedBuildingId === b.id;
        const vacancies = b.vacancies || [];
        
        return `
        <div class="building-row ${isExpanded ? 'expanded' : ''}" data-building-id="${b.id}">
            <div class="building-main" onclick="toggleBuildingExpand('${b.id}')">
                <!-- No -->
                <div class="col-no">${i + 1}</div>
                
                <!-- 빌딩명/주소 -->
                <div class="col-name">
                    <div class="name-row">
                        ${b.region ? `<span class="region-badge region-${(b.region || '').toLowerCase()}">${b.region}</span>` : ''}
                        <span class="name">${b.name || '-'}</span>
                        <button class="star-btn-sm ${starredBuildings.has(b.id) ? 'starred' : ''}" onclick="event.stopPropagation(); toggleStar('${b.id}')" title="즐겨찾기">
                            ${starredBuildings.has(b.id) ? '★' : '☆'}
                        </button>
                    </div>
                    <div class="address">${b.address || '-'}</div>
                </div>
                
                <!-- 빌딩 정보 (3x3 그리드로 확장) -->
                <div class="col-info">
                    <div class="info-item"><span class="info-label">연면적</span><span class="info-value">${b.grossFloorPy ? formatNumber(b.grossFloorPy) + '평' : '-'}</span></div>
                    <div class="info-item"><span class="info-label">기준층</span><span class="info-value">${b.typicalFloorPy ? formatNumber(b.typicalFloorPy) + '평' : '-'}</span></div>
                    <div class="info-item"><span class="info-label">전용률</span><span class="info-value">${b.exclusiveRate ? b.exclusiveRate + '%' : '-'}</span></div>
                    <div class="info-item"><span class="info-label">층수</span><span class="info-value">${formatFloors(b)}</span></div>
                    <div class="info-item"><span class="info-label">준공</span><span class="info-value">${b.completionYear || '-'}</span></div>
                    <div class="info-item"><span class="info-label">역세권</span><span class="info-value">${formatStation(b)}</span></div>
                    <div class="info-item"><span class="info-label">보증금</span><span class="info-value">${b.depositPy || '-'}</span></div>
                    <div class="info-item"><span class="info-label">임대료</span><span class="info-value price">${b.rentPy || '-'}</span></div>
                    <div class="info-item"><span class="info-label">관리비</span><span class="info-value">${b.maintenancePy || '-'}</span></div>
                </div>
                
                <!-- 공실 -->
                <div>${renderVacancyBadge(b)}</div>
                
                <!-- 렌트롤 -->
                <div>${renderRentrollBadge(b)}</div>
                
                <!-- 메모 -->
                <div>${renderMemoBadge(b)}</div>
                
                <!-- 인센티브 -->
                <div>${renderIncentiveBadge(b)}</div>
                
                <!-- 안내문 -->
                <div>${renderDocumentSelect(b)}</div>
                
                <!-- 펼침 -->
                <div class="expand-icon">${isExpanded ? '▲' : '▼'}</div>
            </div>
            <div class="vacancy-expand">
                ${renderVacancyTable(b, vacancies)}
            </div>
        </div>
        `;
    }).join('');
}

// 뱃지 렌더링 함수들
export function renderVacancyBadge(b) {
    const vacancies = b.vacancies || [];
    if (vacancies.length === 0) {
        return '<span style="color:var(--text-muted)">-</span>';
    }
    
    const count = vacancies.length;
    const displayCount = count >= 10 ? '9+' : count;
    const latestDate = vacancies.reduce((latest, v) => {
        const d = v.publishDate || v.updatedAt || '';
        return d > latest ? d : latest;
    }, '');
    const isNew = isRecentlyUpdated(latestDate);
    
    return `
        <span class="circle-badge badge-vacancy clickable ${isNew ? 'has-new' : ''}" onclick="event.stopPropagation(); showVacancyPopup('${b.id}')">
            ${displayCount}
            ${isNew ? '<span class="new-indicator">N</span>' : ''}
        </span>
    `;
}

export function renderRentrollBadge(b) {
    if (b.rentrollCount === 0) {
        return '<span style="color:var(--text-muted)">-</span>';
    }
    
    const count = b.rentrollCount;
    const displayCount = count >= 10 ? '9+' : count;
    const latestDate = b.rentrolls?.reduce((latest, r) => {
        const d = r.date || r.yearMonth || '';
        return d > latest ? d : latest;
    }, '') || '';
    const isNew = isRecentlyUpdated(latestDate);
    
    return `
        <div class="rentroll-badge-wrapper" onclick="event.stopPropagation(); showDataPopup('${b.id}', 'rentroll')">
            <span class="circle-badge badge-rentroll ${isNew ? 'has-new' : ''}">
                ${displayCount}
                ${isNew ? '<span class="new-indicator">N</span>' : ''}
            </span>
            <span class="timeseries-icon" title="시계열">📈</span>
        </div>
    `;
}

export function renderMemoBadge(b) {
    if (b.memoCount === 0) {
        return '<span style="color:var(--text-muted)">-</span>';
    }
    
    const count = b.memoCount;
    const displayCount = count >= 10 ? '9+' : count;
    const latestDate = b.memos?.reduce((latest, m) => {
        const d = m.date || m.createdAt || '';
        return d > latest ? d : latest;
    }, '') || '';
    const isNew = isRecentlyUpdated(latestDate);
    
    return `
        <span class="circle-badge badge-memo clickable ${isNew ? 'has-new' : ''}" onclick="event.stopPropagation(); showDataPopup('${b.id}', 'memo')">
            ${displayCount}
            ${isNew ? '<span class="new-indicator">N</span>' : ''}
        </span>
    `;
}

export function renderIncentiveBadge(b) {
    if (!b.hasIncentive) {
        return '<span style="color:var(--text-muted)">-</span>';
    }
    
    const count = b.incentives?.length || 0;
    const displayCount = count >= 10 ? '9+' : count;
    const latestDate = b.incentives?.reduce((latest, i) => {
        const d = i.date || i.createdAt || '';
        return d > latest ? d : latest;
    }, '') || '';
    const isNew = isRecentlyUpdated(latestDate);
    
    return `
        <span class="circle-badge badge-incentive clickable ${isNew ? 'has-new' : ''}" onclick="event.stopPropagation(); showDataPopup('${b.id}', 'incentive')">
            ${displayCount}
            ${isNew ? '<span class="new-indicator">N</span>' : ''}
        </span>
    `;
}

export function renderDocumentSelect(b) {
    if (!b.documents || b.documents.length === 0) {
        return '<span style="color:var(--text-muted)">-</span>';
    }
    
    // 최신순 정렬
    const sorted = [...b.documents].sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
    
    return `
        <select class="doc-select-box" onclick="event.stopPropagation();" onchange="showDocumentPreview('${b.id}', this.value, this)">
            <option value="" disabled selected>선택</option>
            ${sorted.map((d, i) => `
                <option value="${i}">${d.source || '기타'}-${d.publishDate || ''}</option>
            `).join('')}
        </select>
    `;
}

// 공실 테이블 렌더링 (출처별 탭 방식)
export function renderVacancyTable(building, vacancies) {
    if (!vacancies || vacancies.length === 0) {
        return '<div class="no-vacancy">등록된 공실 정보가 없습니다</div>';
    }
    
    // 출처별로 그룹핑 + 최신 발행일 기준 정렬
    const sourceGroups = {};
    vacancies.forEach(v => {
        const source = v.source || '기타';
        if (!sourceGroups[source]) {
            sourceGroups[source] = {
                source,
                publishDate: v.publishDate || '00.00',
                vacancies: []
            };
        }
        sourceGroups[source].vacancies.push(v);
        if ((v.publishDate || '00.00') > sourceGroups[source].publishDate) {
            sourceGroups[source].publishDate = v.publishDate;
        }
    });
    
    // 최신 발행일 기준으로 출처 정렬
    const sortedSources = Object.values(sourceGroups).sort((a, b) => 
        (b.publishDate || '').localeCompare(a.publishDate || '')
    );
    
    const totalCount = vacancies.length;
    
    return `
        <div class="vacancy-header">
            <h4>🏢 공실 현황 <span class="vacancy-count">${totalCount}건</span></h4>
            <div class="vacancy-actions">
                <button onclick="event.stopPropagation(); selectAllVacancies('${building.id}')">전체 선택</button>
                <button onclick="event.stopPropagation(); addToCompList('${building.id}')" class="primary">Comp List 추가</button>
            </div>
        </div>
        
        <!-- 출처별 탭 -->
        <div class="source-tabs" data-building-id="${building.id}">
            ${sortedSources.map((g, i) => `
                <button class="source-tab ${i === 0 ? 'active' : ''}" 
                        data-source="${g.source}" 
                        onclick="event.stopPropagation(); switchSourceTab('${building.id}', '${g.source}')">
                    ${g.source} <span class="tab-date">(${g.publishDate})</span>
                    <span class="tab-count">${g.vacancies.length}</span>
                </button>
            `).join('')}
        </div>
        
        <!-- 출처별 공실 테이블 -->
        ${sortedSources.map((g, i) => `
        <div class="source-panel ${i === 0 ? 'active' : ''}" data-building-id="${building.id}" data-source="${g.source}">
            <table class="vacancy-table">
                <thead>
                    <tr>
                        <th class="checkbox-cell"><input type="checkbox" onclick="event.stopPropagation(); toggleAllVacancies('${building.id}', this, '${g.source}')"></th>
                        <th>공실층</th>
                        <th>임대면적</th>
                        <th>전용면적</th>
                        <th>보증금/평</th>
                        <th>임대료/평</th>
                        <th>관리비/평</th>
                        <th>입주시기</th>
                        <th>⭐</th>
                        <th style="width: 100px;">관리</th>
                    </tr>
                </thead>
                <tbody>
                    ${g.vacancies.slice(0, 10).map((v, idx) => renderVacancyRow(building, v, idx)).join('')}
                </tbody>
            </table>
            ${g.vacancies.length > 10 ? `
                <div class="load-more-container" data-building-id="${building.id}" data-source="${g.source}" data-loaded="10" data-total="${g.vacancies.length}">
                    <button class="btn-load-more" onclick="event.stopPropagation(); loadMoreVacancies('${building.id}', '${g.source}')">
                        더보기 (${g.vacancies.length - 10}건 더)
                    </button>
                </div>
            ` : ''}
        </div>
        `).join('')}
    `;
}

// 공실 행 렌더링
function renderVacancyRow(building, v, idx) {
    const vacancyKey = `${building.id}_${v.source || ''}_${v.publishDate || ''}_${v.floor || idx}`.replace(/[.\s]/g, '_');
    const isSelected = state.selectedVacancies.has(vacancyKey);
    const pageNum = parseInt(v.pageNum) || 0;
    const hasPreview = v.pageImageUrl || pageNum > 0;
    
    // 이미지 URL 생성
    let imageUrl = v.pageImageUrl || '';
    if (!imageUrl && v.source && v.publishDate && pageNum > 0) {
        const formattedFolder = (v.source + '_' + v.publishDate).replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
        imageUrl = 'https://firebasestorage.googleapis.com/v0/b/cre-unified.firebasestorage.app/o/leasing-docs%2F' + encodeURIComponent(formattedFolder) + '%2Fpage_' + String(pageNum).padStart(3, '0') + '.jpg?alt=media';
    }
    
    return `
        <tr class="${isSelected ? 'selected-row' : ''}" data-vacancy-key="${vacancyKey}">
            <td class="checkbox-cell">
                <input type="checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleVacancySelect('${vacancyKey}')">
            </td>
            <td class="floor-cell">${v.floor || '-'}</td>
            <td class="area-cell">${v.rentArea ? formatNumber(v.rentArea) + '평' : '-'}</td>
            <td class="area-cell">${v.exclusiveArea ? formatNumber(v.exclusiveArea) + '평' : '-'}</td>
            <td class="price-cell">${v.depositPy || '-'}</td>
            <td class="price-cell">${v.rentPy || '-'}</td>
            <td class="price-cell">${v.maintenancePy || '-'}</td>
            <td>${v.moveInDate || '-'}</td>
            <td>
                <button class="star-btn ${v.starred ? 'starred' : ''}" onclick="event.stopPropagation(); toggleVacancyStar('${building.id}', '${v._key || idx}')">
                    ${v.starred ? '★' : '☆'}
                </button>
            </td>
            <td>
                <div class="row-actions" style="opacity: 1; justify-content: center;">
                    ${hasPreview ? `<button class="row-action-btn" onclick="event.stopPropagation(); showPagePreview('${imageUrl}', '${v.source || ''}', '${v.publishDate || ''}', ${pageNum})" title="원본 보기${pageNum ? ' (P' + pageNum + ')' : ''}">👁️</button>` : ''}
                    <button class="row-action-btn" onclick="event.stopPropagation(); editVacancy('${building.id}', '${v._key || ''}')" title="수정">✏️</button>
                    <button class="row-action-btn delete" onclick="event.stopPropagation(); deleteVacancy('${building.id}', '${v._key || ''}')" title="삭제">×</button>
                </div>
            </td>
        </tr>
    `;
}

// 출처 탭 전환
export function switchSourceTab(buildingId, source) {
    // 탭 활성화
    document.querySelectorAll(`.source-tabs[data-building-id="${buildingId}"] .source-tab`).forEach(tab => {
        tab.classList.toggle('active', tab.dataset.source === source);
    });
    // 패널 활성화
    document.querySelectorAll(`.source-panel[data-building-id="${buildingId}"]`).forEach(panel => {
        panel.classList.toggle('active', panel.dataset.source === source);
    });
}

// 더보기 로드
export function loadMoreVacancies(buildingId, source) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    const container = document.querySelector(`.load-more-container[data-building-id="${buildingId}"][data-source="${source}"]`);
    if (!container) return;
    
    const loaded = parseInt(container.dataset.loaded) || 10;
    const total = parseInt(container.dataset.total) || 0;
    
    // 해당 출처의 공실만 필터
    const sourceVacancies = building.vacancies.filter(v => (v.source || '기타') === source);
    const nextBatch = sourceVacancies.slice(loaded, loaded + 10);
    
    // 테이블에 추가
    const tbody = container.previousElementSibling.querySelector('tbody');
    nextBatch.forEach((v, idx) => {
        tbody.insertAdjacentHTML('beforeend', renderVacancyRow(building, v, loaded + idx));
    });
    
    // 카운터 업데이트
    const newLoaded = loaded + nextBatch.length;
    container.dataset.loaded = newLoaded;
    
    if (newLoaded >= total) {
        container.remove();
    } else {
        container.querySelector('.btn-load-more').textContent = `더보기 (${total - newLoaded}건 더)`;
    }
}

// 선택된 개수 업데이트
export function updateSelectedCount() {
    const selectedCount = state.selectedVacancies.size;
    const el = document.getElementById('selectedCount');
    if (el) el.textContent = selectedCount;
}

// 빌딩 펼침/접기
export function toggleBuildingExpand(buildingId) {
    if (state.expandedBuildingId === buildingId) {
        state.expandedBuildingId = null;
    } else {
        state.expandedBuildingId = buildingId;
    }
    renderTableView();
}

// 뷰 모드 설정
export function setViewMode(mode) {
    state.currentViewMode = mode;
    
    document.querySelectorAll('.nav-item[data-view]').forEach(el => {
        el.classList.toggle('active', el.dataset.view === mode);
    });
    
    // 원본: mapView는 hidden 클래스 토글, tableView는 active 클래스 토글
    document.getElementById('mapView').classList.toggle('hidden', mode !== 'map');
    document.getElementById('tableView').classList.toggle('active', mode === 'list');
    
    if (mode === 'list') {
        renderTableView();
    }
}

// 리스트 탭 설정
export function setListTab(tab) {
    state.currentListTab = tab;
    
    document.querySelectorAll('.list-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === tab);
    });
    
    renderBuildingList();
}

// 테마 토글
export function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    
    const btn = document.querySelector('.theme-btn');
    if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
}

// window에 등록
window.renderBuildingList = renderBuildingList;
window.renderTableView = renderTableView;
window.selectBuildingFromList = selectBuildingFromList;
window.toggleStar = toggleStar;
window.loadStarredBuildings = loadStarredBuildings;
window.toggleBuildingExpand = toggleBuildingExpand;
window.setViewMode = setViewMode;
window.setListTab = setListTab;
window.toggleTheme = toggleTheme;
window.updateSelectedCount = updateSelectedCount;
window.switchSourceTab = switchSourceTab;
window.loadMoreVacancies = loadMoreVacancies;
window.toggleSelectAllStarred = (checked) => {
    document.querySelectorAll('.starred-check').forEach(cb => cb.checked = checked);
    updateStarredSelection();
};
window.updateStarredSelection = () => {
    const selected = document.querySelectorAll('.starred-check:checked').length;
    const btn = document.getElementById('removeStarredBtn');
    if (btn) btn.disabled = selected === 0;
};
window.removeSelectedStarred = () => {
    document.querySelectorAll('.starred-check:checked').forEach(cb => {
        const id = cb.dataset.id;
        state.starredBuildings.delete(id);
    });
    saveStarredBuildings();
    renderBuildingList();
};

// ===== UI 이벤트 설정 =====

export function setupUIListeners() {
    // 리스트 탭
    document.querySelectorAll('.list-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.list-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.currentListTab = tab.dataset.tab;
            renderBuildingList();
        });
    });
    
    // 필터 칩 클릭 - 드롭다운 토글
    document.querySelectorAll('.filter-chip[data-filter]').forEach(chip => {
        chip.addEventListener('click', e => {
            // 드롭다운 내부 클릭은 무시
            if (e.target.closest('.filter-dropdown')) return;
            
            e.stopPropagation();
            const dd = chip.querySelector('.filter-dropdown');
            if (dd) {
                document.querySelectorAll('.filter-dropdown').forEach(d => {
                    if (d !== dd) d.classList.remove('show');
                });
                dd.classList.toggle('show');
            }
        });
    });
    
    // 필터 드롭다운 내부 클릭 - 이벤트 전파 중지 (입력창 클릭 시 닫히지 않도록)
    document.querySelectorAll('.filter-dropdown').forEach(dd => {
        dd.addEventListener('click', e => {
            e.stopPropagation();
        });
    });
    
    // 필터 옵션 클릭 - 복수 선택 가능 (토글)
    document.querySelectorAll('.filter-option').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation();
            opt.classList.toggle('selected');  // selected 클래스 토글 (복수 선택)
            // 드롭다운 닫지 않음 - 적용 버튼으로 닫음
        });
    });
    
    // 드롭다운 외부 클릭 시 닫기
    document.addEventListener('click', () => {
        document.querySelectorAll('.filter-dropdown').forEach(d => d.classList.remove('show'));
    });
}

// ===== 필터 함수 =====

/**
 * 우리 안내문 물건 필터 토글
 * - vacancies 컬렉션에 데이터가 있는 빌딩만 표시
 */
export function toggleLeasingGuideFilter(checked) {
    state.filterLeasingGuide = checked;
    applyFilters();
    
    // 지도 마커 업데이트
    if (window.updateMapMarkers) {
        window.updateMapMarkers();
    }
}

/**
 * 공실 있는 빌딩만 필터 토글
 */
export function toggleVacancyFilter(checked) {
    state.filterHasVacancy = checked;
    applyFilters();
    
    // 지도 마커 업데이트
    if (window.updateMapMarkers) {
        window.updateMapMarkers();
    }
}

/**
 * 필터 적용
 */
function applyFilters() {
    let filtered = [...state.allBuildings];
    
    // ★ 우리 안내문 물건 필터 (state 초기화 체크)
    if (state.filterLeasingGuide && state.leasingGuideBuildings) {
        filtered = filtered.filter(b => state.leasingGuideBuildings.has(b.id));
    }
    
    // ★ 공실 있는 빌딩만 필터
    if (state.filterHasVacancy !== false) {  // 기본값 true로 동작
        filtered = filtered.filter(b => b.hasVacancy || b.vacancies?.length > 0);
    }
    
    // 기존 필터들 (권역, 면적, 임대료, 전용률, 인센티브)
    if (state.selectedRegions && state.selectedRegions.length > 0) {
        filtered = filtered.filter(b => state.selectedRegions.includes(b.region));
    }
    
    if (state.selectedArea && state.selectedArea.min !== undefined) {
        filtered = filtered.filter(b => {
            const area = b.typicalFloorPy || b.grossFloorPy || 0;
            return area >= state.selectedArea.min && area <= state.selectedArea.max;
        });
    }
    
    if (state.selectedRent && state.selectedRent.min !== undefined) {
        filtered = filtered.filter(b => {
            const rent = b.rentPy || 0;
            return rent >= state.selectedRent.min && rent <= state.selectedRent.max;
        });
    }
    
    if (state.selectedExclusiveRate && state.selectedExclusiveRate.min !== undefined) {
        filtered = filtered.filter(b => {
            const rate = b.exclusiveRate || 0;
            return rate >= state.selectedExclusiveRate.min && rate <= state.selectedExclusiveRate.max;
        });
    }
    
    if (state.selectedIncentive) {
        filtered = filtered.filter(b => b.hasIncentive);
    }
    
    state.filteredBuildings = filtered;
    
    // UI 업데이트
    renderBuildingList();
    
    // 테이블 뷰 업데이트
    if (state.currentViewMode === 'list' && window.renderTableView) {
        window.renderTableView();
    }
}

// window에 함수 등록
window.toggleLeasingGuideFilter = toggleLeasingGuideFilter;
window.toggleVacancyFilter = toggleVacancyFilter;
