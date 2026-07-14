/**
 * CRE Portal - Comp List Page Module
 * 전용 페이지에서 Comp List 관리, 웹 스프레드시트 편집 기능 제공
 */

import { db, ref, get, set, push, update, remove } from './portal-firebase.js';

// ============================================================
// 상태 관리
// ============================================================
const pageState = {
    currentUser: null,
    allBuildings: [],
    compLists: [],
    filteredCompLists: [],
    selectedCompList: null,
    selectedCompListId: null,
    currentFilter: 'all',
    searchQuery: '',
    buildingSearchResults: [],
    newCompListType: 'general',
    isEditing: false,
    // 편집 중인 Comp List 데이터
    editData: {
        id: null,
        title: '',
        type: 'general',
        buildings: []
    }
};

// ============================================================
// 초기화
// ============================================================
export async function initCompListPage() {
    console.log('Comp List 페이지 초기화 시작...');
    
    // 세션 체크 (portal-auth.js와 동일한 키 사용)
    const session = localStorage.getItem('crePortalUser');
    if (!session) {
        document.getElementById('loginRequired').style.display = 'flex';
        document.getElementById('appContainer').style.display = 'none';
        return;
    }
    
    try {
        pageState.currentUser = JSON.parse(session);
        document.getElementById('headerUserName').textContent = pageState.currentUser.name || pageState.currentUser.email;
        document.getElementById('headerUserRole').textContent = pageState.currentUser.role || 'user';
    } catch (e) {
        console.error('세션 파싱 실패:', e);
        document.getElementById('loginRequired').style.display = 'flex';
        return;
    }
    
    document.getElementById('appContainer').style.display = 'flex';
    
    // 데이터 로드
    await Promise.all([
        loadBuildings(),
        loadCompLists()
    ]);
    
    // 이벤트 리스너 등록
    setupEventListeners();
    
    // URL 파라미터로 compListId가 있으면 자동 선택
    const urlParams = new URLSearchParams(window.location.search);
    const compListId = urlParams.get('id');
    if (compListId) {
        setTimeout(() => selectCompList(compListId), 100);
    }
    
    console.log('Comp List 페이지 초기화 완료');
}

function setupEventListeners() {
    // 빌딩 검색 입력
    const searchInput = document.getElementById('buildingSearchInput');
    if (searchInput) {
        let debounceTimer;
        searchInput.addEventListener('input', (e) => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                searchBuildingsForAdd(e.target.value);
            }, 300);
        });
        
        // 외부 클릭 시 검색 결과 닫기
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.building-search-bar')) {
                document.getElementById('buildingSearchResults').style.display = 'none';
            }
        });
    }
}

// ============================================================
// 데이터 로드
// ============================================================
async function loadBuildings() {
    try {
        const snapshot = await get(ref(db, 'buildings'));
        if (snapshot.exists()) {
            const data = snapshot.val();
            // Firebase raw 데이터를 평탄화하여 저장
            pageState.allBuildings = Object.entries(data).map(([id, b]) => flattenBuildingData(id, b));
            console.log(`빌딩 ${pageState.allBuildings.length}개 로드 완료`);
        }
    } catch (e) {
        console.error('빌딩 로드 실패:', e);
    }
}

// Firebase 빌딩 데이터 평탄화
function flattenBuildingData(id, b) {
    return {
        id,
        // 기본 정보
        name: b.name || '',
        address: b.address || '',
        addressJibun: b.addressJibun || b.address || '',
        region: b.region || '',
        
        // 면적 정보 (area 객체에서 추출)
        typicalFloorPy: b.area?.typicalFloorPy || b.typicalFloorPy || '',
        typicalFloorSqm: b.area?.typicalFloorSqm || b.typicalFloorSqm || '',
        typicalFloorM2: b.area?.typicalFloorSqm || b.area?.typicalFloorM2 || b.typicalFloorM2 || '',
        typicalFloorLeasePy: b.area?.typicalFloorLeasePy || '',
        exclusiveRate: b.area?.exclusiveRate || b.exclusiveRate || '',
        dedicatedRate: b.area?.exclusiveRate || b.dedicatedRate || '',
        grossFloorPy: b.area?.grossFloorPy || b.grossFloorPy || '',
        
        // 층 정보
        floors: b.floors?.display || b.floors || '',
        floorsAbove: b.floors?.above || b.floorsAbove || '',
        floorsBelow: b.floors?.below || b.floorsBelow || '',
        scale: b.floors?.display || b.scale || '',
        
        // 스펙 정보 (specs 객체에서 추출)
        completionYear: b.specs?.completionYear || b.completionYear || '',
        elevators: b.specs?.elevators || b.elevators || '',
        elevator: b.specs?.elevator || b.elevator || '',
        hvac: b.specs?.hvac || b.hvac || '',
        heatingCooling: b.specs?.heatingCooling || b.heatingCooling || '',
        structure: b.specs?.structure || b.structure || '',
        buildingUse: b.specs?.buildingUse || b.buildingUse || '',
        usage: b.specs?.usage || b.usage || '',
        
        // 주차 정보
        parkingInfo: b.parking?.info || b.parkingInfo || '',
        parkingFee: b.parking?.fee || b.parkingFee || '',
        parkingTotal: b.parking?.total || b.parkingTotal || '',
        parkingSpaces: b.parking?.spaces || b.parkingSpaces || '',
        
        // 위치 정보
        nearestStation: b.nearbyStation || b.nearestStation || '',
        station: b.station || '',
        
        // 가격 정보
        rentPy: b.pricing?.rentPy || b.rentPy || '',
        depositPy: b.pricing?.depositPy || b.depositPy || '',
        maintenancePy: b.pricing?.maintenancePy || b.maintenancePy || '',
        
        // 기준가 정보
        floorPricing: b.floorPricing || [],
        
        // 이미지
        exteriorImage: b.exteriorImage || b.mainImage || '',
        mainImage: b.mainImage || '',
        
        // 설명
        description: b.description || '',
        
        // 담당자
        contactPoints: b.contactPoints || [],
        
        // 원본 데이터 참조 (필요시)
        _raw: b
    };
}

async function loadCompLists() {
    try {
        showListLoading(true);
        
        const snapshot = await get(ref(db, 'compLists'));
        if (snapshot.exists()) {
            const data = snapshot.val();
            pageState.compLists = Object.entries(data).map(([id, c]) => ({ id, ...c }));
            pageState.compLists.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            console.log(`Comp List ${pageState.compLists.length}개 로드 완료`);
        } else {
            pageState.compLists = [];
        }
        
        applyFilters();
        renderCompListCards();
    } catch (e) {
        console.error('Comp List 로드 실패:', e);
        showToast('Comp List 로드 실패', 'error');
    } finally {
        showListLoading(false);
    }
}

function showListLoading(show) {
    const container = document.getElementById('compListCards');
    if (show) {
        container.innerHTML = `
            <div class="loading-state">
                <div class="spinner"></div>
                <p>Comp List 불러오는 중...</p>
            </div>
        `;
    }
}

// ============================================================
// 필터링 & 검색
// ============================================================
window.filterCompLists = function(filter) {
    pageState.currentFilter = filter;
    
    // 탭 UI 업데이트
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === filter);
    });
    
    applyFilters();
    renderCompListCards();
};

window.searchCompLists = function(query) {
    pageState.searchQuery = query.toLowerCase().trim();
    applyFilters();
    renderCompListCards();
};

function applyFilters() {
    let filtered = [...pageState.compLists];
    
    // 사용자 필터
    if (pageState.currentFilter === 'mine' && pageState.currentUser) {
        filtered = filtered.filter(c => c.createdBy?.id === pageState.currentUser.id);
    } else if (pageState.currentFilter === 'others' && pageState.currentUser) {
        filtered = filtered.filter(c => c.createdBy?.id !== pageState.currentUser.id);
    }
    
    // 검색어 필터
    if (pageState.searchQuery) {
        filtered = filtered.filter(c => {
            const titleMatch = c.title?.toLowerCase().includes(pageState.searchQuery);
            const buildingMatch = c.buildings?.some(b => 
                b.buildingName?.toLowerCase().includes(pageState.searchQuery)
            );
            return titleMatch || buildingMatch;
        });
    }
    
    pageState.filteredCompLists = filtered;
}

// ============================================================
// Comp List 카드 렌더링
// ============================================================
function renderCompListCards() {
    const container = document.getElementById('compListCards');
    const lists = pageState.filteredCompLists;
    
    if (lists.length === 0) {
        container.innerHTML = `
            <div class="card-empty">
                <p>📋 표시할 Comp List가 없습니다.</p>
                ${pageState.currentFilter === 'mine' ? 
                    '<button class="btn btn-primary btn-sm" onclick="openNewCompListWizard()">새 Comp List 만들기</button>' : 
                    ''}
            </div>
        `;
        return;
    }
    
    container.innerHTML = lists.map(c => {
        const buildingCount = c.buildings?.length || 0;
        const buildings = c.buildings || [];
        const displayBuildings = buildings.slice(0, 4);
        const moreCount = buildings.length - 4;
        
        // 공실 요약
        const vacancyCount = buildings.reduce((sum, b) => sum + (b.vacancies?.length || 0), 0);
        
        // 작성자: 이메일에서 아이디 추출 + 성명
        const email = c.createdBy?.email || '';
        const userId = email.split('@')[0] || '-';
        const userName = c.createdBy?.name || '';
        const authorDisplay = userName ? `${userId} (${userName})` : userId;
        
        // 본인이 생성한 Comp List인지 확인
        const isOwner = pageState.currentUser?.email === email;
        
        // 빌딩 목록 데이터 (팝업용)
        const buildingsData = JSON.stringify(buildings.map(b => ({
            name: b.buildingName || '-',
            region: detectRegionFromBuildingName(b.buildingName) || '-'
        }))).replace(/"/g, '&quot;');
        
        return `
            <div class="complist-card ${pageState.selectedCompListId === c.id ? 'active' : ''}" 
                 onclick="selectCompList('${c.id}')">
                ${isOwner ? `
                    <button class="card-delete-btn" onclick="event.stopPropagation(); deleteCompList('${c.id}', '${escapeHtml(c.title || '제목 없음')}')" title="삭제">
                        🗑️
                    </button>
                ` : ''}
                <div class="card-row card-header">
                    <div class="card-title">${escapeHtml(c.title || '제목 없음')}</div>
                    <span class="card-type ${c.type === 'lg' ? 'lg' : 'general'}">
                        ${c.type === 'lg' ? 'LG그룹용' : '일반용'}
                    </span>
                </div>
                <div class="card-row card-author">
                    <span class="author-info">👤 ${escapeHtml(authorDisplay)}</span>
                    <span class="date-info">📅 ${formatDate(c.createdAt)}</span>
                </div>
                <div class="card-row card-stats">
                    <span class="stat-item">🏢 ${buildingCount}개 빌딩</span>
                    <span class="stat-item">📊 ${vacancyCount}개 공실</span>
                </div>
                <div class="card-row card-buildings">
                    ${displayBuildings.map(b => `
                        <span class="building-chip">${escapeHtml(b.buildingName || '-')}</span>
                    `).join('')}
                    ${moreCount > 0 ? `
                        <span class="building-chip more" onclick="event.stopPropagation(); showBuildingsPopup(${buildingsData}, this)">
                            +${moreCount}
                        </span>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// 빌딩명에서 권역 추출
function detectRegionFromBuildingName(name) {
    if (!name) return '';
    if (name.includes('강남') || name.includes('테헤란') || name.includes('삼성')) return 'GBD';
    if (name.includes('여의도') || name.includes('영등포')) return 'YBD';
    if (name.includes('종로') || name.includes('광화문') || name.includes('을지로')) return 'CBD';
    if (name.includes('분당') || name.includes('판교')) return 'BBD';
    if (name.includes('마포') || name.includes('상암')) return '마포/상암';
    return '';
}

// 빌딩 목록 팝업 표시
window.showBuildingsPopup = function(buildings, element) {
    // 기존 팝업 제거
    const existing = document.querySelector('.buildings-popup');
    if (existing) existing.remove();
    
    const popup = document.createElement('div');
    popup.className = 'buildings-popup';
    popup.innerHTML = `
        <div class="popup-header">
            <span>📋 전체 빌딩 목록 (${buildings.length}개)</span>
            <button onclick="this.parentElement.parentElement.remove()" style="background:none; border:none; cursor:pointer; font-size:16px;">✕</button>
        </div>
        <div class="popup-content">
            ${buildings.map(b => `
                <div class="popup-item">
                    <span class="popup-name">${b.name}</span>
                    ${b.region && b.region !== '-' ? `<span class="popup-region">${b.region}</span>` : ''}
                </div>
            `).join('')}
        </div>
    `;
    
    // 위치 계산
    const rect = element.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = rect.left + 'px';
    popup.style.top = (rect.bottom + 5) + 'px';
    popup.style.zIndex = '9999';
    
    document.body.appendChild(popup);
    
    // 외부 클릭 시 닫기
    setTimeout(() => {
        document.addEventListener('click', function closePopup(e) {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', closePopup);
            }
        });
    }, 100);
}

// Comp List 삭제
window.deleteCompList = async function(compListId, title) {
    // 삭제 확인
    const confirmed = confirm(`정말 "${title}" Comp List를 삭제하시겠습니까?\n\n이 작업은 되돌릴 수 없습니다.`);
    if (!confirmed) return;
    
    try {
        // Firebase에서 삭제
        const compListRef = ref(db, `complists/${compListId}`);
        await remove(compListRef);
        
        // 로컬 상태 업데이트
        pageState.compLists = pageState.compLists.filter(c => c.id !== compListId);
        applyFilters();
        
        // 현재 선택된 Comp List가 삭제된 경우 초기화
        if (pageState.selectedCompListId === compListId) {
            pageState.selectedCompListId = null;
            pageState.selectedCompList = null;
            pageState.editData = { id: null, title: '', type: 'general', buildings: [] };
            
            document.getElementById('detailContent').style.display = 'none';
            document.getElementById('emptyState').style.display = 'flex';
        }
        
        showToast('Comp List가 삭제되었습니다', 'success');
    } catch (error) {
        console.error('Comp List 삭제 실패:', error);
        showToast('삭제에 실패했습니다: ' + error.message, 'error');
    }
}

// ============================================================
// Comp List 선택 & 상세보기
// ============================================================
window.selectCompList = async function(compListId) {
    pageState.selectedCompListId = compListId;
    pageState.selectedCompList = pageState.compLists.find(c => c.id === compListId);
    
    if (!pageState.selectedCompList) {
        showToast('Comp List를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 카드 UI 업데이트
    document.querySelectorAll('.complist-card').forEach(card => {
        card.classList.toggle('active', card.onclick.toString().includes(compListId));
    });
    renderCompListCards();
    
    // 편집 데이터 복사
    pageState.editData = JSON.parse(JSON.stringify(pageState.selectedCompList));
    
    // 저장된 buildingData 평탄화 (기존 데이터 호환성)
    if (pageState.editData.buildings) {
        pageState.editData.buildings = pageState.editData.buildings.map(b => {
            // buildingData가 있으면 평탄화
            if (b.buildingData && b.buildingData._raw) {
                // 이미 평탄화된 상태
                return b;
            } else if (b.buildingData) {
                // 평탄화 필요
                const flatData = flattenBuildingData(b.buildingId, b.buildingData);
                return { ...b, buildingData: flatData };
            }
            // buildingData가 없으면 allBuildings에서 찾아서 채우기
            const found = pageState.allBuildings.find(ab => ab.id === b.buildingId);
            if (found) {
                return { ...b, buildingData: found };
            }
            return b;
        });
    }
    
    // 상세보기 영역 표시
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('detailContent').style.display = 'flex';
    
    // 상세 정보 렌더링
    renderDetailView();
};

function renderDetailView() {
    const data = pageState.editData;
    
    // 헤더 정보
    document.getElementById('detailTitle').value = data.title || '';
    document.getElementById('detailCreator').textContent = `생성자: ${data.createdBy?.name || '-'}`;
    document.getElementById('detailDate').textContent = `생성일: ${formatDate(data.createdAt)}`;
    document.getElementById('detailBuildingCount').textContent = `빌딩: ${data.buildings?.length || 0}개`;
    
    // 현재 빌딩 수 (검색 바 옆)
    const buildingCount = data.buildings?.length || 0;
    const vacancyCount = (data.buildings || []).reduce((sum, b) => sum + (b.vacancies?.length || 0), 0);
    const infoEl = document.getElementById('currentBuildingsInfo');
    if (infoEl) {
        infoEl.innerHTML = `현재 <strong>${buildingCount}</strong>개 빌딩 · <strong>${vacancyCount}</strong>개 공실`;
    }
    
    // 유형 버튼
    document.querySelectorAll('.type-selector .type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === data.type);
    });
    
    // 스프레드시트 렌더링
    if (data.type === 'lg') {
        document.getElementById('generalSpreadsheet').style.display = 'none';
        document.getElementById('lgSpreadsheet').style.display = 'block';
        renderLGSpreadsheet();
    } else {
        document.getElementById('generalSpreadsheet').style.display = 'block';
        document.getElementById('lgSpreadsheet').style.display = 'none';
        renderGeneralSpreadsheet();
    }
}

// ============================================================
// 일반용 스프레드시트 렌더링
// ============================================================
function renderGeneralSpreadsheet() {
    const buildings = pageState.editData.buildings || [];
    
    // 빌딩+공실 조합 평탄화
    const entries = [];
    buildings.forEach((b, bIdx) => {
        const vacancies = b.vacancies || [];
        if (vacancies.length === 0) {
            entries.push({ building: b, vacancy: null, buildingIdx: bIdx, vacancyIdx: -1 });
        } else {
            vacancies.forEach((v, vIdx) => {
                entries.push({ building: b, vacancy: v, buildingIdx: bIdx, vacancyIdx: vIdx });
            });
        }
    });
    
    // 헤더 렌더링
    const thead = document.getElementById('spreadsheetHead');
    
    // 각 빌딩별로 별도의 <th> 생성
    const buildingHeaders = entries.map((e, idx) => `
        <th class="col-building header building-header-cell">
            <div class="building-name">${escapeHtml(e.building.buildingName || '-')}</div>
            <div class="actions">
                <button class="action-btn" onclick="event.stopPropagation(); openVacancyModal('${e.building.buildingId}', ${e.vacancyIdx})" title="공실 편집">✏️</button>
                <button class="action-btn" onclick="event.stopPropagation(); addVacancyToBuilding('${e.building.buildingId}')" title="공실 추가">➕</button>
                <button class="action-btn" onclick="event.stopPropagation(); removeBuildingEntry(${e.buildingIdx}, ${e.vacancyIdx})" title="삭제">🗑️</button>
            </div>
        </th>
    `).join('');
    
    thead.innerHTML = `
        <tr>
            <th class="col-category">구분</th>
            <th class="col-label">항목</th>
            ${entries.length === 0 ? '<th class="col-building">빌딩을 추가하세요</th>' : buildingHeaders}
        </tr>
    `;
    
    // 본문 렌더링
    const tbody = document.getElementById('spreadsheetBody');
    
    if (entries.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td class="col-category section-image">외관사진</td>
                <td class="col-label">빌딩 이미지</td>
                <td class="col-building">-</td>
            </tr>
            <tr>
                <td class="col-category section-building" rowspan="12">빌딩 현황</td>
                <td class="col-label">주소</td>
                <td class="col-building">-</td>
            </tr>
        `;
        return;
    }
    
    let html = '';
    
    // ========================================
    // 1. 외관사진 (맨 위)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-image">외관사진</td>
            <td class="col-label">빌딩 이미지</td>
            ${entries.map((e) => {
                const bd = e.building.buildingData || {};
                const imageUrl = bd.exteriorImage || bd.mainImage || '';
                return `
                    <td class="col-building image-cell">
                        ${imageUrl ? 
                            `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;">
                                <img src="${imageUrl}" onclick="openImageModal('${e.building.buildingId}')" alt="외관">
                            </div>` :
                            `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%;">
                                <button class="upload-btn" onclick="openImageModal('${e.building.buildingId}')">
                                    📷 이미지 등록
                                </button>
                            </div>`
                        }
                    </td>
                `;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 2. 빌딩개요 (엑셀 행 6)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-detail">빌딩개요</td>
            <td class="col-label">설명</td>
            ${entries.map((e) => {
                const bd = e.building.buildingData || {};
                const descValue = bd.description;
                const displayValue = descValue ? escapeHtml(descValue) : `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, 'description', this.parentElement)">입력 필요</span>`;
                return `<td class="col-building cell-editable" data-building-idx="${e.buildingIdx}" data-key="description" onclick="openCellEditor(${e.buildingIdx}, 'description', this)">${displayValue}</td>`;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 3. 빌딩 현황 (엑셀 행 7-18)
    // ========================================
    const buildingInfoRows = [
        { label: '주소 (지번)', key: 'addressJibun', altKey: 'address', editable: true },
        { label: '도로명 주소', key: 'address', editable: true },
        { label: '위치 (인근역)', key: 'nearestStation', altKey: 'station', editable: true },
        { label: '빌딩 규모', key: 'floors', altKey: 'scale', editable: true },
        { label: '준공연도', key: 'completionYear', editable: true },
        { label: '전용률 (%)', key: 'exclusiveRate', altKey: 'dedicatedRate', format: 'percent', editable: true },
        { label: '기준층 임대면적 (m²)', key: 'typicalFloorSqm', altKey: 'typicalFloorM2', format: 'area', editable: true },
        { label: '기준층 임대면적 (평)', key: 'typicalFloorPy', format: 'area', editable: true },
        { label: '기준층 전용면적 (m²)', key: 'exclusiveFloorSqm', formula: 'typicalFloorSqm * exclusiveRate / 100', format: 'area' },
        { label: '기준층 전용면적 (평)', key: 'exclusiveFloorPy', formula: 'typicalFloorPy * exclusiveRate / 100', format: 'area' },
        { label: '엘레베이터', key: 'elevators', altKey: 'elevator', editable: true },
        { label: '냉난방 방식', key: 'hvac', altKey: 'heatingCooling', editable: true }
    ];
    
    buildingInfoRows.forEach((row, idx) => {
        html += '<tr>';
        if (idx === 0) {
            html += `<td class="col-category section-building" rowspan="${buildingInfoRows.length}">빌딩 현황</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        entries.forEach((e, eIdx) => {
            const bd = e.building.buildingData || {};
            let value = '';
            let displayValue = '';
            let isEditable = row.editable;
            
            if (row.formula) {
                // 수식 계산
                const typicalFloorSqm = parseFloat(bd.typicalFloorSqm) || parseFloat(bd.typicalFloorM2) || (parseFloat(bd.typicalFloorPy) || 0) * 3.305785;
                const typicalFloorPy = parseFloat(bd.typicalFloorPy) || 0;
                const exclusiveRate = parseFloat(bd.exclusiveRate) || parseFloat(bd.dedicatedRate) || 0;
                
                if (row.key === 'exclusiveFloorSqm') {
                    value = typicalFloorSqm * exclusiveRate / 100;
                } else if (row.key === 'exclusiveFloorPy') {
                    value = typicalFloorPy * exclusiveRate / 100;
                }
                
                // 기준층 면적이 없으면 입력 필요 표시
                if (!typicalFloorSqm && !typicalFloorPy) {
                    displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">기준층 면적 입력 필요</span>`;
                } else if (!exclusiveRate) {
                    displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">전용률 입력 필요</span>`;
                } else {
                    displayValue = value ? value.toFixed(2) : '-';
                }
                html += `<td class="col-building cell-formula" data-building-idx="${e.buildingIdx}" data-key="${row.key}">${displayValue}</td>`;
            } else {
                // 일반 값
                let rawValue = bd[row.key];
                if (!rawValue && row.altKey) rawValue = bd[row.altKey];
                
                if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
                    value = safeStringify(rawValue);
                    if (row.format === 'percent') {
                        const numVal = parseFloat(value);
                        value = numVal ? (numVal > 1 ? numVal.toFixed(1) + '%' : (numVal * 100).toFixed(1) + '%') : value;
                    } else if (row.format === 'area') {
                        const numVal = parseFloat(value);
                        value = numVal ? numVal.toFixed(2) : value;
                    }
                    displayValue = escapeHtml(value);
                } else {
                    // 값이 없으면 입력 필요 placeholder
                    displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">입력 필요</span>`;
                }
                
                if (isEditable) {
                    html += `<td class="col-building cell-editable" data-building-idx="${e.buildingIdx}" data-key="${row.key}" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">${displayValue}</td>`;
                } else {
                    html += `<td class="col-building">${displayValue}</td>`;
                }
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 4. 빌딩 세부현황 (엑셀 행 19-20)
    // ========================================
    const detailRows = [
        { label: '건물용도', key: 'buildingUse', altKey: 'usage', editable: true },
        { label: '구조', key: 'structure', editable: true }
    ];
    
    detailRows.forEach((row, idx) => {
        html += '<tr>';
        if (idx === 0) {
            html += `<td class="col-category section-detail" rowspan="${detailRows.length}">빌딩 세부</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        entries.forEach((e) => {
            const bd = e.building.buildingData || {};
            let rawValue = bd[row.key];
            if (!rawValue && row.altKey) rawValue = bd[row.altKey];
            
            let displayValue = '';
            if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
                displayValue = escapeHtml(safeStringify(rawValue));
            } else {
                displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">입력 필요</span>`;
            }
            
            html += `<td class="col-building cell-editable" data-building-idx="${e.buildingIdx}" data-key="${row.key}" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">${displayValue}</td>`;
        });
        html += '</tr>';
    });
    
    // ========================================
    // 5. 주차 관련 (엑셀 행 21-23)
    // ========================================
    const parkingRows = [
        { label: '주차 대수 정보', key: 'parkingInfo', altKey: 'parking', editable: true },
        { label: '주차비', key: 'parkingFee', editable: true },
        { label: '주차 대수', key: 'parkingTotal', altKey: 'parkingSpaces', editable: true }
    ];
    
    parkingRows.forEach((row, idx) => {
        html += '<tr>';
        if (idx === 0) {
            html += `<td class="col-category section-parking" rowspan="${parkingRows.length}">주차 관련</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        entries.forEach((e) => {
            const bd = e.building.buildingData || {};
            let rawValue = bd[row.key];
            if (!rawValue && row.altKey) rawValue = bd[row.altKey];
            
            let displayValue = '';
            if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
                displayValue = escapeHtml(safeStringify(rawValue));
            } else {
                displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">입력 필요</span>`;
            }
            
            html += `<td class="col-building cell-editable" data-building-idx="${e.buildingIdx}" data-key="${row.key}" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">${displayValue}</td>`;
        });
        html += '</tr>';
    });
    
    // ========================================
    // 6. 임차 제안 (엑셀 행 25-31)
    // ========================================
    const leaseRows = [
        { label: '최적 임차 층수', key: 'floor', source: 'vacancy', editable: true },
        { label: '입주 가능 시기', key: 'moveInDate', source: 'vacancy', editable: true },
        { label: '거래유형', value: '임대' },
        { label: '임대면적 (m²)', formula: 'ROUNDDOWN(rentArea * 3.305785, 3)', format: 'area' },
        { label: '전용면적 (m²)', formula: 'ROUNDDOWN(exclusiveArea * 3.305785, 3)', format: 'area' },
        { label: '임대면적 (평)', key: 'rentArea', source: 'vacancy', editable: true, format: 'area' },
        { label: '전용면적 (평)', key: 'exclusiveArea', source: 'vacancy', editable: true, format: 'area' }
    ];
    
    leaseRows.forEach((row, idx) => {
        html += '<tr>';
        if (idx === 0) {
            html += `<td class="col-category section-lease" rowspan="${leaseRows.length}">임차 제안</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        entries.forEach((e) => {
            const v = e.vacancy || {};
            let value = '';
            let cellClass = 'col-building';
            
            if (row.formula) {
                const rentArea = parseFloat(v.rentArea) || 100;
                const exclusiveArea = parseFloat(v.exclusiveArea) || 50;
                if (row.formula.includes('rentArea')) {
                    value = (rentArea * 3.305785).toFixed(3);
                } else {
                    value = (exclusiveArea * 3.305785).toFixed(3);
                }
                cellClass += ' cell-formula';
            } else if (row.value) {
                value = row.value;
            } else if (row.source === 'vacancy') {
                value = v[row.key] || '-';
                if (row.editable && e.vacancy) {
                    cellClass += ' cell-editable';
                }
            }
            
            if (row.editable && e.vacancy) {
                html += `<td class="${cellClass}" onclick="editCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, '${row.key}')" 
                         data-key="${row.key}" data-bidx="${e.buildingIdx}" data-vidx="${e.vacancyIdx}">${value}</td>`;
            } else {
                html += `<td class="${cellClass}">${value}</td>`;
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 7. 임대 기준 (엑셀 행 32-39)
    // ========================================
    const rentRows = [
        { label: '월 평당 보증금 (만원)', key: 'depositPy', source: 'vacancy', editable: true },
        { label: '월 평당 임대료 (만원)', key: 'rentPy', source: 'vacancy', editable: true },
        { label: '월 평당 관리비 (만원)', key: 'maintenancePy', source: 'vacancy', editable: true },
        { label: '월 평당 지출비용', formula: 'rentPy + maintenancePy', format: 'currency' },
        { label: '총 보증금', formula: 'depositPy * rentArea * 10000', format: 'won' },
        { label: '월 임대료 총액', formula: 'rentPy * rentArea * 10000', format: 'won' },
        { label: '월 관리비 총액', formula: 'maintenancePy * rentArea * 10000', format: 'won' },
        { label: '월 전용면적당 지출비용', formula: '(rentPy * rentArea + maintenancePy * rentArea) * 10000 / exclusiveArea', format: 'won' }
    ];
    
    rentRows.forEach((row, idx) => {
        html += '<tr>';
        if (idx === 0) {
            html += `<td class="col-category section-rent" rowspan="${rentRows.length}">임대 기준</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        entries.forEach((e) => {
            const v = e.vacancy || {};
            let value = '';
            let cellClass = 'col-building';
            
            const depositPy = parseFloat(v.depositPy) || 0;
            const rentPy = parseFloat(v.rentPy) || 0;
            const maintenancePy = parseFloat(v.maintenancePy) || 0;
            const rentArea = parseFloat(v.rentArea) || 100;
            const exclusiveArea = parseFloat(v.exclusiveArea) || 50;
            
            if (row.formula) {
                cellClass += ' cell-formula';
                if (row.formula === 'rentPy + maintenancePy') {
                    value = rentPy + maintenancePy;
                } else if (row.formula === 'depositPy * rentArea * 10000') {
                    value = depositPy * rentArea * 10000;
                } else if (row.formula === 'rentPy * rentArea * 10000') {
                    value = rentPy * rentArea * 10000;
                } else if (row.formula === 'maintenancePy * rentArea * 10000') {
                    value = maintenancePy * rentArea * 10000;
                } else if (row.formula.includes('exclusiveArea')) {
                    value = exclusiveArea > 0 ? ((rentPy + maintenancePy) * rentArea * 10000 / exclusiveArea) : 0;
                }
                value = formatValue(value, row.format);
            } else if (row.source === 'vacancy') {
                value = v[row.key] || '-';
                if (row.editable && e.vacancy) cellClass += ' cell-editable';
            }
            
            if (row.editable && e.vacancy) {
                html += `<td class="${cellClass}" onclick="editCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, '${row.key}')"
                         data-key="${row.key}" data-bidx="${e.buildingIdx}" data-vidx="${e.vacancyIdx}">${value}</td>`;
            } else {
                html += `<td class="${cellClass}">${value}</td>`;
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 8. 임대기준 조정 (엑셀 행 40-44)
    // ========================================
    const adjustRows = [
        { label: '보증금', formula: 'depositPy', format: 'currency' },
        { label: '렌트프리 (개월/년)', key: 'rentFree', source: 'vacancy', editable: true, default: '0' },
        { label: '평균 임대료', formula: 'rentPy - (rentPy * rentFree / 12)', format: 'currency' },
        { label: '관리비', formula: 'maintenancePy', format: 'currency' },
        { label: 'NOC', formula: '((rentPy - rentPy * rentFree / 12) + maintenancePy) * rentArea / exclusiveArea', format: 'currency' }
    ];
    
    adjustRows.forEach((row, idx) => {
        html += '<tr>';
        if (idx === 0) {
            html += `<td class="col-category" rowspan="${adjustRows.length}" style="background:#e0e7ff;">임대기준 조정</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        entries.forEach((e) => {
            const v = e.vacancy || {};
            let value = '';
            let cellClass = 'col-building';
            
            const depositPy = parseFloat(v.depositPy) || 0;
            const rentPy = parseFloat(v.rentPy) || 0;
            const maintenancePy = parseFloat(v.maintenancePy) || 0;
            const rentFree = parseFloat(v.rentFree) || 0;
            const rentArea = parseFloat(v.rentArea) || 100;
            const exclusiveArea = parseFloat(v.exclusiveArea) || 50;
            
            if (row.formula) {
                cellClass += ' cell-formula';
                if (row.formula === 'depositPy') {
                    value = depositPy;
                } else if (row.formula === 'maintenancePy') {
                    value = maintenancePy;
                } else if (row.formula.includes('rentFree')) {
                    const effectiveRent = rentPy - (rentPy * rentFree / 12);
                    if (row.formula.includes('NOC')) {
                        value = exclusiveArea > 0 ? (effectiveRent + maintenancePy) * rentArea / exclusiveArea : 0;
                    } else {
                        value = effectiveRent;
                    }
                }
                value = formatValue(value, row.format);
            } else if (row.source === 'vacancy') {
                value = v[row.key] || row.default || '-';
                if (row.editable && e.vacancy) cellClass += ' cell-editable';
            }
            
            if (row.editable && e.vacancy) {
                html += `<td class="${cellClass}" onclick="editCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, '${row.key}')"
                         data-key="${row.key}" data-bidx="${e.buildingIdx}" data-vidx="${e.vacancyIdx}">${value}</td>`;
            } else {
                html += `<td class="${cellClass}">${value}</td>`;
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 9. 예상비용 (엑셀 행 46-50)
    // ========================================
    const costRows = [
        { label: '보증금', formula: 'depositPy * rentArea * 10000', format: 'won' },
        { label: '평균 월 임대료', formula: '(rentPy - rentPy * rentFree / 12) * rentArea * 10000', format: 'won' },
        { label: '평균 월 관리비', formula: 'maintenancePy * rentArea * 10000', format: 'won' },
        { label: '월 (임대료 + 관리비)', formula: '((rentPy - rentPy * rentFree / 12) + maintenancePy) * rentArea * 10000', format: 'won' },
        { label: '연 실제 부담 고정금액', formula: '((rentPy - rentPy * rentFree / 12) + maintenancePy) * rentArea * 10000 * 12', format: 'won' }
    ];
    
    costRows.forEach((row, idx) => {
        html += '<tr>';
        if (idx === 0) {
            html += `<td class="col-category section-cost" rowspan="${costRows.length}" style="background:#fce7f3;">예상비용</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        entries.forEach((e) => {
            const v = e.vacancy || {};
            let cellClass = 'col-building cell-formula';
            
            const depositPy = parseFloat(v.depositPy) || 0;
            const rentPy = parseFloat(v.rentPy) || 0;
            const maintenancePy = parseFloat(v.maintenancePy) || 0;
            const rentFree = parseFloat(v.rentFree) || 0;
            const rentArea = parseFloat(v.rentArea) || 100;
            
            const effectiveRent = rentPy - (rentPy * rentFree / 12);
            let value = 0;
            
            if (row.formula.includes('depositPy * rentArea')) {
                value = depositPy * rentArea * 10000;
            } else if (row.formula.includes('rentPy') && !row.formula.includes('maintenancePy')) {
                value = effectiveRent * rentArea * 10000;
            } else if (row.formula.includes('maintenancePy') && !row.formula.includes('rentPy')) {
                value = maintenancePy * rentArea * 10000;
            } else if (row.formula.includes('* 12')) {
                value = (effectiveRent + maintenancePy) * rentArea * 10000 * 12;
            } else {
                value = (effectiveRent + maintenancePy) * rentArea * 10000;
            }
            
            html += `<td class="${cellClass}">${formatValue(value, row.format)}</td>`;
        });
        html += '</tr>';
    });
    
    tbody.innerHTML = html;
}

// ============================================================
// LG용 스프레드시트 렌더링
// ============================================================
function renderLGSpreadsheet() {
    const container = document.getElementById('lgSpreadsheet');
    const buildings = pageState.editData.buildings || [];
    
    if (buildings.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:60px;">
                <p>빌딩을 추가하세요</p>
            </div>
        `;
        return;
    }
    
    // LG용 레이아웃 - 빌딩당 3열 (층/전용/임대)
    let html = `
        <table class="spreadsheet lg-table">
            <thead>
                <tr>
                    <th class="col-category">구분</th>
                    <th class="col-label">항목</th>
                    ${buildings.map(b => `
                        <th colspan="3" class="building-header-cell">
                            <div class="building-name">${escapeHtml(b.buildingName || '-')}</div>
                            <div class="actions">
                                <button class="action-btn" onclick="addVacancyToBuilding('${b.buildingId}')" title="공실 추가">➕</button>
                                <button class="action-btn" onclick="removeBuilding('${b.buildingId}')" title="삭제">🗑️</button>
                            </div>
                        </th>
                    `).join('')}
                </tr>
            </thead>
            <tbody>
    `;
    
    // ========================================
    // 1. 건물 외관 (이미지)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-image">건물 외관</td>
            <td class="col-label">이미지</td>
            ${buildings.map(b => {
                const bd = b.buildingData || {};
                const imageUrl = bd.exteriorImage || bd.mainImage || '';
                return `
                    <td colspan="3" class="image-cell">
                        ${imageUrl ? 
                            `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center;">
                                <img src="${imageUrl}" onclick="openImageModal('${b.buildingId}')" alt="외관">
                            </div>` :
                            `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%;">
                                <button class="upload-btn" onclick="openImageModal('${b.buildingId}')">
                                    📷 이미지 등록
                                </button>
                            </div>`
                        }
                    </td>
                `;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 2. 기초정보 (8행)
    // ========================================
    const infoRows = [
        { label: '주소', key: 'address' },
        { label: '위치', key: 'nearestStation', altKey: 'station' },
        { label: '준공일', key: 'completionYear' },
        { label: '규모', key: 'floors', altKey: 'scale' },
        { label: '연면적', key: 'grossFloorPy', altKey: 'grossFloorArea', suffix: '평' },
        { label: '기준층 전용면적', key: 'typicalFloorPy', suffix: '평' },
        { label: '전용률', key: 'exclusiveRate', altKey: 'dedicatedRate', format: 'percent' },
        { label: '대지면적', key: 'landArea', suffix: '평' }
    ];
    
    infoRows.forEach((row, idx) => {
        html += `<tr>`;
        if (idx === 0) {
            html += `<td class="col-category section-building" rowspan="${infoRows.length}">기초정보</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        buildings.forEach((b, bIdx) => {
            const bd = b.buildingData || {};
            let rawValue = bd[row.key] || (row.altKey ? bd[row.altKey] : '') || '';
            let displayValue = safeStringify(rawValue);
            
            if (row.format === 'percent' && displayValue && displayValue !== '-') {
                const numVal = parseFloat(displayValue);
                displayValue = numVal ? (numVal > 1 ? numVal.toFixed(1) + '%' : (numVal * 100).toFixed(1) + '%') : displayValue;
            }
            if (row.suffix && displayValue && displayValue !== '-' && !String(displayValue).includes(row.suffix)) {
                displayValue += row.suffix;
            }
            
            const hasValue = rawValue && rawValue !== '-';
            html += `<td colspan="3" class="col-building cell-editable" onclick="editBuildingCell(this, ${bIdx}, '${row.key}')">${hasValue ? escapeHtml(displayValue) : '<span class="placeholder-input">입력</span>'}</td>`;
        });
        html += `</tr>`;
    });
    
    // ========================================
    // 2-1. 채권분석 (7행) - 수동 입력용
    // ========================================
    const bondRows = [
        { label: '소유자 (임대인)', key: 'owner' },
        { label: '채권담보 설정여부', key: 'bondStatus' },
        { label: '공동담보 총 대지지분', key: 'jointCollateral' },
        { label: '선순위 담보 총액', key: 'seniorLien' },
        { label: '공시지가 대비 담보율', key: 'collateralRatio' },
        { label: '개별공시지가(25년 1월 기준)', key: 'officialLandPrice' },
        { label: '토지가격 적용', key: 'landPriceApplied' }
    ];
    
    bondRows.forEach((row, idx) => {
        html += `<tr>`;
        if (idx === 0) {
            html += `<td class="col-category section-bond" rowspan="${bondRows.length}">채권분석</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        buildings.forEach((b, bIdx) => {
            const bd = b.buildingData || {};
            const value = bd[row.key] || '';
            html += `<td colspan="3" class="cell-editable cell-input" onclick="editBuildingCell(this, ${bIdx}, '${row.key}')">${escapeHtml(value) || '<span class="placeholder-input">입력</span>'}</td>`;
        });
        html += `</tr>`;
    });
    
    // ========================================
    // 3. 현재 공실 (헤더 + 5행 + 소계)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-vacancy" rowspan="7">현재 공실</td>
            <td class="col-label col-subheader">층/전용/임대</td>
            ${buildings.map(() => `
                <td class="col-subheader">층</td>
                <td class="col-subheader">전용(평)</td>
                <td class="col-subheader">임대(평)</td>
            `).join('')}
        </tr>
    `;
    
    // 공실 5행
    for (let i = 0; i < 5; i++) {
        html += `<tr>`;
        html += `<td class="col-label">공실 ${i + 1}</td>`;
        
        buildings.forEach((b, bIdx) => {
            const v = b.vacancies?.[i];
            if (v) {
                html += `
                    <td class="cell-editable" onclick="editCell(this, ${bIdx}, ${i}, 'floor')">${v.floor || '-'}</td>
                    <td class="cell-editable" onclick="editCell(this, ${bIdx}, ${i}, 'exclusiveArea')">${formatNumber(v.exclusiveArea)}</td>
                    <td class="cell-editable" onclick="editCell(this, ${bIdx}, ${i}, 'rentArea')">${formatNumber(v.rentArea)}</td>
                `;
            } else {
                html += `
                    <td colspan="3" style="text-align:center; color:#059669; cursor:pointer;" onclick="addVacancyToBuilding('${b.buildingId}')">+ 추가</td>
                `;
            }
        });
        html += `</tr>`;
    }
    
    // 소계
    html += `<tr style="background:#fce7f3;">`;
    html += `<td class="col-label" style="font-weight:600;">소계</td>`;
    buildings.forEach(b => {
        const totalExclusive = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.exclusiveArea) || 0), 0);
        const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
        html += `
            <td style="text-align:center;">-</td>
            <td class="cell-formula" style="font-weight:600;">${formatNumber(totalExclusive)}</td>
            <td class="cell-formula" style="font-weight:600;">${formatNumber(totalRent)}</td>
        `;
    });
    html += `</tr>`;
    
    // ========================================
    // 4. 제안 (5행)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-proposal" rowspan="5">제안</td>
            <td class="col-label">계약기간</td>
            ${buildings.map((b, bIdx) => {
                const v = b.vacancies?.[0] || {};
                return `<td colspan="3" class="cell-editable" onclick="editCell(this, ${bIdx}, 0, 'contractPeriod')">${v.contractPeriod || '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">입주가능 시기</td>
            ${buildings.map((b, bIdx) => {
                const v = b.vacancies?.[0] || {};
                return `<td colspan="3" class="cell-editable" onclick="editCell(this, ${bIdx}, 0, 'moveInDate')">${v.moveInDate || '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">제안 층</td>
            ${buildings.map((b, bIdx) => {
                const v = b.vacancies?.[0] || {};
                return `<td colspan="3" class="cell-editable" onclick="editCell(this, ${bIdx}, 0, 'floor')">${v.floor || '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">전용면적</td>
            ${buildings.map(b => {
                const totalExclusive = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.exclusiveArea) || 0), 0);
                return `<td colspan="3" class="cell-formula">${totalExclusive ? formatNumber(totalExclusive) + '평' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">임대면적</td>
            ${buildings.map(b => {
                const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                return `<td colspan="3" class="cell-formula">${totalRent ? formatNumber(totalRent) + '평' : '-'}</td>`;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 5. 기준층 임대기준 (3행)
    // ========================================
    const rentBaseRows = [
        { label: '보증금', key: 'depositPy', unit: '만원/평' },
        { label: '임대료', key: 'rentPy', unit: '만원/평' },
        { label: '관리비', key: 'maintenancePy', unit: '만원/평' }
    ];
    
    rentBaseRows.forEach((row, idx) => {
        html += `<tr>`;
        if (idx === 0) {
            html += `<td class="col-category section-rent" rowspan="${rentBaseRows.length}">기준층<br>임대기준</td>`;
        }
        html += `<td class="col-label">${row.label}</td>`;
        
        buildings.forEach((b, bIdx) => {
            const v = b.vacancies?.[0] || {};
            const value = v[row.key] || '';
            html += `
                <td colspan="3" class="cell-editable" onclick="editCell(this, ${bIdx}, 0, '${row.key}')">
                    ${value ? formatNumber(value) + ' ' + row.unit : '-'}
                </td>
            `;
        });
        html += `</tr>`;
    });
    
    // ========================================
    // 6. 실질 임대기준 (2행)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-realrent" rowspan="2">실질<br>임대기준</td>
            <td class="col-label">실질 임대료(RF반영)</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const rentPy = parseFloat(v.rentPy) || 0;
                const rentFree = parseFloat(v.rentFree) || 0;
                const effectiveRent = rentPy * (12 - rentFree) / 12;
                return `<td colspan="3" class="cell-formula">${effectiveRent ? formatNumber(effectiveRent.toFixed(2)) + ' 만원/평' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">연간 무상임대 (R.F)</td>
            ${buildings.map((b, bIdx) => {
                const v = b.vacancies?.[0] || {};
                return `<td colspan="3" class="cell-editable" onclick="editCell(this, ${bIdx}, 0, 'rentFree')">${v.rentFree ? v.rentFree + '개월' : '-'}</td>`;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 7. 비용검토 (6행)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-cost" rowspan="6">비용검토</td>
            <td class="col-label">보증금</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const depositPy = parseFloat(v.depositPy) || 0;
                const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const totalDeposit = depositPy * totalRent * 10000;
                return `<td colspan="3" class="cell-formula">${totalDeposit ? formatNumber(Math.round(totalDeposit)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">월 임대료</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const rentPy = parseFloat(v.rentPy) || 0;
                const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const monthlyRent = rentPy * totalRent * 10000;
                return `<td colspan="3" class="cell-formula">${monthlyRent ? formatNumber(Math.round(monthlyRent)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">월 관리비</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const maintenancePy = parseFloat(v.maintenancePy) || 0;
                const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const monthlyMaint = maintenancePy * totalRent * 10000;
                return `<td colspan="3" class="cell-formula">${monthlyMaint ? formatNumber(Math.round(monthlyMaint)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">관리비 내역</td>
            ${buildings.map((b, bIdx) => {
                const v = b.vacancies?.[0] || {};
                return `<td colspan="3" class="cell-editable" onclick="editCell(this, ${bIdx}, 0, 'maintenanceDetail')">${v.maintenanceDetail || '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">월납부액</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const rentPy = parseFloat(v.rentPy) || 0;
                const maintenancePy = parseFloat(v.maintenancePy) || 0;
                const totalRentArea = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const monthlyTotal = (rentPy + maintenancePy) * totalRentArea * 10000;
                return `<td colspan="3" class="cell-formula cell-highlight">${monthlyTotal ? formatNumber(Math.round(monthlyTotal)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">(21개월) 총 납부비용</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const rentPy = parseFloat(v.rentPy) || 0;
                const maintenancePy = parseFloat(v.maintenancePy) || 0;
                const totalRentArea = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const total21Months = (rentPy + maintenancePy) * totalRentArea * 10000 * 21;
                return `<td colspan="3" class="cell-formula cell-total">${total21Months ? formatNumber(Math.round(total21Months)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 8. 공사기간 FAVOR (2행)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-favor" rowspan="2">공사기간<br>FAVOR</td>
            <td class="col-label">인테리어 기간 (F.O)</td>
            ${buildings.map((b, bIdx) => {
                const v = b.vacancies?.[0] || {};
                const value = v.fitoutPeriod || v.interiorPeriod || '';
                return `<td colspan="3" class="cell-editable cell-input" onclick="editCell(this, ${bIdx}, 0, 'fitoutPeriod')">${escapeHtml(value) || '<span class="placeholder-input">입력</span>'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">인테리어지원금 (T.I)</td>
            ${buildings.map((b, bIdx) => {
                const v = b.vacancies?.[0] || {};
                const value = v.tiSupport || v.interiorSupport || '';
                return `<td colspan="3" class="cell-editable cell-input" onclick="editCell(this, ${bIdx}, 0, 'tiSupport')">${escapeHtml(value) || '<span class="placeholder-input">입력</span>'}</td>`;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 9. 주차현황 (4행)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-parking" rowspan="4">주차현황</td>
            <td class="col-label">총 주차대수</td>
            ${buildings.map((b, bIdx) => {
                const bd = b.buildingData || {};
                const parking = safeStringify(bd.parkingInfo || bd.parkingTotal || bd.parking || '');
                return `<td colspan="3" class="cell-editable" onclick="editBuildingCell(this, ${bIdx}, 'parkingTotal')">${escapeHtml(parking) || '<span class="placeholder-input">입력</span>'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">무료주차 조건(임대면적)</td>
            ${buildings.map((b, bIdx) => {
                const bd = b.buildingData || {};
                const condition = bd.freeParkingCondition || '';
                return `<td colspan="3" class="cell-editable cell-input" onclick="editBuildingCell(this, ${bIdx}, 'freeParkingCondition')">${condition ? condition + '평당 1대' : '<span class="placeholder-input">입력</span>'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">무료주차 제공대수</td>
            ${buildings.map(b => {
                const bd = b.buildingData || {};
                const condition = parseFloat(bd.freeParkingCondition) || 50;
                const totalRentArea = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const freeParking = condition > 0 ? Math.floor(totalRentArea / condition) : 0;
                return `<td colspan="3" class="cell-formula">${freeParking ? freeParking + '대' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">유료주차(VAT별도)</td>
            ${buildings.map((b, bIdx) => {
                const bd = b.buildingData || {};
                const parkingFee = bd.paidParking || bd.parkingFee || '';
                return `<td colspan="3" class="cell-editable cell-input" onclick="editBuildingCell(this, ${bIdx}, 'paidParking')">${escapeHtml(parkingFee) || '<span class="placeholder-input">입력</span>'}</td>`;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 10. 기타 (2행)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-etc" rowspan="2">기타</td>
            <td class="col-label">평면도</td>
            ${buildings.map((b, bIdx) => {
                const bd = b.buildingData || {};
                const floorPlan = bd.floorPlan || '';
                return `<td colspan="3" class="cell-editable" onclick="editBuildingCell(this, ${bIdx}, 'floorPlan')">${escapeHtml(floorPlan) || '<span class="placeholder-input">입력</span>'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">특이사항</td>
            ${buildings.map((b, bIdx) => {
                const bd = b.buildingData || {};
                const remarks = bd.remarks || '';
                return `<td colspan="3" class="cell-editable" onclick="editBuildingCell(this, ${bIdx}, 'remarks')">${escapeHtml(remarks) || '<span class="placeholder-input">입력</span>'}</td>`;
            }).join('')}
        </tr>
    `;
    
    html += `</tbody></table>`;
    
    container.innerHTML = html;
}

// ============================================================
// 수식 계산
// ============================================================
function calculateFormula(formula, bd, v, entry) {
    try {
        // 변수 치환
        const rentArea = parseFloat(v.rentArea) || 0;
        const exclusiveArea = parseFloat(v.exclusiveArea) || 0;
        const depositPy = parseFloat(v.depositPy) || 0;
        const rentPy = parseFloat(v.rentPy) || 0;
        const maintenancePy = parseFloat(v.maintenancePy) || 0;
        const rentFree = parseFloat(v.rentFree) || 0;
        
        // 중간 계산
        const totalDeposit = depositPy * rentArea * 10000;
        const totalRent = rentPy * rentArea * 10000;
        const totalMaintenance = maintenancePy * rentArea * 10000;
        const effectiveRent = rentPy * (12 - rentFree) / 12;
        const monthlyPayment = (effectiveRent + maintenancePy) * rentArea * 10000;
        
        // 수식 평가
        const result = eval(formula);
        return isNaN(result) || !isFinite(result) ? '-' : result;
    } catch (e) {
        return '-';
    }
}

// ============================================================
// 셀 편집
// ============================================================
window.editCell = function(cell, buildingIdx, vacancyIdx, key) {
    if (cell.querySelector('input')) return; // 이미 편집 중
    
    const currentValue = cell.textContent.replace(/[^0-9.-]/g, '') || '';
    const originalValue = currentValue;
    
    cell.innerHTML = `<input type="text" value="${currentValue}" onblur="saveCellEdit(this, ${buildingIdx}, ${vacancyIdx}, '${key}', '${originalValue}')" onkeypress="if(event.key==='Enter')this.blur()">`;
    cell.querySelector('input').focus();
    cell.querySelector('input').select();
};

window.saveCellEdit = function(input, buildingIdx, vacancyIdx, key, originalValue) {
    const newValue = input.value.trim();
    const cell = input.parentElement;
    
    // 데이터 업데이트
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    if (vacancyIdx >= 0 && building.vacancies?.[vacancyIdx]) {
        building.vacancies[vacancyIdx][key] = newValue;
    } else if (vacancyIdx === -1) {
        // 공실이 없는 빌딩 - 첫 번째 공실 생성
        if (!building.vacancies) building.vacancies = [];
        if (building.vacancies.length === 0) {
            building.vacancies.push({});
        }
        building.vacancies[0][key] = newValue;
    }
    
    // UI 새로고침
    renderDetailView();
    
    if (newValue !== originalValue) {
        showToast('값이 수정되었습니다', 'success');
    }
};

// 빌딩 데이터(buildingData) 편집용 함수
window.editBuildingCell = function(cell, buildingIdx, key) {
    if (cell.querySelector('input')) return; // 이미 편집 중
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    const currentValue = bd[key] || '';
    
    cell.innerHTML = `<input type="text" value="${escapeHtml(currentValue)}" onblur="saveBuildingCellEdit(this, ${buildingIdx}, '${key}')" onkeypress="if(event.key==='Enter')this.blur()" style="width:100%; padding:4px; border:1px solid #3b82f6; border-radius:4px;">`;
    cell.querySelector('input').focus();
    cell.querySelector('input').select();
};

window.saveBuildingCellEdit = function(input, buildingIdx, key) {
    const newValue = input.value.trim();
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    if (!building.buildingData) {
        building.buildingData = {};
    }
    building.buildingData[key] = newValue;
    
    // UI 새로고침
    renderDetailView();
    showToast('값이 수정되었습니다', 'success');
};

// ============================================================
// 빌딩 검색 & 추가
// ============================================================
window.searchBuildingsForAdd = function(query) {
    const dropdown = document.getElementById('buildingSearchResults');
    
    if (!query || query.length < 2) {
        dropdown.style.display = 'none';
        return;
    }
    
    const q = query.toLowerCase();
    const existingIds = new Set((pageState.editData.buildings || []).map(b => b.buildingId));
    
    const results = pageState.allBuildings
        .filter(b => {
            if (existingIds.has(b.id)) return false;
            const nameMatch = b.name?.toLowerCase().includes(q);
            const addrMatch = b.address?.toLowerCase().includes(q);
            return nameMatch || addrMatch;
        })
        .slice(0, 10);
    
    if (results.length === 0) {
        dropdown.innerHTML = `
            <div class="search-no-result">
                <div class="icon">🔍</div>
                <p>검색 결과가 없습니다</p>
                <small>다른 키워드로 검색해보세요</small>
            </div>
        `;
    } else {
        dropdown.innerHTML = results.map(b => {
            const region = b.region || detectRegionFromAddress(b.address) || '';
            const area = b.grossFloorPy ? Math.round(b.grossFloorPy).toLocaleString() + '평' : '';
            return `
                <div class="search-result-item" onclick="addBuildingToList('${b.id}')">
                    <span class="result-name">${escapeHtml(b.name || '-')}</span>
                    <span class="result-addr">${escapeHtml(b.address || '')}</span>
                    ${region || area ? `<span class="result-info">${[region, area].filter(Boolean).join(' · ')}</span>` : ''}
                </div>
            `;
        }).join('');
    }
    
    dropdown.style.display = 'block';
};

// 주소에서 권역 감지
function detectRegionFromAddress(address) {
    if (!address) return '';
    if (address.includes('강남') || address.includes('서초') || address.includes('역삼')) return 'GBD';
    if (address.includes('여의도') || address.includes('영등포') || address.includes('마포')) return 'YBD';
    if (address.includes('종로') || address.includes('중구') || address.includes('을지로')) return 'CBD';
    if (address.includes('분당') || address.includes('판교') || address.includes('성남')) return 'BBD';
    return '';
}

window.addBuildingToList = function(buildingId) {
    const building = pageState.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    if (!pageState.editData.buildings) pageState.editData.buildings = [];
    
    // 중복 체크
    if (pageState.editData.buildings.find(b => b.buildingId === buildingId)) {
        showToast('이미 추가된 빌딩입니다', 'warning');
        return;
    }
    
    // floorPricing 포함하여 buildingData 구성
    const buildingData = {
        ...building,
        // floorPricing이 있으면 포함
        floorPricing: building.floorPricing || []
    };
    
    pageState.editData.buildings.push({
        buildingId: building.id,
        buildingName: building.name,
        buildingData: buildingData,
        vacancies: [],
        addedAt: new Date().toISOString()
    });
    
    // 검색 초기화
    document.getElementById('buildingSearchInput').value = '';
    document.getElementById('buildingSearchResults').style.display = 'none';
    
    // 기준가 정보 표시
    const fpCount = buildingData.floorPricing?.length || 0;
    const fpMsg = fpCount > 0 ? ` (기준가 ${fpCount}개 로드됨)` : '';
    
    // UI 새로고침
    renderDetailView();
    showToast(`${building.name} 추가됨${fpMsg}`, 'success');
};

// ============================================================
// 빌딩/공실 제거
// ============================================================
window.removeBuildingEntry = function(buildingIdx, vacancyIdx) {
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    if (vacancyIdx >= 0 && building.vacancies?.length > 1) {
        // 특정 공실만 제거
        building.vacancies.splice(vacancyIdx, 1);
        showToast('공실 제거됨', 'info');
    } else {
        // 빌딩 전체 제거
        if (confirm(`${building.buildingName}을(를) 삭제하시겠습니까?`)) {
            pageState.editData.buildings.splice(buildingIdx, 1);
            showToast(`${building.buildingName} 제거됨`, 'info');
        } else {
            return;
        }
    }
    
    renderDetailView();
};

window.removeBuilding = function(buildingId) {
    const idx = pageState.editData.buildings.findIndex(b => b.buildingId === buildingId);
    if (idx === -1) return;
    
    const building = pageState.editData.buildings[idx];
    if (confirm(`${building.buildingName}을(를) 삭제하시겠습니까?`)) {
        pageState.editData.buildings.splice(idx, 1);
        renderDetailView();
        showToast(`${building.buildingName} 제거됨`, 'info');
    }
};

// ============================================================
// 기준가 매칭 헬퍼 함수
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

// 층이 범위에 포함되는지 확인 (예: "15F~20F", "B1~B3")
function isFloorInRange(floorNum, rangeStr) {
    if (!rangeStr || floorNum === null) return false;
    
    const str = String(rangeStr).toUpperCase().trim();
    
    // 범위 형식 파싱 (예: "15F~20F", "B1~B3", "10~15F")
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
    
    // 단일 층 형식 (예: "10F", "전층", "기준층")
    if (str.includes('전층') || str.includes('전체') || str.includes('기준')) {
        return true;
    }
    
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
    
    // 층 범위에 맞는 기준가 찾기
    for (const fp of floorPricingList) {
        if (isFloorInRange(floorNum, fp.floorRange)) {
            return fp;
        }
    }
    
    // 범위에 맞는 것이 없으면 첫 번째 기준가 반환 (기본값)
    return null;
}

// ============================================================
// 공실 모달
// ============================================================
window.openVacancyModal = function(buildingId, vacancyIdx = -1) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const modal = document.getElementById('vacancyModal');
    const isEdit = vacancyIdx >= 0 && building.vacancies?.[vacancyIdx];
    
    document.getElementById('vacancyModalTitle').textContent = isEdit ? '공실 수정' : '공실 추가';
    document.getElementById('vf_buildingId').value = buildingId;
    document.getElementById('vf_vacancyIndex').value = vacancyIdx;
    
    // 기준가 목록 표시
    const bd = building.buildingData || {};
    const floorPricing = bd.floorPricing || [];
    const floorPricingSection = document.getElementById('floorPricingSection');
    const floorPricingList = document.getElementById('floorPricingList');
    
    if (floorPricing.length > 0) {
        floorPricingSection.style.display = 'block';
        floorPricingList.innerHTML = floorPricing.map((fp, idx) => `
            <div class="floor-pricing-chip" data-fp-idx="${idx}" onclick="selectFloorPricing(${idx})">
                <span class="fp-label">${fp.label || '기준가 ' + (idx + 1)}</span>
                ${fp.floorRange ? `<span class="fp-range">${fp.floorRange}</span>` : ''}
                <span class="fp-price">${fp.rentPy || '-'}만</span>
            </div>
        `).join('');
    } else {
        floorPricingSection.style.display = 'none';
    }
    
    // 신규 기준가 저장 옵션 초기화
    const savePricingOption = document.getElementById('savePricingOption');
    const saveAsCheckbox = document.getElementById('vf_saveAsPricing');
    savePricingOption.style.display = floorPricing.length === 0 ? 'block' : 'none';
    saveAsCheckbox.checked = false;
    document.getElementById('savePricingDetails').style.display = 'none';
    document.getElementById('vf_pricingLabel').value = '';
    document.getElementById('vf_pricingFloorRange').value = '';
    
    // 체크박스 이벤트
    saveAsCheckbox.onchange = function() {
        document.getElementById('savePricingDetails').style.display = this.checked ? 'flex' : 'none';
    };
    
    if (isEdit) {
        const v = building.vacancies[vacancyIdx];
        document.getElementById('vf_floor').value = v.floor || '';
        document.getElementById('vf_moveInDate').value = v.moveInDate || '';
        document.getElementById('vf_rentArea').value = v.rentArea || '';
        document.getElementById('vf_exclusiveArea').value = v.exclusiveArea || '';
        document.getElementById('vf_depositPy').value = v.depositPy || '';
        document.getElementById('vf_rentPy').value = v.rentPy || '';
        document.getElementById('vf_maintenancePy').value = v.maintenancePy || '';
        
        // 자동 채움 표시 제거
        document.querySelectorAll('.pricing-row input').forEach(inp => inp.classList.remove('auto-filled'));
    } else {
        // 폼 초기화
        ['floor', 'moveInDate', 'rentArea', 'exclusiveArea', 'depositPy', 'rentPy', 'maintenancePy']
            .forEach(id => document.getElementById('vf_' + id).value = '');
        document.querySelectorAll('.pricing-row input').forEach(inp => inp.classList.remove('auto-filled'));
        document.querySelectorAll('.floor-pricing-chip').forEach(chip => chip.classList.remove('selected', 'matched'));
    }
    
    modal.classList.add('show');
};

// 기준가 선택
window.selectFloorPricing = function(fpIdx) {
    const buildingId = document.getElementById('vf_buildingId').value;
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const bd = building.buildingData || {};
    const floorPricing = bd.floorPricing || [];
    const fp = floorPricing[fpIdx];
    if (!fp) return;
    
    // 선택 표시
    document.querySelectorAll('.floor-pricing-chip').forEach(chip => chip.classList.remove('selected', 'matched'));
    document.querySelector(`.floor-pricing-chip[data-fp-idx="${fpIdx}"]`)?.classList.add('selected');
    
    // 값 자동 입력
    if (fp.depositPy) {
        document.getElementById('vf_depositPy').value = fp.depositPy;
        document.getElementById('vf_depositPy').classList.add('auto-filled');
    }
    if (fp.rentPy) {
        document.getElementById('vf_rentPy').value = fp.rentPy;
        document.getElementById('vf_rentPy').classList.add('auto-filled');
    }
    if (fp.maintenancePy) {
        document.getElementById('vf_maintenancePy').value = fp.maintenancePy;
        document.getElementById('vf_maintenancePy').classList.add('auto-filled');
    }
    
    // 면적도 있으면 자동 입력
    if (fp.rentArea && !document.getElementById('vf_rentArea').value) {
        document.getElementById('vf_rentArea').value = fp.rentArea;
    }
    if (fp.exclusiveArea && !document.getElementById('vf_exclusiveArea').value) {
        document.getElementById('vf_exclusiveArea').value = fp.exclusiveArea;
    }
    
    showToast(`'${fp.label || '기준가'}' 적용됨`, 'success');
};

// 층 입력 시 기준가 자동 매칭
window.matchFloorPricing = function() {
    const buildingId = document.getElementById('vf_buildingId').value;
    const floor = document.getElementById('vf_floor').value.trim();
    if (!floor) return;
    
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const bd = building.buildingData || {};
    const floorPricing = bd.floorPricing || [];
    
    if (floorPricing.length === 0) {
        // 기준가 없으면 저장 옵션 표시
        document.getElementById('savePricingOption').style.display = 'block';
        document.getElementById('vf_pricingFloorRange').value = floor;
        return;
    }
    
    // 층에 맞는 기준가 찾기
    const matched = findMatchingFloorPricing(floorPricing, floor);
    
    // 선택 표시 초기화
    document.querySelectorAll('.floor-pricing-chip').forEach(chip => chip.classList.remove('selected', 'matched'));
    
    if (matched) {
        const fpIdx = floorPricing.indexOf(matched);
        const chip = document.querySelector(`.floor-pricing-chip[data-fp-idx="${fpIdx}"]`);
        if (chip) {
            chip.classList.add('matched');
            
            // 값 자동 입력 (기존 값이 없을 때만)
            if (!document.getElementById('vf_depositPy').value && matched.depositPy) {
                document.getElementById('vf_depositPy').value = matched.depositPy;
                document.getElementById('vf_depositPy').classList.add('auto-filled');
            }
            if (!document.getElementById('vf_rentPy').value && matched.rentPy) {
                document.getElementById('vf_rentPy').value = matched.rentPy;
                document.getElementById('vf_rentPy').classList.add('auto-filled');
            }
            if (!document.getElementById('vf_maintenancePy').value && matched.maintenancePy) {
                document.getElementById('vf_maintenancePy').value = matched.maintenancePy;
                document.getElementById('vf_maintenancePy').classList.add('auto-filled');
            }
            
            showToast(`'${matched.label || '기준가'}' 자동 매칭됨`, 'info');
        }
    }
};

// ============================================================
// 셀 인라인 편집
// ============================================================
window.openCellEditor = function(buildingIdx, key, cellElement) {
    // 이미 편집 중이면 무시
    if (cellElement.querySelector('input')) return;
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    const currentValue = bd[key] || '';
    
    // 기존 내용 저장
    const originalContent = cellElement.innerHTML;
    
    // 입력 필드로 교체
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-input';
    input.value = currentValue;
    input.placeholder = getPlaceholderForKey(key);
    
    // 스타일 적용
    input.style.cssText = `
        width: 100%;
        padding: 8px;
        border: 2px solid var(--accent-color);
        border-radius: 4px;
        font-size: 13px;
        box-sizing: border-box;
        background: white;
    `;
    
    cellElement.innerHTML = '';
    cellElement.appendChild(input);
    input.focus();
    input.select();
    
    // Enter 키로 저장
    input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            saveCellValue(buildingIdx, key, input.value, cellElement);
        } else if (e.key === 'Escape') {
            cellElement.innerHTML = originalContent;
        }
    });
    
    // 포커스 잃으면 저장
    input.addEventListener('blur', function() {
        // 약간의 지연을 두어 클릭 이벤트 충돌 방지
        setTimeout(() => {
            if (document.activeElement !== input) {
                saveCellValue(buildingIdx, key, input.value, cellElement);
            }
        }, 100);
    });
};

function getPlaceholderForKey(key) {
    const placeholders = {
        'address': '도로명 주소 입력',
        'addressJibun': '지번 주소 입력',
        'nearestStation': '예: 강남역 도보 5분',
        'floors': '예: 지하 6층 / 지상 20층',
        'completionYear': '예: 2010',
        'exclusiveRate': '예: 55.5',
        'typicalFloorSqm': '면적(m²) 입력',
        'typicalFloorPy': '면적(평) 입력',
        'elevators': '예: 승객 8대, 화물 2대',
        'hvac': '예: 개별냉난방',
        'buildingUse': '예: 업무시설',
        'structure': '예: 철근콘크리트',
        'parkingInfo': '주차 정보 입력',
        'parkingFee': '예: 월 15만원',
        'parkingTotal': '예: 200대'
    };
    return placeholders[key] || '값 입력';
}

function saveCellValue(buildingIdx, key, newValue, cellElement) {
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    if (!building.buildingData) building.buildingData = {};
    
    // 값 저장
    const trimmedValue = newValue.trim();
    building.buildingData[key] = trimmedValue;
    
    // 수식 필드와 연관된 경우 다시 계산 필요
    const needsRecalc = ['typicalFloorSqm', 'typicalFloorPy', 'exclusiveRate', 'dedicatedRate'].includes(key);
    
    if (trimmedValue) {
        cellElement.innerHTML = escapeHtml(trimmedValue);
        showToast('값이 저장되었습니다', 'success');
    } else {
        cellElement.innerHTML = `<span class="placeholder-input" onclick="openCellEditor(${buildingIdx}, '${key}', this.parentElement)">입력 필요</span>`;
    }
    
    // 수식 필드 재계산
    if (needsRecalc) {
        recalculateFormulaCells(buildingIdx);
    }
}

function recalculateFormulaCells(buildingIdx) {
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    const typicalFloorSqm = parseFloat(bd.typicalFloorSqm) || parseFloat(bd.typicalFloorM2) || (parseFloat(bd.typicalFloorPy) || 0) * 3.305785;
    const typicalFloorPy = parseFloat(bd.typicalFloorPy) || 0;
    const exclusiveRate = parseFloat(bd.exclusiveRate) || parseFloat(bd.dedicatedRate) || 0;
    
    // 전용면적 계산
    const exclusiveFloorSqm = typicalFloorSqm * exclusiveRate / 100;
    const exclusiveFloorPy = typicalFloorPy * exclusiveRate / 100;
    
    // 해당 빌딩의 수식 셀 업데이트
    document.querySelectorAll(`td.cell-formula[data-building-idx="${buildingIdx}"]`).forEach(cell => {
        const key = cell.dataset.key;
        let value = '';
        
        if (key === 'exclusiveFloorSqm') {
            if (typicalFloorSqm && exclusiveRate) {
                value = exclusiveFloorSqm.toFixed(2);
            } else if (!typicalFloorSqm && !typicalFloorPy) {
                value = `<span class="placeholder-input" onclick="openCellEditor(${buildingIdx}, 'typicalFloorPy', this.parentElement)">기준층 면적 입력 필요</span>`;
            } else {
                value = `<span class="placeholder-input" onclick="openCellEditor(${buildingIdx}, 'exclusiveRate', this.parentElement)">전용률 입력 필요</span>`;
            }
        } else if (key === 'exclusiveFloorPy') {
            if (typicalFloorPy && exclusiveRate) {
                value = exclusiveFloorPy.toFixed(2);
            } else if (!typicalFloorPy) {
                value = `<span class="placeholder-input" onclick="openCellEditor(${buildingIdx}, 'typicalFloorPy', this.parentElement)">기준층 면적 입력 필요</span>`;
            } else {
                value = `<span class="placeholder-input" onclick="openCellEditor(${buildingIdx}, 'exclusiveRate', this.parentElement)">전용률 입력 필요</span>`;
            }
        }
        
        cell.innerHTML = value;
    });
}

window.closeVacancyModal = function() {
    document.getElementById('vacancyModal').classList.remove('show');
};

window.addVacancyToBuilding = function(buildingId) {
    openVacancyModal(buildingId, -1);
};

window.saveVacancy = async function() {
    const buildingId = document.getElementById('vf_buildingId').value;
    const vacancyIdx = parseInt(document.getElementById('vf_vacancyIndex').value);
    
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const floor = document.getElementById('vf_floor').value.trim();
    
    // 필수값 검증
    if (!floor) {
        showToast('공실층은 필수입니다', 'error');
        return;
    }
    
    const vacancyData = {
        floor,
        moveInDate: document.getElementById('vf_moveInDate').value.trim() || '즉시',
        rentArea: parseFloat(document.getElementById('vf_rentArea').value) || 0,
        exclusiveArea: parseFloat(document.getElementById('vf_exclusiveArea').value) || 0,
        depositPy: parseFloat(document.getElementById('vf_depositPy').value) || 0,
        rentPy: parseFloat(document.getElementById('vf_rentPy').value) || 0,
        maintenancePy: parseFloat(document.getElementById('vf_maintenancePy').value) || 0
    };
    
    if (!building.vacancies) building.vacancies = [];
    
    if (vacancyIdx >= 0 && building.vacancies[vacancyIdx]) {
        // 수정
        building.vacancies[vacancyIdx] = { ...building.vacancies[vacancyIdx], ...vacancyData };
        showToast('공실 정보 수정됨', 'success');
    } else {
        // 추가
        building.vacancies.push(vacancyData);
        showToast('공실 추가됨', 'success');
    }
    
    // 신규 기준가로 저장 옵션 처리
    const saveAsCheckbox = document.getElementById('vf_saveAsPricing');
    if (saveAsCheckbox && saveAsCheckbox.checked) {
        const pricingLabel = document.getElementById('vf_pricingLabel').value.trim() || `${floor} 기준가`;
        const pricingFloorRange = document.getElementById('vf_pricingFloorRange').value.trim() || floor;
        
        // 새 기준가 데이터
        const newPricing = {
            id: 'fp_' + Date.now(),
            label: pricingLabel,
            floorRange: pricingFloorRange,
            depositPy: vacancyData.depositPy,
            rentPy: vacancyData.rentPy,
            maintenancePy: vacancyData.maintenancePy,
            rentArea: vacancyData.rentArea,
            exclusiveArea: vacancyData.exclusiveArea,
            effectiveDate: new Date().toISOString().slice(0, 7), // YYYY-MM
            createdAt: new Date().toISOString(),
            createdBy: pageState.currentUser?.name || pageState.currentUser?.email || 'unknown'
        };
        
        // 빌딩 데이터에 추가
        if (!building.buildingData) building.buildingData = {};
        if (!building.buildingData.floorPricing) building.buildingData.floorPricing = [];
        building.buildingData.floorPricing.push(newPricing);
        
        // Firebase에도 저장
        try {
            const currentPricing = await get(ref(db, `buildings/${buildingId}/floorPricing`));
            const existingPricing = currentPricing.exists() ? currentPricing.val() : [];
            const updatedPricing = Array.isArray(existingPricing) ? [...existingPricing, newPricing] : [newPricing];
            
            await update(ref(db, `buildings/${buildingId}`), {
                floorPricing: updatedPricing,
                updatedAt: new Date().toISOString()
            });
            
            // allBuildings도 업데이트
            const buildingInAll = pageState.allBuildings.find(b => b.id === buildingId);
            if (buildingInAll) {
                if (!buildingInAll.floorPricing) buildingInAll.floorPricing = [];
                buildingInAll.floorPricing.push(newPricing);
            }
            
            showToast(`'${pricingLabel}' 기준가가 저장되었습니다`, 'success');
        } catch (e) {
            console.error('기준가 저장 실패:', e);
            showToast('기준가 저장 실패: ' + e.message, 'error');
        }
    }
    
    closeVacancyModal();
    renderDetailView();
};

// ============================================================
// 이미지 모달
// ============================================================
window.openImageModal = function(buildingId) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const bd = building.buildingData || {};
    const imageUrl = bd.exteriorImage || bd.mainImage || '';
    
    document.getElementById('img_buildingId').value = buildingId;
    document.getElementById('imageModalTitle').textContent = `${building.buildingName} 외관사진`;
    
    const deleteBtn = document.getElementById('deleteImageBtn');
    
    if (imageUrl) {
        document.getElementById('currentBuildingImage').src = imageUrl;
        document.getElementById('currentBuildingImage').style.display = 'block';
        document.getElementById('noImagePlaceholder').style.display = 'none';
        if (deleteBtn) deleteBtn.style.display = 'inline-flex';
    } else {
        document.getElementById('currentBuildingImage').style.display = 'none';
        document.getElementById('noImagePlaceholder').style.display = 'block';
        if (deleteBtn) deleteBtn.style.display = 'none';
    }
    
    document.getElementById('imageUploadModal').classList.add('show');
};

window.closeImageModal = function() {
    document.getElementById('imageUploadModal').classList.remove('show');
};

// 이미지 삭제
window.deleteImage = async function() {
    const buildingId = document.getElementById('img_buildingId').value;
    
    if (!confirm('이미지를 삭제하시겠습니까?')) return;
    
    // 빌딩 데이터에서 이미지 제거
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (building && building.buildingData) {
        delete building.buildingData.exteriorImage;
        delete building.buildingData.mainImage;
    }
    
    // Firebase에서도 삭제
    try {
        await update(ref(db, `buildings/${buildingId}`), {
            exteriorImage: null,
            mainImage: null,
            updatedAt: new Date().toISOString()
        });
        
        showToast('이미지가 삭제되었습니다', 'success');
        closeImageModal();
        renderDetailView();
    } catch (e) {
        console.error('이미지 삭제 실패:', e);
        showToast('이미지 삭제 실패', 'error');
    }
};

window.handleImageUpload = async function(input) {
    const file = input.files[0];
    if (!file) return;
    
    const buildingId = document.getElementById('img_buildingId').value;
    
    // TODO: Firebase Storage에 업로드 구현
    // 현재는 Base64로 임시 처리
    const reader = new FileReader();
    reader.onload = async (e) => {
        const imageData = e.target.result;
        
        // 빌딩 데이터 업데이트
        const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
        if (building) {
            if (!building.buildingData) building.buildingData = {};
            building.buildingData.exteriorImage = imageData;
        }
        
        // Firebase에도 저장 (빌딩 정보 업데이트)
        try {
            await update(ref(db, `buildings/${buildingId}`), {
                exteriorImage: imageData,
                updatedAt: new Date().toISOString()
            });
            
            showToast('이미지 업로드 완료', 'success');
            closeImageModal();
            renderDetailView();
        } catch (e) {
            console.error('이미지 저장 실패:', e);
            showToast('이미지 저장 실패', 'error');
        }
    };
    reader.readAsDataURL(file);
};

// ============================================================
// Comp List 저장 & 다운로드
// ============================================================
// ============================================================
// 빌딩 마스터 데이터 동기화 (complist → buildings 컬렉션)
// ============================================================
async function syncBuildingDataToMaster(buildings) {
    const updatePromises = [];
    
    for (const b of buildings) {
        if (!b.buildingId || !b.buildingData) continue;
        
        // 동기화할 필드만 추출 (편집 가능한 필드)
        const syncFields = {};
        const editableKeys = [
            // 기초정보
            'address', 'nearestStation', 'station', 'completionYear', 'floors', 'scale',
            'grossFloorPy', 'typicalFloorPy', 'exclusiveRate', 'dedicatedRate', 'landArea',
            // 채권분석
            'owner', 'bondStatus', 'jointCollateral', 'seniorLien', 
            'collateralRatio', 'officialLandPrice', 'landPriceApplied',
            // 주차현황
            'parkingTotal', 'parkingInfo', 'freeParkingCondition', 'paidParking', 'parkingFee',
            // 기타
            'floorPlan', 'remarks', 'exteriorImage', 'mainImage', 'description',
            // 시설 정보
            'buildingUse', 'usage', 'structure', 'hvac', 'heatingCooling', 'elevators', 'elevator'
        ];
        
        for (const key of editableKeys) {
            const value = b.buildingData[key];
            if (value !== undefined && value !== null && value !== '') {
                syncFields[key] = value;
            }
        }
        
        // 변경된 필드가 있으면 업데이트
        if (Object.keys(syncFields).length > 0) {
            // 업데이트 로그 기록
            syncFields.lastUpdatedFrom = 'complist';
            syncFields.lastUpdatedAt = new Date().toISOString();
            syncFields.lastUpdatedBy = pageState.currentUser?.email || 'unknown';
            
            updatePromises.push(
                update(ref(db, `buildings/${b.buildingId}`), syncFields)
            );
        }
    }
    
    if (updatePromises.length > 0) {
        await Promise.all(updatePromises);
        console.log(`${updatePromises.length}개 빌딩 마스터 데이터 동기화 완료`);
        return updatePromises.length;
    }
    return 0;
}

window.saveCompList = async function(syncToMaster = false) {
    const title = document.getElementById('detailTitle').value.trim();
    if (!title) {
        showToast('제목을 입력하세요', 'error');
        return;
    }
    
    pageState.editData.title = title;
    pageState.editData.updatedAt = new Date().toISOString();
    pageState.editData.updatedBy = {
        id: pageState.currentUser?.id,
        name: pageState.currentUser?.name,
        email: pageState.currentUser?.email
    };
    
    try {
        // ※ 수정: buildingData 포함하여 저장 (편집된 빌딩 정보 유지)
        // ※ 수정: undefined 방지 - Firebase는 undefined 저장 불가
        const saveData = {
            ...pageState.editData,
            buildings: pageState.editData.buildings.map(b => ({
                buildingId: b.buildingId || '',
                buildingName: b.buildingName || '',
                buildingData: b.buildingData || {},
                vacancies: b.vacancies || [],
                addedAt: b.addedAt || new Date().toISOString()
            }))
        };
        
        if (pageState.editData.id) {
            // 기존 항목 업데이트
            await update(ref(db, `compLists/${pageState.editData.id}`), saveData);
        } else {
            // 새 항목 생성
            const newRef = push(ref(db, 'compLists'));
            saveData.id = newRef.key;
            saveData.createdAt = new Date().toISOString();
            saveData.createdBy = saveData.updatedBy;
            await set(newRef, saveData);
            pageState.editData.id = newRef.key;
        }
        
        // 빌딩 마스터 데이터 동기화 (옵션)
        if (syncToMaster) {
            const syncCount = await syncBuildingDataToMaster(pageState.editData.buildings);
            if (syncCount > 0) {
                showToast(`저장 완료 (${syncCount}개 빌딩 정보 동기화됨)`, 'success');
            } else {
                showToast('저장 완료 (동기화할 변경사항 없음)', 'success');
            }
        } else {
            showToast('저장 완료', 'success');
        }
        
        await loadCompLists();
        
    } catch (e) {
        console.error('저장 실패:', e);
        showToast('저장 실패: ' + e.message, 'error');
    }
};

window.setCompListType = function(type) {
    pageState.editData.type = type;
    
    document.querySelectorAll('.type-selector .type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
    });
    
    renderDetailView();
};

// ============================================================
// 임시저장 (로컬 스토리지)
// ============================================================
window.saveDraft = function() {
    const title = document.getElementById('detailTitle').value.trim();
    if (!title) {
        showToast('제목을 입력하세요', 'warning');
        return;
    }
    
    pageState.editData.title = title;
    pageState.editData.draftSavedAt = new Date().toISOString();
    
    const draftData = {
        ...pageState.editData,
        buildings: pageState.editData.buildings.map(b => ({
            buildingId: b.buildingId || '',
            buildingName: b.buildingName || '',
            vacancies: b.vacancies || [],
            buildingData: b.buildingData || {},
            addedAt: b.addedAt || new Date().toISOString()
        }))
    };
    
    // 임시저장 키 생성 (기존 ID 있으면 사용, 없으면 새로 생성)
    const draftKey = pageState.editData.id ? `complist_draft_${pageState.editData.id}` : `complist_draft_new_${Date.now()}`;
    
    try {
        // 기존 임시저장 목록 가져오기
        let draftList = JSON.parse(localStorage.getItem('complist_drafts') || '[]');
        
        // 같은 ID의 기존 임시저장 제거
        draftList = draftList.filter(d => d.key !== draftKey);
        
        // 새 임시저장 추가
        draftList.unshift({
            key: draftKey,
            title: title,
            type: pageState.editData.type,
            savedAt: new Date().toISOString(),
            buildingCount: pageState.editData.buildings?.length || 0
        });
        
        // 최대 10개까지만 유지
        if (draftList.length > 10) {
            const removed = draftList.splice(10);
            removed.forEach(d => localStorage.removeItem(d.key));
        }
        
        // 저장
        localStorage.setItem('complist_drafts', JSON.stringify(draftList));
        localStorage.setItem(draftKey, JSON.stringify(draftData));
        
        showToast('📋 임시저장 완료', 'success');
        
        // 임시저장 키 기억
        pageState.currentDraftKey = draftKey;
        
    } catch (e) {
        console.error('임시저장 실패:', e);
        showToast('임시저장 실패: 저장 공간 부족', 'error');
    }
};

// 임시저장 불러오기
window.loadDraft = function(draftKey) {
    try {
        const draftData = JSON.parse(localStorage.getItem(draftKey));
        if (!draftData) {
            showToast('임시저장 데이터를 찾을 수 없습니다', 'error');
            return;
        }
        
        pageState.editData = draftData;
        pageState.selectedCompList = draftData;
        pageState.currentDraftKey = draftKey;
        
        document.querySelector('.detail-panel').classList.add('active');
        renderDetailView();
        
        showToast('임시저장을 불러왔습니다', 'success');
        closeDraftListModal();
        
    } catch (e) {
        console.error('임시저장 불러오기 실패:', e);
        showToast('임시저장 불러오기 실패', 'error');
    }
};

// 임시저장 삭제
window.deleteDraft = function(draftKey, event) {
    event.stopPropagation();
    
    if (!confirm('임시저장을 삭제하시겠습니까?')) return;
    
    try {
        // 목록에서 제거
        let draftList = JSON.parse(localStorage.getItem('complist_drafts') || '[]');
        draftList = draftList.filter(d => d.key !== draftKey);
        localStorage.setItem('complist_drafts', JSON.stringify(draftList));
        
        // 데이터 삭제
        localStorage.removeItem(draftKey);
        
        showToast('임시저장이 삭제되었습니다', 'success');
        
        // 목록 새로고침
        renderDraftList();
        
    } catch (e) {
        console.error('임시저장 삭제 실패:', e);
    }
};

// 임시저장 목록 표시
window.showDraftList = function() {
    const draftList = JSON.parse(localStorage.getItem('complist_drafts') || '[]');
    
    if (draftList.length === 0) {
        showToast('임시저장된 항목이 없습니다', 'info');
        return;
    }
    
    // 모달이 없으면 생성
    let modal = document.getElementById('draftListModal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'draftListModal';
        modal.className = 'modal-overlay';
        modal.onclick = function(e) { if (e.target === this) closeDraftListModal(); };
        modal.innerHTML = `
            <div class="modal-content" style="max-width:500px;">
                <div class="modal-header">
                    <h3>📋 임시저장 목록</h3>
                    <button class="modal-close" onclick="closeDraftListModal()">×</button>
                </div>
                <div class="modal-body" id="draftListContent">
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeDraftListModal()">닫기</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }
    
    renderDraftList();
    modal.classList.add('show');
};

window.closeDraftListModal = function() {
    const modal = document.getElementById('draftListModal');
    if (modal) modal.classList.remove('show');
};

function renderDraftList() {
    const draftList = JSON.parse(localStorage.getItem('complist_drafts') || '[]');
    const container = document.getElementById('draftListContent');
    
    if (!container) return;
    
    if (draftList.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#666; padding:20px;">임시저장된 항목이 없습니다</p>';
        return;
    }
    
    container.innerHTML = draftList.map(d => `
        <div class="draft-item" onclick="loadDraft('${d.key}')" style="
            padding: 12px 16px;
            border: 1px solid #e2e8f0;
            margin-bottom: 8px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background 0.15s;
        " onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
            <div>
                <div style="font-weight:600; margin-bottom:4px;">${d.title}</div>
                <div style="font-size:12px; color:#64748b;">
                    ${d.type === 'lg' ? 'LG그룹용' : '일반용'} · ${d.buildingCount}개 빌딩 · ${formatDate(d.savedAt)}
                </div>
            </div>
            <button onclick="deleteDraft('${d.key}', event)" style="
                padding: 6px 10px;
                background: #fef2f2;
                border: none;
                border-radius: 4px;
                color: #dc2626;
                font-size: 12px;
                cursor: pointer;
            ">🗑️</button>
        </div>
    `).join('');
}

// ============================================================
// 새 Comp List 마법사
// ============================================================
window.openNewCompListWizard = function() {
    document.getElementById('newCompListTitle').value = '';
    pageState.newCompListType = 'general';
    
    document.querySelectorAll('.type-buttons .type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === 'general');
    });
    
    document.getElementById('newCompListModal').classList.add('show');
};

window.closeNewCompListWizard = function() {
    document.getElementById('newCompListModal').classList.remove('show');
};

window.selectNewType = function(type) {
    pageState.newCompListType = type;
    document.querySelectorAll('.type-buttons .type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.type === type);
    });
};

window.createNewCompList = async function() {
    const title = document.getElementById('newCompListTitle').value.trim();
    if (!title) {
        showToast('제목을 입력하세요', 'error');
        return;
    }
    
    const newCompList = {
        title,
        type: pageState.newCompListType,
        status: 'draft',
        buildings: [],
        createdAt: new Date().toISOString(),
        createdBy: {
            id: pageState.currentUser?.id,
            name: pageState.currentUser?.name,
            email: pageState.currentUser?.email
        }
    };
    
    try {
        const newRef = push(ref(db, 'compLists'));
        newCompList.id = newRef.key;
        await set(newRef, newCompList);
        
        closeNewCompListWizard();
        showToast('새 Comp List 생성됨', 'success');
        
        await loadCompLists();
        selectCompList(newRef.key);
        
    } catch (e) {
        console.error('생성 실패:', e);
        showToast('생성 실패: ' + e.message, 'error');
    }
};

// ============================================================
// 엑셀 다운로드
// ============================================================
window.downloadCompListExcel = async function() {
    const data = pageState.editData;
    
    if (!data.buildings || data.buildings.length === 0) {
        showToast('다운로드할 빌딩이 없습니다', 'warning');
        return;
    }
    
    // 빌딩 데이터 보강
    const buildingsWithData = data.buildings.map(b => {
        const fullBuilding = pageState.allBuildings.find(ab => ab.id === b.buildingId);
        return {
            ...b,
            buildingData: fullBuilding || b.buildingData || {}
        };
    });
    
    if (data.type === 'lg') {
        await downloadExcelLG({ ...data, buildings: buildingsWithData });
    } else {
        await downloadExcelGeneral({ ...data, buildings: buildingsWithData });
    }
};

// 일반용 엑셀 다운로드
async function downloadExcelGeneral(data) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('후보지');
    const buildings = data.buildings || [];
    
    // 열 문자 변환
    const getCol = (n) => {
        let s = '';
        while (n > 0) {
            let m = (n - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            n = Math.floor((n - 1) / 26);
        }
        return s;
    };
    
    // 빌딩+공실 평탄화
    const entries = [];
    buildings.forEach(b => {
        const vacancies = b.vacancies || [];
        if (vacancies.length === 0) {
            entries.push({ building: b, vacancy: null });
        } else {
            vacancies.forEach(v => entries.push({ building: b, vacancy: v }));
        }
    });
    
    if (entries.length === 0) {
        showToast('다운로드할 데이터가 없습니다', 'warning');
        return;
    }
    
    // 열 너비
    const colWidth = entries.length <= 5 ? 26 : (entries.length <= 10 ? 22 : 18);
    sheet.columns = [
        { width: 3 }, { width: 13 }, { width: 25 },
        ...entries.map(() => ({ width: colWidth }))
    ];
    
    // 헬퍼 함수
    const setCell = (ref, value, opts = {}) => {
        const cell = sheet.getCell(ref);
        cell.value = value;
        cell.font = { name: 'Noto Sans KR', size: 9, ...opts.font };
        cell.alignment = { horizontal: opts.align || 'center', vertical: 'middle', wrapText: true };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
        if (opts.numFmt) cell.numFmt = opts.numFmt;
    };
    
    const setFormula = (ref, formula, numFmt) => {
        const cell = sheet.getCell(ref);
        cell.value = { formula };
        cell.font = { name: 'Noto Sans KR', size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        if (numFmt) cell.numFmt = numFmt;
    };
    
    // 헤더
    sheet.mergeCells('B3:C4');
    setCell('B3', 'PRESENT TO :', { fill: 'FF2C2A2A', font: { color: { argb: 'FFFFFFFF' }, bold: true } });
    
    // 빌딩 헤더
    entries.forEach((e, i) => {
        const col = getCol(4 + i);
        const floorInfo = e.vacancy?.floor ? ` (${e.vacancy.floor})` : '';
        setCell(`${col}4`, e.building.buildingName + floorInfo, { fill: 'FFCCCCCC', font: { bold: true } });
    });
    
    // 외관사진 행 (행 5-6)
    sheet.getRow(5).height = 15;
    sheet.getRow(6).height = 100; // 외관사진 높이
    sheet.mergeCells('B5:C6');
    setCell('B5', '외관사진', { fill: 'FFE0F2FE', font: { bold: true } });
    
    // 이미지 삽입
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const col = getCol(4 + i);
        const bd = e.building.buildingData || {};
        const imageUrl = bd.exteriorImage || bd.mainImage || '';
        
        // 셀 병합 (행 5-6)
        sheet.mergeCells(`${col}5:${col}6`);
        
        if (imageUrl) {
            try {
                // Base64 이미지인 경우
                if (imageUrl.startsWith('data:image')) {
                    const base64Data = imageUrl.split(',')[1];
                    const extension = imageUrl.includes('png') ? 'png' : 'jpeg';
                    const imageId = workbook.addImage({
                        base64: base64Data,
                        extension: extension
                    });
                    
                    // 이미지를 셀에 맞춰서 삽입 (tl: top-left, br: bottom-right)
                    sheet.addImage(imageId, {
                        tl: { col: 3 + i, row: 4 }, // 0-indexed, 행5 = row 4
                        br: { col: 4 + i, row: 6 },  // 행6까지
                        editAs: 'oneCell'
                    });
                } else {
                    // URL인 경우 - 셀에 "이미지 URL" 표시
                    setCell(`${col}5`, '이미지 있음');
                }
            } catch (imgErr) {
                console.error('이미지 삽입 실패:', imgErr);
                setCell(`${col}5`, '-');
            }
        } else {
            setCell(`${col}5`, '-');
        }
    }
    
    // 카테고리 라벨
    const categories = [
        { row: 7, label: '빌딩 현황', fill: 'FFFFFFFF', rowspan: 12 },
        { row: 19, label: '빌딩 세부현황', fill: 'FFFFFFFF', rowspan: 2 },
        { row: 21, label: '주차 관련', fill: 'FFFFFFFF', rowspan: 3 },
        { row: 25, label: '임차 제안', fill: 'FFF9D6AE', rowspan: 7 },
        { row: 32, label: '임대 기준', fill: 'FFD9ECF2', rowspan: 8 },
        { row: 40, label: '임대기준 조정', fill: 'FFD9ECF2', rowspan: 5 },
        { row: 46, label: '예상비용', fill: 'FFFBCF3A', rowspan: 5 }
    ];
    
    // C열 항목명
    const cLabels = {
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
    
    Object.entries(cLabels).forEach(([row, label]) => {
        setCell(`C${row}`, label);
    });
    
    // 빌딩 데이터
    entries.forEach((e, i) => {
        const col = getCol(4 + i);
        const bd = e.building.buildingData || {};
        const v = e.vacancy || {};
        
        // 빌딩 현황
        setCell(`${col}7`, bd.addressJibun || bd.address || '');
        setCell(`${col}8`, bd.address || '');
        setCell(`${col}9`, bd.nearestStation || bd.station || '');
        setCell(`${col}10`, bd.scale || bd.floors || '');
        setCell(`${col}11`, bd.completionYear || '');
        
        const rate = bd.dedicatedRate || bd.exclusiveRate || 0;
        setCell(`${col}12`, rate ? rate / 100 : '', { numFmt: '0.00%' });
        
        const floorM2 = bd.typicalFloorM2 || (bd.typicalFloorPy ? bd.typicalFloorPy * 3.305785 : 0);
        const floorPy = bd.typicalFloorPy || 0;
        setCell(`${col}13`, floorM2 || '', { numFmt: '#,##0.000' });
        setCell(`${col}14`, floorPy || '', { numFmt: '#,##0.000' });
        setCell(`${col}15`, floorM2 * (rate / 100) || '', { numFmt: '#,##0.000' });
        setCell(`${col}16`, floorPy * (rate / 100) || '', { numFmt: '#,##0.000' });
        
        setCell(`${col}17`, bd.elevators || bd.elevator || '');
        setCell(`${col}18`, bd.hvac || bd.heatingCooling || '');
        setCell(`${col}19`, bd.buildingUse || bd.usage || '');
        setCell(`${col}20`, bd.structure || '');
        setCell(`${col}21`, bd.parkingInfo || bd.parking || '');
        setCell(`${col}22`, bd.parkingFee || '');
        setCell(`${col}23`, bd.parkingTotal || bd.parkingSpaces || '');
        
        // 임차 제안
        setCell(`${col}25`, v.floor || '-');
        setCell(`${col}26`, v.moveInDate || v.moveIn || '-');
        setCell(`${col}27`, '-');
        
        const rentAreaPy = parseFloat(v.rentArea) || 100;
        const exclusiveAreaPy = parseFloat(v.exclusiveArea) || 50;
        setFormula(`${col}28`, `ROUNDDOWN(${col}30*3.305785,3)`, '#,##0.000');
        setFormula(`${col}29`, `ROUNDDOWN(${col}31*3.305785,3)`, '#,##0.000');
        setCell(`${col}30`, rentAreaPy, { numFmt: '#,##0.000' });
        setCell(`${col}31`, exclusiveAreaPy, { numFmt: '#,##0.000' });
        
        // 임대 기준
        const depositPy = parseFloat(v.depositPy) || 0;
        const rentPy = parseFloat(v.rentPy) || 0;
        const maintenancePy = parseFloat(v.maintenancePy) || 0;
        
        setCell(`${col}32`, depositPy ? depositPy * 10000 : '', { numFmt: '₩#,##0' });
        setCell(`${col}33`, rentPy ? rentPy * 10000 : '', { numFmt: '₩#,##0' });
        setCell(`${col}34`, maintenancePy ? maintenancePy * 10000 : '', { numFmt: '₩#,##0' });
        setFormula(`${col}35`, `${col}33+${col}34`, '₩#,##0');
        setFormula(`${col}36`, `${col}32*${col}30`, '₩#,##0');
        setFormula(`${col}37`, `${col}33*${col}30`, '₩#,##0');
        setFormula(`${col}38`, `${col}34*${col}30`, '₩#,##0');
        setFormula(`${col}39`, `IFERROR((${col}37+${col}38)/${col}31,0)`, '₩#,##0');
        
        // 임대기준 조정
        setFormula(`${col}40`, `${col}32`, '₩#,##0');
        setCell(`${col}41`, 0);
        setFormula(`${col}42`, `${col}33-((${col}33*${col}41)/12)`, '₩#,##0');
        setFormula(`${col}43`, `${col}34`, '₩#,##0');
        setFormula(`${col}44`, `IFERROR(((${col}42+${col}43)*(${col}30/${col}31)),0)`, '₩#,##0');
        
        // 예상비용
        setFormula(`${col}46`, `${col}40*${col}30`, '₩#,##0');
        setFormula(`${col}47`, `${col}42*${col}30`, '₩#,##0');
        setFormula(`${col}48`, `${col}43*${col}30`, '₩#,##0');
        setFormula(`${col}49`, `${col}47+${col}48`, '₩#,##0');
        setFormula(`${col}50`, `${col}49*12`, '₩#,##0');
    });
    
    // 다운로드
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CompList_${data.title || '후보지'}_${new Date().toISOString().slice(0,10)}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('✅ 엑셀 다운로드 완료', 'success');
}

// LG용 엑셀 다운로드
async function downloadExcelLG(data) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('COMP');
    const buildings = data.buildings || [];
    
    // 열 문자 계산 헬퍼
    const getCol = (n) => {
        let s = '';
        while (n > 0) {
            let m = (n - 1) % 26;
            s = String.fromCharCode(65 + m) + s;
            n = Math.floor((n - 1) / 26);
        }
        return s;
    };
    
    // 빌딩당 3열 (E-G, H-J, K-M, ...)
    const getBuildingCols = (bIdx) => ({
        col1: getCol(5 + bIdx * 3),
        col2: getCol(6 + bIdx * 3),
        col3: getCol(7 + bIdx * 3)
    });
    
    // 열 너비
    sheet.columns = [
        { width: 9.375 }, { width: 4.5 }, { width: 9.375 }, { width: 13 },
        ...buildings.flatMap(() => [{ width: 12 }, { width: 12 }, { width: 12 }])
    ];
    
    const lastCol = getCol(4 + buildings.length * 3);
    
    // 셀 스타일 헬퍼
    const setCell = (ref, value, opts = {}) => {
        const cell = sheet.getCell(ref);
        cell.value = value;
        cell.font = { name: 'Noto Sans KR', size: 9, ...opts.font };
        cell.alignment = { horizontal: opts.align || 'center', vertical: 'middle', wrapText: true };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        if (opts.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } };
        if (opts.numFmt) cell.numFmt = opts.numFmt;
    };
    
    const setFormula = (ref, formula, numFmt) => {
        const cell = sheet.getCell(ref);
        cell.value = { formula };
        cell.font = { name: 'Noto Sans KR', size: 9 };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
        if (numFmt) cell.numFmt = numFmt;
    };
    
    const buildingNames = buildings.map(b => b.buildingName).join(', ');
    
    // ========================================
    // 행 1: 헤더
    // ========================================
    sheet.mergeCells(`A1:${lastCol}1`);
    sheet.getCell('A1').value = `임차제안: ${buildingNames}`;
    sheet.getCell('A1').font = { name: 'Noto Sans KR', size: 14, bold: true };
    sheet.getCell('A1').alignment = { horizontal: 'left', vertical: 'middle' };
    sheet.getRow(1).height = 25;
    
    // ========================================
    // 행 2-4: 조건 요약 (텍스트 입력용)
    // ========================================
    sheet.mergeCells(`A2:${lastCol}2`);
    setCell('A2', '- 규모: 전용 0000PY 이상', { align: 'left' });
    
    sheet.mergeCells(`A3:${lastCol}3`);
    setCell('A3', '- 계약기간: 2025.00.00~2025.00.00', { align: 'left' });
    
    sheet.mergeCells(`A4:${lastCol}4`);
    setCell('A4', '- 위치: 0000역 인근', { align: 'left' });
    
    // ========================================
    // 행 6: 위치/빌딩명
    // ========================================
    sheet.mergeCells('A6:D6');
    setCell('A6', '위치', { fill: 'FFE0F2FE', font: { bold: true } });
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        sheet.mergeCells(`${col1}6:${col3}6`);
        setCell(`${col1}6`, b.buildingName, { fill: 'FFF5D0FE', font: { bold: true, size: 11 } });
    });
    
    // ========================================
    // 행 7-8: 제안 (빈 공간)
    // ========================================
    sheet.mergeCells('A7:D8');
    setCell('A7', '제안', { fill: 'FFE0F2FE', font: { bold: true } });
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        sheet.mergeCells(`${col1}7:${col3}7`);
        setCell(`${col1}7`, '');
        sheet.mergeCells(`${col1}8:${col3}8`);
        setCell(`${col1}8`, '');
    });
    
    // ========================================
    // 행 9-17: 건물 외관 (이미지)
    // ========================================
    sheet.mergeCells('A9:D17');
    setCell('A9', '건물 외관', { fill: 'FFE0F2FE', font: { bold: true } });
    
    for (let r = 9; r <= 17; r++) {
        sheet.getRow(r).height = 18;
    }
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        const bd = b.buildingData || {};
        
        sheet.mergeCells(`${col1}9:${col3}17`);
        const imageUrl = bd.exteriorImage || bd.mainImage || '';
        
        if (imageUrl && imageUrl.startsWith('data:image')) {
            try {
                const base64Data = imageUrl.split(',')[1];
                const extension = imageUrl.includes('png') ? 'png' : 'jpeg';
                const imageId = workbook.addImage({ base64: base64Data, extension });
                sheet.addImage(imageId, {
                    tl: { col: 4 + bIdx * 3, row: 8 },
                    br: { col: 7 + bIdx * 3, row: 17 },
                    editAs: 'oneCell'
                });
            } catch (e) {
                setCell(`${col1}9`, '-');
            }
        } else {
            setCell(`${col1}9`, imageUrl ? '이미지 있음' : '-');
        }
    });
    
    // ========================================
    // 행 18-25: 기초정보 (8개 항목)
    // ========================================
    const infoRows = [
        { row: 18, label: '주   소', key: 'address' },
        { row: 19, label: '위   치', key: 'nearestStation', altKey: 'station' },
        { row: 20, label: '준공일', key: 'completionYear' },
        { row: 21, label: '규  모', key: 'floors', altKey: 'scale' },
        { row: 22, label: '연면적', key: 'grossFloorPy', suffix: '평' },
        { row: 23, label: '기준층 전용면적', key: 'typicalFloorPy', suffix: '평' },
        { row: 24, label: '전용률', key: 'exclusiveRate', format: 'percent' },
        { row: 25, label: '대지면적', key: 'landArea', suffix: '평' }
    ];
    
    sheet.mergeCells('A18:A25');
    setCell('A18', '기초\n정보', { fill: 'FFE0F2FE', font: { bold: true } });
    
    infoRows.forEach(info => {
        sheet.mergeCells(`B${info.row}:D${info.row}`);
        setCell(`B${info.row}`, info.label, { fill: 'FFF8FAFC' });
        
        buildings.forEach((b, bIdx) => {
            const { col1, col3 } = getBuildingCols(bIdx);
            const bd = b.buildingData || {};
            
            let value = bd[info.key] || (info.altKey ? bd[info.altKey] : '') || '';
            if (info.format === 'percent' && value) {
                const numVal = parseFloat(value);
                value = numVal ? (numVal > 1 ? numVal.toFixed(2) + '%' : (numVal * 100).toFixed(2) + '%') : value;
            }
            if (info.suffix && value && !String(value).includes(info.suffix)) {
                value = value + info.suffix;
            }
            
            sheet.mergeCells(`${col1}${info.row}:${col3}${info.row}`);
            setCell(`${col1}${info.row}`, value || '-');
        });
    });
    
    // ========================================
    // 행 26-32: 채권분석 (7개 항목) - 텍스트 입력용
    // ========================================
    const bondRows = [
        { row: 26, label: '소유자 (임대인)', key: 'owner' },
        { row: 27, label: '채권담보 설정여부', key: 'bondStatus' },
        { row: 28, label: '공동담보 총 대지지분', key: 'jointCollateral' },
        { row: 29, label: '선순위 담보 총액', key: 'seniorLien' },
        { row: 30, label: '공시지가 대비 담보율', key: 'collateralRatio' },
        { row: 31, label: '개별공시지가(25년 1월 기준)', key: 'officialLandPrice' },
        { row: 32, label: '토지가격 적용', key: 'landPriceApplied' }
    ];
    
    sheet.mergeCells('A26:A32');
    setCell('A26', '채권\n분석', { fill: 'FFFEF3C7', font: { bold: true } });
    
    bondRows.forEach(info => {
        sheet.mergeCells(`B${info.row}:D${info.row}`);
        setCell(`B${info.row}`, info.label, { fill: 'FFF8FAFC' });
        
        buildings.forEach((b, bIdx) => {
            const { col1, col3 } = getBuildingCols(bIdx);
            const bd = b.buildingData || {};
            
            sheet.mergeCells(`${col1}${info.row}:${col3}${info.row}`);
            setCell(`${col1}${info.row}`, bd[info.key] || '', { fill: 'FFFFFBEB' });
        });
    });
    
    // ========================================
    // 행 33-39: 현재 공실 (헤더 + 5공실 + 소계)
    // ========================================
    sheet.mergeCells('A33:D39');
    setCell('A33', '현재 공실', { fill: 'FFDBEAFE', font: { bold: true } });
    
    // 공실 헤더 (행 33)
    buildings.forEach((b, bIdx) => {
        const { col1, col2, col3 } = getBuildingCols(bIdx);
        setCell(`${col1}33`, '층', { fill: 'FFD1D5DB', font: { bold: true } });
        setCell(`${col2}33`, '전용', { fill: 'FFD1D5DB', font: { bold: true } });
        setCell(`${col3}33`, '임대', { fill: 'FFD1D5DB', font: { bold: true } });
    });
    
    // 공실 데이터 (행 34-38)
    for (let i = 0; i < 5; i++) {
        const row = 34 + i;
        buildings.forEach((b, bIdx) => {
            const { col1, col2, col3 } = getBuildingCols(bIdx);
            const v = (b.vacancies || [])[i];
            
            if (v) {
                setCell(`${col1}${row}`, v.floor || '');
                setCell(`${col2}${row}`, parseFloat(v.exclusiveArea) || '', { numFmt: '#,##0.00' });
                setCell(`${col3}${row}`, parseFloat(v.rentArea) || '', { numFmt: '#,##0.00' });
            } else {
                setCell(`${col1}${row}`, '');
                setCell(`${col2}${row}`, '');
                setCell(`${col3}${row}`, '');
            }
        });
    }
    
    // 소계 (행 39)
    buildings.forEach((b, bIdx) => {
        const { col1, col2, col3 } = getBuildingCols(bIdx);
        setCell(`${col1}39`, '소계', { font: { bold: true } });
        setFormula(`${col2}39`, `SUM(${col2}34:${col2}38)`, '#,##0.00');
        setFormula(`${col3}39`, `SUM(${col3}34:${col3}38)`, '#,##0.00');
    });
    
    // ========================================
    // 행 40-44: 제안 (5개 항목)
    // ========================================
    sheet.mergeCells('A40:A44');
    setCell('A40', '제안', { fill: 'FFFCE7F3', font: { bold: true } });
    
    const proposalRows = [
        { row: 40, label: '계약기간', defaultValue: '5년' },
        { row: 41, label: '입주가능 시기', key: 'moveInDate', defaultValue: '즉시' },
        { row: 42, label: '제안 층', key: 'floor' },
        { row: 43, label: '전용면적', formula: true },
        { row: 44, label: '임대면적', formula: true }
    ];
    
    proposalRows.forEach(info => {
        sheet.mergeCells(`B${info.row}:D${info.row}`);
        setCell(`B${info.row}`, info.label);
        
        buildings.forEach((b, bIdx) => {
            const { col1, col2, col3 } = getBuildingCols(bIdx);
            const v0 = (b.vacancies || [])[0] || {};
            
            sheet.mergeCells(`${col1}${info.row}:${col3}${info.row}`);
            
            if (info.formula) {
                if (info.row === 43) {
                    setFormula(`${col1}${info.row}`, `${col2}34`, '#,##0.00');
                } else if (info.row === 44) {
                    setFormula(`${col1}${info.row}`, `${col3}34`, '#,##0.00');
                }
            } else {
                const value = v0[info.key] || info.defaultValue || '';
                setCell(`${col1}${info.row}`, value);
            }
        });
    });
    
    // ========================================
    // 행 45-47: 기준층 임대기준 (3개)
    // ========================================
    sheet.mergeCells('A45:A47');
    setCell('A45', '기준층\n임대기준', { fill: 'FFFCE7F3', font: { bold: true } });
    
    const rentBaseRows = [
        { row: 45, label: '보증금', key: 'depositPy', defaultValue: 75 },
        { row: 46, label: '임대료', key: 'rentPy', defaultValue: 7.5 },
        { row: 47, label: '관리비', key: 'maintenancePy', defaultValue: 3.7 }
    ];
    
    rentBaseRows.forEach(info => {
        sheet.mergeCells(`B${info.row}:D${info.row}`);
        setCell(`B${info.row}`, info.label);
        
        buildings.forEach((b, bIdx) => {
            const { col1, col3 } = getBuildingCols(bIdx);
            const v0 = (b.vacancies || [])[0] || {};
            
            sheet.mergeCells(`${col1}${info.row}:${col3}${info.row}`);
            const value = parseFloat(v0[info.key]) || info.defaultValue;
            setCell(`${col1}${info.row}`, value, { fill: 'FFFFF2CC', numFmt: '#,##0.0' });
        });
    });
    
    // ========================================
    // 행 48-49: 실질 임대기준 (2개)
    // ========================================
    sheet.mergeCells('A48:A49');
    setCell('A48', '실질\n임대기준', { fill: 'FFFCE7F3', font: { bold: true } });
    
    // 행 48: 실질 임대료(RF만 반영)
    sheet.mergeCells('B48:D48');
    setCell('B48', '실질 임대료(RF만 반영)');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        sheet.mergeCells(`${col1}48:${col3}48`);
        setFormula(`${col1}48`, `${col1}46*(12-${col1}49)/12`, '#,##0.00');
    });
    
    // 행 49: 연간 무상임대 (R.F)
    sheet.mergeCells('B49:D49');
    setCell('B49', '연간 무상임대 (R.F)');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        const v0 = (b.vacancies || [])[0] || {};
        sheet.mergeCells(`${col1}49:${col3}49`);
        setCell(`${col1}49`, parseFloat(v0.rentFree) || 0, { fill: 'FFFFF2CC' });
    });
    
    // ========================================
    // 행 50-55: 비용검토 (6개 항목)
    // ========================================
    sheet.mergeCells('A50:A55');
    setCell('A50', '비용검토', { fill: 'FFFEF3C7', font: { bold: true } });
    
    // ※ 수정: 만원/평 × 평 = 만원 → 원 환산을 위해 ×10000 추가
    const costRows = [
        { row: 50, label: '보증금', formula: (c1) => `${c1}45*${c1}44*10000` },
        { row: 51, label: '월 임대료', formula: (c1) => `${c1}46*${c1}44*10000` },
        { row: 52, label: '월 관리비', formula: (c1) => `${c1}47*${c1}44*10000` },
        { row: 53, label: '관리비 내역', text: '냉난방비 별도' },
        { row: 54, label: '월납부액', formula: (c1) => `${c1}51+${c1}52` },
        { row: 55, label: '(21개월 기준) 총 납부 비용', formula: (c1) => `${c1}54*21` }
    ];
    
    costRows.forEach(info => {
        sheet.mergeCells(`B${info.row}:D${info.row}`);
        setCell(`B${info.row}`, info.label);
        
        buildings.forEach((b, bIdx) => {
            const { col1, col3 } = getBuildingCols(bIdx);
            sheet.mergeCells(`${col1}${info.row}:${col3}${info.row}`);
            
            if (info.formula) {
                setFormula(`${col1}${info.row}`, info.formula(col1), '#,##0');
            } else {
                setCell(`${col1}${info.row}`, info.text || '');
            }
        });
    });
    
    // ========================================
    // 행 56-58: 공사기간 FAVOR (3행)
    // ========================================
    sheet.mergeCells('A56:A58');
    setCell('A56', '공사기간\nFAVOR', { fill: 'FFE0E7FF', font: { bold: true } });
    
    // 행 56: 인테리어 기간 (F.O)
    sheet.mergeCells('B56:D56');
    setCell('B56', '인테리어 기간 (F.O)');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        const v0 = (b.vacancies || [])[0] || {};
        sheet.mergeCells(`${col1}56:${col3}56`);
        setCell(`${col1}56`, v0.fitoutPeriod || '미제공', { fill: 'FFFFFBEB' });
    });
    
    // 행 57-58: 인테리어지원금 (T.I)
    sheet.mergeCells('B57:D58');
    setCell('B57', '인테리어지원금 (T.I)');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        const v0 = (b.vacancies || [])[0] || {};
        sheet.mergeCells(`${col1}57:${col3}58`);
        setCell(`${col1}57`, v0.tiSupport || '미제공', { fill: 'FFFFFBEB' });
    });
    
    // ========================================
    // 행 59-62: 주차현황 (4개 항목)
    // ========================================
    sheet.mergeCells('A59:A62');
    setCell('A59', '주차현황', { fill: 'FFFBCFE8', font: { bold: true } });
    
    // 행 59: 총 주차대수
    sheet.mergeCells('B59:D59');
    setCell('B59', '총 주차대수');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        const bd = b.buildingData || {};
        sheet.mergeCells(`${col1}59:${col3}59`);
        setCell(`${col1}59`, bd.parkingTotal || bd.parkingInfo || '-');
    });
    
    // 행 60: 무료주차 조건(임대면적)
    sheet.mergeCells('B60:D60');
    setCell('B60', '무료주차 조건(임대면적)');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        const bd = b.buildingData || {};
        sheet.mergeCells(`${col1}60:${col3}60`);
        setCell(`${col1}60`, parseFloat(bd.freeParkingCondition) || 50, { fill: 'FFFFF2CC' });
    });
    
    // 행 61: 무료주차 제공대수
    sheet.mergeCells('B61:D61');
    setCell('B61', '무료주차 제공대수');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        sheet.mergeCells(`${col1}61:${col3}61`);
        setFormula(`${col1}61`, `${col1}44/${col1}60`, '#,##0.0');
    });
    
    // 행 62: 유료주차(VAT별도)
    sheet.mergeCells('B62:D62');
    setCell('B62', '유료주차(VAT별도)');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        const bd = b.buildingData || {};
        sheet.mergeCells(`${col1}62:${col3}62`);
        setCell(`${col1}62`, bd.paidParking || bd.parkingFee || '-', { fill: 'FFFFFBEB' });
    });
    
    // ========================================
    // 행 63-72: 기타 - 평면도 (10행)
    // ========================================
    sheet.mergeCells('A63:A72');
    setCell('A63', '기타', { fill: 'FFF3F4F6', font: { bold: true } });
    
    sheet.mergeCells('B63:D72');
    setCell('B63', '평면도');
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        sheet.mergeCells(`${col1}63:${col3}72`);
        
        const bd = b.buildingData || {};
        const floorPlanUrl = bd.floorPlan || bd.floorPlanImage || '';
        
        if (floorPlanUrl && floorPlanUrl.startsWith('data:image')) {
            try {
                const base64Data = floorPlanUrl.split(',')[1];
                const extension = floorPlanUrl.includes('png') ? 'png' : 'jpeg';
                const imageId = workbook.addImage({ base64: base64Data, extension });
                sheet.addImage(imageId, {
                    tl: { col: 4 + bIdx * 3, row: 62 },
                    br: { col: 7 + bIdx * 3, row: 72 },
                    editAs: 'oneCell'
                });
            } catch (e) {
                setCell(`${col1}63`, '평면도 없음');
            }
        } else {
            setCell(`${col1}63`, floorPlanUrl ? '평면도 있음' : '평면도 없음');
        }
    });
    
    for (let r = 63; r <= 72; r++) {
        sheet.getRow(r).height = 18;
    }
    
    // ========================================
    // 다운로드
    // ========================================
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

// ============================================================
// 유틸리티 함수
// ============================================================

// 객체를 안전하게 문자열로 변환
function safeStringify(value) {
    if (value === null || value === undefined || value === '') return '-';
    
    // 이미 문자열이면 그대로 반환
    if (typeof value === 'string') return value || '-';
    
    // 숫자면 문자열로 변환
    if (typeof value === 'number') return String(value);
    
    // 배열이면 쉼표로 연결
    if (Array.isArray(value)) {
        return value.filter(v => v).join(', ') || '-';
    }
    
    // 객체인 경우 특정 필드 조합
    if (typeof value === 'object') {
        // scale (빌딩 규모) 처리: { above: "20층", below: "6층" } 또는 { groundFloors, basementFloors }
        if (value.above !== undefined || value.below !== undefined) {
            const parts = [];
            if (value.below) parts.push(`지하${value.below}`);
            if (value.above) parts.push(`지상${value.above}`);
            return parts.join(', ') || '-';
        }
        if (value.groundFloors !== undefined || value.basementFloors !== undefined) {
            const parts = [];
            if (value.basementFloors) parts.push(`지하${value.basementFloors}층`);
            if (value.groundFloors) parts.push(`지상${value.groundFloors}층`);
            return parts.join(', ') || '-';
        }
        
        // parking 관련 처리
        if (value.total !== undefined || value.count !== undefined) {
            const total = value.total || value.count || '';
            const type = value.type || value.method || '';
            if (total && type) return `총 ${total}대 (${type})`;
            if (total) return `총 ${total}대`;
            return '-';
        }
        
        // 일반 객체: 값들을 조합
        const values = Object.values(value).filter(v => v && typeof v !== 'object');
        if (values.length > 0) {
            return values.join(' ') || '-';
        }
        
        return '-';
    }
    
    return String(value) || '-';
}

function escapeHtml(str) {
    if (!str) return '';
    const safeStr = safeStringify(str);
    return String(safeStr).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatNumber(value) {
    if (value === null || value === undefined || value === '') return '-';
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    return num.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
}

function formatValue(value, format) {
    if (value === null || value === undefined || value === '' || value === '-') return '-';
    
    const num = parseFloat(value);
    if (isNaN(num)) return value;
    
    switch (format) {
        case 'percent':
            return num.toFixed(1) + '%';
        case 'number':
            return num.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
        case 'currency':
            return num.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' 만원';
        case 'won':
            return '₩' + Math.round(num).toLocaleString('ko-KR');
        default:
            return value;
    }
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    
    setTimeout(() => toast.remove(), 3000);
}

// 로그아웃
window.handleLogout = function() {
    localStorage.removeItem('crePortalUser');
    window.location.href = 'portal.html';
};

// 테마 토글
window.toggleTheme = function() {
    const current = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', current === 'dark' ? 'light' : 'dark');
};
