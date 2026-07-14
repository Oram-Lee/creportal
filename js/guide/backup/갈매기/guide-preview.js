/**
 * Leasing Guide - 미리보기
 * 전체 미리보기, 목차 페이지, PDF 생성, 보기 기능
 * 
 * v2.1 수정사항:
 * - 권역 표시: item.region 우선 사용
 * - 지도 이미지: mapImage 및 static map 개선
 * - 레이아웃: A4 가로 비율 최대 활용
 * - 이미지 처리 개선
 * 
 * v2.2 수정사항 (2026-01-14):
 * - ★ NaN 문제 해결: safeFormatPrice 헬퍼 함수 추가
 * - 콤마 포함 문자열도 정상 표시
 * 
 * v3.6 수정사항 (2026-01-20):
 * - ★ 층 표기 정규화 함수 추가 (FF 중복 방지)
 * 
 * v4.6 수정사항 (2026-01-21):
 * - ★ 담당자 로직 수정: item.contactPoints 우선 참조 (편집 모드 연동)
 * 
 * v4.7 수정사항 (2026-01-22):
 * - ★ 미리보기 LOCATION: Firebase Storage 이미지 자동 로드
 * - building.images.location URL이 있으면 해당 이미지 표시
 * 
 * v4.8 수정사항 (2026-01-22):
 * - ★ 현재 빌딩만 미리보기: previewCurrentBuilding(idx)
 * - ★ PDF 출력 메뉴: openPrintMenu(idx)
 * - ★ 현재 페이지 출력: printCurrentBuilding(idx)
 * - ★ 전체 페이지 출력: printAllPages()
 * - window.print() 기반 PDF 저장 기능
 */

import { state, db, ref, get, DEFAULT_REGIONS, getAllRegions, getRegionInfo } from './guide-state.js';
import { showToast, formatNumber, normalizeBuilding, getRegionName, getExteriorImages, getFloorPlanImages } from './guide-utils.js';

// ★ v3.6: 층 표기 정규화 함수 (FF 중복 방지)
function formatFloorDisplay(floor) {
    if (!floor || floor === '-') return '-';
    
    let str = String(floor).trim().toUpperCase();
    
    // 이미 정규화된 형식인지 확인
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

// ★ v2.2: 안전한 가격 포맷팅 (콤마 포함 문자열도 처리)
function safeFormatPrice(value) {
    if (!value && value !== 0) return null;
    
    // 이미 문자열이고 콤마가 포함되어 있으면 그대로 반환
    if (typeof value === 'string') {
        if (value.includes(',')) return value;
        // 콤마 없는 숫자 문자열이면 변환
        const num = parseFloat(value);
        return isNaN(num) ? value : formatNumber(num);
    }
    
    // 숫자면 포맷팅
    if (typeof value === 'number') {
        return formatNumber(value);
    }
    
    return value;
}

// 기본 권역 순서 (커스텀 권역은 뒤에 추가됨)
const BASE_REGION_ORDER = ['GBD', 'YBD', 'CBD', 'BBD', 'PAN', 'ETC'];

// 동적 권역 순서 가져오기
function getRegionOrder() {
    const customCodes = state.customRegions.map(r => r.code);
    return [...BASE_REGION_ORDER, ...customCodes];
}

// 빌딩 데이터를 권역별로 그룹핑
function groupBuildingsByRegion(tocItems, buildingDataMap) {
    const groups = {};
    
    tocItems.forEach((item, idx) => {
        if (item.type === 'building') {
            const building = buildingDataMap[item.buildingId];
            if (building) {
                // ★ 수정: 아이템에 지정된 권역 우선, 없으면 빌딩 기본 권역
                const region = (item.region || building.region || 'ETC').toUpperCase();
                if (!groups[region]) {
                    groups[region] = [];
                }
                groups[region].push({
                    item,
                    building,
                    name: building.name || '빌딩명',
                    tocIndex: idx
                });
            }
        }
    });
    
    return groups;
}

// 안내문 보기 (목록에서)
export async function viewGuide(guideId) {
    const guide = state.leasingGuides[guideId];
    if (!guide) {
        showToast('안내문을 찾을 수 없습니다', 'error');
        return;
    }
    
    const tocItems = guide.items || guide.tocItems || [];
    
    // 빌딩 데이터 로드
    const buildingDataMap = {};
    const buildingPromises = tocItems
        .filter(i => i.type === 'building')
        .map(async (item) => {
            let building = state.allBuildings.find(b => b.id === item.buildingId);
            if (!building) {
                try {
                    const snapshot = await get(ref(db, `buildings/${item.buildingId}`));
                    if (snapshot.exists()) {
                        building = { id: item.buildingId, ...snapshot.val() };
                        normalizeBuilding(building);
                        state.allBuildings.push(building);
                    }
                } catch (e) {
                    console.error('빌딩 로드 오류:', e);
                }
            }
            if (building) {
                buildingDataMap[item.buildingId] = building;
            }
            return { item, building };
        });
    
    await Promise.all(buildingPromises);
    
    // 커스텀 권역 로드
    if (guide.customRegions) {
        state.customRegions = guide.customRegions;
    }
    
    const pages = buildPages(tocItems, buildingDataMap, guide.coverSettings, guide.endingSettings);
    
    state.previewPages = pages;
    state.previewCurrentPage = 0;
    state.previewGuideTitle = guide.title;
    
    showFullPreviewModal();
}

// 전체 미리보기 (편집 중)
export function previewGuide() {
    const buildingDataMap = {};
    state.tocItems.forEach(item => {
        if (item.type === 'building') {
            const building = state.allBuildings.find(b => b.id === item.buildingId);
            if (building) {
                buildingDataMap[item.buildingId] = building;
            }
        }
    });
    
    const pages = buildPages(state.tocItems, buildingDataMap, state.coverSettings, state.endingSettings);
    
    state.previewPages = pages;
    state.previewCurrentPage = 0;
    state.previewGuideTitle = document.getElementById('editTitle')?.value || '임대안내문';
    
    showFullPreviewModal();
}

// 페이지 구성 (표지 → 전체목차 → [권역목차 → 빌딩들...] 반복 → 엔딩)
function buildPages(tocItems, buildingDataMap, coverSettings, endingSettings) {
    const pages = [];
    
    // 1. 표지
    pages.push({
        type: 'cover',
        data: coverSettings || {}
    });
    
    // 권역별 그룹핑
    const regionGroups = groupBuildingsByRegion(tocItems, buildingDataMap);
    const regionOrder = getRegionOrder();
    const activeRegions = regionOrder.filter(r => regionGroups[r] && regionGroups[r].length > 0);
    
    if (activeRegions.length > 0) {
        // 2. 전체 목차 페이지
        pages.push({
            type: 'toc-full',
            data: { regionGroups, activeRegions, coverSettings }
        });
        
        // 3. 권역별 목차 + 빌딩 페이지
        activeRegions.forEach(region => {
            const buildings = regionGroups[region];
            
            // 권역별 목차 페이지
            pages.push({
                type: 'toc-region',
                data: { region, buildings, coverSettings }
            });
            
            // 해당 권역 빌딩 페이지들
            buildings.forEach(bd => {
                pages.push({
                    type: 'building',
                    data: { item: bd.item, building: bd.building }
                });
            });
        });
    }
    
    // 4. 엔딩 페이지 (마지막)
    const ending = endingSettings || state.endingSettings;
    if (ending && ending.enabled !== false) {
        pages.push({
            type: 'ending',
            data: { endingSettings: ending, coverSettings }
        });
    }
    
    return pages;
}

// 전체 미리보기 모달 표시
function showFullPreviewModal() {
    // 기존 모달 제거
    const existingModal = document.getElementById('fullPreviewModal');
    if (existingModal) existingModal.remove();
    
    const modalHtml = `
        <div class="fullpreview-modal" id="fullPreviewModal">
            <div class="fullpreview-header">
                <div class="fullpreview-title">📄 ${state.previewGuideTitle} 미리보기</div>
                <button class="fullpreview-close" onclick="closeFullPreviewModal()">×</button>
            </div>
            <div class="fullpreview-content" id="fullPreviewContent">
                ${renderCurrentPage()}
            </div>
            <div class="fullpreview-nav">
                <button class="fullpreview-nav-btn" onclick="prevPreviewPage()" ${state.previewCurrentPage === 0 ? 'disabled' : ''}>◀ 이전</button>
                <div class="fullpreview-page-dots">
                    ${state.previewPages.map((_, i) => `
                        <div class="fullpreview-dot ${i === state.previewCurrentPage ? 'active' : ''}" onclick="goToPreviewPage(${i})"></div>
                    `).join('')}
                </div>
                <div class="fullpreview-page-info">${state.previewCurrentPage + 1} / ${state.previewPages.length}</div>
                <button class="fullpreview-nav-btn" onclick="nextPreviewPage()" ${state.previewCurrentPage === state.previewPages.length - 1 ? 'disabled' : ''}>다음 ▶</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // ★ v4.6: 모달 로드 후 지도 초기화
    setTimeout(() => initPreviewMaps(), 200);
}

// 현재 페이지 렌더링
function renderCurrentPage() {
    const page = state.previewPages[state.previewCurrentPage];
    if (!page) return '<div>페이지 없음</div>';
    
    switch (page.type) {
        case 'cover':
            return renderCoverPreviewPage(page.data);
        case 'toc-full':
            return renderTocFullPage(page.data);
        case 'toc-region':
            return renderTocRegionPage(page.data);
        case 'building':
            return renderBuildingPreviewPage(page.data);
        case 'divider':
            return renderDividerPreviewPage(page.data);
        case 'ending':
            return renderEndingPage(page.data);
        default:
            return '<div>알 수 없는 페이지 타입</div>';
    }
}

// 페이지 이동
export function prevPreviewPage() {
    if (state.previewCurrentPage > 0) {
        state.previewCurrentPage--;
        updatePreviewContent();
    }
}

export function nextPreviewPage() {
    if (state.previewCurrentPage < state.previewPages.length - 1) {
        state.previewCurrentPage++;
        updatePreviewContent();
    }
}

export function goToPreviewPage(idx) {
    if (idx >= 0 && idx < state.previewPages.length) {
        state.previewCurrentPage = idx;
        updatePreviewContent();
    }
}

// 빌딩 페이지로 직접 이동
export function goToBuildingPage(buildingId) {
    const idx = state.previewPages.findIndex(p => 
        p.type === 'building' && p.data.building.id === buildingId
    );
    if (idx >= 0) {
        goToPreviewPage(idx);
    }
}

// 미리보기 콘텐츠 업데이트
function updatePreviewContent() {
    const content = document.getElementById('fullPreviewContent');
    if (content) {
        content.innerHTML = renderCurrentPage();
    }
    
    // 네비게이션 업데이트
    const nav = document.querySelector('.fullpreview-nav');
    if (nav) {
        nav.innerHTML = `
            <button class="fullpreview-nav-btn" onclick="prevPreviewPage()" ${state.previewCurrentPage === 0 ? 'disabled' : ''}>◀ 이전</button>
            <div class="fullpreview-page-dots">
                ${state.previewPages.map((_, i) => `
                    <div class="fullpreview-dot ${i === state.previewCurrentPage ? 'active' : ''}" onclick="goToPreviewPage(${i})"></div>
                `).join('')}
            </div>
            <div class="fullpreview-page-info">${state.previewCurrentPage + 1} / ${state.previewPages.length}</div>
            <button class="fullpreview-nav-btn" onclick="nextPreviewPage()" ${state.previewCurrentPage === state.previewPages.length - 1 ? 'disabled' : ''}>다음 ▶</button>
        `;
    }
    
    // ★ v4.6: 페이지 렌더링 후 지도 초기화
    setTimeout(() => initPreviewMaps(), 100);
}

// ★ v4.6: 미리보기 지도 초기화
function initPreviewMaps() {
    const mapContainers = document.querySelectorAll('.preview-map-container');
    
    mapContainers.forEach(container => {
        const lat = parseFloat(container.dataset.lat);
        const lng = parseFloat(container.dataset.lng);
        const name = container.dataset.name || '';
        
        if (!lat || !lng || isNaN(lat) || isNaN(lng)) return;
        if (container.dataset.initialized === 'true') return; // 이미 초기화됨
        
        try {
            // 카카오맵 초기화
            const mapOption = {
                center: new kakao.maps.LatLng(lat, lng),
                level: 3,
                draggable: false,
                scrollwheel: false,
                disableDoubleClickZoom: true
            };
            
            const map = new kakao.maps.Map(container, mapOption);
            
            // 마커 추가
            const marker = new kakao.maps.Marker({
                position: new kakao.maps.LatLng(lat, lng),
                map: map
            });
            
            // 빌딩명 인포윈도우
            if (name) {
                const infowindow = new kakao.maps.InfoWindow({
                    content: `<div style="padding:5px 10px; font-size:12px; white-space:nowrap;">${name}</div>`
                });
                infowindow.open(map, marker);
            }
            
            container.dataset.initialized = 'true';
            
        } catch (e) {
            console.error('미리보기 지도 초기화 오류:', e);
            container.innerHTML = `
                <div style="text-align:center; color:#6b7280; padding:20px;">
                    <div style="font-size:24px; margin-bottom:8px;">📍</div>
                    <div style="font-size:12px;">${name || '위치'}</div>
                    <div style="font-size:11px; color:#9ca3af;">(${lat.toFixed(5)}, ${lng.toFixed(5)})</div>
                </div>
            `;
        }
    });
}

// 모달 닫기
export function closeFullPreviewModal() {
    const modal = document.getElementById('fullPreviewModal');
    if (modal) modal.remove();
}

// ========== 표지 페이지 ==========
function renderCoverPreviewPage(coverSettings) {
    const cs = coverSettings || {};
    const logoJustify = cs.logoPosition === 'left' ? 'flex-start' : 
                       cs.logoPosition === 'center' ? 'center' : 'flex-end';
    
    return `
        <div class="fullpreview-cover">
            <div class="cover-bg">
                <svg class="skyline" viewBox="0 0 400 60" preserveAspectRatio="none">
                    <path d="M0,60 L0,45 L15,45 L15,30 L25,30 L25,45 L35,45 L35,20 L50,20 L50,45 L60,45 L60,35 L75,35 L75,45 L85,45 L85,15 L100,15 L100,45 L110,45 L110,40 L125,40 L125,45 L135,45 L135,25 L150,25 L150,45 L160,45 L160,10 L180,10 L180,45 L190,45 L190,30 L205,30 L205,45 L215,45 L215,20 L230,20 L230,45 L240,45 L240,35 L255,35 L255,45 L265,45 L265,25 L280,25 L280,45 L290,45 L290,15 L310,15 L310,45 L320,45 L320,40 L335,40 L335,45 L345,45 L345,30 L360,30 L360,45 L370,45 L370,20 L385,20 L385,45 L400,45 L400,60 Z" fill="rgba(255,255,255,0.15)"/>
                </svg>
            </div>
            <div class="cover-text">
                <div class="cover-title">${cs.title || 'Leasing Information'}</div>
                ${cs.subtitle ? `<div class="cover-subtitle">${cs.subtitle}</div>` : ''}
            </div>
            <div class="cover-slogan">${cs.slogan || 'Best Space For A Better Life'}</div>
            <div class="cover-logo" style="justify-content:${logoJustify}">
                ${cs.logoImage ? `<img src="${cs.logoImage}" alt="Logo">` : ''}
            </div>
        </div>
    `;
}

// ========== 전체 목차 페이지 (기존 스타일 복원) ==========
function renderTocFullPage(data) {
    const { regionGroups, activeRegions, coverSettings } = data;
    const cs = coverSettings || {};
    
    // 권역별 아이콘
    const regionIcons = {
        'GBD': '🟡', 'YBD': '🟢', 'CBD': '🔵', 'BBD': '🟣', 'PAN': '🟠', 'ETC': '⚪'
    };
    
    return `
        <div class="fullpreview-toc-full">
            <div class="toc-full-header">
                <div class="toc-full-title">C O N T E N T S</div>
                ${cs.logoImage ? `<img src="${cs.logoImage}" class="toc-full-logo" alt="Logo">` : ''}
            </div>
            <div class="toc-full-accent-bar"></div>
            <div class="toc-full-body">
                ${activeRegions.map(region => {
                    const buildings = regionGroups[region];
                    const regionInfo = getRegionInfo(region);
                    const icon = regionIcons[region] || '📍';
                    
                    return `
                        <div class="toc-full-column">
                            <div class="toc-full-region-header">
                                <span class="toc-region-icon">${icon}</span>
                                <span class="toc-region-label">${region}</span>
                            </div>
                            <div class="toc-full-region-list">
                                ${buildings.map((bd, i) => `
                                    <div class="toc-full-item" onclick="goToBuildingPage('${bd.building.id}')">
                                        <span class="toc-item-num">${String(i + 1).padStart(2, '0')}</span>
                                        <span class="toc-item-name">${bd.name}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

// ========== 권역별 목차 페이지 (기존 스타일 복원) ==========
function renderTocRegionPage(data) {
    const { region, buildings, coverSettings } = data;
    const cs = coverSettings || {};
    const regionInfo = getRegionInfo(region);
    
    // 도시 스카이라인 SVG
    const skylineSvg = `
        <svg viewBox="0 0 400 100" preserveAspectRatio="none">
            <path d="M0,100 L0,70 L20,70 L20,50 L35,50 L35,70 L50,70 L50,40 L70,40 L70,70 L85,70 L85,55 L100,55 L100,70 L115,70 L115,30 L140,30 L140,70 L155,70 L155,60 L175,60 L175,70 L190,70 L190,45 L210,45 L210,70 L225,70 L225,35 L250,35 L250,70 L265,70 L265,50 L285,50 L285,70 L300,70 L300,25 L330,25 L330,70 L345,70 L345,55 L365,55 L365,70 L380,70 L380,40 L400,40 L400,100 Z" fill="rgba(255,255,255,0.15)"/>
        </svg>
    `;
    
    return `
        <div class="fullpreview-toc-region">
            <div class="toc-region-main-header">
                <div class="toc-region-title-area">
                    <div class="toc-region-title">${regionInfo.name} (${region})</div>
                    <div class="toc-region-divider"></div>
                </div>
                <div class="toc-region-list-area">
                    ${buildings.map((bd, i) => `
                        <div class="toc-region-item" onclick="goToBuildingPage('${bd.building.id}')">
                            <span class="toc-region-item-num">${String(i + 1).padStart(2, '0')}</span>
                            <span class="toc-region-item-name">${bd.name}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div class="toc-region-skyline">${skylineSvg}</div>
            ${cs.logoImage ? `<img src="${cs.logoImage}" class="toc-region-logo" alt="Logo">` : ''}
        </div>
    `;
}

// 간지 페이지 렌더링
function renderDividerPreviewPage(divider) {
    // 흰색 배경 단일 템플릿
    const defaultBgColor = '#ffffff';
    const defaultTextColor = '#1e3a5f';
    const bg = divider.bgImage ? `url(${divider.bgImage}) center/cover` : defaultBgColor;
    
    return `
        <div class="fullpreview-divider" style="background:${bg}; color:${defaultTextColor};">
            <div class="divider-title">${divider.title || '간지'}</div>
            <div class="divider-content">${divider.content || ''}</div>
        </div>
    `;
}

// ========== 빌딩 페이지 렌더링 (v2.3 지도/이미지 완전 수정) ==========
function renderBuildingPreviewPage(data) {
    const { item, building } = data;
    
    // ★ 수정: item.region 우선 사용
    const region = (item.region || building.region || 'ETC').toUpperCase();
    
    // 이미지 fallback 처리 (tocItem → Firebase 빌딩 데이터)
    let exteriorImages = item.exteriorImages || [];
    if (exteriorImages.length === 0) {
        exteriorImages = getExteriorImages(building);
    }
    let floorPlanImages = item.floorPlanImages || [];
    if (floorPlanImages.length === 0) {
        floorPlanImages = getFloorPlanImages(building);
    }
    
    const mainImg = exteriorImages[item.mainImageIndex || 0];
    const floorPlanImg = floorPlanImages[0];
    
    // ★ v4.6: 지도 이미지 처리 - 캡처 이미지 우선, 좌표 있으면 동적 지도 렌더링 예약
    const lat = building.lat || building.coordinates?.lat;
    const lng = building.lng || building.coordinates?.lng;
    const mapId = `previewMap_${item.buildingId || Math.random().toString(36).substr(2, 9)}`;
    
    let mapContent = '<div class="map-placeholder"><span>📍</span><span class="map-text">위치 정보 없음</span></div>';
    
    // ★ v4.7: Firebase Storage 이미지도 체크
    const mapImageUrl = item.mapImage || building.images?.location;
    
    if (mapImageUrl) {
        // 캡처된 이미지 또는 Firebase Storage 이미지가 있으면 사용
        mapContent = `<img src="${mapImageUrl}" alt="위치" class="map-img">`;
    } else if (lat && lng) {
        // 좌표가 있으면 동적 지도 컨테이너 생성
        mapContent = `
            <div class="preview-map-container" id="${mapId}" 
                 data-lat="${lat}" data-lng="${lng}" data-name="${(building.name || '').replace(/"/g, '&quot;')}"
                 style="width:100%; height:100%; min-height:180px; background:#e5e7eb; display:flex; align-items:center; justify-content:center;">
                <div style="text-align:center; color:#6b7280;">
                    <div style="font-size:24px; margin-bottom:8px;">🗺️</div>
                    <div style="font-size:12px;">지도 로딩 중...</div>
                </div>
            </div>
        `;
    } else if (building.address) {
        // 좌표 없고 주소만 있으면 주소 표시
        mapContent = `
            <div class="map-placeholder address">
                <span>📍</span>
                <span class="map-text">${building.address}</span>
            </div>
        `;
    }
    
    // 공실 정보 (customVacancies + selectedExternalVacancies + leasingGuideVacancies)
    const vacancies = [
        ...(item.customVacancies || []).map((v, i) => ({...v, type: 'custom', id: `custom_${i}`})),
        ...(item.selectedExternalVacancies || []),
        ...(item.leasingGuideVacancies || [])  // portal.html에서 저장된 공실
    ];
    
    // ★ v4.6: 담당자 - item에 지정된 담당자 우선, 없으면 빌딩 담당자, 그것도 없으면 기본값
    const itemContacts = item.contactPoints || [];
    const buildingContacts = building.contactPoints || [];
    const contacts = itemContacts.length > 0 
        ? itemContacts 
        : (buildingContacts.length > 0 
            ? buildingContacts 
            : (window.DEFAULT_CONTACT_POINTS || []));
    const guideMemos = (building.memos || []).filter(m => m.showInLeasingGuide);
    
    // 빌딩 정보 정규화
    normalizeBuilding(building);
    
    return `
        <div class="fullpreview-building">
            <div class="fullpreview-building-header">
                <div class="fullpreview-building-title">
                    🏢 ${building.name || '빌딩명'}
                    ${item.exclusive ? '<span class="exclusive-badge">전속</span>' : ''}
                </div>
                <div class="fullpreview-region">Leasing Information (${region})</div>
            </div>
            
            <div class="fullpreview-building-body">
                <!-- 좌측 컬럼: 빌딩 사진 + 위치 -->
                <div class="fullpreview-col fullpreview-col-left">
                    <div class="preview-section building-photo-section">
                        <div class="section-title">BUILDING PHOTO</div>
                        <div class="section-content photo-content">
                            ${mainImg ? `<img src="${mainImg.url || mainImg}" alt="빌딩 외관" class="building-photo">` : '<div class="photo-placeholder"><span>🏢</span></div>'}
                        </div>
                    </div>
                    <div class="preview-section location-section">
                        <div class="section-title">LOCATION</div>
                        <div class="section-content map-content">
                            ${mapContent}
                        </div>
                    </div>
                </div>
                
                <!-- 중앙 컬럼: 빌딩 정보 + 평면도 -->
                <div class="fullpreview-col fullpreview-col-center">
                    <div class="preview-section info-section">
                        <div class="section-title">GENERAL INFORMATION</div>
                        <div class="section-content">
                            <table class="info-table">
                                <tr><th>주소</th><td>${building.address || '-'}</td></tr>
                                <tr><th>위치</th><td>${building.nearbyStation || '-'}</td></tr>
                                <tr><th>연면적</th><td>${formatNumber(building.grossFloorPy)}평 (${formatNumber(Math.round((building.grossFloorPy || 0) * 3.3058))}㎡)</td></tr>
                                <tr><th>규모</th><td>B${building.floorsBelow || 0} / ${building.floorsAbove || 0}F</td></tr>
                                <tr><th>준공</th><td>${building.completionYear || '-'}년</td></tr>
                                <tr><th>기준층</th><td>${formatNumber(building.typicalFloorPy)}평 (전용률 ${building.exclusiveRate || '-'}%)</td></tr>
                                <tr><th>E/V</th><td>총 ${building.elevatorTotal || '-'}대</td></tr>
                                <tr><th>주차</th><td>총 ${building.parkingTotal || '-'}대 ${building.parkingNote || ''}</td></tr>
                            </table>
                        </div>
                    </div>
                    <div class="preview-section floorplan-section">
                        <div class="section-title">TYPICAL FLOOR PLAN</div>
                        <div class="section-content floorplan-content">
                            ${floorPlanImg ? `<img src="${floorPlanImg.url || floorPlanImg}" alt="평면도" class="floorplan-img">` : '<div class="floorplan-placeholder"><span>📐</span></div>'}
                        </div>
                    </div>
                </div>
                
                <!-- 우측 컬럼: 공실 + RENT + NOTE + 담당자 -->
                <div class="fullpreview-col fullpreview-col-right">
                    <div class="preview-section vacancy-section">
                        <div class="section-title-row">
                            <span>SPACE AVAILABILITY</span>
                            <span class="section-unit">면적: 평 | 금액: 원/평</span>
                        </div>
                        <div class="section-content">
                            <table class="vacancy-table">
                                <thead>
                                    <tr>
                                        <th>해당층</th>
                                        <th>전용 면적</th>
                                        <th>임대 면적</th>
                                        <th>보증금</th>
                                        <th>임대료</th>
                                        <th>관리비</th>
                                        <th>입주 시기</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${vacancies.length > 0 ? vacancies.slice(0, 5).map(v => `
                                        <tr>
                                            <td>${formatFloorDisplay(v.floor)}</td>
                                            <td>${safeFormatPrice(v.exclusiveArea || v.area) || '-'}</td>
                                            <td>${safeFormatPrice(v.rentArea || v.area) || '-'}</td>
                                            <td>${safeFormatPrice(v.deposit || v.depositPy) || '문의'}</td>
                                            <td>${safeFormatPrice(v.rent || v.rentPy) || '문의'}</td>
                                            <td>${safeFormatPrice(v.maintenance || v.maintenancePy) || '문의'}</td>
                                            <td>${v.moveIn || v.moveInDate || '-'}</td>
                                        </tr>
                                    `).join('') : '<tr><td colspan="7" class="empty-cell">공실 없음</td></tr>'}
                                </tbody>
                                ${vacancies.length > 0 ? `
                                <tfoot>
                                    <tr>
                                        <td>합계</td>
                                        <td>${formatNumber(vacancies.reduce((sum, v) => sum + (parseFloat(v.exclusiveArea || v.area) || 0), 0))}</td>
                                        <td>${formatNumber(vacancies.reduce((sum, v) => sum + (parseFloat(v.rentArea || v.area) || 0), 0))}</td>
                                        <td colspan="4">-</td>
                                    </tr>
                                </tfoot>
                                ` : ''}
                            </table>
                        </div>
                    </div>
                    
                    <!-- RENT (기준가) -->
                    <div class="preview-section rent-section">
                        <div class="section-title-row">
                            <span>RENT</span>
                            <span class="section-unit">(단위:원/임대평)</span>
                        </div>
                        <div class="section-content">
                            <table class="rent-table">
                                <thead>
                                    <tr>
                                        <th>구분</th>
                                        <th>보증금</th>
                                        <th>임대료</th>
                                        <th>관리비</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    <tr>
                                        <td>기준층</td>
                                        <td>${formatNumber(building.floorPricing?.[0]?.depositPy || building.depositPy) || '-'}</td>
                                        <td>${formatNumber(building.floorPricing?.[0]?.rentPy || building.rentPy) || '-'}</td>
                                        <td>${formatNumber(building.floorPricing?.[0]?.maintenancePy || building.maintenancePy) || '-'}</td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    </div>
                    
                    <!-- NOTE (항상 표시) -->
                    <div class="preview-section note-section">
                        <div class="section-title">NOTE</div>
                        <div class="section-content note-content">
                            ${guideMemos.length > 0 
                                ? guideMemos.map(m => `<div class="note-item">• ${m.content}</div>`).join('') 
                                : '<div class="note-empty">-</div>'}
                        </div>
                    </div>
                    
                    <div class="preview-section contact-section">
                        <div class="section-title">CONTACT POINT</div>
                        <div class="section-content">
                            <table class="contact-table">
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th>Phone</th>
                                        <th>Email</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${contacts.length > 0 ? contacts.slice(0, 4).map(c => {
                                        const nameDisplay = c.name ? (c.position ? `${c.name}(${c.position})` : c.name) : '-';
                                        return `
                                            <tr>
                                                <td>${nameDisplay}</td>
                                                <td>${c.phone || c.mobile || '-'}</td>
                                                <td>${c.email || '-'}</td>
                                            </tr>
                                        `;
                                    }).join('') : '<tr><td colspan="3" class="empty-cell">No contacts</td></tr>'}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ========== 엔딩 페이지 (THANK YOU) ==========
function renderEndingPage(data) {
    const es = data.endingSettings || {};
    const cs = data.coverSettings || {};
    const accentColor = es.accentColor || '#ec4899';
    const images = es.images || [];
    
    return `
        <div class="fullpreview-ending">
            <div class="ending-left">
                <div class="ending-headlines">
                    <div class="ending-headline">${es.headline1 || '사람을 먼저 생각하는,'}</div>
                    <div class="ending-headline">${es.headline2 || '고객의 미래를 위하는,'}</div>
                    <div class="ending-headline">${es.headline3 || '공간을 혁신하는,'}</div>
                    <div class="ending-company" style="color:${accentColor};">${es.companyName || '에스앤아이 코퍼레이션'}</div>
                </div>
                <div class="ending-descriptions">
                    <p>${es.description1 || '공간에 대한 전문성과 혁신은 고객을 위한 것이어야 합니다'}</p>
                    <p>${es.description2 || '우리는 공간에 대한 최고의 전문성과 앞선 기술력을 바탕으로'}</p>
                    <p>${es.description3 || '고객의 비즈니스 성공을 지원하고 품격 있는 시간을 제공합니다'}</p>
                    <p>${es.description4 || '사람이 없는 공간은 공허하고 무의미하기에'}</p>
                    <p>${es.description5 || '우리는 언제나 사람을 먼저 생각하는 공간을 만들어 가겠습니다'}</p>
                </div>
                <div class="ending-thankyou" style="color:${accentColor};">${es.thankYouText || 'THANK YOU'}</div>
                <div class="ending-closing">${es.closingText || '고객이 신뢰할 수 있는 관리를 수행하겠습니다'}</div>
                <div class="ending-logo-area">
                    ${cs.logoImage ? `<img src="${cs.logoImage}" alt="Logo" class="ending-logo">` : '<div class="ending-logo-placeholder">S&I Corp.</div>'}
                </div>
                <div class="ending-slogan">${es.slogan || '공간에 가치를 더하는 <span style="color:' + accentColor + ';">공/간/관/리/전/문/가</span>'}</div>
            </div>
            <div class="ending-right">
                <div class="ending-image-grid">
                    ${[0,1,2,3,4,5,6,7,8,9].map(i => {
                        const img = images[i];
                        return `
                            <div class="ending-img-cell">
                                ${img ? `<img src="${img}" alt="이미지${i+1}">` : '<div class="ending-img-empty"></div>'}
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        </div>
    `;
}

// ★ v4.8: 현재 빌딩만 미리보기
export function previewCurrentBuilding(idx) {
    const item = state.tocItems[idx];
    if (!item || item.type !== 'building') {
        showToast('빌딩 페이지가 아닙니다', 'error');
        return;
    }
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building) {
        showToast('빌딩 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 단일 빌딩 페이지만 구성
    state.previewPages = [{
        type: 'building',
        data: { item, building }
    }];
    state.previewCurrentPage = 0;
    state.previewGuideTitle = building.name || '빌딩 미리보기';
    
    showFullPreviewModal();
}

// ★ v4.8: 출력 메뉴 모달
export function openPrintMenu(idx) {
    const item = state.tocItems[idx];
    const building = item ? state.allBuildings.find(b => b.id === item.buildingId) : null;
    const buildingName = building?.name || '현재 페이지';
    
    // 기존 모달 제거
    const existing = document.getElementById('printMenuModal');
    if (existing) existing.remove();
    
    const modalHtml = `
        <div class="modal-backdrop" id="printMenuModal" onclick="closePrintMenu()">
            <div class="modal-content print-menu-modal" onclick="event.stopPropagation()" style="max-width:400px;">
                <div class="modal-header">
                    <h3>🖨️ PDF 출력</h3>
                    <button class="modal-close" onclick="closePrintMenu()">×</button>
                </div>
                <div class="modal-body" style="padding:20px;">
                    <p style="color:#6b7280; font-size:13px; margin-bottom:20px;">
                        인쇄 대화상자에서 "PDF로 저장"을 선택하세요.
                    </p>
                    <div style="display:flex; flex-direction:column; gap:12px;">
                        <button class="btn btn-primary" onclick="printCurrentBuilding(${idx})" style="padding:14px; font-size:15px;">
                            📄 현재 페이지만 출력<br>
                            <span style="font-size:12px; color:rgba(255,255,255,0.8);">${buildingName}</span>
                        </button>
                        <button class="btn btn-secondary" onclick="printAllPages()" style="padding:14px; font-size:15px;">
                            📑 전체 페이지 출력<br>
                            <span style="font-size:12px; color:rgba(0,0,0,0.5);">${state.tocItems.filter(i => i.type === 'building').length}개 빌딩 + 표지/목차/엔딩</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export function closePrintMenu() {
    const modal = document.getElementById('printMenuModal');
    if (modal) modal.remove();
}

// ★ v4.8: 현재 빌딩만 출력
export function printCurrentBuilding(idx) {
    closePrintMenu();
    
    const item = state.tocItems[idx];
    if (!item || item.type !== 'building') {
        showToast('빌딩 페이지가 아닙니다', 'error');
        return;
    }
    
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (!building) {
        showToast('빌딩 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 단일 페이지 데이터 구성
    const pageData = { item, building };
    const pageHtml = renderBuildingPreviewPage(pageData);
    
    openPrintWindow([pageHtml], building.name || '빌딩');
}

// ★ v4.8: 전체 페이지 출력
export function printAllPages() {
    closePrintMenu();
    
    // 전체 페이지 구성
    const buildingDataMap = {};
    state.tocItems.forEach(item => {
        if (item.type === 'building') {
            const building = state.allBuildings.find(b => b.id === item.buildingId);
            if (building) {
                buildingDataMap[item.buildingId] = building;
            }
        }
    });
    
    const pages = buildPages(state.tocItems, buildingDataMap, state.coverSettings, state.endingSettings);
    
    // 각 페이지 HTML 생성
    const pageHtmls = pages.map(page => {
        switch (page.type) {
            case 'cover':
                return renderCoverPreviewPage(page.data);
            case 'toc-full':
                return renderTocFullPage(page.data);
            case 'toc-region':
                return renderTocRegionPage(page.data);
            case 'building':
                return renderBuildingPreviewPage(page.data);
            case 'divider':
                return renderDividerPreviewPage(page.data);
            case 'ending':
                return renderEndingPage(page.data);
            default:
                return '';
        }
    });
    
    const guideTitle = document.getElementById('editTitle')?.value || '임대안내문';
    openPrintWindow(pageHtmls, guideTitle);
}

// ★ v4.8: 인쇄용 새 창 열기
function openPrintWindow(pageHtmls, title) {
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        showToast('팝업이 차단되었습니다. 팝업을 허용해주세요.', 'error');
        return;
    }
    
    // 인쇄용 스타일 가져오기 (현재 페이지의 스타일 시트)
    const styleSheets = Array.from(document.styleSheets)
        .map(sheet => {
            try {
                return sheet.href ? `<link rel="stylesheet" href="${sheet.href}">` : '';
            } catch (e) {
                return '';
            }
        })
        .join('');
    
    const printHtml = `
<!DOCTYPE html>
<html lang="ko">
<head>
    <meta charset="UTF-8">
    <title>${title} - PDF 출력</title>
    ${styleSheets}
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        @media print {
            @page {
                size: A4 landscape;
                margin: 10mm;
            }
            
            body {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
            
            .print-page {
                page-break-after: always;
                page-break-inside: avoid;
            }
            
            .print-page:last-child {
                page-break-after: auto;
            }
            
            .no-print {
                display: none !important;
            }
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', sans-serif;
            background: #f1f5f9;
            padding: 20px;
        }
        
        .print-page {
            width: 297mm;
            min-height: 210mm;
            background: white;
            margin: 0 auto 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            overflow: hidden;
        }
        
        .print-controls {
            position: fixed;
            top: 20px;
            right: 20px;
            display: flex;
            gap: 10px;
            z-index: 1000;
        }
        
        .print-btn {
            padding: 12px 24px;
            font-size: 15px;
            font-weight: 600;
            border: none;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .print-btn-primary {
            background: #3b82f6;
            color: white;
        }
        
        .print-btn-primary:hover {
            background: #2563eb;
        }
        
        .print-btn-secondary {
            background: #e5e7eb;
            color: #374151;
        }
        
        .print-btn-secondary:hover {
            background: #d1d5db;
        }
        
        /* 미리보기 스타일 상속 */
        .fullpreview-building,
        .fullpreview-cover,
        .fullpreview-toc,
        .fullpreview-ending {
            width: 100%;
            height: 100%;
            padding: 20px;
        }
    </style>
</head>
<body>
    <div class="print-controls no-print">
        <button class="print-btn print-btn-primary" onclick="window.print()">🖨️ 인쇄 / PDF 저장</button>
        <button class="print-btn print-btn-secondary" onclick="window.close()">✕ 닫기</button>
    </div>
    
    ${pageHtmls.map(html => `<div class="print-page">${html}</div>`).join('')}
    
    <script>
        // 이미지 로드 완료 후 자동 인쇄 (선택적)
        // window.onload = () => setTimeout(() => window.print(), 500);
    </script>
</body>
</html>
    `;
    
    printWindow.document.write(printHtml);
    printWindow.document.close();
    
    showToast('인쇄 창이 열렸습니다', 'success');
}

// ★ v5.0: 출력 페이지 열기 (새 창)
export function openPrintPage() {
    const guideId = state.currentGuide?.id;
    if (!guideId) {
        showToast('안내문을 먼저 저장해주세요', 'warning');
        return;
    }
    
    // 새 창으로 출력 페이지 열기
    const printUrl = `leasing-guide-print.html?id=${guideId}`;
    window.open(printUrl, '_blank');
}

// 전역 함수 등록
export function registerPreviewFunctions() {
    window.viewGuide = viewGuide;
    window.previewGuide = previewGuide;
    window.previewCurrentBuilding = previewCurrentBuilding;
    window.closeFullPreviewModal = closeFullPreviewModal;
    window.prevPreviewPage = prevPreviewPage;
    window.nextPreviewPage = nextPreviewPage;
    window.goToPreviewPage = goToPreviewPage;
    window.goToBuildingPage = goToBuildingPage;
    window.openPrintMenu = openPrintMenu;
    window.closePrintMenu = closePrintMenu;
    window.printCurrentBuilding = printCurrentBuilding;
    window.printAllPages = printAllPages;
    window.openPrintPage = openPrintPage;
}
