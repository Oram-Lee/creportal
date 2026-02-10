/**
 * Leasing Guide - 목차 및 편집모드
 * TOC 렌더링, 드래그앤드롭, 편집모드 전환
 * 
 * v4.9 수정사항 (2026-01-22):
 * - ★ TOC 개편: 표지/전체목차/권역목차/빌딩/간지/엔딩 모두 표시
 * - ★ 페이지 네비게이션: 이전/다음 버튼
 * - ★ 자동 생성 항목 클릭 시 해당 페이지 미리보기
 * - ★ selectPage() 통합 함수
 * 
 * v5.0 수정사항 (2026-02-10):
 * - ★ 권역 순서 드래그앤드롭: 좌측 TOC에서 권역 헤더를 드래그하여 순서 변경
 * - ★ state.regionOrder로 사용자 정의 순서 저장 (localStorage 자동 저장)
 * - ★ 순서 초기화 버튼: 커스텀 순서일 때 "↻ 초기화" 버튼 표시
 * - ★ tocItems 자동 재정렬: 권역 순서 변경 시 빌딩 목록도 자동 정렬
 * - ★ guide-preview.js와 순서 동기화: 미리보기/출력에도 변경 순서 반영
 */

import { state, getRegionOrder, setRegionOrder, resetRegionOrder } from './guide-state.js';
import { showToast, getRegionName } from './guide-utils.js';
// 순환 의존성 방지 - window 객체를 통해 호출
// renderCoverEditor, renderBuildingEditor, renderDividerEditor, renderGuideList, renderEndingEditor

// ★ 권역 순서는 guide-state.js에서 import (getRegionOrder)

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
    
    // ★ 권역 순서가 커스텀이면 초기화 버튼 표시
    if (state.regionOrder && Array.isArray(state.regionOrder)) {
        html += `
            <div class="region-order-reset">
                <span class="region-order-hint">⠿ 권역 헤더를 드래그하여 순서 변경</span>
                <button class="region-order-reset-btn" onclick="event.stopPropagation(); resetRegionOrderAction()" title="기본 순서로 되돌리기">↻ 초기화</button>
            </div>
        `;
    } else {
        html += `
            <div class="region-order-reset">
                <span class="region-order-hint">⠿ 권역 헤더를 드래그하여 순서 변경</span>
            </div>
        `;
    }
    
    // 3. 권역별
    activeRegions.forEach((region, regionIdx) => {
        const items = regionGroups[region];
        const buildingCount = items.filter(i => i.type === 'building').length;
        
        // 권역 그룹 시작 — ★ 드래그앤드롭 가능
        html += `<div class="toc-region-group" data-region="${region}"
                      draggable="true"
                      ondragstart="handleRegionDragStart(event, '${region}')"
                      ondragover="handleRegionDragOver(event)"
                      ondrop="handleRegionDrop(event, '${region}')"
                      ondragend="handleRegionDragEnd(event)">`;
        
        // 권역 목차 (자동 생성) — ★ 드래그 핸들 추가
        html += `
            <div class="toc-item toc-region-header ${state.selectedPageType === 'toc-region' && state.selectedRegion === region ? 'active' : ''}"
                 onclick="selectPage('toc-region', '${region}')">
                <span class="region-drag-handle" title="드래그하여 권역 순서 변경">⠿</span>
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

// ★ 권역 드래그앤드롭 ============================
let draggedRegion = null;

export function handleRegionDragStart(e, region) {
    // 빌딩 개별 드래그와 충돌 방지: 이벤트 소스가 region-drag-handle이면 권역 드래그
    const handle = e.target.closest('.region-drag-handle');
    const regionHeader = e.target.closest('.toc-region-header');
    if (!handle && !regionHeader) {
        // 빌딩 아이템에서 시작된 드래그는 무시 (빌딩 드래그 핸들러가 처리)
        e.preventDefault();
        return;
    }
    
    draggedRegion = region;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `region:${region}`);
    
    // 권역 그룹 전체에 dragging 스타일 적용
    const group = e.target.closest('.toc-region-group');
    if (group) {
        setTimeout(() => group.classList.add('region-dragging'), 0);
    }
    
    console.log(`[RegionDrag] 시작: ${region}`);
}

export function handleRegionDragOver(e) {
    if (!draggedRegion) return; // 권역 드래그가 아니면 무시
    
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const targetGroup = e.target.closest('.toc-region-group');
    if (targetGroup) {
        // 기존 하이라이트 모두 제거
        document.querySelectorAll('.toc-region-group').forEach(g => {
            g.classList.remove('region-drag-over-top', 'region-drag-over-bottom');
        });
        
        // 마우스 위치에 따라 위/아래 하이라이트
        const rect = targetGroup.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
            targetGroup.classList.add('region-drag-over-top');
        } else {
            targetGroup.classList.add('region-drag-over-bottom');
        }
    }
}

export function handleRegionDrop(e, targetRegion) {
    e.preventDefault();
    e.stopPropagation();
    
    if (!draggedRegion || draggedRegion === targetRegion) {
        cleanupRegionDrag();
        return;
    }
    
    // 현재 권역 순서 가져오기
    const currentOrder = getRegionOrder();
    const fromIdx = currentOrder.indexOf(draggedRegion);
    const toIdx = currentOrder.indexOf(targetRegion);
    
    if (fromIdx === -1 || toIdx === -1) {
        cleanupRegionDrag();
        return;
    }
    
    // 드롭 위치(위/아래) 판단
    const targetGroup = e.target.closest('.toc-region-group');
    let dropAfter = false;
    if (targetGroup) {
        const rect = targetGroup.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        dropAfter = (e.clientY >= midY);
    }
    
    // 순서 변경: 먼저 제거 후 삽입
    const newOrder = [...currentOrder];
    newOrder.splice(fromIdx, 1);
    
    // 삽입 위치 계산
    let insertAt = newOrder.indexOf(targetRegion);
    if (insertAt === -1) insertAt = newOrder.length;
    if (dropAfter) insertAt++;
    
    newOrder.splice(insertAt, 0, draggedRegion);
    
    // tocItems도 새 권역 순서에 맞게 재정렬
    reorderTocItemsByRegion(newOrder);
    
    // 상태 저장
    setRegionOrder(newOrder);
    
    console.log(`[RegionDrag] 순서 변경: ${currentOrder.join(',')} → ${newOrder.join(',')}`);
    showToast(`권역 순서가 변경되었습니다`, 'success');
    
    cleanupRegionDrag();
    renderToc();
}

export function handleRegionDragEnd(e) {
    cleanupRegionDrag();
}

function cleanupRegionDrag() {
    draggedRegion = null;
    document.querySelectorAll('.toc-region-group').forEach(g => {
        g.classList.remove('region-dragging', 'region-drag-over-top', 'region-drag-over-bottom');
    });
}

// ★ tocItems를 새 권역 순서에 맞게 재정렬
function reorderTocItemsByRegion(newRegionOrder) {
    const regionGroups = groupItemsByRegion();
    const reordered = [];
    
    newRegionOrder.forEach(region => {
        if (regionGroups[region]) {
            regionGroups[region].forEach(({ item }) => {
                reordered.push(item);
            });
        }
    });
    
    // 어떤 권역에도 속하지 않은 아이템 추가 (안전장치)
    const reorderedIds = new Set(reordered.map(i => i.buildingId || i.title));
    state.tocItems.forEach(item => {
        const id = item.buildingId || item.title;
        if (!reorderedIds.has(id)) {
            reordered.push(item);
        }
    });
    
    state.tocItems = reordered;
}

// ★ 권역 순서 초기화
export function resetRegionOrderAction() {
    if (confirm('권역 순서를 기본값(GBD → YBD → CBD → BBD → PAN → ETC)으로 초기화하시겠습니까?')) {
        resetRegionOrder();
        
        // tocItems도 기본 순서로 재정렬
        const defaultOrder = getRegionOrder();
        reorderTocItemsByRegion(defaultOrder);
        
        renderToc();
        showToast('권역 순서가 초기화되었습니다', 'success');
    }
}

// 드래그 시작 (빌딩 개별)
let draggedIdx = null;
export function handleDragStart(e, idx) {
    if (draggedRegion) return; // 권역 드래그 중이면 무시
    e.stopPropagation(); // ★ 권역 그룹으로 이벤트 버블링 방지
    draggedIdx = idx;
    e.target.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
}

// 드래그 오버 (빌딩 개별)
export function handleDragOver(e) {
    if (draggedRegion) return; // 권역 드래그 중이면 무시
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
    // 빌딩 개별 드래그
    window.handleDragStart = handleDragStart;
    window.handleDragOver = handleDragOver;
    window.handleDrop = handleDrop;
    window.handleDragEnd = handleDragEnd;
    // ★ 권역 드래그앤드롭
    window.handleRegionDragStart = handleRegionDragStart;
    window.handleRegionDragOver = handleRegionDragOver;
    window.handleRegionDrop = handleRegionDrop;
    window.handleRegionDragEnd = handleRegionDragEnd;
    window.resetRegionOrderAction = resetRegionOrderAction;
    // 기타
    window.deleteTocItem = deleteTocItem;
    window.selectTocItem = selectTocItem;
    window.selectPage = selectPage;
    window.toggleCloseStatus = toggleCloseStatus;
    window.navigateToPrev = navigateToPrev;
    window.navigateToNext = navigateToNext;
    window.getPageInfo = getPageInfo;
}
