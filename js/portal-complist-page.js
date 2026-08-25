/**
 * CRE Portal - Comp List Page Module
 * 전용 페이지에서 Comp List 관리, 웹 스프레드시트 편집 기능 제공
 */

import { db, ref, get, set, push, update, remove } from './portal-firebase.js';
import {
    initTemplates, registerTemplate, getTemplate,
    allContainerIds, SNI_BUILDING_KEYS
} from './complist-templates.js';

// ============================================================
// 단위 변환 헬퍼 함수 (마이그레이션 호환)
// ============================================================
/**
 * 가격 값을 원 단위로 정규화
 * - 마이그레이션 후 데이터: 이미 원 단위 (예: 119500)
 * - 기존/OCR 데이터: 만원 단위일 수 있음 (예: 11.95)
 * 
 * 판단 기준: 값이 1000 미만이면 만원 단위로 간주
 */
function toWon(value) {
    const num = parseFloat(value) || 0;
    if (num === 0) return 0;
    // 1000 미만이면 만원 단위로 간주 (×10000)
    // 1000 이상이면 이미 원 단위
    return num < 1000 ? num * 10000 : num;
}

/**
 * 원 단위 값을 만원 단위로 변환 (표시용)
 */
function toManwon(value) {
    const num = parseFloat(value) || 0;
    if (num === 0) return 0;
    // 1000 이상이면 원 단위로 간주 (÷10000)
    // 1000 미만이면 이미 만원 단위
    return num >= 1000 ? num / 10000 : num;
}

/**
 * 만원 단위로 포맷팅 (표시용)
 */
function formatManwon(value) {
    const manwon = toManwon(value);
    if (manwon === 0) return '-';
    return formatNumber(manwon.toFixed(1)) + '만원';
}

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
// ============================================================
// 템플릿 레지스트리 등록
// ※ 유형별 하드코딩 분기를 대체. 새 포맷 추가 시 여기에 등록만 하면 됨.
// ============================================================
function setupTemplates() {
    initTemplates({
        toWon, toManwon, formatManwon, formatNumber,
        escapeHtml, safeStringify, getExteriorUrl, showToast,
        getState: () => pageState,
        rerender: () => renderDetailView()
    });

    registerTemplate({
        id: 'general',
        label: '일반용',
        icon: '📊',
        badgeClass: 'general',
        containerId: 'generalSpreadsheet',
        render: renderGeneralSpreadsheet,
        exportExcel: downloadExcelGeneral
    });

    registerTemplate({
        id: 'lg',
        label: 'LG그룹용',
        icon: '🏢',
        badgeClass: 'lg',
        containerId: 'lgSpreadsheet',
        render: renderLGSpreadsheet,
        exportExcel: downloadExcelLG
    });
    // 'sni'(S&I 시세자료)는 complist-templates.js에서 자체 등록됨
}

export async function initCompListPage() {
    console.log('Comp List 페이지 초기화 시작...');
    
    setupTemplates();
    
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
        // ★ 마이그레이션 후 변경: buildings와 vacancies를 병렬 로드
        // 새 구조: vacancies/{buildingId}/{vacancyId} (독립 컬렉션)
        const [buildingsSnapshot, vacanciesSnapshot] = await Promise.all([
            get(ref(db, 'buildings')),
            get(ref(db, 'vacancies'))
        ]);
        
        // vacancies 데이터를 buildingId 기준으로 Map 생성
        const vacanciesMap = {};
        if (vacanciesSnapshot.exists()) {
            const vacanciesData = vacanciesSnapshot.val();
            // 구조: vacancies/{buildingId}/{vacancyId}
            Object.entries(vacanciesData).forEach(([buildingId, buildingVacancies]) => {
                if (buildingVacancies && typeof buildingVacancies === 'object') {
                    vacanciesMap[buildingId] = Object.entries(buildingVacancies).map(([vKey, v]) => ({
                        id: vKey,
                        _key: vKey,
                        ...v
                    }));
                }
            });
            console.log(`vacancies 컬렉션에서 ${Object.keys(vacanciesMap).length}개 빌딩의 공실 로드`);
        }
        
        if (buildingsSnapshot.exists()) {
            const buildingsData = buildingsSnapshot.val();
            
            pageState.allBuildings = Object.entries(buildingsData).map(([id, b]) => {
                const flatBuilding = flattenBuildingData(id, b);
                
                // ★ 우선순위 1: 독립 vacancies 컬렉션에서 매핑
                if (vacanciesMap[id] && vacanciesMap[id].length > 0) {
                    flatBuilding.vacancies = vacanciesMap[id];
                }
                // ★ 우선순위 2: 기존 buildings/{id}/vacancies (하위호환)
                else if (b.vacancies && typeof b.vacancies === 'object') {
                    flatBuilding.vacancies = Object.entries(b.vacancies).map(([vKey, v]) => ({
                        id: vKey,
                        _key: vKey,
                        ...v
                    }));
                } else {
                    flatBuilding.vacancies = [];
                }
                
                return flatBuilding;
            });
            
            console.log(`빌딩 ${pageState.allBuildings.length}개 로드 완료`);
            
            // 공실 있는 빌딩 수 로깅
            const buildingsWithVacancies = pageState.allBuildings.filter(b => b.vacancies && b.vacancies.length > 0).length;
            console.log(`공실 정보가 있는 빌딩: ${buildingsWithVacancies}개`);
            
            // 디버깅: 공실 있는 빌딩 샘플 (최대 5개)
            pageState.allBuildings.filter(b => b.vacancies && b.vacancies.length > 0).slice(0, 5).forEach(b => {
                console.log(`  - ${b.name}: ${b.vacancies.length}개 공실`);
            });
        }
    } catch (e) {
        console.error('빌딩 로드 실패:', e);
    }
}

// ★ 외관 이미지 URL 추출 헬퍼 (모든 경로를 통합 확인)
function getExteriorUrl(bd) {
    // 1순위: exteriorImage (단일 문자열 - complist에서 저장)
    if (bd.exteriorImage) return bd.exteriorImage;
    // 2순위: mainImage
    if (bd.mainImage) return bd.mainImage;
    // 3순위: images.exterior 배열 (portal.html에서 저장)
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
    // 4순위: exteriorImages 배열 (일부 빌딩에서 사용)
    const extImgs = bd.exteriorImages;
    if (extImgs && Array.isArray(extImgs) && extImgs.length > 0) {
        const first = extImgs[0];
        if (typeof first === 'string') return first;
        if (first?.url) return first.url;
    }
    return '';
}

// Firebase 빌딩 데이터 평탄화
function flattenBuildingData(id, b) {
    // ※ 엘리베이터: specs.passengerElevator + specs.freightElevator → "승객12/화물4대" 형식
    let elevatorsDisplay = '';
    const passenger = b.specs?.passengerElevator || 0;
    const freight = b.specs?.freightElevator || 0;
    if (passenger || freight) {
        const parts = [];
        if (passenger) parts.push(`승객${passenger}`);
        if (freight) parts.push(`화물${freight}대`);
        elevatorsDisplay = parts.join('/');
    }
    
    // ※ 주차 대수 표시
    const parkingTotal = b.parking?.total || b.parkingTotal || '';
    const parkingDisplay = parkingTotal ? `${parkingTotal}대` : '';
    
    return {
        id,
        // 기본 정보
        name: b.name || '',
        address: b.address || '',
        addressJibun: b.addressJibun || b.address || '',
        region: b.region || b.regionId || '',
        regionId: b.regionId || b.region || '',
        grade: b.grade || '',
        
        // 면적 정보 (area 객체에서 추출)
        typicalFloorPy: b.area?.typicalFloorPy || b.typicalFloorPy || '',
        typicalFloorSqm: b.area?.typicalFloorSqm || b.typicalFloorSqm || '',
        typicalFloorM2: b.area?.typicalFloorSqm || b.area?.typicalFloorM2 || b.typicalFloorM2 || '',
        typicalFloorLeasePy: b.area?.typicalFloorLeasePy || b.typicalFloorLeasePy || '',
        exclusiveRate: b.area?.exclusiveRate || b.exclusiveRate || '',
        dedicatedRate: b.area?.exclusiveRate || b.dedicatedRate || '',
        grossFloorPy: b.area?.grossFloorPy || b.grossFloorPy || '',
        grossFloorSqm: b.area?.grossFloorSqm || b.grossFloorSqm || '',
        // ※ 대지면적/건축면적은 ㎡로 저장됨 → 평으로 변환
        landAreaSqm: b.area?.landArea || b.landArea || '',
        landArea: (() => {
            const sqm = parseFloat(b.area?.landArea || b.landArea || 0);
            return sqm ? Math.round(sqm / 3.3058) : '';
        })(),
        buildingAreaSqm: b.area?.buildingArea || b.buildingArea || '',
        buildingArea: (() => {
            const sqm = parseFloat(b.area?.buildingArea || b.buildingArea || 0);
            return sqm ? Math.round(sqm / 3.3058) : '';
        })(),
        
        // 층 정보
        floors: b.floors?.display || b.floors || '',
        floorsAbove: b.floors?.above || b.floorsAbove || '',
        floorsBelow: b.floors?.below || b.floorsBelow || '',
        scale: b.floors?.display || b.scale || '',
        
        // 스펙 정보 - 건축물대장
        completionYear: b.completionYear || b.specs?.completionYear || '',  // 루트 레벨 우선
        passengerElevator: passenger,
        freightElevator: freight,
        elevators: elevatorsDisplay,  // "승객12/화물4대" 형식
        elevator: elevatorsDisplay,   // 별칭
        
        // 스펙 정보 - 건축물대장 (구조, 용도)
        structure: b.structure || b.specs?.structure || '',
        buildingUse: b.buildingUse || b.specs?.buildingUse || '',
        usage: b.usage || b.specs?.usage || b.specs?.buildingUse || '',
        
        // 스펙 정보 - 수동 입력
        hvac: b.hvac || b.specs?.hvac || '',
        heatingCooling: b.heatingCooling || b.specs?.heatingCooling || '',
        
        // 주차 정보 - 건축물대장
        parkingTotal: parkingTotal,           // 숫자
        parkingTotalDisplay: parkingDisplay,  // "443대" 형식
        parkingSpaces: parkingTotal,          // 별칭
        
        // 주차 정보 - 수동 입력
        parkingInfo: b.parking?.info || b.parkingInfo || parkingDisplay,  // 없으면 대수로 대체
        parkingFee: b.parking?.fee || b.parkingFee || '',
        parkingRatio: b.parking?.ratio || b.parkingRatio || '',
        freeParkingCondition: b.freeParkingCondition || '',
        paidParking: b.paidParking || '',
        
        // 위치 정보 - 수동 입력
        nearestStation: b.nearbyStation || b.nearestStation || '',
        nearbyStation: b.nearbyStation || b.nearestStation || '',
        station: b.station || b.nearbyStation || '',
        stationDistance: b.stationDistance || '',
        
        // 가격 정보 - 수동 입력
        rentPy: b.pricing?.rentPy || b.rentPy || '',
        depositPy: b.pricing?.depositPy || b.depositPy || '',
        maintenancePy: b.pricing?.maintenancePy || b.maintenancePy || '',
        
        // 기준가 정보
        floorPricing: b.floorPricing || [],
        
        // 이미지 (★ 모든 경로 통합)
        exteriorImage: getExteriorUrl(b),
        mainImage: b.mainImage || '',
        
        // 설명
        description: b.description || '',
        
        // 소유자/PM - 수동 입력
        owner: b.owner || '',
        pm: b.pm || '',
        
        // ★ 채권분석 필드 (수동 입력)
        bondStatus: b.bondStatus || '',           // 채권담보 설정여부
        jointCollateral: b.jointCollateral || '', // 공동담보 총 대지지분
        seniorLien: b.seniorLien || '',           // 선순위 담보 총액
        collateralRatio: b.collateralRatio || '', // 공시지가 대비 담보율
        officialLandPrice: b.officialLandPrice || '', // 개별공시지가(25년 1월 기준)
        landPriceApplied: b.landPriceApplied || '',   // 토지가격 적용
        
        // 담당자
        contactPoints: b.contactPoints || [],
        
        // 좌표
        coordinates: b.coordinates || { lat: null, lng: null },
        
        // ※ 추가: 공실 정보 (portal.html에서 저장된 경우)
        vacancies: b.vacancies || [],
        
        // ★ S&I 시세자료 양식 - 상세 사양
        parkingSystem: b.parkingSystem || b.specs?.parkingSystem || '',
        entranceDirection: b.entranceDirection || b.specs?.entranceDirection || '',
        restroomPerFloor: b.restroomPerFloor || b.specs?.restroomPerFloor || '',
        remodelYear: b.remodelYear || b.specs?.remodelYear || '',
        
        // ★ S&I 시세자료 양식 - 딜 조건 (수동 입력)
        contractMonths: b.contractMonths || '',
        fitoutMonths: b.fitoutMonths || '',
        fitoutFreeMaintMonths: b.fitoutFreeMaintMonths || '',
        tiPerPy: b.tiPerPy || '',
        leaseNote: b.leaseNote || '',
        
        // ★ 건축물대장 추가 필드
        vlRat: b.vlRat || '',
        bcRat: b.bcRat || '',
        mainPurpose: b.mainPurpose || b.specs?.buildingUse || b.buildingUse || '',
        
        // ★ 객체 전체 (건축물대장 갱신용)
        area: b.area,
        specs: b.specs,
        parking: b.parking,
        floorsObj: b.floors,  // floors 객체 전체 (floors는 이미 display 문자열로 사용중)
        
        // ★ 이미지 (평면도 등)
        images: b.images || { exterior: [], floorPlan: [], lobby: [], facilities: [], etc: [] },
        floorPlanImages: b.images?.floorPlan || [],  // 평면도 이미지 배열
        
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
                    <span class="card-type ${getTemplate(c.type).badgeClass || 'general'}">
                        ${getTemplate(c.type).label}
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
        renderCompListCards();  // ★ 카드 목록 다시 렌더링
        
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
    
    // ★ 저장된 buildingData를 최신 Firebase 데이터로 병합
    if (pageState.editData.buildings) {
        pageState.editData.buildings = pageState.editData.buildings.map(b => {
            // allBuildings에서 최신 데이터 찾기
            const latestData = pageState.allBuildings.find(ab => ab.id === b.buildingId);
            
            if (latestData) {
                // 저장된 사용자 입력값 보존 (complist에서만 편집 가능한 필드들)
                const userEditedFields = {};
                const editableKeys = [
                    'rentPy', 'depositPy', 'maintenancePy',  // 가격
                    'exclusiveRate', 'typicalFloorPy', 'typicalFloorSqm', 'typicalFloorLeasePy',  // 면적
                    'hvac', 'parkingFee', 'freeParkingCondition', 'paidParking',  // 주차/시설
                    'floorPlan', 'floorPlanImages', 'remarks', 'specialNotes',  // 기타 (평면도 이미지 포함)
                    ...SNI_BUILDING_KEYS  // S&I 시세자료 양식 (상세 사양 + 딜 조건)
                ];
                
                if (b.buildingData) {
                    editableKeys.forEach(key => {
                        if (b.buildingData[key] !== undefined && b.buildingData[key] !== '') {
                            userEditedFields[key] = b.buildingData[key];
                        }
                    });
                }
                
                // 최신 Firebase 데이터 + 저장된 사용자 입력값 병합
                const mergedData = {
                    ...latestData,           // 최신 Firebase 데이터 (건축물대장 포함)
                    ...userEditedFields,     // 사용자가 편집한 값은 유지
                    _raw: latestData._raw    // 원본 데이터 참조
                };
                
                console.log(`빌딩 "${b.buildingName}" 데이터 최신화 완료`);
                return { ...b, buildingData: mergedData };
            }
            
            // allBuildings에서 찾지 못한 경우 기존 로직
            if (b.buildingData && b.buildingData._raw) {
                return b;
            } else if (b.buildingData) {
                const flatData = flattenBuildingData(b.buildingId, b.buildingData);
                return { ...b, buildingData: flatData };
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
    
    // 스프레드시트 렌더링 (레지스트리)
    const template = getTemplate(data.type);
    allContainerIds().forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === template.containerId) ? 'block' : 'none';
    });
    template.render();
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
    const buildingHeaders = entries.map((e, idx) => {
        const hasVacancy = e.vacancy !== null;
        const vacancyCount = e.building.vacancies?.length || 0;
        const hasPortalVacancies = checkPortalVacancies(e.building.buildingId);
        
        // 공실 상태 표시
        let vacancyStatus = '';
        if (!hasVacancy) {
            vacancyStatus = `<div class="vacancy-status no-vacancy">
                <span>공실 정보 없음</span>
                ${hasPortalVacancies ? 
                    `<button class="load-vacancy-btn" onclick="event.stopPropagation(); loadVacanciesFromPortal('${e.building.buildingId}')" title="portal.html에서 불러오기">📥 불러오기</button>` : 
                    `<button class="add-vacancy-btn" onclick="event.stopPropagation(); openVacancyModal('${e.building.buildingId}', -1)" title="공실 추가">➕ 추가</button>`
                }
            </div>`;
        } else {
            vacancyStatus = `<div class="vacancy-status has-vacancy">
                <span>공실 ${e.vacancyIdx + 1}/${vacancyCount}</span>
            </div>`;
        }
        
        return `
        <th class="col-building header building-header-cell">
            <div class="building-name">${escapeHtml(e.building.buildingName || '-')}</div>
            ${vacancyStatus}
            <div class="actions">
                <button class="action-btn" onclick="event.stopPropagation(); refreshBuildingLedgerInComplist('${e.building.buildingId}')" title="건축물대장 불러오기" style="background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: white;">🔄</button>
                <button class="action-btn" onclick="event.stopPropagation(); openVacancyManageModal('${e.building.buildingId}')" title="공실 관리" style="background: linear-gradient(135deg, #10b981, #059669); color: white;">📋</button>
                <button class="action-btn" onclick="event.stopPropagation(); addVacancyToBuilding('${e.building.buildingId}')" title="공실 추가">➕</button>
                <button class="action-btn" onclick="event.stopPropagation(); removeBuildingEntry(${e.buildingIdx}, ${e.vacancyIdx})" title="삭제">🗑️</button>
            </div>
        </th>`;
    }).join('');
    
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
                const imageUrl = getExteriorUrl(bd);
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
    // ※ 건축물대장 필드는 fromLedger: true로 표시
    // ※ 건축물대장 값이 있으면 수정 불가, 없으면 입력 가능
    const buildingInfoRows = [
        { label: '주소 (지번)', key: 'addressJibun', altKey: 'address', fromLedger: true },
        { label: '도로명 주소', key: 'address', fromLedger: true },
        { label: '위치 (인근역)', key: 'nearestStation', altKey: 'station', editable: true },
        { label: '빌딩 규모', key: 'floors', altKey: 'scale', fromLedger: true },
        { label: '준공연도', key: 'completionYear', fromLedger: true },
        { label: '전용률 (%)', key: 'exclusiveRate', altKey: 'dedicatedRate', format: 'percent', editable: true },
        { label: '기준층 임대면적 (m²)', key: 'typicalFloorSqm', altKey: 'typicalFloorM2', format: 'area', editable: true },
        { label: '기준층 임대면적 (평)', key: 'typicalFloorPy', format: 'area', editable: true },
        { label: '기준층 전용면적 (m²)', key: 'exclusiveFloorSqm', formula: 'typicalFloorSqm * exclusiveRate / 100', format: 'area' },
        { label: '기준층 전용면적 (평)', key: 'exclusiveFloorPy', formula: 'typicalFloorPy * exclusiveRate / 100', format: 'area' },
        { label: '엘레베이터', key: 'elevators', altKey: 'elevator', fromLedger: true },
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
            
            // ※ 수정: 건축물대장 필드는 값이 있으면 수정 불가
            let rawValue = bd[row.key];
            if (!rawValue && row.altKey) rawValue = bd[row.altKey];
            const hasLedgerValue = rawValue !== undefined && rawValue !== null && rawValue !== '';
            let isEditable = row.editable || (row.fromLedger && !hasLedgerValue);
            
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
                // 일반 값 (rawValue는 위에서 이미 정의됨)
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
                    // ※ 건축물대장 값이 있으면 수정 불가 표시 추가
                    if (row.fromLedger) {
                        displayValue += ' <span style="font-size:10px;color:#94a3b8;">🔒</span>';
                    }
                } else {
                    // 값이 없으면 입력 필요 placeholder
                    if (isEditable) {
                        displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">입력 필요</span>`;
                    } else {
                        displayValue = '-';
                    }
                }
                
                if (isEditable) {
                    html += `<td class="col-building cell-editable" data-building-idx="${e.buildingIdx}" data-key="${row.key}" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">${displayValue}</td>`;
                } else {
                    html += `<td class="col-building cell-readonly" title="건축물대장 정보 (수정 불가)">${displayValue}</td>`;
                }
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 4. 빌딩 세부현황 (엑셀 행 19-20)
    // ※ 건물용도, 구조는 건축물대장에서 가져옴 (fromLedger)
    // ========================================
    const detailRows = [
        { label: '건물용도', key: 'buildingUse', altKey: 'usage', fromLedger: true },
        { label: '구조', key: 'structure', fromLedger: true }
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
            
            const hasLedgerValue = rawValue !== undefined && rawValue !== null && rawValue !== '';
            const isEditable = row.editable || (row.fromLedger && !hasLedgerValue);
            
            let displayValue = '';
            if (hasLedgerValue) {
                displayValue = escapeHtml(safeStringify(rawValue));
                if (row.fromLedger) {
                    displayValue += ' <span style="font-size:10px;color:#94a3b8;">🔒</span>';
                }
            } else {
                if (isEditable) {
                    displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">입력 필요</span>`;
                } else {
                    displayValue = '-';
                }
            }
            
            if (isEditable) {
                html += `<td class="col-building cell-editable" data-building-idx="${e.buildingIdx}" data-key="${row.key}" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">${displayValue}</td>`;
            } else {
                html += `<td class="col-building cell-readonly" title="건축물대장 정보 (수정 불가)">${displayValue}</td>`;
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 5. 주차 관련 (엑셀 행 21-22)
    // ※ parkingTotal은 건축물대장에서 가져옴 (fromLedger)
    // ※ "주차 대수 정보"는 "주차 대수"와 중복이므로 제거
    // ========================================
    const parkingRows = [
        { label: '주차 대수', key: 'parkingTotal', altKey: 'parkingSpaces', fromLedger: true, suffix: '대' },
        { label: '주차비', key: 'parkingFee', editable: true }
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
            
            const hasLedgerValue = rawValue !== undefined && rawValue !== null && rawValue !== '';
            const isEditable = row.editable || (row.fromLedger && !hasLedgerValue);
            
            let displayValue = '';
            if (hasLedgerValue) {
                displayValue = escapeHtml(safeStringify(rawValue));
                // suffix 처리 (예: "대")
                if (row.suffix && !String(displayValue).includes(row.suffix)) {
                    displayValue += row.suffix;
                }
                if (row.fromLedger) {
                    displayValue += ' <span style="font-size:10px;color:#94a3b8;">🔒</span>';
                }
            } else {
                if (isEditable) {
                    displayValue = `<span class="placeholder-input" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">입력 필요</span>`;
                } else {
                    displayValue = '-';
                }
            }
            
            if (isEditable) {
                html += `<td class="col-building cell-editable" data-building-idx="${e.buildingIdx}" data-key="${row.key}" onclick="openCellEditor(${e.buildingIdx}, '${row.key}', this)">${displayValue}</td>`;
            } else {
                html += `<td class="col-building cell-readonly" title="건축물대장 정보 (수정 불가)">${displayValue}</td>`;
            }
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
                // ※ 수정: 기본값 제거 - 값이 없으면 '-' 표시
                const rentArea = parseFloat(v.rentArea) || 0;
                const exclusiveArea = parseFloat(v.exclusiveArea) || 0;
                if (row.formula.includes('rentArea')) {
                    value = rentArea > 0 ? (rentArea * 3.305785).toFixed(3) : '-';
                } else {
                    value = exclusiveArea > 0 ? (exclusiveArea * 3.305785).toFixed(3) : '-';
                }
                cellClass += ' cell-formula';
            } else if (row.value) {
                value = row.value;
            } else if (row.source === 'vacancy') {
                value = v[row.key] || '-';
                // ※ 수정: 공실 없어도 편집 가능
                if (row.editable) {
                    cellClass += ' cell-editable';
                }
            }
            
            // ※ 수정: 공실 없어도 편집 가능 - 클릭 시 자동 생성
            if (row.editable) {
                const displayValue = value === '-' ? `<span class="placeholder-input">입력 필요</span>` : value;
                html += `<td class="${cellClass}" onclick="editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, '${row.key}')" 
                         data-key="${row.key}" data-bidx="${e.buildingIdx}" data-vidx="${e.vacancyIdx}">${displayValue}</td>`;
            } else {
                html += `<td class="${cellClass}">${value}</td>`;
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 7. 임대 기준 (엑셀 행 32-39)
    // ========================================
    // ★ 마이그레이션 호환: 단위 자동 감지 (toWon/toManwon 함수 사용)
    const rentRows = [
        { label: '월 평당 보증금', key: 'depositPy', source: 'vacancy', editable: true, displayUnit: 'manwon' },
        { label: '월 평당 임대료', key: 'rentPy', source: 'vacancy', editable: true, displayUnit: 'manwon' },
        { label: '월 평당 관리비', key: 'maintenancePy', source: 'vacancy', editable: true, displayUnit: 'manwon' },
        { label: '월 평당 지출비용', formula: 'rentPy + maintenancePy', format: 'manwon' },
        { label: '총 보증금', formula: 'depositPy * rentArea', format: 'won' },
        { label: '월 임대료 총액', formula: 'rentPy * rentArea', format: 'won' },
        { label: '월 관리비 총액', formula: 'maintenancePy * rentArea', format: 'won' },
        { label: '월 전용면적당 지출비용', formula: '(rentPy + maintenancePy) * rentArea / exclusiveArea', format: 'won' }
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
            
            // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화
            const depositPy = toWon(v.depositPy);
            const rentPy = toWon(v.rentPy);
            const maintenancePy = toWon(v.maintenancePy);
            // ※ 수정: 기본값 제거
            const rentArea = parseFloat(v.rentArea) || 0;
            const exclusiveArea = parseFloat(v.exclusiveArea) || 0;
            
            if (row.formula) {
                cellClass += ' cell-formula';
                if (row.formula === 'rentPy + maintenancePy') {
                    // 월 평당 지출비용 (만원 단위로 표시)
                    value = rentPy + maintenancePy;
                } else if (row.formula === 'depositPy * rentArea') {
                    value = rentArea > 0 ? depositPy * rentArea : '-';
                } else if (row.formula === 'rentPy * rentArea') {
                    value = rentArea > 0 ? rentPy * rentArea : '-';
                } else if (row.formula === 'maintenancePy * rentArea') {
                    value = rentArea > 0 ? maintenancePy * rentArea : '-';
                } else if (row.formula.includes('exclusiveArea')) {
                    value = (rentArea > 0 && exclusiveArea > 0) ? ((rentPy + maintenancePy) * rentArea / exclusiveArea) : '-';
                }
                if (value !== '-') {
                    // format에 따른 표시
                    if (row.format === 'manwon') {
                        value = formatManwon(value);
                    } else {
                        value = formatValue(value, row.format);
                    }
                }
            } else if (row.source === 'vacancy') {
                // ★ 원본 값을 만원 단위로 변환해서 표시
                const rawValue = v[row.key];
                if (row.displayUnit === 'manwon' && rawValue) {
                    value = toManwon(rawValue).toFixed(1) + '만원';
                } else {
                    value = rawValue || '-';
                }
                // ※ 수정: 공실 없어도 편집 가능
                if (row.editable) cellClass += ' cell-editable';
            }
            
            // ※ 수정: 공실 없어도 편집 가능
            if (row.editable) {
                const displayValue = value === '-' ? `<span class="placeholder-input">입력 필요</span>` : value;
                html += `<td class="${cellClass}" onclick="editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, '${row.key}')"
                         data-key="${row.key}" data-bidx="${e.buildingIdx}" data-vidx="${e.vacancyIdx}">${displayValue}</td>`;
            } else {
                html += `<td class="${cellClass}">${value}</td>`;
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 8. 임대기준 조정 (엑셀 행 40-44)
    // ========================================
    // ★ 마이그레이션 호환: toWon으로 계산, 만원 단위로 표시
    const adjustRows = [
        { label: '보증금', formula: 'depositPy', format: 'manwon' },
        { label: '렌트프리 (개월/년)', key: 'rentFree', source: 'vacancy', editable: true, default: '0' },
        { label: '평균 임대료', formula: 'rentPy - (rentPy * rentFree / 12)', format: 'manwon' },
        { label: '관리비', formula: 'maintenancePy', format: 'manwon' },
        { label: 'NOC', formula: '((rentPy - rentPy * rentFree / 12) + maintenancePy) * rentArea / exclusiveArea', format: 'manwon' }
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
            
            // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화
            const depositPy = toWon(v.depositPy);
            const rentPy = toWon(v.rentPy);
            const maintenancePy = toWon(v.maintenancePy);
            const rentFree = parseFloat(v.rentFree) || 0;
            // ※ 수정: 기본값 제거
            const rentArea = parseFloat(v.rentArea) || 0;
            const exclusiveArea = parseFloat(v.exclusiveArea) || 0;
            
            if (row.formula) {
                cellClass += ' cell-formula';
                if (row.formula === 'depositPy') {
                    value = depositPy;
                } else if (row.formula === 'maintenancePy') {
                    value = maintenancePy;
                } else if (row.formula.includes('rentFree')) {
                    const effectiveRent = rentPy - (rentPy * rentFree / 12);
                    if (row.formula.includes('NOC')) {
                        value = (rentArea > 0 && exclusiveArea > 0) ? (effectiveRent + maintenancePy) * rentArea / exclusiveArea : '-';
                    } else {
                        value = effectiveRent;
                    }
                }
                // ★ 만원 단위로 변환해서 표시
                if (value !== '-' && row.format === 'manwon') {
                    value = formatManwon(value);
                } else if (value !== '-') {
                    value = formatValue(value, row.format);
                }
            } else if (row.source === 'vacancy') {
                value = v[row.key] || row.default || '-';
                // ※ 수정: 공실 없어도 편집 가능
                if (row.editable) cellClass += ' cell-editable';
            }
            
            // ※ 수정: 공실 없어도 편집 가능
            if (row.editable) {
                const displayValue = value === '-' ? `<span class="placeholder-input">입력 필요</span>` : value;
                html += `<td class="${cellClass}" onclick="editVacancyCell(this, ${e.buildingIdx}, ${e.vacancyIdx}, '${row.key}')"
                         data-key="${row.key}" data-bidx="${e.buildingIdx}" data-vidx="${e.vacancyIdx}">${displayValue}</td>`;
            } else {
                html += `<td class="${cellClass}">${value}</td>`;
            }
        });
        html += '</tr>';
    });
    
    // ========================================
    // 9. 예상비용 (엑셀 행 46-50)
    // ========================================
    // ★ 마이그레이션 호환: * 10000 제거
    const costRows = [
        { label: '보증금', formula: 'depositPy * rentArea', format: 'won' },
        { label: '평균 월 임대료', formula: '(rentPy - rentPy * rentFree / 12) * rentArea', format: 'won' },
        { label: '평균 월 관리비', formula: 'maintenancePy * rentArea', format: 'won' },
        { label: '월 (임대료 + 관리비)', formula: '((rentPy - rentPy * rentFree / 12) + maintenancePy) * rentArea', format: 'won' },
        { label: '연 실제 부담 고정금액', formula: '((rentPy - rentPy * rentFree / 12) + maintenancePy) * rentArea * 12', format: 'won' }
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
            
            // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화
            const depositPy = toWon(v.depositPy);
            const rentPy = toWon(v.rentPy);
            const maintenancePy = toWon(v.maintenancePy);
            const rentFree = parseFloat(v.rentFree) || 0;
            // ※ 수정: 기본값 제거
            const rentArea = parseFloat(v.rentArea) || 0;
            
            const effectiveRent = rentPy - (rentPy * rentFree / 12);
            let value = '-';
            
            if (rentArea > 0) {
                if (row.formula.includes('depositPy * rentArea')) {
                    value = depositPy * rentArea;
                } else if (row.formula.includes('rentPy') && !row.formula.includes('maintenancePy')) {
                    value = effectiveRent * rentArea;
                } else if (row.formula.includes('maintenancePy') && !row.formula.includes('rentPy')) {
                    value = maintenancePy * rentArea;
                } else if (row.formula.includes('* 12')) {
                    value = (effectiveRent + maintenancePy) * rentArea * 12;
                } else {
                    value = (effectiveRent + maintenancePy) * rentArea;
                }
                value = formatValue(value, row.format);
            }
            
            html += `<td class="${cellClass}">${value}</td>`;
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
                    ${buildings.map((b, bIdx) => {
                        const vacancyCount = b.vacancies?.length || 0;
                        const hasPortalVacancies = checkPortalVacancies(b.buildingId);
                        
                        let vacancyStatus = '';
                        if (vacancyCount === 0) {
                            vacancyStatus = `<div class="vacancy-status no-vacancy">
                                <span>공실 없음</span>
                                ${hasPortalVacancies ? 
                                    `<button class="load-vacancy-btn" onclick="event.stopPropagation(); loadVacanciesFromPortal('${b.buildingId}')">📥 불러오기</button>` : ''
                                }
                            </div>`;
                        } else {
                            vacancyStatus = `<div class="vacancy-status has-vacancy">
                                <span>공실 ${vacancyCount}개</span>
                            </div>`;
                        }
                        
                        return `
                        <th colspan="3" class="building-header-cell">
                            <div class="building-name">${escapeHtml(b.buildingName || '-')}</div>
                            ${vacancyStatus}
                            <div class="actions">
                                <button class="action-btn" onclick="refreshBuildingLedgerInComplist('${b.buildingId}')" title="건축물대장 불러오기" style="background: linear-gradient(135deg, #3b82f6, #1d4ed8); color: white;">🔄</button>
                                <button class="action-btn" onclick="openVacancyManageModal('${b.buildingId}')" title="공실 관리" style="background: linear-gradient(135deg, #10b981, #059669); color: white;">📋</button>
                                <button class="action-btn" onclick="addVacancyToBuilding('${b.buildingId}')" title="공실 추가">➕</button>
                                <button class="action-btn" onclick="removeBuilding('${b.buildingId}')" title="삭제">🗑️</button>
                            </div>
                        </th>`;
                    }).join('')}
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
                const imageUrl = getExteriorUrl(bd);
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
    // ※ 건축물대장 필드: address, completionYear, floors, grossFloorPy, landArea
    // ========================================
    const infoRows = [
        { label: '주소', key: 'address', fromLedger: true },
        { label: '위치', key: 'nearestStation', altKey: 'station', editable: true },
        { label: '준공일', key: 'completionYear', fromLedger: true },
        { label: '규모', key: 'floors', altKey: 'scale', fromLedger: true },
        { label: '연면적', key: 'grossFloorPy', altKey: 'grossFloorArea', suffix: '평', fromLedger: true },
        { label: '기준층 전용면적', key: 'typicalFloorPy', suffix: '평', editable: true },
        { label: '전용률', key: 'exclusiveRate', altKey: 'dedicatedRate', format: 'percent', editable: true },
        { label: '대지면적', key: 'landArea', suffix: '평', fromLedger: true }
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
            
            // 건축물대장 필드는 값이 있으면 수정 불가
            const hasLedgerValue = rawValue && rawValue !== '-';
            const isEditable = row.editable || (row.fromLedger && !hasLedgerValue);
            
            if (row.format === 'percent' && displayValue && displayValue !== '-') {
                const numVal = parseFloat(displayValue);
                displayValue = numVal ? (numVal > 1 ? numVal.toFixed(1) + '%' : (numVal * 100).toFixed(1) + '%') : displayValue;
            }
            if (row.suffix && displayValue && displayValue !== '-' && !String(displayValue).includes(row.suffix)) {
                displayValue += row.suffix;
            }
            
            if (hasLedgerValue && row.fromLedger) {
                // 건축물대장 값 - 수정 불가
                html += `<td colspan="3" class="col-building cell-readonly" title="건축물대장 정보 (수정 불가)">${escapeHtml(displayValue)} <span style="font-size:10px;color:#94a3b8;">🔒</span></td>`;
            } else if (isEditable) {
                // 편집 가능
                html += `<td colspan="3" class="col-building cell-editable" onclick="editBuildingCell(this, ${bIdx}, '${row.key}')">${hasLedgerValue ? escapeHtml(displayValue) : '<span class="placeholder-input">입력</span>'}</td>`;
            } else {
                html += `<td colspan="3" class="col-building">${escapeHtml(displayValue) || '-'}</td>`;
            }
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
    // ★ 마이그레이션 호환: toManwon()으로 만원 단위 표시
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
            const rawValue = v[row.key];
            // ★ 마이그레이션 호환: 원 단위 값을 만원으로 변환
            const displayValue = rawValue ? toManwon(rawValue).toFixed(1) : '';
            html += `
                <td colspan="3" class="cell-editable" onclick="editCell(this, ${bIdx}, 0, '${row.key}')">
                    ${displayValue ? formatNumber(displayValue) + ' ' + row.unit : '-'}
                </td>
            `;
        });
        html += `</tr>`;
    });
    
    // ========================================
    // 6. 실질 임대기준 (2행)
    // ========================================
    // ★ 마이그레이션 호환: toWon()으로 계산, toManwon()으로 표시
    html += `
        <tr>
            <td class="col-category section-realrent" rowspan="2">실질<br>임대기준</td>
            <td class="col-label">실질 임대료(RF반영)</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const rentPy = toWon(v.rentPy);
                const rentFree = parseFloat(v.rentFree) || 0;
                const effectiveRent = rentPy * (12 - rentFree) / 12;
                // 결과를 만원 단위로 변환해서 표시
                const displayValue = effectiveRent ? toManwon(effectiveRent).toFixed(2) : 0;
                return `<td colspan="3" class="cell-formula">${displayValue ? formatNumber(displayValue) + ' 만원/평' : '-'}</td>`;
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
    // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화, * 10000 제거
    html += `
        <tr>
            <td class="col-category section-cost" rowspan="6">비용검토</td>
            <td class="col-label">보증금</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const depositPy = toWon(v.depositPy);
                const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const totalDeposit = depositPy * totalRent;
                return `<td colspan="3" class="cell-formula">${totalDeposit ? formatNumber(Math.round(totalDeposit)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">월 임대료</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const rentPy = toWon(v.rentPy);
                const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const monthlyRent = rentPy * totalRent;
                return `<td colspan="3" class="cell-formula">${monthlyRent ? formatNumber(Math.round(monthlyRent)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">월 관리비</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const maintenancePy = toWon(v.maintenancePy);
                const totalRent = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const monthlyMaint = maintenancePy * totalRent;
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
                const rentPy = toWon(v.rentPy);
                const maintenancePy = toWon(v.maintenancePy);
                const totalRentArea = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const monthlyTotal = (rentPy + maintenancePy) * totalRentArea;
                return `<td colspan="3" class="cell-formula cell-highlight">${monthlyTotal ? formatNumber(Math.round(monthlyTotal)) + '원' : '-'}</td>`;
            }).join('')}
        </tr>
        <tr>
            <td class="col-label">(21개월) 총 납부비용</td>
            ${buildings.map(b => {
                const v = b.vacancies?.[0] || {};
                const rentPy = toWon(v.rentPy);
                const maintenancePy = toWon(v.maintenancePy);
                const totalRentArea = (b.vacancies || []).reduce((sum, v) => sum + (parseFloat(v.rentArea) || 0), 0);
                const total21Months = (rentPy + maintenancePy) * totalRentArea * 21;
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
    // ※ 총 주차대수는 건축물대장 데이터 (parkingTotal)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-parking" rowspan="4">주차현황</td>
            <td class="col-label">총 주차대수</td>
            ${buildings.map((b, bIdx) => {
                const bd = b.buildingData || {};
                // parkingTotal만 사용 (건축물대장)
                const parkingTotal = bd.parkingTotal || bd.parkingSpaces || '';
                const parking = parkingTotal ? safeStringify(parkingTotal) + '대' : '';
                const hasLedgerValue = parkingTotal && parkingTotal !== '-';
                if (hasLedgerValue) {
                    return `<td colspan="3" class="cell-readonly" title="건축물대장 정보 (수정 불가)">${escapeHtml(parking)} <span style="font-size:10px;color:#94a3b8;">🔒</span></td>`;
                } else {
                    return `<td colspan="3" class="cell-editable" onclick="editBuildingCell(this, ${bIdx}, 'parkingTotal')"><span class="placeholder-input">입력</span></td>`;
                }
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
    // 10. 기타 - 평면도 (외관사진과 동일한 크기/배치)
    // ========================================
    html += `
        <tr>
            <td class="col-category section-image">평면도</td>
            <td class="col-label">이미지</td>
            ${buildings.map((b, bIdx) => {
                const bd = b.buildingData || {};
                const floorPlanImages = bd.floorPlanImages || bd.images?.floorPlan || [];
                const firstImage = floorPlanImages.length > 0 ? 
                    (typeof floorPlanImages[0] === 'string' ? floorPlanImages[0] : floorPlanImages[0]?.url) : '';
                
                return `
                    <td colspan="3" class="image-cell">
                        ${firstImage ? 
                            `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; position:relative;">
                                <img src="${firstImage}" onclick="openFloorPlanModal('${b.buildingId}', ${bIdx})" alt="평면도" style="cursor:pointer;">
                                ${floorPlanImages.length > 1 ? `<span style="position:absolute; bottom:4px; right:4px; background:rgba(0,0,0,0.6); color:white; font-size:11px; padding:2px 6px; border-radius:10px;">+${floorPlanImages.length - 1}</span>` : ''}
                            </div>` :
                            `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%;">
                                <button class="upload-btn" onclick="openFloorPlanModal('${b.buildingId}', ${bIdx})">
                                    📐 평면도 등록
                                </button>
                            </div>`
                        }
                    </td>
                `;
            }).join('')}
        </tr>
    `;
    
    // ========================================
    // 11. 기타 - 특이사항
    // ========================================
    html += `
        <tr>
            <td class="col-category section-etc">기타</td>
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
        // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화
        const depositPy = toWon(v.depositPy);
        const rentPy = toWon(v.rentPy);
        const maintenancePy = toWon(v.maintenancePy);
        const rentFree = parseFloat(v.rentFree) || 0;
        
        // 중간 계산 (이미 원 단위이므로 * 10000 제거)
        const totalDeposit = depositPy * rentArea;
        const totalRent = rentPy * rentArea;
        const totalMaintenance = maintenancePy * rentArea;
        const effectiveRent = rentPy * (12 - rentFree) / 12;
        const monthlyPayment = (effectiveRent + maintenancePy) * rentArea;
        
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
// ※ 추가: 공실 필드 편집 함수 (공실이 없으면 자동 생성)
window.editVacancyCell = function(cell, buildingIdx, vacancyIdx, key) {
    if (cell.querySelector('input')) return; // 이미 편집 중
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    // 공실이 없으면 먼저 생성
    if (vacancyIdx === -1 || !building.vacancies || building.vacancies.length === 0) {
        if (!building.vacancies) building.vacancies = [];
        if (building.vacancies.length === 0) {
            building.vacancies.push({
                floor: '',
                moveInDate: '',
                rentArea: '',
                exclusiveArea: '',
                depositPy: '',
                rentPy: '',
                maintenancePy: '',
                rentFree: '0'
            });
        }
        vacancyIdx = 0;
    }
    
    const v = building.vacancies[vacancyIdx] || {};
    const currentValue = v[key] || '';
    
    cell.innerHTML = `<input type="text" value="${currentValue}" 
        onblur="saveVacancyCellEdit(this, ${buildingIdx}, ${vacancyIdx}, '${key}')" 
        onkeypress="if(event.key==='Enter')this.blur()"
        style="width:100%; padding:4px; border:1px solid #3b82f6; border-radius:4px;">`;
    cell.querySelector('input').focus();
    cell.querySelector('input').select();
};

window.saveVacancyCellEdit = function(input, buildingIdx, vacancyIdx, key) {
    const newValue = input.value.trim();
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    // 공실 배열 확인
    if (!building.vacancies) building.vacancies = [];
    if (!building.vacancies[vacancyIdx]) {
        building.vacancies[vacancyIdx] = {};
    }
    
    building.vacancies[vacancyIdx][key] = newValue;
    
    // UI 새로고침
    renderDetailView();
    showToast('값이 수정되었습니다', 'success');
};

window.editCell = function(cell, buildingIdx, vacancyIdx, key) {
    if (cell.querySelector('input')) return; // 이미 편집 중
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    // ※ 수정: 공실이 없으면 먼저 생성
    if (!building.vacancies) building.vacancies = [];
    if (vacancyIdx >= 0 && !building.vacancies[vacancyIdx]) {
        // 필요한 인덱스까지 공실 생성
        while (building.vacancies.length <= vacancyIdx) {
            building.vacancies.push({
                floor: '',
                moveInDate: '',
                rentArea: '',
                exclusiveArea: '',
                depositPy: '',
                rentPy: '',
                maintenancePy: '',
                rentFree: '0'
            });
        }
    }
    
    const v = building.vacancies[vacancyIdx] || {};
    const currentValue = v[key] || '';
    
    cell.innerHTML = `<input type="text" value="${currentValue}" 
        onblur="saveCellEdit(this, ${buildingIdx}, ${vacancyIdx}, '${key}', '${currentValue}')" 
        onkeypress="if(event.key==='Enter')this.blur()"
        style="width:100%; padding:4px; border:1px solid #3b82f6; border-radius:4px;">`;
    cell.querySelector('input').focus();
    cell.querySelector('input').select();
};

window.saveCellEdit = function(input, buildingIdx, vacancyIdx, key, originalValue) {
    const newValue = input.value.trim();
    const cell = input.parentElement;
    
    // 데이터 업데이트
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    // ※ 수정: 공실이 없으면 자동 생성
    if (!building.vacancies) building.vacancies = [];
    
    if (vacancyIdx >= 0) {
        // 필요한 인덱스까지 공실 생성
        while (building.vacancies.length <= vacancyIdx) {
            building.vacancies.push({
                floor: '',
                moveInDate: '',
                rentArea: '',
                exclusiveArea: '',
                depositPy: '',
                rentPy: '',
                maintenancePy: '',
                rentFree: '0'
            });
        }
        building.vacancies[vacancyIdx][key] = newValue;
    } else if (vacancyIdx === -1) {
        // 공실이 없는 빌딩 - 첫 번째 공실 생성
        if (building.vacancies.length === 0) {
            building.vacancies.push({
                floor: '',
                moveInDate: '',
                rentArea: '',
                exclusiveArea: '',
                depositPy: '',
                rentPy: '',
                maintenancePy: '',
                rentFree: '0'
            });
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
    if (cell.querySelector('input') || cell.querySelector('select')) return; // 이미 편집 중
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    const currentValue = bd[key] || '';
    
    // ★ hvac(냉난방) 필드는 드롭다운으로 표시
    if (key === 'hvac' || key === 'heatingCooling') {
        const hvacOptions = ['', '개별냉난방', '중앙냉난방', '지역난방', '복합'];
        const optionsHtml = hvacOptions.map(opt => 
            `<option value="${opt}" ${currentValue === opt ? 'selected' : ''}>${opt || '선택'}</option>`
        ).join('');
        
        cell.innerHTML = `<select onchange="saveBuildingCellEdit(this, ${buildingIdx}, '${key}')" onblur="saveBuildingCellEdit(this, ${buildingIdx}, '${key}')" style="width:100%; padding:4px; border:1px solid #3b82f6; border-radius:4px; background:white;">${optionsHtml}</select>`;
        cell.querySelector('select').focus();
    } else {
        // 기존 텍스트 입력
        cell.innerHTML = `<input type="text" value="${escapeHtml(currentValue)}" onblur="saveBuildingCellEdit(this, ${buildingIdx}, '${key}')" onkeypress="if(event.key==='Enter')this.blur()" style="width:100%; padding:4px; border:1px solid #3b82f6; border-radius:4px;">`;
        cell.querySelector('input').focus();
        cell.querySelector('input').select();
    }
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
    
    // portal.html에서 저장된 공실 정보 확인
    let portalVacancies = [];
    if (building._raw?.vacancies && typeof building._raw.vacancies === 'object') {
        // 객체 형태면 배열로 변환
        portalVacancies = Object.entries(building._raw.vacancies).map(([k, v]) => ({ ...v, _key: k }));
    } else if (building.vacancies && Array.isArray(building.vacancies) && building.vacancies.length > 0) {
        portalVacancies = building.vacancies;
    }
    
    // ★ 빌딩을 먼저 추가 (공실은 비워둠)
    const newBuilding = {
        buildingId: building.id,
        buildingName: building.name,
        buildingData: buildingData,
        vacancies: [],  // 공실은 비워둠
        addedAt: new Date().toISOString()
    };
    
    pageState.editData.buildings.push(newBuilding);
    
    // 검색 초기화
    document.getElementById('buildingSearchInput').value = '';
    document.getElementById('buildingSearchResults').style.display = 'none';
    
    // UI 새로고침
    renderDetailView();
    
    // ★ 공실 정보가 있으면 선택 모달 표시
    if (portalVacancies.length > 0) {
        showToast(`${building.name} 추가됨 - 공실 ${portalVacancies.length}개 선택 가능`, 'success');
        // 약간의 딜레이 후 모달 표시 (UI 렌더링 완료 후)
        setTimeout(() => {
            openVacancySelectionModal(buildingId, portalVacancies, newBuilding);
        }, 300);
    } else {
        showToast(`${building.name} 추가됨`, 'success');
    }
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
window.openVacancyModal = function(buildingId, vacancyIdx = -1, showExposeOption = false) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    // 안내문 공실 선택 모달 닫기 (있으면)
    closeVacancySelectionModal();
    
    const modal = document.getElementById('vacancyModal');
    const isEdit = vacancyIdx >= 0 && building.vacancies?.[vacancyIdx];
    
    document.getElementById('vacancyModalTitle').textContent = isEdit ? '공실 수정' : '공실 추가';
    document.getElementById('vf_buildingId').value = buildingId;
    document.getElementById('vf_vacancyIndex').value = vacancyIdx;
    
    // ★ 노출 옵션 섹션 표시/숨김
    let exposeSection = document.getElementById('exposeOptionSection');
    if (!exposeSection) {
        // 노출 옵션 섹션 동적 생성 (최초 1회)
        const formContent = modal.querySelector('.modal-body');
        if (formContent) {
            const sectionHtml = `
                <div id="exposeOptionSection" class="expose-option-section" style="display: none; margin-top: 16px; padding: 16px; background: #fef3c7; border-radius: 8px; border: 1px solid #fcd34d;">
                    <label style="display: flex; align-items: flex-start; gap: 10px; cursor: pointer;">
                        <input type="checkbox" id="vf_exposeToPortal" style="width: 18px; height: 18px; margin-top: 2px;">
                        <div>
                            <div style="font-weight: 600; color: #92400e; font-size: 13px;">
                                입력값 검색시 공실 정보 및 임대정보 노출 허용
                            </div>
                            <div style="font-size: 12px; color: #a16207; margin-top: 4px;">
                                해당 빌딩 검색시 안내문 메뉴에서 조회될 수 있게 합니다.<br>
                                회사명은 사용자명으로, 입력 연월이 함께 표기됩니다.
                            </div>
                        </div>
                    </label>
                </div>
            `;
            formContent.insertAdjacentHTML('beforeend', sectionHtml);
            exposeSection = document.getElementById('exposeOptionSection');
        }
    }
    
    // 노출 옵션 표시 여부
    if (exposeSection) {
        exposeSection.style.display = showExposeOption && !isEdit ? 'block' : 'none';
        const checkbox = document.getElementById('vf_exposeToPortal');
        if (checkbox) checkbox.checked = false;
    }
    
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
    if (cellElement.querySelector('input') || cellElement.querySelector('select')) return;
    
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    const currentValue = bd[key] || '';
    
    // 기존 내용 저장
    const originalContent = cellElement.innerHTML;
    
    // ★ hvac(냉난방) 필드는 드롭다운으로 표시
    if (key === 'hvac' || key === 'heatingCooling') {
        const hvacOptions = ['', '개별냉난방', '중앙냉난방', '지역난방', '복합'];
        
        const select = document.createElement('select');
        select.className = 'cell-input';
        select.style.cssText = `
            width: 100%;
            padding: 8px;
            border: 2px solid var(--accent-color);
            border-radius: 4px;
            font-size: 13px;
            box-sizing: border-box;
            background: white;
            cursor: pointer;
        `;
        
        hvacOptions.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt;
            option.textContent = opt || '선택';
            if (currentValue === opt) option.selected = true;
            select.appendChild(option);
        });
        
        cellElement.innerHTML = '';
        cellElement.appendChild(select);
        select.focus();
        
        // 변경 시 저장
        select.addEventListener('change', function() {
            saveCellValue(buildingIdx, key, select.value, cellElement);
        });
        
        // 포커스 잃으면 저장
        select.addEventListener('blur', function() {
            setTimeout(() => {
                if (document.activeElement !== select) {
                    saveCellValue(buildingIdx, key, select.value, cellElement);
                }
            }, 100);
        });
        
        // ESC 키로 취소
        select.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                cellElement.innerHTML = originalContent;
            }
        });
    } else {
        // 기존 텍스트 입력
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
    }
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

// ★ 공실 추가 버튼 클릭 시 - 안내문 공실 선택 모달 열기
window.addVacancyToBuilding = function(buildingId) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) {
        showToast('빌딩을 찾을 수 없습니다', 'error');
        return;
    }
    
    // portal.html의 원본 빌딩 데이터에서 공실 정보 가져오기
    const portalBuilding = pageState.allBuildings.find(b => b.id === buildingId);
    let portalVacancies = [];
    
    console.log('=== 공실 추가 디버깅 ===');
    console.log('buildingId:', buildingId);
    console.log('portalBuilding:', portalBuilding);
    
    if (portalBuilding) {
        // vacancies 배열 확인
        portalVacancies = portalBuilding.vacancies || [];
        console.log('portalVacancies:', portalVacancies);
        console.log('portalVacancies.length:', portalVacancies.length);
    }
    
    // 안내문 공실 정보가 있으면 선택 모달 표시
    if (portalVacancies.length > 0) {
        console.log('→ 공실 선택 모달 표시');
        openVacancySelectionModal(buildingId, portalVacancies, building);
    } else {
        console.log('→ 신규 입력 모달 표시 (공실 없음)');
        // 공실 정보 없으면 바로 신규 입력 모달 (노출 옵션 포함)
        openVacancyModal(buildingId, -1, true);  // true = showExposeOption
    }
};

// ============================================================
// ★ 안내문 공실 선택 모달
// ============================================================
window.openVacancySelectionModal = function(buildingId, portalVacancies, building) {
    // 회사(source)와 발행년월(publishDate)별로 그룹화
    const groupedBySource = {};
    portalVacancies.forEach(v => {
        const source = v.source || '미분류';
        const publishDate = v.publishDate || '날짜없음';
        const key = `${source}_${publishDate}`;
        
        if (!groupedBySource[key]) {
            groupedBySource[key] = {
                source,
                publishDate,
                vacancies: []
            };
        }
        groupedBySource[key].vacancies.push(v);
    });
    
    const groups = Object.values(groupedBySource).sort((a, b) => 
        (b.publishDate || '').localeCompare(a.publishDate || '')
    );
    
    // 모달 생성
    let modal = document.getElementById('vacancySelectionModal');
    if (modal) modal.remove();
    
    modal = document.createElement('div');
    modal.id = 'vacancySelectionModal';
    modal.className = 'modal show';
    // ★ 모달 위치를 화면 가운데로 고정
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    
    modal.innerHTML = `
        <div class="modal-content" style="max-width: 700px; max-height: 85vh; overflow: hidden; display: flex; flex-direction: column; background: white; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
            <div class="modal-header" style="padding: 16px 20px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; font-size: 16px; font-weight: 600;">📋 ${building.buildingName} 공실 정보</h3>
                <button class="btn-close" onclick="closeVacancySelectionModal()" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #6b7280;">×</button>
            </div>
            
            <div class="modal-body" style="flex: 1; overflow-y: auto; padding: 16px 20px;">
                <div style="background: #dbeafe; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: #1e40af;">
                    💡 임대안내문에서 추출된 공실 정보입니다. 선택하여 Comp List에 추가하거나 신규로 입력할 수 있습니다.
                </div>
                
                <div style="background: #fef3c7; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 12px; color: #92400e;">
                    ⚠️ 여기서 편집/삭제해도 <strong>원본 안내문 데이터는 변경되지 않습니다.</strong>
                </div>
                
                <!-- 회사/발행년월별 그룹 -->
                <div id="vacancySourceGroups">
                    ${groups.map((group, gIdx) => `
                        <div class="vacancy-source-group" style="border: 1px solid #e5e7eb; border-radius: 10px; margin-bottom: 12px; overflow: hidden;">
                            <div style="background: #f8fafc; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #e5e7eb;">
                                <div>
                                    <span style="font-weight: 600; color: #374151;">${group.source}</span>
                                    <span style="font-size: 12px; color: #6b7280; margin-left: 8px;">${group.publishDate}</span>
                                </div>
                                <div style="display: flex; gap: 8px;">
                                    <button class="btn btn-sm btn-outline" onclick="selectAllVacanciesInGroup(${gIdx})" style="padding: 4px 8px; font-size: 11px; border: 1px solid #d1d5db; background: white; border-radius: 4px; cursor: pointer;">전체 선택</button>
                                    <span style="font-size: 12px; color: #9ca3af;">${group.vacancies.length}개 공실</span>
                                </div>
                            </div>
                            <div style="padding: 12px;">
                                ${group.vacancies.map((v, vIdx) => `
                                    <label class="vacancy-select-item" style="display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px; cursor: pointer; transition: all 0.2s;"
                                           onmouseover="this.style.background='#f0f9ff'; this.style.borderColor='#3b82f6';"
                                           onmouseout="this.style.background=''; this.style.borderColor='#e5e7eb';">
                                        <input type="checkbox" class="vacancy-checkbox" data-group="${gIdx}" data-idx="${vIdx}" 
                                               data-vacancy='${JSON.stringify(v).replace(/'/g, "&#39;")}'
                                               style="width: 18px; height: 18px;">
                                        <div style="flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; font-size: 12px;">
                                            <div>
                                                <span style="color: #9ca3af;">층수</span>
                                                <div style="font-weight: 600; color: #374151;">${v.floor || '-'}</div>
                                            </div>
                                            <div>
                                                <span style="color: #9ca3af;">임대면적</span>
                                                <div style="font-weight: 600; color: #374151;">${v.rentArea || '-'}평</div>
                                            </div>
                                            <div>
                                                <span style="color: #9ca3af;">임대료</span>
                                                <div style="font-weight: 600; color: #374151;">${v.rentPy || '-'}만</div>
                                            </div>
                                            <div>
                                                <span style="color: #9ca3af;">입주시기</span>
                                                <div style="font-weight: 600; color: #374151;">${v.moveInDate || v.moveIn || '즉시'}</div>
                                            </div>
                                        </div>
                                    </label>
                                `).join('')}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            
            <div class="modal-footer" style="padding: 16px 20px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; background: #f9fafb;">
                <button class="btn btn-outline" onclick="openVacancyModal('${buildingId}', -1, true)" style="padding: 8px 16px; border: 1px solid #d1d5db; background: white; border-radius: 6px; cursor: pointer; font-size: 13px;">
                    ➕ 신규 공실 입력
                </button>
                <div style="display: flex; gap: 8px;">
                    <button class="btn btn-secondary" onclick="closeVacancySelectionModal()" style="padding: 8px 16px; border: 1px solid #d1d5db; background: white; border-radius: 6px; cursor: pointer; font-size: 13px;">취소</button>
                    <button class="btn btn-primary" onclick="addSelectedVacancies('${buildingId}')" style="padding: 8px 16px; border: none; background: #3b82f6; color: white; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">
                        선택 항목 추가
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 클릭으로 닫기
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeVacancySelectionModal();
    });
    
    // 그룹 데이터 저장
    window._vacancySelectionGroups = groups;
};

window.closeVacancySelectionModal = function() {
    const modal = document.getElementById('vacancySelectionModal');
    if (modal) modal.remove();
    window._vacancySelectionGroups = null;
};

// 그룹 내 전체 선택
window.selectAllVacanciesInGroup = function(groupIdx) {
    const checkboxes = document.querySelectorAll(`.vacancy-checkbox[data-group="${groupIdx}"]`);
    const allChecked = Array.from(checkboxes).every(cb => cb.checked);
    checkboxes.forEach(cb => cb.checked = !allChecked);
};

// 선택된 공실 추가
window.addSelectedVacancies = function(buildingId) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const checkboxes = document.querySelectorAll('.vacancy-checkbox:checked');
    if (checkboxes.length === 0) {
        showToast('추가할 공실을 선택하세요', 'warning');
        return;
    }
    
    // 숫자 파싱 헬퍼
    const parseNum = (val) => {
        if (val === null || val === undefined || val === '') return 0;
        const str = String(val).replace(/,/g, '');
        return parseFloat(str) || 0;
    };
    
    // 선택된 공실 추가 (복사본으로)
    if (!building.vacancies) building.vacancies = [];
    
    // ★ 중복 체크
    const existingFloors = building.vacancies.map(v => v.floor);
    const selectedVacancies = [];
    const duplicates = [];
    
    checkboxes.forEach(cb => {
        const v = JSON.parse(cb.dataset.vacancy);
        const floor = v.floor || '';
        
        if (existingFloors.includes(floor)) {
            duplicates.push(floor);
        }
        selectedVacancies.push(v);
    });
    
    // 중복이 있으면 사용자에게 확인
    if (duplicates.length > 0) {
        const uniqueDuplicates = [...new Set(duplicates)];
        const action = confirm(
            `다음 층은 이미 추가되어 있습니다:\n${uniqueDuplicates.join(', ')}\n\n` +
            `[확인] 기존 공실 유지하고 새 공실만 추가\n` +
            `[취소] 추가 취소`
        );
        if (!action) {
            return;
        }
    }
    
    // 중복되지 않은 공실만 추가
    let addedCount = 0;
    selectedVacancies.forEach(v => {
        const floor = v.floor || '';
        
        // 중복 건너뛰기
        if (existingFloors.includes(floor)) {
            return;
        }
        
        building.vacancies.push({
            floor,
            moveInDate: v.moveInDate || v.moveIn || '즉시',
            rentArea: parseNum(v.rentArea),
            exclusiveArea: parseNum(v.exclusiveArea),
            depositPy: parseNum(v.depositPy),
            rentPy: parseNum(v.rentPy),
            maintenancePy: parseNum(v.maintenancePy),
            rentFree: v.rentFree || '0',
            contractPeriod: v.contractPeriod || '',
            maintenanceDetail: v.maintenanceDetail || '',
            // ★ 출처 정보 (원본 추적용)
            _sourceInfo: {
                source: v.source || '',
                publishDate: v.publishDate || '',
                loadedFrom: 'leasing-guide',
                loadedAt: new Date().toISOString()
            }
        });
        addedCount++;
    });
    
    closeVacancySelectionModal();
    renderDetailView();
    
    if (addedCount > 0) {
        showToast(`${addedCount}개 공실이 추가되었습니다${duplicates.length > 0 ? ` (중복 ${duplicates.length}개 제외)` : ''}`, 'success');
    } else {
        showToast('모든 공실이 이미 추가되어 있습니다', 'warning');
    }
};

// ============================================================
// ★ 빌딩별 공실 관리 모달
// ============================================================
window.openVacancyManageModal = function(buildingId) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) {
        showToast('빌딩을 찾을 수 없습니다', 'error');
        return;
    }
    
    const vacancies = building.vacancies || [];
    
    // portal에서 불러올 수 있는 공실 확인
    const portalBuilding = pageState.allBuildings.find(b => b.id === buildingId);
    const portalVacancies = portalBuilding?.vacancies || [];
    
    // 모달 생성
    let modal = document.getElementById('vacancyManageModal');
    if (modal) modal.remove();
    
    modal = document.createElement('div');
    modal.id = 'vacancyManageModal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 10002;
        display: flex;
        align-items: center;
        justify-content: center;
    `;
    
    modal.innerHTML = `
        <div style="background: white; border-radius: 12px; width: 90%; max-width: 600px; max-height: 85vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 20px 60px rgba(0,0,0,0.3);">
            <div style="padding: 16px 20px; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; font-size: 16px; font-weight: 600;">📋 ${building.buildingName} 공실 관리</h3>
                <button onclick="closeVacancyManageModal()" style="background: none; border: none; font-size: 24px; cursor: pointer; color: #6b7280;">×</button>
            </div>
            
            <div style="flex: 1; overflow-y: auto; padding: 16px 20px;">
                ${vacancies.length === 0 ? `
                    <div style="text-align: center; padding: 40px 20px; color: #6b7280;">
                        <div style="font-size: 48px; margin-bottom: 12px;">📭</div>
                        <div style="font-size: 14px;">등록된 공실이 없습니다</div>
                        ${portalVacancies.length > 0 ? `
                            <div style="margin-top: 16px; padding: 12px; background: #dbeafe; border-radius: 8px; font-size: 13px; color: #1e40af;">
                                💡 안내문에서 추출된 공실 ${portalVacancies.length}개를 추가할 수 있습니다.
                            </div>
                        ` : ''}
                    </div>
                ` : `
                    <div style="margin-bottom: 16px; padding: 12px; background: #f0fdf4; border-radius: 8px; font-size: 13px; color: #166534;">
                        ✅ 현재 ${vacancies.length}개 공실이 등록되어 있습니다.
                    </div>
                    
                    <div id="vacancyManageList">
                        ${vacancies.map((v, idx) => `
                            <div class="vacancy-manage-item" style="display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px;">
                                <div style="flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; font-size: 12px;">
                                    <div>
                                        <span style="color: #9ca3af;">층수</span>
                                        <div style="font-weight: 600; color: #374151;">${v.floor || '-'}</div>
                                    </div>
                                    <div>
                                        <span style="color: #9ca3af;">임대면적</span>
                                        <div style="font-weight: 600; color: #374151;">${v.rentArea || '-'}평</div>
                                    </div>
                                    <div>
                                        <span style="color: #9ca3af;">임대료</span>
                                        <div style="font-weight: 600; color: #374151;">${v.rentPy || '-'}만</div>
                                    </div>
                                    <div>
                                        <span style="color: #9ca3af;">입주시기</span>
                                        <div style="font-weight: 600; color: #374151;">${v.moveInDate || '즉시'}</div>
                                    </div>
                                </div>
                                <button onclick="deleteVacancyFromManage('${buildingId}', ${idx})" 
                                        style="padding: 6px 10px; border: 1px solid #fecaca; background: #fef2f2; border-radius: 6px; cursor: pointer; font-size: 12px; color: #dc2626;">
                                    삭제
                                </button>
                            </div>
                        `).join('')}
                    </div>
                `}
            </div>
            
            <div style="padding: 16px 20px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; background: #f9fafb;">
                <div style="display: flex; gap: 8px;">
                    ${vacancies.length > 0 ? `
                        <button onclick="clearAllVacancies('${buildingId}')" 
                                style="padding: 8px 16px; border: 1px solid #fecaca; background: #fef2f2; border-radius: 6px; cursor: pointer; font-size: 13px; color: #dc2626;">
                            🗑️ 전체 삭제
                        </button>
                    ` : ''}
                </div>
                <div style="display: flex; gap: 8px;">
                    <button onclick="closeVacancyManageModal()" 
                            style="padding: 8px 16px; border: 1px solid #d1d5db; background: white; border-radius: 6px; cursor: pointer; font-size: 13px;">
                        닫기
                    </button>
                    <button onclick="closeVacancyManageModal(); addVacancyToBuilding('${buildingId}')" 
                            style="padding: 8px 16px; border: none; background: #3b82f6; color: white; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500;">
                        ➕ 공실 추가
                    </button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 클릭으로 닫기
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeVacancyManageModal();
    });
};

window.closeVacancyManageModal = function() {
    const modal = document.getElementById('vacancyManageModal');
    if (modal) modal.remove();
};

// 공실 관리 모달에서 개별 삭제
window.deleteVacancyFromManage = function(buildingId, vacancyIdx) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building || !building.vacancies) return;
    
    const vacancy = building.vacancies[vacancyIdx];
    if (!vacancy) return;
    
    if (!confirm(`${vacancy.floor || ''}층 공실을 삭제하시겠습니까?`)) return;
    
    building.vacancies.splice(vacancyIdx, 1);
    
    // 모달 다시 열기 (갱신)
    openVacancyManageModal(buildingId);
    renderDetailView();
    showToast('공실이 삭제되었습니다', 'info');
};

// 공실 전체 삭제
window.clearAllVacancies = function(buildingId) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) return;
    
    const count = building.vacancies?.length || 0;
    if (count === 0) return;
    
    if (!confirm(`${building.buildingName}의 공실 ${count}개를 모두 삭제하시겠습니까?`)) return;
    
    building.vacancies = [];
    
    // 모달 다시 열기 (갱신)
    openVacancyManageModal(buildingId);
    renderDetailView();
    showToast(`${count}개 공실이 삭제되었습니다`, 'info');
};

// ============================================================
// ★ 건축물대장 로딩 오버레이
// ============================================================
function showLedgerLoadingOverlay(buildingName) {
    let overlay = document.getElementById('ledgerLoadingOverlay');
    if (overlay) overlay.remove();
    
    overlay = document.createElement('div');
    overlay.id = 'ledgerLoadingOverlay';
    overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.6);
        z-index: 10003;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 20px;
    `;
    
    overlay.innerHTML = `
        <div style="background: white; border-radius: 16px; padding: 32px 48px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
            <div style="margin-bottom: 20px;">
                <div class="ledger-spinner" style="
                    width: 50px;
                    height: 50px;
                    border: 4px solid #e5e7eb;
                    border-top: 4px solid #3b82f6;
                    border-radius: 50%;
                    animation: ledgerSpin 1s linear infinite;
                    margin: 0 auto;
                "></div>
            </div>
            <div style="font-size: 16px; font-weight: 600; color: #374151; margin-bottom: 8px;">
                건축물대장 정보 갱신중
            </div>
            <div style="font-size: 13px; color: #6b7280;">
                ${buildingName}의 정보를 조회하고 있습니다...
            </div>
            <div style="font-size: 11px; color: #9ca3af; margin-top: 12px;">
                잠시만 기다려주세요
            </div>
        </div>
        <style>
            @keyframes ledgerSpin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        </style>
    `;
    
    document.body.appendChild(overlay);
}

function hideLedgerLoadingOverlay() {
    const overlay = document.getElementById('ledgerLoadingOverlay');
    if (overlay) overlay.remove();
}

// ============================================================
// portal.html 공실 정보 확인/불러오기
// ============================================================

// portal.html(allBuildings)에 공실 정보가 있는지 확인
function checkPortalVacancies(buildingId) {
    const portalBuilding = pageState.allBuildings.find(b => b.id === buildingId);
    if (!portalBuilding) return false;
    
    // vacancies 배열 확인
    if (portalBuilding.vacancies && Array.isArray(portalBuilding.vacancies) && portalBuilding.vacancies.length > 0) {
        return true;
    }
    
    // _raw.vacancies 확인
    if (portalBuilding._raw?.vacancies && Array.isArray(portalBuilding._raw.vacancies) && portalBuilding._raw.vacancies.length > 0) {
        return true;
    }
    
    return false;
}

// portal.html에서 공실 정보 불러오기
window.loadVacanciesFromPortal = function(buildingId) {
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) {
        showToast('빌딩을 찾을 수 없습니다', 'error');
        return;
    }
    
    const portalBuilding = pageState.allBuildings.find(b => b.id === buildingId);
    if (!portalBuilding) {
        showToast('원본 빌딩 데이터를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 공실 정보 추출
    let portalVacancies = [];
    if (portalBuilding.vacancies && Array.isArray(portalBuilding.vacancies)) {
        portalVacancies = portalBuilding.vacancies;
    } else if (portalBuilding._raw?.vacancies && Array.isArray(portalBuilding._raw.vacancies)) {
        portalVacancies = portalBuilding._raw.vacancies;
    }
    
    if (portalVacancies.length === 0) {
        showToast('불러올 공실 정보가 없습니다', 'warning');
        return;
    }
    
    // 기존 공실이 있으면 확인
    const existingCount = building.vacancies?.length || 0;
    if (existingCount > 0) {
        const action = confirm(
            `현재 ${existingCount}개의 공실이 있습니다.\n` +
            `portal.html에서 ${portalVacancies.length}개의 공실을 불러옵니다.\n\n` +
            `[확인] 기존 공실에 추가\n` +
            `[취소] 기존 공실 유지`
        );
        if (!action) return;
    }
    
    // 숫자 파싱 헬퍼 (콤마 제거)
    const parseNum = (val) => {
        if (val === null || val === undefined || val === '') return 0;
        // 문자열이면 콤마 제거
        const str = String(val).replace(/,/g, '');
        return parseFloat(str) || 0;
    };
    
    // 공실 정보 변환 및 추가
    const newVacancies = portalVacancies.map(v => ({
        floor: v.floor || '',
        moveInDate: v.moveInDate || v.moveIn || '즉시',
        rentArea: parseNum(v.rentArea),
        exclusiveArea: parseNum(v.exclusiveArea),
        depositPy: parseNum(v.depositPy),
        rentPy: parseNum(v.rentPy),
        maintenancePy: parseNum(v.maintenancePy),
        rentFree: v.rentFree || '0',
        contractPeriod: v.contractPeriod || '',
        maintenanceDetail: v.maintenanceDetail || '',
        // 출처 정보 보존
        source: v.source || '',
        publishDate: v.publishDate || '',
        loadedFrom: 'portal',
        loadedAt: new Date().toISOString()
    }));
    
    // 기존 공실 배열에 추가
    if (!building.vacancies) building.vacancies = [];
    building.vacancies.push(...newVacancies);
    
    // UI 새로고침
    renderDetailView();
    showToast(`${newVacancies.length}개 공실 정보를 불러왔습니다`, 'success');
};

// 특정 빌딩의 portal 공실 정보 미리보기
window.previewPortalVacancies = function(buildingId) {
    const portalBuilding = pageState.allBuildings.find(b => b.id === buildingId);
    if (!portalBuilding) return;
    
    let portalVacancies = portalBuilding.vacancies || portalBuilding._raw?.vacancies || [];
    if (portalVacancies.length === 0) {
        showToast('불러올 공실 정보가 없습니다', 'warning');
        return;
    }
    
    // 미리보기 모달 또는 알림 표시
    const preview = portalVacancies.map((v, i) => 
        `${i + 1}. ${v.floor || '-'}층 / ${v.rentArea || '-'}평 / ${v.rentPy || '-'}만원`
    ).join('\n');
    
    alert(`portal.html 공실 정보 (${portalVacancies.length}개):\n\n${preview}`);
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
    
    // ★ 노출 옵션 체크 확인
    const exposeCheckbox = document.getElementById('vf_exposeToPortal');
    const shouldExposeToPortal = exposeCheckbox && exposeCheckbox.checked;
    
    if (shouldExposeToPortal) {
        // 사용자 정보로 source 설정
        const userName = pageState.currentUser?.name || pageState.currentUser?.email?.split('@')[0] || '사용자';
        const now = new Date();
        const publishDate = `${String(now.getFullYear()).slice(2)}.${String(now.getMonth() + 1).padStart(2, '0')}`;
        
        vacancyData.source = userName;
        vacancyData.publishDate = publishDate;
        vacancyData.createdBy = pageState.currentUser?.email || 'unknown';
        vacancyData.createdAt = now.toISOString();
        vacancyData._userInputted = true;  // 사용자 직접 입력 표시
    }
    
    if (vacancyIdx >= 0 && building.vacancies[vacancyIdx]) {
        // 수정
        building.vacancies[vacancyIdx] = { ...building.vacancies[vacancyIdx], ...vacancyData };
        showToast('공실 정보 수정됨', 'success');
    } else {
        // 추가
        building.vacancies.push(vacancyData);
        showToast('공실 추가됨', 'success');
    }
    
    // ★ 노출 옵션이 체크되면 Firebase vacancies에도 저장
    if (shouldExposeToPortal) {
        try {
            const vacancyRef = push(ref(db, `vacancies`));
            await set(vacancyRef, {
                buildingId,
                buildingName: building.buildingName,
                ...vacancyData,
                updatedAt: new Date().toISOString()
            });
            
            showToast('공실 정보가 안내문 메뉴에서도 조회됩니다', 'info');
        } catch (e) {
            console.error('공실 노출 저장 실패:', e);
            // 노출 저장 실패해도 complist에는 추가됨
        }
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
    const imageUrl = getExteriorUrl(bd);
    
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
        // ★ images.exterior 배열도 삭제 (portal.html 호환)
        if (building.buildingData.images) {
            delete building.buildingData.images.exterior;
        }
    }
    
    // Firebase에서도 삭제
    try {
        await update(ref(db, `buildings/${buildingId}`), {
            exteriorImage: null,
            mainImage: null,
            updatedAt: new Date().toISOString()
        });
        // ★ images/exterior도 삭제 (portal.html 호환)
        await update(ref(db, `buildings/${buildingId}/images`), {
            exterior: null
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
            // ★ images.exterior 배열에도 반영 (portal.html 호환)
            if (!building.buildingData.images) building.buildingData.images = {};
            building.buildingData.images.exterior = [{ url: imageData, name: 'exterior_complist.jpg' }];
        }
        
        // Firebase에도 저장 (빌딩 정보 업데이트)
        try {
            await update(ref(db, `buildings/${buildingId}`), {
                exteriorImage: imageData,
                updatedAt: new Date().toISOString()
            });
            // ★ images/exterior에도 저장 (portal.html 호환)
            await update(ref(db, `buildings/${buildingId}/images`), {
                exterior: [{ url: imageData, name: 'exterior_complist.jpg' }]
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
// 평면도 이미지 관리 (여러 이미지 지원)
// ============================================================
window.openFloorPlanModal = function(buildingId, buildingIdx) {
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    const floorPlanImages = bd.floorPlanImages || bd.images?.floorPlan || [];
    
    // 모달 HTML 생성
    let modalHtml = `
        <div id="floorPlanModal" class="modal show" style="z-index: 2000;">
            <div class="modal-content" style="max-width: 700px;">
                <div class="modal-header">
                    <h3>📐 ${building.buildingName} 평면도</h3>
                    <button class="btn-close" onclick="closeFloorPlanModal()">×</button>
                </div>
                <div class="modal-body" style="padding: 20px;">
                    <input type="hidden" id="fp_buildingId" value="${buildingId}">
                    <input type="hidden" id="fp_buildingIdx" value="${buildingIdx}">
                    
                    <!-- 이미지 목록 -->
                    <div id="floorPlanImageList" style="display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; min-height: 100px;">
                        ${floorPlanImages.length > 0 ? floorPlanImages.map((img, idx) => `
                            <div class="floor-plan-thumb" style="position: relative; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                                <img src="${img}" style="width: 150px; height: 100px; object-fit: contain; background: #f8f9fa; cursor: pointer;" onclick="viewFloorPlanImage(${idx})">
                                <button onclick="deleteFloorPlanImage(${idx})" style="position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border-radius: 50%; background: rgba(220,38,38,0.9); color: white; border: none; cursor: pointer; font-size: 14px;">×</button>
                            </div>
                        `).join('') : '<div style="display: flex; align-items: center; justify-content: center; width: 100%; color: #9ca3af; font-size: 14px;">등록된 평면도가 없습니다</div>'}
                    </div>
                    
                    <!-- 업로드 버튼 -->
                    <div style="border: 2px dashed #d1d5db; border-radius: 8px; padding: 20px; text-align: center; cursor: pointer; transition: all 0.2s;" 
                         onclick="document.getElementById('floorPlanFileInput').click()"
                         onmouseover="this.style.borderColor='#3b82f6'; this.style.background='#eff6ff';"
                         onmouseout="this.style.borderColor='#d1d5db'; this.style.background='transparent';">
                        <div style="font-size: 32px; margin-bottom: 8px;">📷</div>
                        <div style="color: #6b7280;">클릭하여 평면도 이미지 추가</div>
                        <div style="color: #9ca3af; font-size: 12px; margin-top: 4px;">JPG, PNG 지원 (여러 장 추가 가능)</div>
                    </div>
                    <input type="file" id="floorPlanFileInput" accept="image/*" style="display: none;" onchange="handleFloorPlanUpload(this)">
                </div>
                <div class="modal-footer" style="padding: 16px 20px; border-top: 1px solid #e5e7eb; display: flex; justify-content: flex-end; gap: 8px;">
                    <button class="btn-secondary" onclick="closeFloorPlanModal()">닫기</button>
                </div>
            </div>
        </div>
    `;
    
    // 기존 모달이 있으면 제거
    const existingModal = document.getElementById('floorPlanModal');
    if (existingModal) existingModal.remove();
    
    // 모달 추가
    document.body.insertAdjacentHTML('beforeend', modalHtml);
};

window.closeFloorPlanModal = function() {
    const modal = document.getElementById('floorPlanModal');
    if (modal) modal.remove();
};

window.viewFloorPlanImage = function(imageIdx) {
    const buildingIdx = parseInt(document.getElementById('fp_buildingIdx').value);
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    const floorPlanImages = bd.floorPlanImages || bd.images?.floorPlan || [];
    
    if (floorPlanImages[imageIdx]) {
        // 이미지 뷰어 모달
        const viewerHtml = `
            <div id="floorPlanViewer" style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 3000; display: flex; align-items: center; justify-content: center; cursor: pointer;" onclick="this.remove()">
                <img src="${floorPlanImages[imageIdx]}" style="max-width: 90%; max-height: 90%; object-fit: contain;">
                <button style="position: absolute; top: 20px; right: 20px; width: 40px; height: 40px; border-radius: 50%; background: rgba(255,255,255,0.2); color: white; border: none; cursor: pointer; font-size: 24px;">×</button>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', viewerHtml);
    }
};

window.deleteFloorPlanImage = async function(imageIdx) {
    if (!confirm('이 평면도 이미지를 삭제하시겠습니까?')) return;
    
    const buildingId = document.getElementById('fp_buildingId').value;
    const buildingIdx = parseInt(document.getElementById('fp_buildingIdx').value);
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    const bd = building.buildingData || {};
    let floorPlanImages = bd.floorPlanImages || bd.images?.floorPlan || [];
    
    // 배열에서 제거
    floorPlanImages = floorPlanImages.filter((_, idx) => idx !== imageIdx);
    
    // 로컬 상태 업데이트
    if (!building.buildingData) building.buildingData = {};
    building.buildingData.floorPlanImages = floorPlanImages;
    if (!building.buildingData.images) building.buildingData.images = {};
    building.buildingData.images.floorPlan = floorPlanImages;
    
    // Firebase 업데이트
    try {
        await update(ref(db, `buildings/${buildingId}/images`), {
            floorPlan: floorPlanImages
        });
        
        showToast('평면도 이미지가 삭제되었습니다', 'success');
        
        // 모달 새로고침
        closeFloorPlanModal();
        openFloorPlanModal(buildingId, buildingIdx);
        renderDetailView();
    } catch (e) {
        console.error('평면도 삭제 실패:', e);
        showToast('평면도 삭제 실패', 'error');
    }
};

window.handleFloorPlanUpload = async function(input) {
    const file = input.files[0];
    if (!file) return;
    
    const buildingId = document.getElementById('fp_buildingId').value;
    const buildingIdx = parseInt(document.getElementById('fp_buildingIdx').value);
    const building = pageState.editData.buildings[buildingIdx];
    if (!building) return;
    
    // 파일 크기 체크 (5MB 제한)
    if (file.size > 5 * 1024 * 1024) {
        showToast('파일 크기는 5MB 이하여야 합니다', 'warning');
        return;
    }
    
    const reader = new FileReader();
    reader.onload = async (e) => {
        const imageData = e.target.result;
        
        const bd = building.buildingData || {};
        let floorPlanImages = bd.floorPlanImages || bd.images?.floorPlan || [];
        
        // 배열에 추가
        floorPlanImages = [...floorPlanImages, imageData];
        
        // 로컬 상태 업데이트
        if (!building.buildingData) building.buildingData = {};
        building.buildingData.floorPlanImages = floorPlanImages;
        if (!building.buildingData.images) building.buildingData.images = {};
        building.buildingData.images.floorPlan = floorPlanImages;
        
        // Firebase 업데이트
        try {
            await update(ref(db, `buildings/${buildingId}/images`), {
                floorPlan: floorPlanImages
            });
            
            showToast('평면도 이미지가 추가되었습니다', 'success');
            
            // 모달 새로고침
            closeFloorPlanModal();
            openFloorPlanModal(buildingId, buildingIdx);
            renderDetailView();
        } catch (e) {
            console.error('평면도 업로드 실패:', e);
            showToast('평면도 업로드 실패', 'error');
        }
    };
    reader.readAsDataURL(file);
    
    // 파일 입력 초기화 (같은 파일 다시 선택 가능하도록)
    input.value = '';
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
        
        // ※ 동기화 가능한 필드만 (건축물대장 필드 제외)
        // 건축물대장 필드: address, addressJibun, completionYear, floors, scale,
        //                 grossFloorPy, grossFloorSqm, landArea, buildingArea,
        //                 parkingTotal, elevators, passengerElevator, freightElevator,
        //                 structure, buildingUse (구조, 건물용도)
        const syncFields = {};
        const editableKeys = [
            // 수동 입력 기초정보
            'nearestStation', 'nearbyStation', 'station', 'stationDistance',
            'typicalFloorPy', 'typicalFloorSqm', 'typicalFloorLeasePy',
            'exclusiveRate', 'dedicatedRate',
            'region', 'regionId', 'grade',
            // 채권분석
            'owner', 'bondStatus', 'jointCollateral', 'seniorLien', 
            'collateralRatio', 'officialLandPrice', 'landPriceApplied',
            // 주차 (대수 제외)
            'parkingRatio', 'parkingInfo', 'freeParkingCondition', 'paidParking', 'parkingFee',
            // 임대조건
            'depositPy', 'rentPy', 'maintenancePy',
            // 시설 정보 (엘리베이터, 구조, 용도 제외 - 건축물대장)
            'hvac', 'heatingCooling',
            // 기타
            'floorPlan', 'remarks', 'exteriorImage', 'mainImage', 'description', 'pm',
            // S&I 시세자료 양식 (상세 사양 + 딜 조건 + 임차 특이사항)
            ...SNI_BUILDING_KEYS
        ];
        
        for (const key of editableKeys) {
            const value = b.buildingData[key];
            if (value !== undefined && value !== null && value !== '') {
                syncFields[key] = value;
            }
        }
        
        // ※ 추가: nearestStation ↔ nearbyStation 상호 동기화
        // complist에서 nearestStation을 사용하지만, portal에서 nearbyStation으로 읽음
        if (b.buildingData.nearestStation && !syncFields.nearbyStation) {
            syncFields.nearbyStation = b.buildingData.nearestStation;
        }
        if (b.buildingData.nearbyStation && !syncFields.nearestStation) {
            syncFields.nearestStation = b.buildingData.nearbyStation;
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
    // ※ 수정: undefined 방지 - Firebase는 undefined 저장 불가
    pageState.editData.updatedBy = {
        id: pageState.currentUser?.id || '',
        name: pageState.currentUser?.name || pageState.currentUser?.email?.split('@')[0] || 'unknown',
        email: pageState.currentUser?.email || ''
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
                selectedVacancyIdxs: b.selectedVacancyIdxs || [],  // S&I 양식 열 구성용
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
    
    // ★ 이미지 데이터 제외 함수 (localStorage 용량 절약)
    const stripImageData = (buildingData) => {
        if (!buildingData) return {};
        
        // 제외할 이미지 관련 키
        const imageKeys = [
            'exteriorImage', 'exteriorImages', 'mainImage',
            'floorPlanImages', 'images', 'floorPlan',
            '_raw'  // 원본 데이터도 제외 (이미지 포함 가능)
        ];
        
        const filtered = {};
        for (const [key, value] of Object.entries(buildingData)) {
            // 이미지 키 제외
            if (imageKeys.includes(key)) continue;
            
            // base64 이미지 데이터 제외 (data:image로 시작하는 문자열)
            if (typeof value === 'string' && value.startsWith('data:image')) continue;
            
            // 배열인 경우 base64 이미지 필터링
            if (Array.isArray(value)) {
                const filteredArr = value.filter(item => {
                    if (typeof item === 'string' && item.startsWith('data:image')) return false;
                    if (item?.url && item.url.startsWith('data:image')) return false;
                    return true;
                });
                if (filteredArr.length > 0) filtered[key] = filteredArr;
                continue;
            }
            
            filtered[key] = value;
        }
        return filtered;
    };
    
    const draftData = {
        ...pageState.editData,
        buildings: pageState.editData.buildings.map(b => ({
            buildingId: b.buildingId || '',
            buildingName: b.buildingName || '',
            vacancies: b.vacancies || [],
            selectedVacancyIdxs: b.selectedVacancyIdxs || [],  // S&I 양식 열 구성용
            buildingData: stripImageData(b.buildingData),  // ★ 이미지 제외
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
                    ${getTemplate(d.type).label} · ${d.buildingCount}개 빌딩 · ${formatDate(d.savedAt)}
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
    
    // ※ undefined 방지 - Firebase는 undefined 저장 불가
    const newCompList = {
        title,
        type: pageState.newCompListType || 'general',
        status: 'draft',
        buildings: [],
        createdAt: new Date().toISOString(),
        createdBy: {
            id: pageState.currentUser?.id || '',
            name: pageState.currentUser?.name || pageState.currentUser?.email?.split('@')[0] || 'unknown',
            email: pageState.currentUser?.email || ''
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
    
    // ★ 수정: 빌딩 데이터 병합 (웹 편집 값 우선)
    const buildingsWithData = data.buildings.map(b => {
        const fullBuilding = pageState.allBuildings.find(ab => ab.id === b.buildingId);
        
        // ★ 핵심 수정: fullBuilding과 b.buildingData를 병합
        // b.buildingData의 값이 우선 적용되어 웹에서 편집한 채권분석 등이 반영됨
        const mergedBuildingData = {
            ...(fullBuilding || {}),      // 원본 빌딩 데이터
            ...(b.buildingData || {})     // 웹에서 편집한 값 (우선)
        };
        
        return {
            ...b,
            buildingData: mergedBuildingData
        };
    });
    
    console.log('엑셀 다운로드 - 병합된 빌딩 데이터:', buildingsWithData.map(b => ({
        name: b.buildingData?.name,
        owner: b.buildingData?.owner,
        bondStatus: b.buildingData?.bondStatus,
        jointCollateral: b.buildingData?.jointCollateral
    })));
    
    await getTemplate(data.type).exportExcel({ ...data, buildings: buildingsWithData });
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
    
    // ★ 수정: 열 구조 변경 — A: 대항목, B: 항목명, C부터 빌딩
    const colWidth = entries.length <= 5 ? 26 : (entries.length <= 10 ? 22 : 18);
    sheet.columns = [
        { width: 10 },  // A열 (대항목)
        { width: 18 },  // B열 (항목명)
        ...entries.map(() => ({ width: colWidth }))  // C열부터 빌딩 데이터
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
    
    // ★ 수정: B열만 사용, 빌딩 데이터는 C열부터
    // 헤더
    sheet.mergeCells('B3:B4');
    setCell('B3', 'PRESENT TO :', { fill: 'FF2C2A2A', font: { color: { argb: 'FFFFFFFF' }, bold: true } });
    
    // 빌딩 헤더 (C열부터)
    entries.forEach((e, i) => {
        const col = getCol(3 + i);  // ★ C열부터 시작
        const floorInfo = e.vacancy?.floor ? ` (${e.vacancy.floor})` : '';
        setCell(`${col}4`, e.building.buildingName + floorInfo, { fill: 'FFCCCCCC', font: { bold: true } });
    });
    
    // 외관사진 행 (행 5-6)
    sheet.getRow(5).height = 15;
    sheet.getRow(6).height = 100; // 외관사진 높이
    sheet.mergeCells('B5:B6');
    setCell('B5', '외관사진', { fill: 'FFE0F2FE', font: { bold: true } });
    
    // 이미지 삽입
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const col = getCol(3 + i);  // ★ C열부터 시작
        const bd = e.building.buildingData || {};
        const imageUrl = getExteriorUrl(bd);
        
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
                    
                    // ★ 열 인덱스 수정 (C열=2부터 시작)
                    sheet.addImage(imageId, {
                        tl: { col: 2 + i, row: 4 }, // 0-indexed, 행5 = row 4
                        br: { col: 3 + i, row: 6 },  // 행6까지
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
    
    // ★ v10.2: A열 대항목 카테고리 렌더링
    setCell('A6', '빌딩개요/일반', { fill: 'FFFFFFFF', font: { bold: true } });
    categories.forEach(cat => {
        if (cat.rowspan > 1) {
            sheet.mergeCells(`A${cat.row}:A${cat.row + cat.rowspan - 1}`);
        }
        setCell(`A${cat.row}`, cat.label, { fill: cat.fill, font: { bold: true } });
    });
    
    // ★ B열 항목명 (기존 C열 라벨을 B열로 이동) — "주차 대수"→"무료주차"
    const bLabels = {
        7: '주소 지번', 8: '도로명 주소', 9: '위치', 10: '빌딩 규모', 11: '준공연도',
        12: '전용률 (%)', 13: '기준층 임대면적 (m²)', 14: '기준층 임대면적 (평)',
        15: '기준층 전용면적 (m²)', 16: '기준층 전용면적 (평)', 17: '엘레베이터', 18: '냉난방 방식',
        19: '건물용도', 20: '구조', 21: '주차 대수 정보', 22: '주차비', 23: '무료주차',
        25: '최적 임차 층수', 26: '입주 가능 시기', 27: '거래유형',
        28: '임대면적 (m²)', 29: '전용면적 (m²)', 30: '임대면적 (평)', 31: '전용면적 (평)',
        32: '월 평당 보증금', 33: '월 평당 임대료', 34: '월 평당 관리비', 35: '월 평당 지출비용',
        36: '총 보증금', 37: '월 임대료 총액', 38: '월 관리비 총액', 39: '월 전용면적당 지출비용',
        40: '보증금', 41: '렌트프리 (개월/년)', 42: '평균 임대료', 43: '관리비', 44: 'NOC',
        46: '보증금', 47: '평균 월 임대료', 48: '평균 월 관리비', 49: '월 (임대료 + 관리비)', 50: '연 실제 부담 고정금액'
    };
    
    // ★ B열에 항목명 설정
    Object.entries(bLabels).forEach(([row, label]) => {
        setCell(`B${row}`, label);
    });
    
    // 빌딩 데이터 (★ C열부터 시작)
    entries.forEach((e, i) => {
        const col = getCol(3 + i);  // ★ C열부터 시작
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
        // ★ v10.2: 무료주차 = freeParkingCondition 기반 계산
        const freeParkingCondition = parseFloat(bd.freeParkingCondition) || 0;
        const rentAreaForParking = parseFloat(v.rentArea) || 0;
        if (freeParkingCondition > 0 && rentAreaForParking > 0) {
            const freeCount = Math.floor(rentAreaForParking / freeParkingCondition);
            setCell(`${col}23`, `${freeCount}대 (${freeParkingCondition}평당 1대)`);
        } else if (freeParkingCondition > 0) {
            setCell(`${col}23`, `${freeParkingCondition}평당 1대`);
        } else {
            setCell(`${col}23`, '-');
        }
        
        // 임차 제안
        setCell(`${col}25`, v.floor || '-');
        setCell(`${col}26`, v.moveInDate || v.moveIn || '-');
        setCell(`${col}27`, '-');
        
        // ※ 수정: 기본값 제거 - 값이 없으면 빈 셀
        const rentAreaPy = parseFloat(v.rentArea) || 0;
        const exclusiveAreaPy = parseFloat(v.exclusiveArea) || 0;
        if (rentAreaPy > 0) {
            setFormula(`${col}28`, `ROUNDDOWN(${col}30*3.305785,3)`, '#,##0.000');
            setCell(`${col}30`, rentAreaPy, { numFmt: '#,##0.000' });
        } else {
            setCell(`${col}28`, '');
            setCell(`${col}30`, '');
        }
        if (exclusiveAreaPy > 0) {
            setFormula(`${col}29`, `ROUNDDOWN(${col}31*3.305785,3)`, '#,##0.000');
            setCell(`${col}31`, exclusiveAreaPy, { numFmt: '#,##0.000' });
        } else {
            setCell(`${col}29`, '');
            setCell(`${col}31`, '');
        }
        
        // 임대 기준
        // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화, * 10000 제거
        const depositPy = toWon(v.depositPy);
        const rentPy = toWon(v.rentPy);
        const maintenancePy = toWon(v.maintenancePy);
        
        setCell(`${col}32`, depositPy || '', { numFmt: '₩#,##0' });
        setCell(`${col}33`, rentPy || '', { numFmt: '₩#,##0' });
        setCell(`${col}34`, maintenancePy || '', { numFmt: '₩#,##0' });
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
    try {
        console.log('LG 엑셀 다운로드 시작...', data);
        
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('COMP');
        const buildings = data.buildings || [];
        
        if (buildings.length === 0) {
            showToast('다운로드할 빌딩이 없습니다', 'warning');
            return;
        }
        
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
        const imageUrl = getExteriorUrl(bd);
        
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
    
    // ★ 마이그레이션 호환: defaultValue를 원 단위로 변경
    const rentBaseRows = [
        { row: 45, label: '보증금', key: 'depositPy', defaultValue: 750000 },
        { row: 46, label: '임대료', key: 'rentPy', defaultValue: 75000 },
        { row: 47, label: '관리비', key: 'maintenancePy', defaultValue: 37000 }
    ];
    
    rentBaseRows.forEach(info => {
        sheet.mergeCells(`B${info.row}:D${info.row}`);
        setCell(`B${info.row}`, info.label);
        
        buildings.forEach((b, bIdx) => {
            const { col1, col3 } = getBuildingCols(bIdx);
            const v0 = (b.vacancies || [])[0] || {};
            
            sheet.mergeCells(`${col1}${info.row}:${col3}${info.row}`);
            // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화
            const value = toWon(v0[info.key]) || info.defaultValue;
            setCell(`${col1}${info.row}`, value, { fill: 'FFFFF2CC', numFmt: '₩#,##0' });
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
    
    // ★ 마이그레이션 호환: 셀 45-47이 이미 원 단위이므로 *10000 제거
    const costRows = [
        { row: 50, label: '보증금', formula: (c1) => `${c1}45*${c1}44` },
        { row: 51, label: '월 임대료', formula: (c1) => `${c1}46*${c1}44` },
        { row: 52, label: '월 관리비', formula: (c1) => `${c1}47*${c1}44` },
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
    // 행 63-71: 평면도 (외관사진과 동일한 9행)
    // ========================================
    sheet.mergeCells('A63:D71');
    setCell('A63', '평면도', { fill: 'FFE0F2FE', font: { bold: true } });
    
    for (let r = 63; r <= 71; r++) {
        sheet.getRow(r).height = 18;
    }
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        sheet.mergeCells(`${col1}63:${col3}71`);
        
        const bd = b.buildingData || {};
        // floorPlanImages 배열에서 첫 번째 이미지 가져오기
        const floorPlanImages = bd.floorPlanImages || bd.images?.floorPlan || [];
        const imageUrl = floorPlanImages.length > 0 ? 
            (typeof floorPlanImages[0] === 'string' ? floorPlanImages[0] : floorPlanImages[0]?.url) : '';
        
        if (imageUrl && imageUrl.startsWith('data:image')) {
            try {
                const base64Data = imageUrl.split(',')[1];
                const extension = imageUrl.includes('png') ? 'png' : 'jpeg';
                const imageId = workbook.addImage({ base64: base64Data, extension });
                sheet.addImage(imageId, {
                    tl: { col: 4 + bIdx * 3, row: 62 },
                    br: { col: 7 + bIdx * 3, row: 71 },
                    editAs: 'oneCell'
                });
            } catch (e) {
                setCell(`${col1}63`, '평면도 없음');
            }
        } else {
            setCell(`${col1}63`, imageUrl ? '평면도 있음' : '평면도 없음');
        }
    });
    
    // ========================================
    // 행 72: 기타 - 특이사항
    // ========================================
    // ★ 수정: A72:D72 전체 병합 제거, A72만 단독 사용
    setCell('A72', '기타', { fill: 'FFF3F4F6', font: { bold: true } });
    sheet.mergeCells('B72:D72');
    setCell('B72', '특이사항', { fill: 'FFF8FAFC' });
    
    buildings.forEach((b, bIdx) => {
        const { col1, col3 } = getBuildingCols(bIdx);
        sheet.mergeCells(`${col1}72:${col3}72`);
        const bd = b.buildingData || {};
        setCell(`${col1}72`, bd.remarks || '-');
    });
    sheet.getRow(72).height = 30;
    
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
    
    } catch (error) {
        console.error('LG 엑셀 다운로드 오류:', error);
        showToast(`LG 엑셀 다운로드 실패: ${error.message}`, 'error');
    }
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

// ============================================================
// 건축물대장 불러오기 (Comp List용)
// ============================================================

const LEDGER_API_BASE_URL = 'https://portal-dsyl.onrender.com';

// 건축물대장 필드 매핑 (building-register.html 구조에 맞춤)
// Comp List에서는 buildingData 객체를 사용하므로 별도 처리
const LEDGER_FIELD_MAP_COMPLIST = {
    // 루트 레벨 필드
    completionYear: { 
        label: '준공년도', 
        path: 'completionYear',
        extract: (info) => info.useAprDay ? info.useAprDay.substring(0, 4) : null,
        getCurrent: (bd) => bd.completionYear
    },
    
    // floors 객체 필드
    'floors/above': { 
        label: '지상층수', 
        path: 'floors/above',
        extract: (info) => info.grndFlrCnt ? parseInt(info.grndFlrCnt) : null,
        getCurrent: (bd) => bd.floors?.above || bd.floorsAbove
    },
    'floors/below': { 
        label: '지하층수', 
        path: 'floors/below',
        extract: (info) => info.ugrndFlrCnt ? parseInt(info.ugrndFlrCnt) : null,
        getCurrent: (bd) => bd.floors?.below || bd.floorsBelow
    },
    'floors/display': { 
        label: '층수 표시', 
        path: 'floors/display',
        extract: (info) => {
            const above = info.grndFlrCnt || 0;
            const below = info.ugrndFlrCnt || 0;
            if (above || below) {
                return `지하${below}층/지상${above}층`;
            }
            return null;
        },
        getCurrent: (bd) => bd.floors?.display || bd.floors || bd.scale
    },
    
    // area 객체 필드
    'area/grossFloorSqm': { 
        label: '연면적(㎡)', 
        path: 'area/grossFloorSqm',
        extract: (info) => info.totArea ? Math.round(info.totArea) : null,
        getCurrent: (bd) => bd.area?.grossFloorSqm || bd.grossFloorSqm
    },
    'area/grossFloorPy': { 
        label: '연면적(평)', 
        path: 'area/grossFloorPy',
        extract: (info) => info.totArea ? Math.round(info.totArea / 3.3058) : null,
        getCurrent: (bd) => bd.area?.grossFloorPy || bd.grossFloorPy
    },
    'area/landArea': { 
        label: '대지면적(㎡)', 
        path: 'area/landArea',
        extract: (info) => info.platArea ? Math.round(info.platArea) : null,
        getCurrent: (bd) => bd.area?.landArea || bd.landArea
    },
    'area/buildingArea': { 
        label: '건축면적(㎡)', 
        path: 'area/buildingArea',
        extract: (info) => info.archArea ? Math.round(info.archArea) : null,
        getCurrent: (bd) => bd.area?.buildingArea || bd.buildingArea
    },
    
    // specs 객체 필드
    'specs/passengerElevator': { 
        label: '승용 엘리베이터', 
        path: 'specs/passengerElevator',
        extract: (info) => info.rideUseElvtCnt ? parseInt(info.rideUseElvtCnt) : null,
        getCurrent: (bd) => bd.specs?.passengerElevator || bd.passengerElevator
    },
    'specs/freightElevator': { 
        label: '비상용 엘리베이터', 
        path: 'specs/freightElevator',
        extract: (info) => info.emgenUseElvtCnt ? parseInt(info.emgenUseElvtCnt) : null,
        getCurrent: (bd) => bd.specs?.freightElevator || bd.freightElevator
    },
    'specs/structure': { 
        label: '구조', 
        path: 'specs/structure',
        extract: (info) => info.strctCdNm || null,
        getCurrent: (bd) => bd.specs?.structure || bd.structure
    },
    'specs/buildingUse': { 
        label: '건물용도', 
        path: 'specs/buildingUse',
        extract: (info) => info.mainPurpose || null,
        getCurrent: (bd) => bd.specs?.buildingUse || bd.buildingUse || bd.usage
    },
    
    // parking 객체 필드
    'parking/total': { 
        label: '주차대수', 
        path: 'parking/total',
        extract: (info) => info.totPkngCnt ? parseInt(info.totPkngCnt) : null,
        getCurrent: (bd) => bd.parking?.total || bd.parkingTotal || bd.parkingSpaces
    },
    
    // 비율 정보 (루트 레벨)
    vlRat: { 
        label: '용적률(%)', 
        path: 'vlRat',
        extract: (info) => info.vlRat ? parseFloat(info.vlRat).toFixed(2) : null,
        getCurrent: (bd) => bd.vlRat || bd.floorAreaRatio
    },
    bcRat: { 
        label: '건폐율(%)', 
        path: 'bcRat',
        extract: (info) => info.bcRat ? parseFloat(info.bcRat).toFixed(2) : null,
        getCurrent: (bd) => bd.bcRat || bd.buildingCoverageRatio
    },
    
    // 주용도 (루트 레벨에도 저장)
    mainPurpose: { 
        label: '주용도', 
        path: 'mainPurpose',
        extract: (info) => info.mainPurpose || null,
        getCurrent: (bd) => bd.mainPurpose || bd.specs?.buildingUse || bd.buildingUse
    }
};

// Comp List에서 건축물대장 불러오기
window.refreshBuildingLedgerInComplist = async function(buildingId) {
    // 빌딩 찾기
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) {
        showToast('빌딩을 찾을 수 없습니다', 'error');
        return;
    }
    
    const bd = building.buildingData || {};
    const address = bd.address || bd.addressJibun || '';
    
    if (!address) {
        showToast('빌딩 주소 정보가 없습니다', 'error');
        return;
    }
    
    // ★ 로딩 오버레이 표시
    showLedgerLoadingOverlay(building.buildingName || '빌딩');
    
    try {
        const response = await fetch(`${LEDGER_API_BASE_URL}/api/building-register/search?address=${encodeURIComponent(address)}`);
        const data = await response.json();
        
        console.log('건축물대장 API 응답:', data);
        
        if (!data.success || !data.results || data.results.length === 0) {
            hideLedgerLoadingOverlay();
            showToast('건축물대장 정보를 찾을 수 없습니다', 'warning');
            return;
        }
        
        // 첫 번째 결과 사용 (또는 빌딩명이 일치하는 결과 찾기)
        let selectedResult = data.results[0];
        
        // 빌딩명으로 매칭 시도
        if (data.results.length > 1 && building.buildingName) {
            const matched = data.results.find(r => {
                const resultName = r.buildingName || r.buildingInfo?.buildingName || '';
                return resultName.includes(building.buildingName) || building.buildingName.includes(resultName);
            });
            if (matched) selectedResult = matched;
        }
        
        const info = selectedResult.buildingInfo;
        if (!info) {
            hideLedgerLoadingOverlay();
            showToast('건축물대장 상세 정보가 없습니다', 'warning');
            return;
        }
        
        // 변경사항 수집 (새로운 필드 매핑 사용)
        const changes = [];
        const updateData = {};
        
        for (const [fieldKey, fieldConfig] of Object.entries(LEDGER_FIELD_MAP_COMPLIST)) {
            const newValue = fieldConfig.extract(info);
            if (newValue === null || newValue === undefined) continue;
            
            // getCurrent 함수로 현재 값 가져오기
            const currentValue = fieldConfig.getCurrent(bd);
            const newValueStr = String(newValue);
            const currentValueStr = currentValue !== null && currentValue !== undefined ? String(currentValue) : '';
            
            // 값이 다르거나 비어있으면 업데이트 대상
            if (!currentValueStr || currentValueStr !== newValueStr) {
                changes.push({
                    field: fieldKey,
                    path: fieldConfig.path,
                    label: fieldConfig.label,
                    oldValue: currentValueStr || '-',
                    newValue: newValueStr
                });
                updateData[fieldConfig.path] = newValue;
            }
        }
        
        if (changes.length === 0) {
            showToast('모든 정보가 최신 상태입니다 ✅', 'success');
            return;
        }
        
        // ★ 로딩 오버레이 숨기기
        hideLedgerLoadingOverlay();
        
        // 변경사항 확인 모달 표시
        showLedgerCompareModalInComplist(changes, updateData, buildingId);
        
    } catch (error) {
        console.error('건축물대장 조회 오류:', error);
        hideLedgerLoadingOverlay();
        showToast('건축물대장 조회 중 오류가 발생했습니다', 'error');
    }
};

// Comp List용 건축물대장 비교 모달 표시
function showLedgerCompareModalInComplist(changes, updateData, buildingId) {
    // 기존 모달이 있으면 제거
    let modal = document.getElementById('ledgerUpdateModalComplist');
    if (modal) modal.remove();
    
    // 모달 생성
    modal = document.createElement('div');
    modal.id = 'ledgerUpdateModalComplist';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 10001; display: flex; align-items: center; justify-content: center;';
    
    modal.innerHTML = `
        <div style="background: white; border-radius: 12px; width: 90%; max-width: 500px; max-height: 80vh; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.3);">
            <div style="padding: 16px 20px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: white; display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; font-size: 16px;">🔄 건축물대장 정보 갱신</h3>
                <button onclick="closeLedgerModalComplist()" style="background: none; border: none; color: white; font-size: 20px; cursor: pointer;">×</button>
            </div>
            <div style="padding: 16px 20px; max-height: 50vh; overflow-y: auto;">
                <div style="padding: 10px 14px; background: #dbeafe; border-radius: 8px; margin-bottom: 16px; font-size: 13px; color: #1e40af;">
                    💡 ${changes.length}개 항목이 변경되었습니다. 적용할 항목을 선택하세요.
                </div>
                <div id="ledgerChangesListComplist">
                    ${changes.map((c, idx) => `
                        <div style="display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 8px;">
                            <input type="checkbox" id="ledgerFieldComplist_${idx}" data-path="${c.path}" checked style="width: 18px; height: 18px; cursor: pointer;">
                            <div style="flex: 1;">
                                <div style="font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">${c.label}</div>
                                <div style="display: flex; align-items: center; gap: 8px; font-size: 12px;">
                                    <span style="color: #ef4444; text-decoration: line-through;">${c.oldValue}</span>
                                    <span style="color: #9ca3af;">→</span>
                                    <span style="color: #10b981; font-weight: 600;">${c.newValue}</span>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div style="padding: 12px 20px; border-top: 1px solid #e5e7eb; display: flex; justify-content: space-between; align-items: center; background: #f9fafb;">
                <label style="font-size: 12px; color: #6b7280; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="checkbox" id="ledgerSelectAllComplist" checked onchange="toggleLedgerSelectAllComplist(this.checked)">
                    전체 선택
                </label>
                <div style="display: flex; gap: 8px;">
                    <button onclick="closeLedgerModalComplist()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; font-size: 13px;">취소</button>
                    <button onclick="applyLedgerChangesComplist('${buildingId}')" style="padding: 8px 16px; border: none; border-radius: 6px; background: #2563eb; color: white; cursor: pointer; font-size: 13px; font-weight: 500;">적용</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 클릭으로 닫기
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeLedgerModalComplist();
    });
    
    // 데이터 저장
    window._ledgerUpdateDataComplist = updateData;
    window._ledgerChangesComplist = changes;
}

// Comp List용 모달 닫기
window.closeLedgerModalComplist = function() {
    const modal = document.getElementById('ledgerUpdateModalComplist');
    if (modal) modal.remove();
    window._ledgerUpdateDataComplist = null;
    window._ledgerChangesComplist = null;
};

// Comp List용 전체 선택/해제
window.toggleLedgerSelectAllComplist = function(checked) {
    document.querySelectorAll('#ledgerChangesListComplist input[type="checkbox"]').forEach(cb => {
        cb.checked = checked;
    });
};

// Comp List용 변경사항 적용
window.applyLedgerChangesComplist = async function(buildingId) {
    const updateData = window._ledgerUpdateDataComplist;
    const changes = window._ledgerChangesComplist;
    
    if (!updateData || !changes) {
        showToast('적용할 데이터가 없습니다', 'error');
        return;
    }
    
    // 빌딩 찾기
    const building = pageState.editData.buildings.find(b => b.buildingId === buildingId);
    if (!building) {
        showToast('빌딩을 찾을 수 없습니다', 'error');
        return;
    }
    
    const bd = building.buildingData || {};
    
    // 선택된 필드만 추출 (Firebase 경로 형식 사용)
    const firebaseUpdates = {};
    let selectedCount = 0;
    
    document.querySelectorAll('#ledgerChangesListComplist input[type="checkbox"]:checked').forEach(cb => {
        const path = cb.dataset.path;  // 'floors/above', 'area/grossFloorSqm' 등
        if (path && updateData[path] !== undefined) {
            firebaseUpdates[path] = updateData[path];
            selectedCount++;
        }
    });
    
    if (selectedCount === 0) {
        showToast('적용할 항목을 선택해주세요', 'warning');
        return;
    }
    
    // floors/above 또는 floors/below가 있으면 floors/display도 자동 추가
    if (firebaseUpdates['floors/above'] !== undefined || firebaseUpdates['floors/below'] !== undefined) {
        const above = firebaseUpdates['floors/above'] ?? updateData['floors/above'] ?? bd.floors?.above ?? 0;
        const below = firebaseUpdates['floors/below'] ?? updateData['floors/below'] ?? bd.floors?.below ?? 0;
        firebaseUpdates['floors/display'] = `지하${below}층/지상${above}층`;
        console.log('floors/display 자동 생성:', firebaseUpdates['floors/display']);
    }
    
    try {
        // 갱신 정보 추가
        firebaseUpdates.lastLedgerUpdateAt = new Date().toISOString();
        firebaseUpdates.lastLedgerUpdateBy = pageState.currentUser?.email || 'unknown';
        
        console.log('Firebase 업데이트 데이터:', firebaseUpdates);
        console.log('빌딩 ID:', buildingId);
        
        // Firebase에 저장 (경로 형식으로 중첩 객체 업데이트)
        await update(ref(db, `buildings/${buildingId}`), firebaseUpdates);
        console.log('Firebase에 건축물대장 정보 저장 완료');
        
        // 로컬 buildingData에도 적용 (중첩 구조로 변환)
        if (!building.buildingData) {
            building.buildingData = {};
        }
        
        for (const [path, value] of Object.entries(firebaseUpdates)) {
            if (path.includes('/')) {
                const [parent, child] = path.split('/');
                // 기존 값이 없거나, 객체가 아닌 경우 (문자열 등) 새 객체로 초기화
                if (!building.buildingData[parent] || typeof building.buildingData[parent] !== 'object' || Array.isArray(building.buildingData[parent])) {
                    building.buildingData[parent] = {};
                }
                building.buildingData[parent][child] = value;
            } else {
                building.buildingData[path] = value;
            }
        }
        
        // 엘리베이터 표시 형식 업데이트
        const passenger = building.buildingData.specs?.passengerElevator || 0;
        const freight = building.buildingData.specs?.freightElevator || 0;
        if (passenger || freight) {
            const parts = [];
            if (passenger) parts.push(`승객${passenger}`);
            if (freight) parts.push(`화물${freight}대`);
            building.buildingData.elevators = parts.join('/');
            building.buildingData.elevator = building.buildingData.elevators;
        }
        
        // 주차 표시 형식 업데이트
        const parkingTotal = building.buildingData.parking?.total;
        if (parkingTotal) {
            building.buildingData.parkingTotalDisplay = `${parkingTotal}대`;
        }
        
        // allBuildings도 업데이트 (중첩 구조로)
        const buildingInAll = pageState.allBuildings.find(b => b.id === buildingId);
        if (buildingInAll) {
            for (const [path, value] of Object.entries(firebaseUpdates)) {
                if (path.includes('/')) {
                    const [parent, child] = path.split('/');
                    // 기존 값이 없거나, 객체가 아닌 경우 (문자열 등) 새 객체로 초기화
                    if (!buildingInAll[parent] || typeof buildingInAll[parent] !== 'object' || Array.isArray(buildingInAll[parent])) {
                        buildingInAll[parent] = {};
                    }
                    buildingInAll[parent][child] = value;
                } else {
                    buildingInAll[path] = value;
                }
            }
        }
        
        // UI 새로고침
        renderDetailView();
        
        closeLedgerModalComplist();
        showToast(`${selectedCount}개 항목이 갱신되었습니다 ✅`, 'success');
        
    } catch (error) {
        console.error('건축물대장 정보 저장 오류:', error);
        showToast('정보 저장 중 오류가 발생했습니다', 'error');
    }
};
