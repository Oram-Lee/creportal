/**
 * Leasing Guide - 빌딩 추가 모달
 * 장바구니 형태의 빌딩 선택 UI
 */

import { state } from './guide-state.js';
import { showToast, detectRegion, getRegionName, getExteriorImages, getFloorPlanImages } from './guide-utils.js';
// renderToc은 window 객체를 통해 호출 (순환 의존성 방지)

// 빌딩 장바구니
let buildingCart = [];
let cartViewMode = 'all';
let selectedCartRegion = 'all';

// 빌딩 추가 모달 열기
export function openAddBuildingModal() {
    buildingCart = [];
    cartViewMode = 'all';
    selectedCartRegion = 'all';
    
    const modal = document.getElementById('addBuildingModal');
    if (modal) {
        modal.classList.add('show');
        filterBuildingList();
        renderCart();
    }
}

// 모달 닫기
export function closeAddBuildingModal() {
    const modal = document.getElementById('addBuildingModal');
    if (modal) modal.classList.remove('show');
    buildingCart = [];
}

// 권역 필터
export function filterByRegion(region) {
    document.querySelectorAll('.picker-filter-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.picker-filter-btn[data-region="${region}"]`)?.classList.add('active');
    filterBuildingList();
}

// 빌딩 목록 필터링
export function filterBuildingList() {
    const searchQuery = document.getElementById('buildingSearch')?.value?.toLowerCase() || '';
    const regionFilter = document.querySelector('.picker-filter-btn.active')?.dataset?.region || 'all';
    const sortBy = document.getElementById('buildingSortSelect')?.value || 'name';
    
    // 이미 추가된 빌딩 ID
    const addedIds = state.tocItems.filter(i => i.type === 'building').map(i => i.buildingId);
    
    let filtered = state.allBuildings.filter(b => {
        // 이미 추가된 빌딩 제외
        if (addedIds.includes(b.id)) return false;
        
        // 검색어 필터
        if (searchQuery) {
            const searchTarget = `${b.name || ''} ${b.address || ''} ${b.roadAddress || ''}`.toLowerCase();
            if (!searchTarget.includes(searchQuery)) return false;
        }
        
        // 권역 필터
        if (regionFilter === 'starred') {
            if (!state.starredBuildings.has(b.id)) return false;
        } else if (regionFilter !== 'all') {
            if ((b.region || detectRegion(b.address)) !== regionFilter) return false;
        }
        
        return true;
    });
    
    // 정렬
    filtered.sort((a, b) => {
        if (sortBy === 'name') return (a.name || '').localeCompare(b.name || '');
        if (sortBy === 'region') return (a.region || '').localeCompare(b.region || '');
        return 0;
    });
    
    // 렌더링
    const listContainer = document.getElementById('buildingList');
    if (!listContainer) return;
    
    if (filtered.length === 0) {
        listContainer.innerHTML = '<div class="empty-state">검색 결과가 없습니다</div>';
        return;
    }
    
    listContainer.innerHTML = filtered.map(b => {
        const region = b.region || detectRegion(b.address);
        const inCart = buildingCart.includes(b.id);
        const isStarred = state.starredBuildings.has(b.id);
        
        // ★ 공실 개수 계산
        const vacancyCount = Array.isArray(b.vacancies) ? b.vacancies.length : 0;
        
        return `
            <div class="picker-item ${inCart ? 'selected' : ''}" onclick="toggleBuildingCart('${b.id}')">
                <div class="picker-item-info">
                    ${isStarred ? '<span class="star">⭐</span>' : ''}
                    <span class="region-badge region-${region}">${region}</span>
                    <span class="picker-item-name">${b.name || '이름없음'}</span>
                    ${vacancyCount > 0 ? `<span class="vacancy-count-badge">${vacancyCount}</span>` : ''}
                </div>
                <div class="picker-item-address">${b.address || b.roadAddress || '-'}</div>
            </div>
        `;
    }).join('');
}

// 장바구니 토글
export function toggleBuildingCart(buildingId) {
    const idx = buildingCart.indexOf(buildingId);
    if (idx >= 0) {
        buildingCart.splice(idx, 1);
    } else {
        buildingCart.push(buildingId);
    }
    filterBuildingList();
    renderCart();
}

// 장바구니에서 제거
export function removeFromCart(buildingId) {
    buildingCart = buildingCart.filter(id => id !== buildingId);
    filterBuildingList();
    renderCart();
}

// 장바구니 뷰 모드 설정
export function setCartViewMode(mode) {
    cartViewMode = mode;
    document.querySelectorAll('.cart-view-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.cart-view-btn[data-mode="${mode}"]`)?.classList.add('active');
    renderCart();
}

// 장바구니 렌더링
export function renderCart() {
    const cartBody = document.getElementById('cartList');
    const cartCount = document.getElementById('cartCount');
    
    if (cartCount) cartCount.textContent = buildingCart.length;
    if (!cartBody) return;
    
    if (buildingCart.length === 0) {
        cartBody.innerHTML = `
            <div class="cart-empty">
                <div class="icon">🏢</div>
                <div>좌측에서 빌딩을 선택하세요</div>
            </div>
        `;
        return;
    }
    
    // 권역별 그룹핑
    const groups = {};
    buildingCart.forEach(id => {
        const b = state.allBuildings.find(x => x.id === id);
        if (!b) return;
        const region = b.region || detectRegion(b.address) || 'ETC';
        if (!groups[region]) groups[region] = [];
        groups[region].push(b);
    });
    
    if (cartViewMode === 'region') {
        // 권역별 뷰
        cartBody.innerHTML = Object.entries(groups).map(([region, buildings]) => `
            <div class="cart-group">
                <div class="cart-group-header">
                    <span class="region-badge region-${region}">${region}</span>
                    <span class="count">${buildings.length}개</span>
                </div>
                ${buildings.map(b => `
                    <div class="cart-item">
                        <span class="cart-item-name">${b.name || '이름없음'}</span>
                        <button class="cart-remove-btn" onclick="removeFromCart('${b.id}')">×</button>
                    </div>
                `).join('')}
            </div>
        `).join('');
    } else {
        // 전체 뷰
        cartBody.innerHTML = buildingCart.map(id => {
            const b = state.allBuildings.find(x => x.id === id);
            if (!b) return '';
            const region = b.region || detectRegion(b.address) || 'ETC';
            return `
                <div class="cart-item">
                    <span class="region-badge region-${region}">${region}</span>
                    <span class="cart-item-name">${b.name || '이름없음'}</span>
                    <button class="cart-remove-btn" onclick="removeFromCart('${b.id}')">×</button>
                </div>
            `;
        }).join('');
    }
    
    // 권역별 요약
    const summaryEl = document.getElementById('cartSummary');
    if (summaryEl) {
        summaryEl.innerHTML = Object.entries(groups).map(([region, buildings]) => 
            `<span class="region-badge region-${region}">${region}(${buildings.length})</span>`
        ).join('');
    }
}

// 빌딩 추가 확정
export function confirmAddBuildings() {
    if (buildingCart.length === 0) {
        showToast('추가할 빌딩을 선택하세요', 'error');
        return;
    }
    
    buildingCart.forEach(id => {
        const building = state.allBuildings.find(b => b.id === id);
        if (!building) return;
        
        // Firebase에서 기존 이미지 가져오기 (portal.html/complist.html 호환)
        const exteriorImages = getExteriorImages(building);
        const floorPlanImages = getFloorPlanImages(building);
        
        state.tocItems.push({
            type: 'building',
            buildingId: id,
            region: building.region || detectRegion(building.address),
            closeConfirmed: false,
            exteriorImages: exteriorImages,
            floorPlanImages: floorPlanImages,
            mainImageIndex: 0,
            customVacancies: [],
            selectedExternalVacancies: []
        });
    });
    
    closeAddBuildingModal();
    window.renderToc();
    showToast(`${buildingCart.length}개 빌딩이 추가되었습니다`, 'success');
}

// 전역 함수 등록
export function registerModalFunctions() {
    window.openAddBuildingModal = openAddBuildingModal;
    window.closeAddBuildingModal = closeAddBuildingModal;
    window.filterByRegion = filterByRegion;
    window.filterBuildingList = filterBuildingList;
    window.toggleBuildingCart = toggleBuildingCart;
    window.removeFromCart = removeFromCart;
    window.setCartViewMode = setCartViewMode;
    window.confirmAddBuildings = confirmAddBuildings;
}
