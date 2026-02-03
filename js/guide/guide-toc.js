/**
 * Leasing Guide - 목차 및 편집모드
 * TOC 렌더링, 드래그앤드롭, 편집모드 전환
 * 
 * v4.9 수정사항 (2026-01-22):
 * - ★ TOC 개편: 표지/전체목차/권역목차/빌딩/간지/엔딩 모두 표시
 * - ★ 페이지 네비게이션: 이전/다음 버튼
 * - ★ 자동 생성 항목 클릭 시 해당 페이지 미리보기
 * - ★ selectPage() 통합 함수
 */

import { state } from './guide-state.js';
import { showToast, getRegionName } from './guide-utils.js';
// 순환 의존성 방지 - window 객체를 통해 호출
// renderCoverEditor, renderBuildingEditor, renderDividerEditor, renderGuideList, renderEndingEditor

// 기본 권역 순서
const BASE_REGION_ORDER = ['GBD', 'YBD', 'CBD', 'BBD', 'PAN', 'ETC'];

// 동적 권역 순서 가져오기
function getRegionOrder() {
    const customCodes = (state.customRegions || []).map(r => r.code);
    return [...BASE_REGION_ORDER, ...customCodes];
}

// 빌딩을 권역별로 그룹핑
function groupItemsByRegion() {
    const groups = {};
    
    state.tocItems.forEach((item, idx) => {
        if (item.type === 'building') {
            const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
            const region = (item.region || building.region || 'ETC').toUpperCase();
            if (!groups[region]) {
                groups[region] = [];
            }
            groups[region].push({ item, building, idx, type: 'building' });
        } else if (item.type === 'divider') {
            // 간지는 가장 최근 권역에 추가하거나 ETC에
            const regions = Object.keys(groups);
            const lastRegion = regions.length > 0 ? regions[regions.length - 1] : 'ETC';
            if (!groups[lastRegion]) groups[lastRegion] = [];
            groups[lastRegion].push({ item, idx, type: 'divider' });
        }
    });
    
    return groups;
}

// ★ 전체 페이지 순서 생성 (네비게이션용)
function buildPageSequence() {
    const pages = [];
    
    // 1. 표지
    pages.push({ type: 'cover', id: 'cover' });
    
    if (state.tocItems.length === 0) {
        return pages;
    }
    
    // 권역별 그룹핑
    const regionGroups = groupItemsByRegion();
    const regionOrder = getRegionOrder();
    const activeRegions = regionOrder.filter(r => regionGroups[r] && regionGroups[r].length > 0);
    
    if (activeRegions.length > 0) {
        // 2. 전체 목차
        pages.push({ type: 'toc-full', id: 'toc-full' });
        
        // 3. 권역별 (권역목차 + 빌딩들)
        activeRegions.forEach(region => {
            // 권역 목차
            pages.push({ type: 'toc-region', id: `toc-region-${region}`, region });
            
            // 해당 권역 아이템들
            regionGroups[region].forEach(({ item, idx, type }) => {
                if (type === 'building') {
                    pages.push({ type: 'building', id: `building-${idx}`, tocIndex: idx });
                } else if (type === 'divider') {
                    pages.push({ type: 'divider', id: `divider-${idx}`, tocIndex: idx });
                }
            });
        });
    }
    
    // 4. 엔딩
    const ending = state.endingSettings;
    if (ending && ending.enabled !== false) {
        pages.push({ type: 'ending', id: 'ending' });
    }
    
    return pages;
}

// 현재 선택된 페이지 인덱스 찾기
function getCurrentPageIndex() {
    const pages = buildPageSequence();
    const selected = state.selectedTocIndex;
    const selectedType = state.selectedPageType || 'cover';
    
    if (selectedType === 'cover') {
        return 0;
    }
    
    if (selectedType === 'toc-full') {
        return pages.findIndex(p => p.type === 'toc-full');
    }
    
    if (selectedType === 'toc-region') {
        return pages.findIndex(p => p.type === 'toc-region' && p.region === state.selectedRegion);
    }
    
    if (selectedType === 'ending') {
        return pages.findIndex(p => p.type === 'ending');
    }
    
    // building 또는 divider
    return pages.findIndex(p => p.tocIndex === selected);
}

// 편집 모드 열기
export function openEditor() {
    document.getElementById('listContainer').style.display = 'none';
    document.getElementById('editContainer').classList.add('active');
    
    const titleInput = document.getElementById('editTitle');
    if (titleInput && state.currentGuide) {
        titleInput.value = state.currentGuide.title || '';
    }
    
    state.selectedTocIndex = -1;
    state.selectedPageType = 'cover';
    renderToc();
    window.renderCoverEditor();
}

// 편집 모드 닫기
export function closeEditor() {
    document.getElementById('editContainer').classList.remove('active');
    document.getElementById('listContainer').style.display = 'block';
    state.currentGuide = null;
    state.tocItems = [];
    state.selectedTocIndex = -1;
    state.selectedPageType = 'cover';
    window.renderGuideList();
}

// Guide에서 tocItems 설정
export function setTocItemsFromGuide(guide) {
    state.tocItems = guide.items ? JSON.parse(JSON.stringify(guide.items)) : [];
}

// ★ v4.9: 개편된 목차 렌더링
export function renderToc() {
    const tocList = document.getElementById('tocList');
    if (!tocList) return;
    
    state.tocItems = state.tocItems || [];
    
    let html = '';
    
    // 1. 표지
    html += `
        <div class="toc-item toc-cover ${state.selectedPageType === 'cover' ? 'active' : ''}" 
             onclick="selectPage('cover')">
            <span class="item-icon">📋</span>
            <span class="item-name">표지</span>
        </div>
    `;
    
    if (state.tocItems.length === 0) {
        html += `
            <div class="toc-empty">
                <p>등록된 빌딩이 없습니다</p>
                <button class="btn btn-primary btn-sm" onclick="openAddBuildingModal()">+ 빌딩 추가</button>
            </div>
        `;
        tocList.innerHTML = html;
        renderSummary();
        return;
    }
    
    // 권역별 그룹핑
    const regionGroups = groupItemsByRegion();
    const regionOrder = getRegionOrder();
    const activeRegions = regionOrder.filter(r => regionGroups[r] && regionGroups[r].length > 0);
    
    // 2. 전체 목차 (자동 생성)
    html += `
        <div class="toc-item toc-auto ${state.selectedPageType === 'toc-full' ? 'active' : ''}"
             onclick="selectPage('toc-full')">
            <span class="item-icon">📑</span>
            <span class="item-name">전체 목차</span>
            <span class="auto-badge">자동</span>
        </div>
    `;
    
    // 3. 권역별
    activeRegions.forEach(region => {
        const items = regionGroups[region];
        const buildingCount = items.filter(i => i.type === 'building').length;
        
        // 권역 그룹 시작
        html += `<div class="toc-region-group">`;
        
        // 권역 목차 (자동 생성)
        html += `
            <div class="toc-item toc-region-header ${state.selectedPageType === 'toc-region' && state.selectedRegion === region ? 'active' : ''}"
                 onclick="selectPage('toc-region', '${region}')">
                <span class="item-icon">📑</span>
                <span class="region-badge region-${region}">${region}</span>
                <span class="item-name">${getRegionName(region)}</span>
                <span class="count-badge">${buildingCount}</span>
            </div>
            <div class="toc-region-items">
        `;
        
        // 해당 권역 아이템들
        items.forEach(({ item, building, idx, type }) => {
            if (type === 'building') {
                const isConfirmed = item.closeConfirmed;
                const isSelected = state.selectedTocIndex === idx && state.selectedPageType === 'building';
                
                html += `
                    <div class="toc-item toc-building ${isSelected ? 'active' : ''} ${isConfirmed ? 'confirmed' : ''}"
                         draggable="true"
                         ondragstart="handleDragStart(event, ${idx})"
                         ondragover="handleDragOver(event)"
                         ondrop="handleDrop(event, ${idx})"
                         ondragend="handleDragEnd(event)"
                         onclick="selectPage('building', null, ${idx})">
                        <span class="drag-handle">⋮⋮</span>
                        <span class="item-icon">🏢</span>
                        <span class="item-name">${building?.name || '알 수 없음'}</span>
                        ${isConfirmed ? '<span class="close-dot confirmed"></span>' : ''}
                        <button class="delete-btn" onclick="event.stopPropagation(); deleteTocItem(${idx})">×</button>
                    </div>
                `;
            } else if (type === 'divider') {
                const isSelected = state.selectedTocIndex === idx && state.selectedPageType === 'divider';
                
                html += `
                    <div class="toc-item toc-divider ${isSelected ? 'active' : ''}"
                         draggable="true"
                         ondragstart="handleDragStart(event, ${idx})"
                         ondragover="handleDragOver(event)"
                         ondrop="handleDrop(event, ${idx})"
                         ondragend="handleDragEnd(event)"
                         onclick="selectPage('divider', null, ${idx})">
                        <span class="drag-handle">⋮⋮</span>
                        <span class="item-icon">📄</span>
                        <span class="item-name">${item.title || '간지'}</span>
                        <button class="delete-btn" onclick="event.stopPropagation(); deleteTocItem(${idx})">×</button>
                    </div>
                `;
            }
        });
        
        html += `</div></div>`; // toc-region-items, toc-region-group
    });
    
    // 4. 엔딩 (설정이 활성화된 경우)
    const ending = state.endingSettings;
    if (ending && ending.enabled !== false) {
        html += `
            <div class="toc-item toc-ending ${state.selectedPageType === 'ending' ? 'active' : ''}"
                 onclick="selectPage('ending')">
                <span class="item-icon">🎬</span>
                <span class="item-name">엔딩</span>
            </div>
        `;
    }
    
    tocList.innerHTML = html;
    renderSummary();
}

// 요약 정보 렌더링
export function renderSummary() {
    const summary = document.getElementById('summaryGrid');
    if (!summary) return;
    
    const buildingCount = state.tocItems.filter(i => i.type === 'building').length;
    const confirmedCount = state.tocItems.filter(i => i.type === 'building' && i.closeConfirmed).length;
    const pages = buildPageSequence();
    
    const regionCount = {};
    state.tocItems.forEach(item => {
        if (item.type === 'building') {
            const region = item.region || 'ETC';
            regionCount[region] = (regionCount[region] || 0) + 1;
        }
    });
    
    summary.innerHTML = `
        <div class="summary-row">
            <span class="summary-label">총 페이지</span>
            <span class="summary-value">${pages.length}p</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">빌딩</span>
            <span class="summary-value">${buildingCount}개</span>
        </div>
        <div class="summary-row">
            <span class="summary-label">마감확정</span>
            <span class="summary-value">${confirmedCount}/${buildingCount}</span>
        </div>
        <div class="summary-regions">
            ${Object.entries(regionCount).map(([r, c]) => `
                <span class="region-badge region-${r}">${r}(${c})</span>
            `).join('')}
        </div>
    `;
}

// ★ v4.9: 페이지 선택 (통합)
export function selectPage(type, region = null, tocIndex = null) {
    state.selectedPageType = type;
    state.selectedRegion = region;
    state.selectedTocIndex = tocIndex !== null ? tocIndex : -1;
    
    renderToc();
    
    switch (type) {
        case 'cover':
            window.renderCoverEditor();
            break;
            
        case 'toc-full':
            renderTocFullPreview();
            break;
            
        case 'toc-region':
            renderTocRegionPreview(region);
            break;
            
        case 'building':
            const buildingItem = state.tocItems[tocIndex];
            const building = state.allBuildings.find(b => b.id === buildingItem?.buildingId) || {};
            window.renderBuildingEditor(buildingItem, building);
            break;
            
        case 'divider':
            const dividerItem = state.tocItems[tocIndex];
            window.renderDividerEditor(dividerItem, tocIndex);
            break;
            
        case 'ending':
            window.renderEndingEditor();
            break;
    }
}

// ★ v4.9: 전체 목차 미리보기 렌더링
function renderTocFullPreview() {
    const editorMain = document.getElementById('editorMain');
    if (!editorMain) return;
    
    const regionGroups = groupItemsByRegion();
    const regionOrder = getRegionOrder();
    const activeRegions = regionOrder.filter(r => regionGroups[r] && regionGroups[r].length > 0);
    
    const cs = state.coverSettings || {};
    
    editorMain.innerHTML = `
        <!-- 플로팅 메뉴 -->
        ${renderFloatingNav()}
        
        <div class="toc-preview-container">
            <div class="toc-preview-header">
                <div class="preview-badge">📑 자동 생성 페이지</div>
                <h2>전체 목차 (CONTENTS)</h2>
                <p>빌딩 추가/삭제 시 자동 업데이트됩니다.</p>
            </div>
            
            <div class="toc-preview-page">
                <div class="fullpreview-toc-full">
                    <div class="toc-full-header">
                        <div class="toc-full-logo">
                            ${cs.logoImage ? `<img src="${cs.logoImage}" alt="Logo">` : '<span>S&I</span>'}
                        </div>
                        <div class="toc-full-title">
                            <h1>CONTENTS</h1>
                            <p>임대 안내문 목차</p>
                        </div>
                    </div>
                    <div class="toc-full-grid">
                        ${activeRegions.map(region => {
                            const items = regionGroups[region];
                            const buildings = items.filter(i => i.type === 'building');
                            return `
                                <div class="toc-full-region">
                                    <div class="toc-region-title">
                                        <span class="region-badge region-${region}">${region}</span>
                                        <span class="region-name">${getRegionName(region)}</span>
                                        <span class="region-count">${buildings.length}건</span>
                                    </div>
                                    <div class="toc-region-buildings">
                                        ${buildings.slice(0, 8).map(({ building }) => `
                                            <div class="toc-building-name">${building?.name || '-'}</div>
                                        `).join('')}
                                        ${buildings.length > 8 ? `<div class="toc-more">외 ${buildings.length - 8}건</div>` : ''}
                                    </div>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ★ v4.9: 권역별 목차 미리보기 렌더링
function renderTocRegionPreview(region) {
    const editorMain = document.getElementById('editorMain');
    if (!editorMain) return;
    
    const regionGroups = groupItemsByRegion();
    const items = regionGroups[region] || [];
    const buildings = items.filter(i => i.type === 'building');
    
    const cs = state.coverSettings || {};
    
    editorMain.innerHTML = `
        <!-- 플로팅 메뉴 -->
        ${renderFloatingNav()}
        
        <div class="toc-preview-container">
            <div class="toc-preview-header">
                <div class="preview-badge">📑 자동 생성 페이지</div>
                <h2>${region} - ${getRegionName(region)} 목차</h2>
                <p>이 권역의 빌딩 목록입니다.</p>
            </div>
            
            <div class="toc-preview-page">
                <div class="fullpreview-toc-region">
                    <div class="toc-region-header-banner region-${region}">
                        <div class="toc-region-logo">
                            ${cs.logoImage ? `<img src="${cs.logoImage}" alt="Logo">` : '<span>S&I</span>'}
                        </div>
                        <div class="toc-region-info">
                            <span class="region-code">${region}</span>
                            <span class="region-full-name">${getRegionName(region)}</span>
                            <span class="region-building-count">${buildings.length}건</span>
                        </div>
                    </div>
                    <div class="toc-region-list">
                        ${buildings.map(({ building }, i) => `
                            <div class="toc-region-item">
                                <span class="item-num">${String(i + 1).padStart(2, '0')}</span>
                                <span class="item-name">${building?.name || '-'}</span>
                                <span class="item-address">${building?.address || '-'}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ★ v4.9: 플로팅 네비게이션 렌더링 (자동 생성 페이지용)
function renderFloatingNav() {
    const pageInfo = getPageInfo();
    
    return `
        <div class="floating-menu no-print">
            <div class="floating-menu-left">
                <div class="floating-nav-buttons">
                    <button class="floating-nav-btn" onclick="navigateToPrev()" title="이전 페이지">
                        ◀ 이전
                    </button>
                    <span class="floating-page-info">${pageInfo.current} / ${pageInfo.total}</span>
                    <button class="floating-nav-btn" onclick="navigateToNext()" title="다음 페이지">
                        다음 ▶
                    </button>
                </div>
                <div class="floating-shortcuts">
                    <button class="floating-shortcut" onclick="openPrintPage()" title="현재 페이지 PDF 출력">
                        🖨️ 출력
                    </button>
                </div>
            </div>
        </div>
    `;
}

// ★ v4.9: 이전 페이지로 이동
export function navigateToPrev() {
    const pages = buildPageSequence();
    const currentIdx = getCurrentPageIndex();
    
    if (currentIdx > 0) {
        const prevPage = pages[currentIdx - 1];
        selectPage(prevPage.type, prevPage.region, prevPage.tocIndex);
    } else {
        showToast('첫 페이지입니다', 'info');
    }
}

// ★ v4.9: 다음 페이지로 이동
export function navigateToNext() {
    const pages = buildPageSequence();
    const currentIdx = getCurrentPageIndex();
    
    if (currentIdx < pages.length - 1) {
        const nextPage = pages[currentIdx + 1];
        selectPage(nextPage.type, nextPage.region, nextPage.tocIndex);
    } else {
        showToast('마지막 페이지입니다', 'info');
    }
}

// ★ v4.9: 현재 페이지 정보 가져오기 (플로팅 메뉴용)
export function getPageInfo() {
    const pages = buildPageSequence();
    const currentIdx = getCurrentPageIndex();
    return {
        current: currentIdx + 1,
        total: pages.length
    };
}

// 드래그 시작
let draggedIdx = null;
export function handleDragStart(e, idx) {
    draggedIdx = idx;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

// 드래그 오버
export function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.toc-item');
    if (target) {
        document.querySelectorAll('.toc-item').forEach(i => i.classList.remove('drag-over'));
        target.classList.add('drag-over');
    }
}

// 드롭
export function handleDrop(e, targetIdx) {
    e.preventDefault();
    if (draggedIdx === null || draggedIdx === targetIdx) return;
    
    const draggedItem = state.tocItems[draggedIdx];
    
    // ★ 드롭 위치의 권역 파악하여 item.region 업데이트
    const targetItem = state.tocItems[targetIdx];
    if (targetItem) {
        let targetRegion = null;
        
        if (targetItem.type === 'building') {
            // 타겟이 빌딩이면 해당 빌딩의 권역 사용
            const targetBuilding = state.allBuildings.find(b => b.id === targetItem.buildingId);
            targetRegion = targetItem.region || targetBuilding?.region || 'ETC';
        } else if (targetItem.type === 'divider') {
            // 타겟이 간지면 앞 빌딩의 권역 찾기
            for (let i = targetIdx - 1; i >= 0; i--) {
                if (state.tocItems[i].type === 'building') {
                    const prevBuilding = state.allBuildings.find(b => b.id === state.tocItems[i].buildingId);
                    targetRegion = state.tocItems[i].region || prevBuilding?.region || 'ETC';
                    break;
                }
            }
        }
        
        // 드래그한 아이템의 권역 업데이트
        if (targetRegion && draggedItem.type === 'building') {
            draggedItem.region = targetRegion.toUpperCase();
            console.log(`[Drag] 빌딩 권역 변경: ${draggedItem.region}`);
        }
    }
    
    state.tocItems.splice(draggedIdx, 1);
    
    const newIdx = draggedIdx < targetIdx ? targetIdx : targetIdx;
    state.tocItems.splice(newIdx, 0, draggedItem);
    
    draggedIdx = null;
    renderToc();
}

// 드래그 종료
export function handleDragEnd(e) {
    e.target.classList.remove('dragging');
    document.querySelectorAll('.toc-item').forEach(i => i.classList.remove('drag-over'));
    draggedIdx = null;
}

// 목차 아이템 삭제
export function deleteTocItem(idx) {
    if (idx < 0 || idx >= state.tocItems.length) return;
    
    const item = state.tocItems[idx];
    const name = item.type === 'divider' ? '간지' : 
        (state.allBuildings.find(b => b.id === item.buildingId)?.name || '항목');
    
    if (confirm(`"${name}"을(를) 목록에서 제거하시겠습니까?`)) {
        state.tocItems.splice(idx, 1);
        
        if (state.selectedTocIndex === idx) {
            state.selectedTocIndex = -1;
            state.selectedPageType = 'cover';
            window.renderCoverEditor();
        } else if (state.selectedTocIndex > idx) {
            state.selectedTocIndex--;
        }
        
        renderToc();
    }
}

// 기존 selectTocItem 호환성 유지
export async function selectTocItem(idx, type) {
    if (idx === -1 || type === 'cover') {
        selectPage('cover');
    } else if (type === 'divider') {
        selectPage('divider', null, idx);
    } else {
        selectPage('building', null, idx);
    }
}

// 마감 상태 토글
export function toggleCloseStatus(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.closeConfirmed = !item.closeConfirmed;
    
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    window.renderBuildingEditor(item, building);
    renderToc();
    
    showToast(item.closeConfirmed ? '마감 확정되었습니다' : '마감이 해제되었습니다', 'success');
}

// 전역 함수 등록
export function registerTocFunctions() {
    window.openEditor = openEditor;
    window.closeEditor = closeEditor;
    window.renderToc = renderToc;
    window.setTocItemsFromGuide = setTocItemsFromGuide;
    window.handleDragStart = handleDragStart;
    window.handleDragOver = handleDragOver;
    window.handleDrop = handleDrop;
    window.handleDragEnd = handleDragEnd;
    window.deleteTocItem = deleteTocItem;
    window.selectTocItem = selectTocItem;
    window.selectPage = selectPage;
    window.toggleCloseStatus = toggleCloseStatus;
    window.navigateToPrev = navigateToPrev;
    window.navigateToNext = navigateToNext;
    window.getPageInfo = getPageInfo;
}
