/**
 * Leasing Guide - 빌딩 에디터
 * 빌딩 프리뷰, 이미지 관리, 정보 수정
 * 
 * v2.1 수정사항:
 * - 이미지 placeholder에 권장 크기 표시
 * - portal.html leasingGuides 공실 데이터 연동
 * - 타사 공실 탭에 "안내문 공실" 옵션 추가
 * 
 * v2.3 수정사항 (2026-01-14):
 * - ★ Firebase "Write too large" 오류 해결
 * - compressImage() 함수 추가: 이미지 압축 (800px, JPEG 70%)
 * - syncImageToBuilding() 함수 추가: buildings 컬렉션 동기화
 * - uploadImage() 수정: 압축 후 저장, buildings/{id}에도 동기화
 * - removeImage() 수정: 삭제 시 buildings/{id}에서도 삭제
 * 
 * v3.6 수정사항 (2026-01-20):
 * - ★ 층 표기 정규화 함수 추가 (FF 중복 방지)
 * 
 * v4.6 수정사항 (2026-01-21):
 * - ★ 담당자 변경/해지 버튼 추가
 * - window.renderContactSectionWithActions 함수 연동
 * 
 * v4.7 수정사항 (2026-01-22):
 * - ★ 수동 모드 LOCATION: Firebase Storage 이미지 자동 로드
 * - building.images.location URL이 있으면 해당 이미지 표시
 * - 삭제 버튼: 업로드한 이미지 삭제 기능
 * - 기본값 복원: Storage 이미지가 있으면 복원 버튼 표시
 * - resetToStorageMapImage() 함수 추가
 * 
 * v4.8 수정사항 (2026-01-22):
 * - ★ 플로팅 메뉴 개선: 미리보기/전체보기/출력 버튼 분리
 * - 현재 빌딩 미리보기, 전체 미리보기, PDF 출력 기능
 * 
 * v4.9 수정사항 (2026-01-22):
 * - ★ 플로팅 메뉴에 이전/다음 페이지 네비게이션 추가
 * - 페이지 번호 표시 (N / Total)
 * 
 * v5.0 수정사항 (2026-01-22):
 * - ★ 출력 페이지 분리 (leasing-guide-print.html)
 * - ★ 공실 최대 개수 제한 (12개) 및 UI 안내
 * - ★ Contact Point 기본값 처리 개선
 * 
 * v5.1 수정사항 (2026-02-03):
 * - ★ 지도 자동 생성 버튼 추가 (카카오 Static Map API)
 * - generateLocationMap() 함수: 서버 API 호출 → Firebase Storage 저장
 * - 수동 모드에서 좌표가 있으면 "🗺️ 지도 생성" 버튼 표시
 * 
 * v5.2 수정사항 (2026-02-10):
 * - ★ #11: 수동 모드 LOCATION 이미지 드래그앤드롭/Ctrl+V 지원
 * - setupLocationDropAndPaste(): 드래그앤드롭 + 클립보드 붙여넣기 이벤트 설정
 * - processLocationImage(): 이미지 파일 압축 후 mapImage에 적용
 * - 플레이스홀더 텍스트 변경: "드래그앤드롭, Ctrl+V 또는 클릭"
 */

import { state, db, ref, get, update, getAllRegions } from './guide-state.js?v=5.1';
import { showToast, formatNumber, formatArea, formatPercent, normalizeBuilding, toWon, formatPriceWon, getExteriorImages, getFloorPlanImages } from './guide-utils.js?v=5.1';
import { 
    getUniqueSourcesHtml, 
    getUniqueDatesHtml, 
    renderExternalVacancyGroups, 
    renderExternalCartItems 
} from './guide-vacancy.js?v=5.1';
import { initBuildingKakaoMap } from './guide-map.js?v=5.1';

// ★ v5.0: 공실 최대 개수 (A4 가로 기준, 헤더/합계 포함)
const MAX_VACANCIES_PER_BUILDING = 12;

// ★ v4.6: state를 전역으로 노출 (leasing-guide.html의 담당자 CRUD 함수에서 사용)
window.guideState = state;

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

// ★ 권장 이미지 크기 상수
const IMAGE_SIZES = {
    exterior: { width: 800, height: 600, label: '외관: 800×600px 권장' },
    floorplan: { width: 800, height: 600, label: '평면도: 800×600px 권장' },
    map: { width: 600, height: 400, label: '지도: 600×400px 권장' }
};

// ★ 타사 공실 자동 로드 함수
async function loadExternalVacancies(buildingId) {
    try {
        const vacancyRef = ref(db, `vacancies/${buildingId}`);
        const snapshot = await get(vacancyRef);
        
        if (snapshot.exists()) {
            const vacancyData = snapshot.val();
            // 배열로 변환
            return Object.entries(vacancyData).map(([id, v]) => ({
                id,
                ...v
            }));
        }
        return [];
    } catch (error) {
        console.error('타사 공실 로드 오류:', error);
        return [];
    }
}

// ★ v3.8: 기준가(floorPricing) 비동기 로드 - 공실 이관 시 동반 참조
async function loadFloorPricing(buildingId, item) {
    try {
        const fpRef = ref(db, `buildings/${buildingId}/floorPricing`);
        const snapshot = await get(fpRef);
        
        if (snapshot.exists()) {
            const data = snapshot.val();
            item.floorPricing = Array.isArray(data) ? data : Object.values(data);
            console.log(`✅ floorPricing 로드: ${buildingId} → ${item.floorPricing.length}개`);
        } else {
            item.floorPricing = [];
        }
        item.floorPricingLoaded = true;
    } catch (error) {
        console.error('floorPricing 로드 오류:', error);
        item.floorPricing = [];
        item.floorPricingLoaded = true;
    }
}

// 빌딩 에디터 렌더링
export function renderBuildingEditor(item, building) {
    const editorMain = document.getElementById('editorMain');
    if (!editorMain) return;
    
    const isConfirmed = item?.closeConfirmed;
    const region = (item.region || building.region || 'ETC').toUpperCase();
    const idx = state.tocItems.indexOf(item);
    const allRegions = getAllRegions();
    
    // 이미지 데이터 초기화 (Firebase에서 기존 이미지 가져오기)
    if (!item.exteriorImages || item.exteriorImages.length === 0) {
        item.exteriorImages = getExteriorImages(building);
    }
    if (!item.floorPlanImages || item.floorPlanImages.length === 0) {
        item.floorPlanImages = getFloorPlanImages(building);
    }
    if (!item.mainImageIndex) item.mainImageIndex = 0;
    if (!item.customVacancies) item.customVacancies = [];
    if (!item.selectedExternalVacancies) item.selectedExternalVacancies = [];
    if (!item.leasingGuideVacancies) item.leasingGuideVacancies = [];  // ★ 안내문 공실
    
    // ★ v3.8: 기준가(floorPricing) 자동 로드 - 공실 이관 시 동반 참조용
    if (!item.floorPricingLoaded) {
        loadFloorPricing(building.id, item);
    }
    
    // ★ 타사 공실 자동 로드 (vacancies가 없거나 로드되지 않은 경우)
    let externalVacancies = building.vacancies;
    if (!Array.isArray(externalVacancies)) {
        externalVacancies = [];
        // 비동기로 로드 후 UI 업데이트
        loadExternalVacancies(building.id).then(vacancies => {
            if (vacancies && vacancies.length > 0) {
                building.vacancies = vacancies;
                // 타사 공실 영역만 업데이트
                const extBody = document.getElementById('extVacancyBody');
                if (extBody) {
                    extBody.innerHTML = renderExternalVacancyGroups(vacancies, item.selectedExternalVacancies, idx);
                }
                const countEl = document.querySelector('.external-vacancy-count');
                if (countEl) {
                    countEl.textContent = `${vacancies.length}건`;
                }
            }
        });
    }
    
    // ★ leasingGuides에서 해당 빌딩의 공실 정보 가져오기
    const leasingGuideVacancies = getLeasingGuideVacancies(building.id);
    
    // 빌딩 데이터 정규화
    normalizeBuilding(building);
    
    // 메인 이미지
    const mainImg = item.exteriorImages[item.mainImageIndex];
    const floorPlanImg = item.floorPlanImages[0];
    
    // ★ 공실 정렬 순서 초기화 (기본값: 오름차순)
    if (!item.vacancySortOrder) item.vacancySortOrder = 'asc';
    
    // 선택된 공실 통합 (customVacancies + selectedExternalVacancies + leasingGuideVacancies)
    const allVacanciesRaw = [
        ...item.customVacancies.map((v, i) => ({...v, type: 'custom', id: `custom_${i}`})),
        ...item.selectedExternalVacancies,
        ...item.leasingGuideVacancies.map((v, i) => ({...v, type: 'guide', id: `guide_${i}`}))
    ];
    
    // ★ 층 정렬 함수
    const sortVacancies = (vacancies, order) => {
        return [...vacancies].sort((a, b) => {
            const floorA = parseFloorNumber(a.floor);
            const floorB = parseFloorNumber(b.floor);
            return order === 'asc' ? floorA - floorB : floorB - floorA;
        });
    };
    
    // ★ 층 번호 파싱 (B1=-1, B2=-2, 1F=1, 12F=12 등)
    const parseFloorNumber = (floor) => {
        if (!floor || floor === '-') return 0;
        const str = String(floor).trim().toUpperCase();
        // 지하층: B1, B2 등
        const basement = str.match(/^B(\d+)/);
        if (basement) return -parseInt(basement[1]);
        // 일반층: 12F, 3F, 12, 3 등
        const above = str.match(/^(\d+)/);
        if (above) return parseInt(above[1]);
        return 0;
    };
    
    // 정렬 적용
    const allVacancies = sortVacancies(allVacanciesRaw, item.vacancySortOrder);
    
    // NOTE (임대안내문 표시용 메모)
    const guideMemos = (building.memos || []).filter(m => m.showInLeasingGuide);
    const noteHtml = guideMemos.length === 0 ? `
        <div class="preview-note-section preview-note-empty">
            <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                <span>NOTE</span>
                <button class="info-action-btn add-note-btn" onclick="openNoteModal(${idx}, '${building.id}')" title="노트 추가">+ 추가</button>
            </div>
            <div class="preview-note-placeholder" onclick="openNoteModal(${idx}, '${building.id}')">
                📝 클릭하여 노트 추가
            </div>
        </div>
    ` : `
        <div class="preview-note-section">
            <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                <span>NOTE</span>
                <button class="info-action-btn" onclick="openNoteModal(${idx}, '${building.id}')" title="노트 편집">✏️</button>
            </div>
            <div class="preview-note-content">
                ${guideMemos.map(m => `<div class="note-item">• ${(m.content||'').replace(/\n/g,'<br>')}</div>`).join('')}
            </div>
        </div>
    `;
    
    // ★ v4.9: 페이지 정보 가져오기
    const pageInfo = window.getPageInfo ? window.getPageInfo() : { current: idx + 3, total: '?' };
    
    editorMain.innerHTML = `
        <!-- 플로팅 메뉴 -->
        <div class="floating-menu no-print">
            <div class="floating-menu-left">
                <!-- ★ v4.9: 페이지 네비게이션 -->
                <div class="floating-nav-buttons">
                    <button class="floating-nav-btn" onclick="navigateToPrev()" title="이전 페이지">
                        ◀ 이전
                    </button>
                    <span class="floating-page-info">${pageInfo.current} / ${pageInfo.total}</span>
                    <button class="floating-nav-btn" onclick="navigateToNext()" title="다음 페이지">
                        다음 ▶
                    </button>
                </div>
                <div class="floating-status ${isConfirmed ? 'confirmed' : 'pending'}">
                    ${isConfirmed ? '✅ 확정' : '⏳ 대기'}
                </div>
                <div class="floating-shortcuts">
                    <select class="region-select-btn" onchange="changeItemRegion(${idx}, this.value)" title="권역 변경">
                        ${allRegions.map(r => `<option value="${r.code}" ${region === r.code ? 'selected' : ''}>${r.code} (${r.name})</option>`).join('')}
                    </select>
                    <button class="floating-shortcut" onclick="openPrintPage(${idx})" title="현재 페이지 출력">
                        🖨️ 출력
                    </button>
                    <button class="floating-shortcut" onclick="openPrintPage()" title="전체 페이지 출력" style="background:#22c55e;">
                        📄 전체
                    </button>
                    <button class="floating-shortcut" onclick="document.getElementById('imageManagerSection').scrollIntoView({behavior:'smooth'})">
                        📷 이미지
                    </button>
                    <button class="floating-shortcut" onclick="document.getElementById('dataManagerSection').scrollIntoView({behavior:'smooth'})">
                        📋 공실
                    </button>
                </div>
            </div>
            <button class="btn btn-sm ${isConfirmed ? 'btn-secondary' : 'btn-primary'}" onclick="toggleCloseStatus(${idx})">
                ${isConfirmed ? '🔓 마감해제' : '🔒 마감확정'}
            </button>
        </div>
        
        <!-- 가로형 임대안내문 프리뷰 (A4 Landscape) -->
        <div class="building-preview">
            <!-- 헤더: 빌딩명 + 권역정보 -->
            <div class="building-preview-header">
                <div class="building-title">
                    <span class="building-icon">🏢</span>
                    <span class="building-name">${building.name || '빌딩명'}</span>
                    ${item.exclusive ? '<span class="exclusive-badge">전속</span>' : ''}
                </div>
                <div class="region-info">Leasing Information (${region})</div>
            </div>
            
            <!-- 3열 메인 컨텐츠 -->
            <div class="building-preview-body">
                <!-- 좌측: 빌딩 사진 + 지도 -->
                <div class="preview-col-left">
                    <div>
                        <div class="preview-section-title">BUILDING PHOTO</div>
                        <!-- ★ 수정: 권장 크기 표시 -->
                        <div class="preview-building-photo preview-editable" onclick="uploadImage(${idx}, 'exterior')">
                            ${mainImg ? `<img src="${typeof mainImg === 'string' ? mainImg : (mainImg.url || mainImg)}" alt="빌딩 외관">` : `
                                <div class="upload-placeholder">
                                    <span class="placeholder-icon">🏢</span>
                                    <span class="placeholder-text">클릭하여 업로드</span>
                                    <span class="placeholder-size">${IMAGE_SIZES.exterior.label}</span>
                                </div>
                            `}
                        </div>
                    </div>
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>LOCATION</span>
                            <div style="display:flex; gap:4px; align-items:center;">
                                <!-- ★ v4.6: 로드뷰/캡처 버튼을 지도 밖으로 이동 -->
                                ${item.mapMode === 'auto' ? `
                                    ${building.lat && building.lng ? `<button class="info-action-btn" onclick="event.stopPropagation(); openRoadview(${building.lat}, ${building.lng})" title="로드뷰 보기" style="font-size:11px; padding:4px 8px;">👁️ 로드뷰</button>` : ''}
                                    <button class="info-action-btn" onclick="event.stopPropagation(); captureMap(${idx}, '${(building.name || '지도').replace(/'/g, "\\'")}')" title="지도 캡처 저장" style="font-size:11px; padding:4px 8px;">📸 캡처</button>
                                ` : `
                                    <!-- ★ v4.7: 수동 모드 - 삭제/기본값 버튼 -->
                                    <!-- ★ v5.1: 지도 자동 생성 버튼 추가 -->
                                    ${(building.coordinates?.lat && building.coordinates?.lng) || (building.lat && building.lng) ? `
                                        <button class="info-action-btn" onclick="event.stopPropagation(); generateLocationMap(${idx}, '${building.id}')" title="카카오 지도 이미지 자동 생성" style="font-size:11px; padding:4px 8px; background:#3b82f6; color:white;">🗺️ 지도생성</button>
                                    ` : ''}
                                    ${item.mapImage ? `
                                        <button class="info-action-btn" onclick="event.stopPropagation(); removeMapImage(${idx})" title="업로드 이미지 삭제" style="font-size:11px; padding:4px 8px; color:#dc2626;">🗑️ 삭제</button>
                                        ${building.images?.location ? `<button class="info-action-btn" onclick="event.stopPropagation(); resetToStorageMapImage(${idx}, '${building.id}')" title="Firebase Storage 이미지로 복원" style="font-size:11px; padding:4px 8px; color:#2563eb;">🔄 기본값</button>` : ''}
                                    ` : (building.images?.location ? `
                                        <span style="font-size:10px; color:#6b7280; padding:4px;">📦 Storage</span>
                                    ` : '')}
                                `}
                                <div class="location-mode-toggle">
                                    <button class="location-mode-btn ${item.mapMode !== 'auto' ? 'active' : ''}" onclick="setMapMode(${idx}, 'manual')">📷수동</button>
                                    <button class="location-mode-btn ${item.mapMode === 'auto' ? 'active' : ''}" onclick="setMapMode(${idx}, 'auto')">🗺️자동</button>
                                </div>
                            </div>
                        </div>
                        <!-- ★ 수정: 권장 크기 표시 -->
                        <div class="preview-location-map ${item.mapMode !== 'auto' ? 'preview-editable' : ''}" 
                             id="locationMap_${idx}"
                             ${item.mapMode !== 'auto' ? `onclick="uploadImage(${idx}, 'map')"` : ''}>
                            ${item.mapMode === 'auto' ? `
                                <div class="kakao-map-container" id="kakaoMapContainer_${idx}"></div>
                            ` : ((item.mapImage || building.images?.location) ? `<img src="${item.mapImage || building.images?.location}" alt="위치">` : `
                                <div class="upload-placeholder">
                                    <span class="placeholder-icon">🗺️</span>
                                    <span class="placeholder-text">드래그앤드롭, Ctrl+V 또는 클릭</span>
                                    <span class="placeholder-size">${IMAGE_SIZES.map.label}</span>
                                </div>
                            `)}
                        </div>
                    </div>
                </div>
                
                <!-- 중앙: 빌딩 정보 + 평면도 -->
                <div class="preview-col-center">
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>GENERAL INFORMATION</span>
                            <div class="info-action-btns">
                                <button class="info-action-btn" onclick="fetchBuildingRegistry('${building.id}')" title="Firebase에서 최신 데이터 불러오기">🔄 DB동기화</button>
                                <button class="info-action-btn" onclick="openBuildingEditModal('${building.id}')" title="수동으로 정보 입력/수정">✏️ 수정</button>
                            </div>
                        </div>
                        <table class="preview-info-table">
                            <tr><th>주소</th><td>${building.address || '-'}</td></tr>
                            <tr><th>위치</th><td>${building.nearbyStation || '-'}</td></tr>
                            <tr><th>연면적</th><td>${formatArea(building.grossFloorPy)} 평 (${formatNumber((building.grossFloorPy || 0) * 3.3058)}㎡)</td></tr>
                            <tr><th>규모</th><td>B${building.floorsBelow || 0} / ${building.floorsAbove || 0}F</td></tr>
                            <tr><th>준공년도</th><td>${building.completionYear || '-'}년</td></tr>
                            <tr><th>기준층(임대)</th><td>${formatArea(building.typicalFloorPy)} 평</td></tr>
                            <tr><th>전용률</th><td>${formatPercent(building.exclusiveRate || building.area?.exclusiveRate)}%</td></tr>
                            <tr><th>E/V</th><td>총 ${building.elevatorTotal || '-'}대</td></tr>
                            <tr><th>주차</th><td>총 ${String(building.parkingTotal || '-').replace(/대+$/, '')}대${building.parkingNote ? '<br><span style="font-size:10px; color:#555;">' + String(building.parkingNote).replace(/^대\s*/, '').replace(/\n/g, '<br>') + '</span>' : ''}</td></tr>
                        </table>
                    </div>
                    <div>
                        <div class="preview-section-title">TYPICAL FLOOR PLAN</div>
                        <!-- ★ 수정: 권장 크기 표시 -->
                        <div class="preview-floor-plan preview-editable" onclick="uploadImage(${idx}, 'floorplan')">
                            ${floorPlanImg ? `<img src="${typeof floorPlanImg === 'string' ? floorPlanImg : (floorPlanImg.url || floorPlanImg)}" alt="평면도">` : `
                                <div class="upload-placeholder">
                                    <span class="placeholder-icon">📐</span>
                                    <span class="placeholder-text">평면도 업로드</span>
                                    <span class="placeholder-size">${IMAGE_SIZES.floorplan.label}</span>
                                </div>
                            `}
                        </div>
                    </div>
                </div>
                
                <!-- 우측: 공실 + 임대조건 + 담당자 -->
                <div class="preview-col-right">
                    <div>
                        <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>SPACE AVAILABILITY</span>
                            <span class="preview-unit-note">면적: 평 | 금액: 원/평</span>
                        </div>
                        <table class="preview-vacancy-table">
                            <thead>
                                <tr>
                                    <th class="sortable-header" onclick="toggleVacancySort(${idx})" style="cursor:pointer;" title="클릭하여 정렬 변경">
                                        해당층 ${item.vacancySortOrder === 'asc' ? '▲' : '▼'}
                                    </th>
                                    <th>임대 면적</th>
                                    <th>전용 면적</th>
                                    <th>보증금</th>
                                    <th>임대료</th>
                                    <th>관리비</th>
                                    <th>입주 시기</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${allVacancies.length > 0 ? allVacancies.map(v => `
                                    <tr>
                                        <td class="floor">${formatFloorDisplay(v.floor)}</td>
                                        <td>${v.rentArea || v.area || '-'}</td>
                                        <td>${v.exclusiveArea || v.area || '-'}</td>
                                        <td>${v.deposit || v.depositPy || '문의'}</td>
                                        <td>${v.rent || v.rentPy || '문의'}</td>
                                        <td>${v.maintenance || v.maintenancePy || '문의'}</td>
                                        <td>${v.moveIn || v.moveInDate || '-'}</td>
                                    </tr>
                                `).join('') : `
                                    <tr><td colspan="7" class="no-vacancy-cell">
                                        <div class="no-vacancy-message">
                                            <span class="no-vacancy-icon">🏢</span>
                                            <span class="no-vacancy-text">${
                                                (item.customVacancies === null && item.selectedExternalVacancies === null && item.leasingGuideVacancies === null)
                                                ? '공실 데이터 없음 - 아래에서 추가해주세요'
                                                : '현재 공실 없음 (만실)'
                                            }</span>
                                        </div>
                                    </td></tr>
                                `}
                                ${allVacancies.length > 0 ? `
                                    <tr class="total-row">
                                        <td>합계</td>
                                        <td>${formatNumber(allVacancies.reduce((s,v) => s + (parseFloat(v.rentArea || v.area || 0)), 0))}</td>
                                        <td>${formatNumber(allVacancies.reduce((s,v) => s + (parseFloat(v.exclusiveArea || v.area || 0)), 0))}</td>
                                        <td colspan="4">-</td>
                                    </tr>
                                ` : ''}
                            </tbody>
                        </table>
                    </div>
                    
                    <!-- 임대 조건 -->
                    <div class="preview-rent-section">
                        <div class="preview-section-title">RENT <span style="font-weight:normal; font-size:8px; color:#94a3b8;">(단위:원/임대평)</span></div>
                        <table class="preview-rent-table">
                            <tr>
                                <th>구분</th>
                                <th>보증금</th>
                                <th>임대료</th>
                                <th>관리비</th>
                            </tr>
                            ${(() => {
                                const selectedIds = item.selectedFloorPricingIds || [];
                                const fps = item.floorPricing || [];
                                const selectedFps = fps.filter((fp, i) => selectedIds.includes(fp.id || String(i)));
                                if (selectedFps.length > 0) {
                                    return selectedFps.map(fp => `
                                        <tr>
                                            <td>${fp.label || fp.floorRange || '기준층'}</td>
                                            <td>${formatPriceWon(fp.depositPy)}</td>
                                            <td>${formatPriceWon(fp.rentPy)}</td>
                                            <td>${formatPriceWon(fp.maintenancePy)}</td>
                                        </tr>
                                    `).join('');
                                }
                                return `<tr>
                                    <td>기준층</td>
                                    <td>${formatPriceWon(building.depositPy)}</td>
                                    <td>${formatPriceWon(building.rentPy)}</td>
                                    <td>${formatPriceWon(building.maintenancePy)}</td>
                                </tr>`;
                            })()}
                        </table>
                    </div>
                    
                    <!-- NOTE -->
                    ${noteHtml}
                    
                    <!-- Contact Point - v4.6: 변경/해지 버튼 추가 -->
                    <div class="preview-contact-section">
                        ${(() => {
                            // ★ v4.6: window.renderContactSectionWithActions 함수가 있으면 사용
                            if (typeof window.renderContactSectionWithActions === 'function') {
                                const buildingContacts = item.contactPoints || building.contactPoints || [];
                                return window.renderContactSectionWithActions(
                                    buildingContacts,
                                    building.id,
                                    building.name,
                                    idx
                                );
                            }
                            
                            // Fallback: 기존 담당자 테이블 (변경/해지 버튼 추가)
                            const buildingContacts = item.contactPoints || building.contactPoints || [];
                            const contacts = buildingContacts.length > 0 
                                ? buildingContacts 
                                : (window.DEFAULT_CONTACT_POINTS || []);
                            const isDefault = !(buildingContacts.length > 0) || window.isDefaultContactPoints?.(buildingContacts);
                            
                            let html = `
                                <div class="preview-section-title" style="display:flex; justify-content:space-between; align-items:center;">
                                    <span>CONTACT POINT</span>
                                    <div style="display:flex; gap:6px; align-items:center;">
                                        <span class="${isDefault ? 'default-badge' : 'custom-badge'}" style="font-size:10px; padding:2px 8px; border-radius:10px; ${isDefault ? 'background:#e5e7eb; color:#6b7280;' : 'background:#dbeafe; color:#1d4ed8;'}">
                                            ${isDefault ? '기본값' : '지정됨'}
                                        </span>
                                        <button class="info-action-btn" onclick="openContactChangeModal('${building.id}', '${building.name.replace(/'/g, "\\'")}', ${idx}, ${JSON.stringify(contacts).replace(/"/g, '&quot;')})" style="font-size:11px; padding:4px 8px;">변경</button>
                                        ${!isDefault ? `<button class="info-action-btn" onclick="resetBuildingToDefaultContacts(${idx})" style="font-size:11px; padding:4px 8px; color:#dc2626;">해지</button>` : ''}
                                    </div>
                                </div>
                                <table class="preview-contact-table">
                                    <tr>
                                        <th>Name</th>
                                        <th>Phone</th>
                                        <th>Email</th>
                                    </tr>
                            `;
                            
                            if (contacts.length > 0) {
                                html += contacts.slice(0, 4).map(c => {
                                    const nameDisplay = c.name ? (c.position ? c.name + '(' + c.position + ')' : c.name) : '-';
                                    const phoneDisplay = c.phone || c.mobile || '-';
                                    const emailDisplay = c.email || '-';
                                    return '<tr><td>' + nameDisplay + '</td><td>' + phoneDisplay + '</td><td>' + emailDisplay + '</td></tr>';
                                }).join('');
                            } else {
                                html += '<tr><td colspan="3" style="color:#94a3b8;">No contacts</td></tr>';
                            }
                            
                            html += '</table>';
                            return html;
                        })()}
                    </div>
                </div>
            </div>
        </div>
        
        <!-- 이미지 관리 섹션 -->
        <div class="image-manager" id="imageManagerSection">
            <div class="image-manager-header">
                <div class="image-manager-title">📷 이미지 관리</div>
                <div class="image-tabs">
                    <button class="image-tab active" data-type="exterior" onclick="switchImageTab(${idx}, 'exterior', this)">외관 (${item.exteriorImages.length})</button>
                    <button class="image-tab" data-type="floorplan" onclick="switchImageTab(${idx}, 'floorplan', this)">평면도 (${item.floorPlanImages.length})</button>
                    <button class="image-tab" data-type="map" onclick="switchImageTab(${idx}, 'map', this)">지도 (${(item.mapImage || building.images?.location) ? 1 : 0})</button>
                </div>
            </div>
            <div class="image-size-info">
                💡 권장 크기: 외관/평면도 <strong>800×600px</strong> | 지도 <strong>600×400px</strong> (가로 비율 4:3)
            </div>
            <div class="image-grid" id="imageGrid">
                ${item.exteriorImages.length > 0 ? item.exteriorImages.map((img, i) => `
                    <div class="image-thumb ${item.mainImageIndex === i ? 'main' : ''}" onclick="setMainImage(${idx}, ${i})" title="${item.mainImageIndex === i ? '메인 이미지' : '클릭하여 메인으로 설정'}">
                        <img src="${typeof img === 'string' ? img : (img.url || img)}" alt="외관 ${i+1}">
                        <button class="remove-btn" onclick="event.stopPropagation(); removeImage(${idx}, 'exterior', ${i})">×</button>
                    </div>
                `).join('') : '<div class="image-empty">등록된 외관 이미지가 없습니다</div>'}
                <button class="image-add-btn" onclick="uploadImage(${idx}, 'exterior')" title="이미지 추가">+</button>
            </div>
        </div>
        
        <!-- 데이터 관리 섹션 -->
        <div class="image-manager" id="dataManagerSection">
            <div class="image-manager-header">
                <div class="image-manager-title">📋 데이터 관리</div>
                <div style="display:flex; gap:8px;">
                    <button class="btn btn-sm btn-primary" onclick="openContactPointModal('${item?.buildingId}')">👤 담당자</button>
                    <button class="btn btn-sm btn-secondary" onclick="addDividerAfter('${item?.buildingId}')">📄 간지</button>
                </div>
            </div>
            
            <!-- 기준층 정보 -->
            <div class="standard-floor-section">
                <div class="standard-floor-header">
                    <div class="standard-floor-title">📐 기준층 임대조건 (RENT)</div>
                    <button class="btn btn-sm btn-primary" onclick="saveStandardFloor('${building.id}')">💾 저장</button>
                </div>
                <div class="standard-floor-grid">
                    <div class="standard-floor-field">
                        <label>보증금 (원/평)</label>
                        <input type="text" id="stdDeposit" value="${building.depositPy || ''}" placeholder="예: 60만">
                    </div>
                    <div class="standard-floor-field">
                        <label>임대료 (원/평)</label>
                        <input type="text" id="stdRent" value="${building.rentPy || ''}" placeholder="예: 8.5만">
                    </div>
                    <div class="standard-floor-field">
                        <label>관리비 (원/평)</label>
                        <input type="text" id="stdMaintenance" value="${building.maintenancePy || ''}" placeholder="예: 3.5만">
                    </div>
                    <div class="standard-floor-field">
                        <label>전용률 (%)</label>
                        <input type="text" id="stdExclusiveRate" value="${building.exclusiveRate || ''}" placeholder="예: 52">
                    </div>
                </div>
            </div>
            
            <!-- 공실 관리 -->
            <div class="vacancy-section">
                <div class="vacancy-header">
                    <div class="vacancy-title">🏠 공실 관리</div>
                    <div class="vacancy-count-info">
                        <span class="vacancy-current-count ${allVacancies.length >= MAX_VACANCIES_PER_BUILDING ? 'over-limit' : ''}">${allVacancies.length}</span>
                        <span class="vacancy-max-count">/ ${MAX_VACANCIES_PER_BUILDING}개</span>
                        <span class="vacancy-limit-hint">(출력 최대)</span>
                    </div>
                    <button class="btn btn-sm btn-secondary" onclick="openVacancyAddPanel(${idx})" ${allVacancies.length >= MAX_VACANCIES_PER_BUILDING ? 'disabled title="최대 개수 초과"' : ''}>+ 공실 추가</button>
                </div>
                
                ${allVacancies.length >= MAX_VACANCIES_PER_BUILDING ? `
                <div class="vacancy-warning">
                    ⚠️ 출력 가능한 최대 공실 개수(${MAX_VACANCIES_PER_BUILDING}개)에 도달했습니다. 더 추가하면 인쇄 시 잘릴 수 있습니다.
                </div>
                ` : ''}
                
                <!-- 공실 추가 패널 -->
                <div class="vacancy-add-panel" id="vacancyAddPanel" style="display:none;">
                    <div class="vacancy-add-tabs">
                        <button class="vacancy-add-tab active" onclick="switchAddVacancyMode('direct')">직접 입력</button>
                        <button class="vacancy-add-tab" onclick="switchAddVacancyMode('external')">타사 공실</button>
                    </div>
                    
                    <!-- 직접 입력 -->
                    <div id="addVacancyDirect" class="vacancy-add-content">
                        <div class="vacancy-add-grid">
                            <input type="text" id="newVacFloor" placeholder="층 (예: 15)">
                            <input type="text" id="newVacExclusive" placeholder="전용면적">
                            <input type="text" id="newVacArea" placeholder="임대면적">
                            <input type="text" id="newVacDeposit" placeholder="보증금">
                            <input type="text" id="newVacRent" placeholder="임대료">
                            <input type="text" id="newVacMaintenance" placeholder="관리비">
                            <input type="text" id="newVacMoveIn" placeholder="입주시기">
                            <button class="btn btn-primary btn-sm" onclick="addDirectVacancy(${idx})">추가</button>
                        </div>
                    </div>
                    
                    <!-- 타사 공실 (자동 로드, 다중 선택) -->
                    <div id="addVacancyExternal" class="vacancy-add-content" style="display:none;">
                        <div class="external-vacancy-container">
                            <!-- 좌측: 공실 리스트 (자동 표시) -->
                            <div class="external-vacancy-list">
                                <div class="external-vacancy-header">
                                    <div class="external-vacancy-filters">
                                        <select id="extSourceFilter" onchange="filterExternalVacancies(${idx})">
                                            <option value="all">전체 출처</option>
                                            ${getUniqueSourcesHtml(externalVacancies)}
                                        </select>
                                        <select id="extDateFilter" onchange="filterExternalVacancies(${idx})">
                                            <option value="all">전체 날짜</option>
                                            ${getUniqueDatesHtml(externalVacancies)}
                                        </select>
                                    </div>
                                    <span class="external-vacancy-count">${externalVacancies.length}건</span>
                                </div>
                                <div class="external-vacancy-body" id="extVacancyBody">
                                    ${renderExternalVacancyGroups(externalVacancies, item.selectedExternalVacancies, idx)}
                                </div>
                            </div>
                            
                            <!-- 우측: 선택된 공실 (장바구니) -->
                            <div class="external-vacancy-cart">
                                <div class="external-vacancy-cart-header">
                                    <span>✓ 적용됨 (${item.selectedExternalVacancies.length})${(item.pendingExternalVacancies?.length || 0) > 0 ? ` / 대기 (${item.pendingExternalVacancies.length})` : ''}</span>
                                    <div style="display:flex; gap:4px;">
                                        <button class="btn btn-sm btn-secondary" onclick="clearExternalCart(${idx})">초기화</button>
                                    </div>
                                </div>
                                <!-- ★ v3.8: pending 반영 바 -->
                                <div id="extPendingBar" style="display:${(item.pendingExternalVacancies?.length || 0) > 0 ? 'flex' : 'none'}; align-items:center; justify-content:space-between; padding:8px 12px; background:#fffbeb; border-bottom:1px solid #fde68a;">
                                    ${(item.pendingExternalVacancies?.length || 0) > 0 ? `
                                        <span style="font-size:12px; color:#d97706; font-weight:600;">⏳ ${item.pendingExternalVacancies.length}건 대기 중</span>
                                        <div style="display:flex; gap:4px;">
                                            <button class="btn btn-sm" onclick="cancelPendingExternal(${idx})" 
                                                style="background:#f3f4f6; color:#6b7280; border:1px solid #d1d5db; font-size:11px; padding:3px 8px;">취소</button>
                                            <button class="btn btn-sm btn-primary" onclick="applyPendingExternalVacancies(${idx})" 
                                                style="background:#2563eb; color:white; font-size:11px; padding:3px 10px; font-weight:600;">✓ 반영</button>
                                        </div>
                                    ` : ''}
                                </div>
                                <div class="external-vacancy-cart-body" id="extCartBody">
                                    ${renderExternalCartItems(item.selectedExternalVacancies, idx)}
                                </div>
                            </div>
                            
                            <div class="external-vacancy-notice">
                                💡 공실을 체크한 후 <strong>[✓ 반영]</strong> 버튼을 클릭해야 공실 현황에 적용됩니다.
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- 등록된 공실 테이블 -->
                <table class="vacancy-list-table">
                    <thead>
                        <tr>
                            <th>층</th>
                            <th>전용(평)</th>
                            <th>임대(평)</th>
                            <th>보증금</th>
                            <th>임대료</th>
                            <th>입주시기</th>
                            <th>관리</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${allVacancies.length > 0 ? allVacancies.map((v, i) => `
                            <tr>
                                <td class="floor">${formatFloorDisplay(v.floor)}</td>
                                <td>${v.exclusiveArea || v.area || '-'}</td>
                                <td>${v.rentArea || v.area || '-'}</td>
                                <td>${v.deposit || v.depositPy || '-'}</td>
                                <td>${v.rent || v.rentPy || '-'}</td>
                                <td>${v.moveIn || v.moveInDate || '협의'}</td>
                                <td>
                                    <div class="actions">
                                        <button class="btn btn-sm btn-secondary" onclick="editVacancyItem(${idx}, '${v.id}', '${v.type}')">✏️</button>
                                        <button class="btn btn-sm btn-danger" onclick="removeSelectedVacancy(${idx}, '${v.id}', '${v.type}')">×</button>
                                    </div>
                                </td>
                            </tr>
                        `).join('') : `<tr><td colspan="7" style="text-align:center; padding:30px; color:#94a3b8;">등록된 공실이 없습니다</td></tr>`}
                    </tbody>
                </table>
                ${item.floorPricing && item.floorPricing.length > 0 ? `
                    <div style="margin-top:8px; padding:10px 12px; background:#f0f9ff; border:1px solid #bae6fd; border-radius:6px;">
                        <div style="font-size:12px; font-weight:600; color:#0369a1; margin-bottom:8px;">
                            💰 기준가 선택 <span style="font-weight:normal; color:#64748b;">(RENT 테이블에 표시됨)</span>
                            <button onclick="toggleAllFloorPricing(${idx}, true)" style="margin-left:8px; font-size:10px; padding:2px 6px; border:1px solid #0369a1; border-radius:3px; background:white; color:#0369a1; cursor:pointer;">전체선택</button>
                            <button onclick="toggleAllFloorPricing(${idx}, false)" style="margin-left:4px; font-size:10px; padding:2px 6px; border:1px solid #94a3b8; border-radius:3px; background:white; color:#64748b; cursor:pointer;">전체해제</button>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:4px;">
                            ${item.floorPricing.map((fp, fi) => {
                                const fpId = fp.id || String(fi);
                                const selectedIds = item.selectedFloorPricingIds || [fpId];
                                const isChecked = selectedIds.includes(fpId);
                                const label = fp.label || fp.floorRange || ('기준가 ' + (fi+1));
                                const dep = fp.depositPy ? fp.depositPy.toLocaleString() : '-';
                                const rent = fp.rentPy ? fp.rentPy.toLocaleString() : '-';
                                const maint = fp.maintenancePy ? fp.maintenancePy.toLocaleString() : '-';
                                return '<label style="display:flex; align-items:center; gap:8px; padding:6px 8px; background:white; border-radius:4px; cursor:pointer; font-size:12px;">'
                                    + '<input type="checkbox" ' + (isChecked ? 'checked' : '') + ' onchange="toggleFloorPricing(' + idx + ', \'' + fpId + '\')" style="cursor:pointer;">'
                                    + '<span style="font-weight:500;">' + label + '</span>'
                                    + '<span style="color:#64748b;">보증금 ' + dep + ' / 임대 ' + rent + ' / 관리 ' + maint + '</span>'
                                    + '</label>';
                            }).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        </div>
    `;
        
    // 숨겨진 파일 input 추가
    if (!document.getElementById('imageUploadInput')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'imageUploadInput';
        input.accept = 'image/*';
        input.multiple = true;
        input.style.display = 'none';
        document.body.appendChild(input);
    }
    
    // ★ v5.2: 수동 모드 LOCATION 드래그앤드롭 + Ctrl+V 이벤트 바인딩
    if (item.mapMode !== 'auto') {
        setTimeout(() => {
            const locationMap = document.getElementById(`locationMap_${idx}`);
            if (locationMap) {
                setupLocationDropAndPaste(locationMap, idx);
            }
        }, 100);
    }
    
    // 자동 모드일 때 카카오맵 초기화
    if (item.mapMode === 'auto') {
        setTimeout(() => initBuildingKakaoMap(idx, building), 200);
    }
}

// ★ 신규: leasingGuides에서 해당 빌딩의 공실 정보 가져오기
function getLeasingGuideVacancies(buildingId) {
    const vacancies = [];
    
    // 모든 leasingGuides를 순회하며 해당 빌딩의 공실 찾기
    Object.values(state.leasingGuides || {}).forEach(guide => {
        const items = guide.items || [];
        items.forEach(item => {
            if (item.buildingId === buildingId) {
                // customVacancies
                if (item.customVacancies && item.customVacancies.length > 0) {
                    item.customVacancies.forEach(v => {
                        vacancies.push({
                            ...v,
                            source: `안내문: ${guide.title || '제목없음'}`,
                            guideId: guide.id
                        });
                    });
                }
                // selectedExternalVacancies
                if (item.selectedExternalVacancies && item.selectedExternalVacancies.length > 0) {
                    item.selectedExternalVacancies.forEach(v => {
                        vacancies.push({
                            ...v,
                            source: `안내문: ${guide.title || '제목없음'}`,
                            guideId: guide.id
                        });
                    });
                }
            }
        });
    });
    
    // 중복 제거 (floor + exclusiveArea + rentArea + source 기준으로 고유 식별)
    const uniqueVacancies = [];
    const seen = new Set();
    vacancies.forEach(v => {
        // ★ 더 정확한 고유 키 생성 (전용면적, 임대면적 모두 포함)
        const exclusiveArea = v.exclusiveArea || v.area || '';
        const rentArea = v.rentArea || v.area || '';
        const key = `${v.floor}_${exclusiveArea}_${rentArea}_${v.source || ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueVacancies.push(v);
        }
    });
    
    return uniqueVacancies;
}

// ★ 신규: 안내문 공실 불러오기
export async function loadLeasingGuideVacancies(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const vacancies = getLeasingGuideVacancies(buildingId);
    
    if (vacancies.length === 0) {
        showToast('저장된 안내문 공실 정보가 없습니다', 'info');
        return;
    }
    
    // 모두 선택
    item.leasingGuideVacancies = vacancies.map(v => ({
        ...v,
        type: 'guide'
    }));
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    renderBuildingEditor(item, building);
    showToast(`${vacancies.length}개의 공실 정보를 불러왔습니다`, 'success');
}

// ★ 신규: 안내문 공실 개별 토글
export function toggleGuideVacancy(idx, vacancyIdx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const buildingId = item.buildingId;
    const allGuideVacancies = getLeasingGuideVacancies(buildingId);
    const targetVacancy = allGuideVacancies[vacancyIdx];
    
    if (!targetVacancy) return;
    
    if (!item.leasingGuideVacancies) item.leasingGuideVacancies = [];
    
    // ★ 더 정확한 비교 (floor + exclusiveArea + rentArea)
    const getVacancyKey = (v) => {
        const exclusiveArea = v.exclusiveArea || v.area || '';
        const rentArea = v.rentArea || v.area || '';
        return `${v.floor}_${exclusiveArea}_${rentArea}`;
    };
    
    const targetKey = getVacancyKey(targetVacancy);
    const existingIdx = item.leasingGuideVacancies.findIndex(v => getVacancyKey(v) === targetKey);
    
    if (existingIdx >= 0) {
        item.leasingGuideVacancies.splice(existingIdx, 1);
    } else {
        item.leasingGuideVacancies.push({
            ...targetVacancy,
            type: 'guide'
        });
    }
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    renderBuildingEditor(item, building);
}

// ★ 신규: 안내문 공실 전체 선택
export function selectAllGuideVacancies(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const allGuideVacancies = getLeasingGuideVacancies(buildingId);
    
    item.leasingGuideVacancies = allGuideVacancies.map(v => ({
        ...v,
        type: 'guide'
    }));
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    renderBuildingEditor(item, building);
    showToast(`${allGuideVacancies.length}개 공실이 선택되었습니다`, 'success');
}


// ★ v2.3 신규: 이미지 압축 함수 (Firebase 용량 제한 해결)
function compressImage(dataUrl, maxWidth = 800, quality = 0.7) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            
            // 최대 너비 초과 시 리사이징
            if (width > maxWidth) {
                height = Math.round((height * maxWidth) / width);
                width = maxWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            
            // JPEG로 압축 (PNG도 JPEG로 변환)
            const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
            
            console.log(`[이미지 압축] ${Math.round(dataUrl.length/1024)}KB → ${Math.round(compressedDataUrl.length/1024)}KB`);
            
            resolve(compressedDataUrl);
        };
        img.src = dataUrl;
    });
}

// ★ v2.3 신규: 이미지를 buildings 컬렉션에 동기화하는 함수
async function syncImageToBuilding(buildingId, type, images) {
    if (!buildingId) return;
    
    try {
        const updateData = {};
        
        if (type === 'exterior') {
            updateData['exteriorImages'] = images;
        } else if (type === 'floorplan') {
            updateData['floorPlanImages'] = images;
        }
        
        if (Object.keys(updateData).length > 0) {
            await update(ref(db, `buildings/${buildingId}`), updateData);
            console.log(`[이미지 동기화] buildings/${buildingId}에 ${type} 이미지 저장 완료`);
        }
    } catch (error) {
        console.error('[이미지 동기화 오류]', error);
        if (error.message && error.message.includes('too large')) {
            showToast('이미지 용량이 너무 큽니다. 더 작은 이미지를 사용해주세요.', 'error');
        }
    }
}

// ★ v2.3 수정: 이미지 업로드 (압축 + buildings 컬렉션 동기화)
export function uploadImage(idx, type) {
    const input = document.getElementById('imageUploadInput');
    if (!input) return;
    
    input.onchange = async function(e) {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        const item = state.tocItems[idx];
        if (!item) return;
        
        showToast('이미지 처리 중...', 'info');
        
        // 파일 읽기 및 압축 Promise 배열
        const processPromises = files.map(file => {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = async function(ev) {
                    const originalDataUrl = ev.target.result;
                    
                    // ★ 이미지 압축 (800px, 70% 품질)
                    const compressedDataUrl = await compressImage(originalDataUrl, 800, 0.7);
                    
                    resolve({ url: compressedDataUrl, fileName: file.name });
                };
                reader.readAsDataURL(file);
            });
        });
        
        // 모든 파일 처리 완료 대기
        const newImages = await Promise.all(processPromises);
        
        // 타입별로 이미지 추가
        if (type === 'exterior') {
            if (!item.exteriorImages) item.exteriorImages = [];
            item.exteriorImages.push(...newImages);
            
            // ★ buildings 컬렉션에도 동기화
            await syncImageToBuilding(item.buildingId, 'exterior', item.exteriorImages);
            
        } else if (type === 'floorplan') {
            if (!item.floorPlanImages) item.floorPlanImages = [];
            // ★ v2.3.2: 새 이미지를 맨 앞에 추가 (미리보기에 바로 반영)
            item.floorPlanImages.unshift(...newImages);
            
            // ★ buildings 컬렉션에도 동기화
            await syncImageToBuilding(item.buildingId, 'floorplan', item.floorPlanImages);
            
        } else if (type === 'map') {
            // 지도 이미지도 압축
            item.mapImage = newImages[0]?.url || '';
        }
        
        const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
        
        // 로컬 building 객체도 업데이트
        if (building && building.id) {
            if (type === 'exterior') {
                building.exteriorImages = item.exteriorImages;
            } else if (type === 'floorplan') {
                building.floorPlanImages = item.floorPlanImages;
            }
        }
        
        renderBuildingEditor(item, building);
        showToast('이미지가 추가되었습니다', 'success');
        
        // ★ v2.3.1: 업로드 완료 후 해당 타입의 탭 자동 활성화
        if (type === 'exterior' || type === 'floorplan' || type === 'map') {
            setTimeout(() => {
                const tabBtn = document.querySelector(`.image-tab[data-type="${type}"]`);
                if (tabBtn) {
                    switchImageTab(idx, type, tabBtn);
                }
            }, 100);
        }
        
        e.target.value = '';
    };
    
    input.click();
}

// 메인 이미지 설정
export function setMainImage(idx, imageIdx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.mainImageIndex = imageIdx;
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    renderBuildingEditor(item, building);
}

// ★ v2.3 수정: 이미지 삭제 (buildings 컬렉션 동기화 포함)
export function removeImage(idx, type, imageIdx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    if (type === 'exterior') {
        item.exteriorImages.splice(imageIdx, 1);
        if (item.mainImageIndex >= item.exteriorImages.length) {
            item.mainImageIndex = Math.max(0, item.exteriorImages.length - 1);
        }
        
        // buildings 컬렉션에도 동기화
        syncImageToBuilding(item.buildingId, 'exterior', item.exteriorImages);
        
    } else if (type === 'floorplan') {
        item.floorPlanImages.splice(imageIdx, 1);
        
        // buildings 컬렉션에도 동기화
        syncImageToBuilding(item.buildingId, 'floorplan', item.floorPlanImages);
    }
    
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    
    // 로컬 building 객체도 업데이트
    if (building && building.id) {
        if (type === 'exterior') {
            building.exteriorImages = item.exteriorImages;
        } else if (type === 'floorplan') {
            building.floorPlanImages = item.floorPlanImages;
        }
    }
    
    renderBuildingEditor(item, building);
    showToast('이미지가 삭제되었습니다', 'success');
}

// 지도 이미지 삭제
export function removeMapImage(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.mapImage = null;
    const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
    renderBuildingEditor(item, building);
    showToast('지도 이미지가 삭제되었습니다', 'success');
}

// ★ v4.7: Firebase Storage 이미지로 복원
export function resetToStorageMapImage(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    
    if (!building.images?.location) {
        showToast('기본 이미지가 없습니다', 'error');
        return;
    }
    
    // 확인 다이얼로그
    const confirmed = confirm(
        `업로드한 이미지를 삭제하고\nFirebase Storage 이미지로 복원하시겠습니까?`
    );
    
    if (confirmed) {
        item.mapImage = null;  // 업로드 이미지 삭제 → Storage 이미지 사용
        renderBuildingEditor(item, building);
        showToast('기본 이미지로 복원되었습니다', 'success');
    }
}

// ★ v5.2: LOCATION 영역 드래그앤드롭 + Ctrl+V 설정
function setupLocationDropAndPaste(container, idx) {
    // 기존 이벤트 제거 (중복 방지)
    container.removeAttribute('data-dnd-bound');
    
    // --- 드래그앤드롭 ---
    container.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '2px dashed #3b82f6';
        container.style.outlineOffset = '-2px';
        container.style.background = 'rgba(59, 130, 246, 0.05)';
    });
    
    container.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '';
        container.style.outlineOffset = '';
        container.style.background = '';
    });
    
    container.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        container.style.outline = '';
        container.style.outlineOffset = '';
        container.style.background = '';
        
        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            const file = files[0];
            if (file.type.startsWith('image/')) {
                processLocationImage(file, idx);
            } else {
                showToast('이미지 파일만 업로드 가능합니다', 'warning');
            }
        }
    });
    
    // --- Ctrl+V (클립보드 붙여넣기) ---
    // container에 tabindex를 설정하여 포커스 가능하게
    container.setAttribute('tabindex', '0');
    container.style.outline = container.style.outline || '';  // focus 시 기본 outline 유지
    
    container.addEventListener('paste', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        const items = e.clipboardData?.items;
        if (!items) return;
        
        for (const clipItem of items) {
            if (clipItem.type.startsWith('image/')) {
                const file = clipItem.getAsFile();
                if (file) {
                    processLocationImage(file, idx);
                    return;
                }
            }
        }
        showToast('클립보드에 이미지가 없습니다', 'warning');
    });
    
    // 클릭 시 포커스 (Ctrl+V 수신 가능하도록)
    container.addEventListener('focus', () => {
        container.style.boxShadow = '0 0 0 2px rgba(59, 130, 246, 0.3)';
    });
    container.addEventListener('blur', () => {
        container.style.boxShadow = '';
    });
    
    container.setAttribute('data-dnd-bound', 'true');
}

// ★ v5.2: LOCATION 이미지 파일 처리 (압축 후 적용)
async function processLocationImage(file, idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    showToast('이미지 처리 중...', 'info');
    
    try {
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve(ev.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        
        // 압축 (800px, 70% 품질)
        const compressed = await compressImage(dataUrl, 800, 0.7);
        item.mapImage = compressed;
        
        const building = state.allBuildings.find(b => b.id === item.buildingId) || {};
        renderBuildingEditor(item, building);
        showToast('지도 이미지가 적용되었습니다', 'success');
        
        // 지도 탭 자동 활성화
        setTimeout(() => {
            const tabBtn = document.querySelector('.image-tab[data-type="map"]');
            if (tabBtn) switchImageTab(idx, 'map', tabBtn);
        }, 100);
        
    } catch (error) {
        console.error('이미지 처리 오류:', error);
        showToast('이미지 처리 중 오류가 발생했습니다', 'error');
    }
}

// ★ v5.1: 지도 이미지 자동 생성 (카카오 Static Map API)
export async function generateLocationMap(idx, buildingId) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    const building = state.allBuildings.find(b => b.id === buildingId) || {};
    
    // 좌표 확인 (coordinates 또는 직접 lat/lng)
    const lat = building.coordinates?.lat || building.lat;
    const lng = building.coordinates?.lng || building.lng;
    
    if (!lat || !lng) {
        showToast('빌딩 좌표 정보가 없습니다', 'error');
        return;
    }
    
    // 로딩 표시
    const mapContainer = document.getElementById(`locationMap_${idx}`);
    if (mapContainer) {
        mapContainer.innerHTML = `
            <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:#666;">
                <div style="font-size:24px; animation: spin 1s linear infinite;">⏳</div>
                <div style="margin-top:8px; font-size:12px;">지도 생성 중...</div>
            </div>
        `;
    }
    
    try {
        // API 서버 URL (CONFIG에서 가져오거나 기본값 사용)
        const API_BASE = window.CONFIG?.API_BASE || 'https://portal-dsyl.onrender.com';
        
        console.log(`🗺️ 지도 생성 요청: ${building.name} (${lat}, ${lng})`);
        
        const response = await fetch(`${API_BASE}/api/generate-location-map`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                buildingId: buildingId,
                lat: lat,
                lng: lng,
                name: building.name || 'Building',
                level: 3,
                width: 600,
                height: 400,
                saveToFirebase: true
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            const imageUrl = result.imageUrl || result.imageBase64;
            
            // state 업데이트
            if (!building.images) building.images = {};
            building.images.location = imageUrl;
            
            // item에도 반영 (mapImage는 null로 유지 → Storage 이미지 사용)
            item.mapImage = null;
            
            // 에디터 다시 렌더링
            renderBuildingEditor(item, building);
            
            showToast('지도 이미지가 생성되었습니다', 'success');
            console.log('  ✅ 지도 생성 완료:', imageUrl?.substring(0, 80) + '...');
            
        } else {
            throw new Error(result.error || '지도 생성 실패');
        }
        
    } catch (error) {
        console.error('지도 생성 오류:', error);
        showToast(`지도 생성 실패: ${error.message}`, 'error');
        
        // 에러 시 원래 상태로 복원
        renderBuildingEditor(item, building);
    }
}

// 이미지 탭 전환
export function switchImageTab(idx, type, btn) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    // 탭 버튼 활성화
    document.querySelectorAll('.image-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    
    // 그리드 업데이트
    const grid = document.getElementById('imageGrid');
    if (!grid) return;
    
    if (type === 'exterior') {
        grid.innerHTML = `
            ${item.exteriorImages.length > 0 ? item.exteriorImages.map((img, i) => `
                <div class="image-thumb ${item.mainImageIndex === i ? 'main' : ''}" onclick="setMainImage(${idx}, ${i})" title="${item.mainImageIndex === i ? '메인 이미지' : '클릭하여 메인으로 설정'}">
                    <img src="${typeof img === 'string' ? img : (img.url || img)}" alt="외관 ${i+1}">
                    <button class="remove-btn" onclick="event.stopPropagation(); removeImage(${idx}, 'exterior', ${i})">×</button>
                </div>
            `).join('') : '<div class="image-empty">등록된 외관 이미지가 없습니다</div>'}
            <button class="image-add-btn" onclick="uploadImage(${idx}, 'exterior')" title="이미지 추가">+</button>
        `;
    } else if (type === 'floorplan') {
        grid.innerHTML = `
            ${item.floorPlanImages.length > 0 ? item.floorPlanImages.map((img, i) => `
                <div class="image-thumb">
                    <img src="${typeof img === 'string' ? img : (img.url || img)}" alt="평면도 ${i+1}">
                    <button class="remove-btn" onclick="event.stopPropagation(); removeImage(${idx}, 'floorplan', ${i})">×</button>
                </div>
            `).join('') : '<div class="image-empty">등록된 평면도 이미지가 없습니다</div>'}
            <button class="image-add-btn" onclick="uploadImage(${idx}, 'floorplan')" title="이미지 추가">+</button>
        `;
    } else if (type === 'map') {
        grid.innerHTML = `
            ${item.mapImage ? `
                <div class="image-thumb">
                    <img src="${item.mapImage}" alt="지도">
                    <button class="remove-btn" onclick="event.stopPropagation(); removeMapImage(${idx})">×</button>
                </div>
            ` : '<div class="image-empty">등록된 지도 이미지가 없습니다</div>'}
            <button class="image-add-btn" onclick="uploadImage(${idx}, 'map')" title="지도 업로드">+</button>
        `;
    }
}

// 기준층 임대조건 저장
export async function saveStandardFloor(buildingId) {
    try {
        const depositPy = document.getElementById('stdDeposit')?.value || '';
        const rentPy = document.getElementById('stdRent')?.value || '';
        const maintenancePy = document.getElementById('stdMaintenance')?.value || '';
        const exclusiveRate = document.getElementById('stdExclusiveRate')?.value || '';
        
        await update(ref(db, `buildings/${buildingId}`), {
            depositPy,
            rentPy,
            maintenancePy,
            exclusiveRate
        });
        
        // 로컬 상태 업데이트
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building) {
            building.depositPy = depositPy;
            building.rentPy = rentPy;
            building.maintenancePy = maintenancePy;
            building.exclusiveRate = exclusiveRate;
        }
        
        showToast('기준층 임대조건이 저장되었습니다', 'success');
        
        // 프리뷰 갱신
        if (state.selectedTocIndex >= 0) {
            const item = state.tocItems[state.selectedTocIndex];
            if (item && building) {
                renderBuildingEditor(item, building);
            }
        }
    } catch (error) {
        console.error('저장 오류:', error);
        showToast('저장 중 오류가 발생했습니다', 'error');
    }
}

// ========== 빌딩 정보 수정 모달 ==========
export function openBuildingEditModal(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    const modalHtml = `
        <div class="modal-overlay show" id="buildingEditModal" onclick="if(event.target===this)closeBuildingEditModal()">
            <div class="modal" style="max-width:600px;">
                <div class="modal-header">
                    <h2 class="modal-title">🏢 빌딩 정보 수정</h2>
                    <button class="modal-close" onclick="closeBuildingEditModal()">×</button>
                </div>
                <div class="modal-body" style="max-height:60vh; overflow-y:auto;">
                    <div class="form-group">
                        <label>빌딩명</label>
                        <input type="text" id="editBldName" value="${building.name || ''}">
                    </div>
                    <div class="form-group">
                        <label>주소</label>
                        <input type="text" id="editBldAddress" value="${building.address || ''}">
                    </div>
                    <div class="form-group">
                        <label>인근역 (위치)</label>
                        <input type="text" id="editBldStation" value="${building.nearbyStation || ''}" placeholder="예: 2호선 강남역 도보 5분">
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>연면적 (평)</label>
                            <input type="text" id="editBldGrossFloor" value="${building.grossFloorPy || ''}">
                        </div>
                        <div class="form-group">
                            <label>기준층 전용면적 (평)</label>
                            <input type="text" id="editBldTypicalFloor" value="${building.typicalFloorPy || ''}">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>전용률 (%)</label>
                            <input type="text" id="editBldExclusiveRate" value="${building.exclusiveRate || ''}">
                        </div>
                        <div class="form-group">
                            <label>준공년도</label>
                            <input type="text" id="editBldYear" value="${building.completionYear || ''}">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>지상 층수</label>
                            <input type="text" id="editBldFloorsAbove" value="${building.floorsAbove || ''}">
                        </div>
                        <div class="form-group">
                            <label>지하 층수</label>
                            <input type="text" id="editBldFloorsBelow" value="${building.floorsBelow || ''}">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                        <div class="form-group">
                            <label>엘리베이터 (총 대수)</label>
                            <input type="text" id="editBldElevator" value="${building.elevatorTotal || ''}">
                        </div>
                        <div class="form-group">
                            <label>주차 (총 대수)</label>
                            <input type="text" id="editBldParking" value="${building.parkingTotal || ''}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label>주차 비고</label>
                        <input type="text" id="editBldParkingNote" value="${building.parkingNote || ''}" placeholder="예: (1대/120평)">
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeBuildingEditModal()">취소</button>
                    <button class="btn btn-primary" onclick="saveBuildingEdit('${buildingId}')">💾 저장</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export function closeBuildingEditModal() {
    const modal = document.getElementById('buildingEditModal');
    if (modal) modal.remove();
}

export async function saveBuildingEdit(buildingId) {
    if (!confirm('이 변경사항은 CRE Portal의 해당 빌딩 기본정보에도 반영됩니다.\n저장하시겠습니까?')) return;
    try {
        const updateData = {
            name: document.getElementById('editBldName')?.value || '',
            address: document.getElementById('editBldAddress')?.value || '',
            nearbyStation: document.getElementById('editBldStation')?.value || '',
            'area/grossFloorPy': parseFloat(document.getElementById('editBldGrossFloor')?.value) || 0,
            'area/typicalFloorPy': parseFloat(document.getElementById('editBldTypicalFloor')?.value) || 0,
            'area/exclusiveRate': parseFloat(document.getElementById('editBldExclusiveRate')?.value) || 0,
            'floors/above': parseInt(document.getElementById('editBldFloorsAbove')?.value) || 0,
            'floors/below': parseInt(document.getElementById('editBldFloorsBelow')?.value) || 0,
            'specs/completionYear': document.getElementById('editBldYear')?.value || '',
            'specs/passengerElevator': parseInt(document.getElementById('editBldElevator')?.value) || 0,
            'parking/total': parseInt(document.getElementById('editBldParking')?.value) || 0,
            parkingNote: document.getElementById('editBldParkingNote')?.value || ''
        };
        
        await update(ref(db, `buildings/${buildingId}`), updateData);
        
        // 로컬 상태 업데이트 (플랫 구조로)
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building) {
            building.name = document.getElementById('editBldName')?.value || building.name;
            building.address = document.getElementById('editBldAddress')?.value || building.address;
            building.nearbyStation = document.getElementById('editBldStation')?.value || building.nearbyStation;
            building.grossFloorPy = parseFloat(document.getElementById('editBldGrossFloor')?.value) || building.grossFloorPy;
            building.typicalFloorPy = parseFloat(document.getElementById('editBldTypicalFloor')?.value) || building.typicalFloorPy;
            building.exclusiveRate = parseFloat(document.getElementById('editBldExclusiveRate')?.value) || building.exclusiveRate;
            building.floorsAbove = parseInt(document.getElementById('editBldFloorsAbove')?.value) || building.floorsAbove;
            building.floorsBelow = parseInt(document.getElementById('editBldFloorsBelow')?.value) || building.floorsBelow;
            building.completionYear = document.getElementById('editBldYear')?.value || building.completionYear;
            building.elevatorTotal = parseInt(document.getElementById('editBldElevator')?.value) || building.elevatorTotal;
            building.parkingTotal = parseInt(document.getElementById('editBldParking')?.value) || building.parkingTotal;
            building.parkingNote = document.getElementById('editBldParkingNote')?.value || building.parkingNote;
        }
        
        closeBuildingEditModal();
        showToast('빌딩 정보가 저장되었습니다', 'success');
        
        // 프리뷰 갱신
        if (state.selectedTocIndex >= 0) {
            const item = state.tocItems[state.selectedTocIndex];
            if (item && building) {
                renderBuildingEditor(item, building);
            }
        }
    } catch (error) {
        console.error('빌딩 정보 저장 오류:', error);
        showToast('저장 중 오류가 발생했습니다', 'error');
    }
}

// ========== 건축물대장 자동 가져오기 ==========
export async function fetchBuildingRegistry(buildingId) {
    showToast('Firebase에서 빌딩 정보 불러오는 중...', 'info');
    
    try {
        // Firebase에서 빌딩 데이터 다시 읽어오기
        const snapshot = await get(ref(db, `buildings/${buildingId}`));
        
        if (!snapshot.exists()) {
            showToast('빌딩 정보를 찾을 수 없습니다', 'error');
            return;
        }
        
        const freshData = snapshot.val();
        freshData.id = buildingId;
        
        // 디버그: 원본 Firebase 데이터
        console.log('[자동] Firebase 원본 데이터:', JSON.stringify(freshData, null, 2));
        console.log('[자동] specs:', freshData.specs);
        console.log('[자동] parking:', freshData.parking);
        console.log('[자동] floors:', freshData.floors);
        console.log('[자동] area:', freshData.area);
        
        // 데이터 정규화 (중첩 구조 → 평면 구조)
        normalizeBuilding(freshData);
        
        // 로컬 상태 업데이트 (state.allBuildings에서 해당 빌딩 교체)
        const idx = state.allBuildings.findIndex(b => b.id === buildingId);
        if (idx >= 0) {
            // 기존 데이터와 병합 (새 데이터 우선)
            state.allBuildings[idx] = { ...state.allBuildings[idx], ...freshData };
        }
        
        const building = state.allBuildings[idx] || freshData;
        
        // 디버그: 정규화 후 데이터
        console.log('[자동] 정규화 후 데이터:', {
            name: building.name,
            floorsAbove: building.floorsAbove,
            floorsBelow: building.floorsBelow,
            elevatorTotal: building.elevatorTotal,
            parkingTotal: building.parkingTotal,
            grossFloorPy: building.grossFloorPy,
            typicalFloorPy: building.typicalFloorPy,
            exclusiveRate: building.exclusiveRate,
            completionYear: building.completionYear
        });
        
        showToast('빌딩 정보를 불러왔습니다', 'success');
        
        // 프리뷰 갱신
        if (state.selectedTocIndex >= 0) {
            const item = state.tocItems[state.selectedTocIndex];
            if (item) {
                renderBuildingEditor(item, building);
            }
        }
        
    } catch (error) {
        console.error('Firebase 데이터 로드 오류:', error);
        showToast('빌딩 정보 로드에 실패했습니다', 'error');
    }
}

// ========== 빌딩 권역 변경 ==========
export function changeItemRegion(idx, newRegion) {
    if (idx < 0 || idx >= state.tocItems.length) return;
    
    const item = state.tocItems[idx];
    if (!item) return;
    
    item.region = newRegion.toUpperCase();
    
    // 목차 갱신
    window.renderToc();
    
    showToast(`권역이 ${newRegion}으로 변경되었습니다`, 'success');
}

// ★ v5.0: 출력 페이지 열기 (별도 페이지로 분리)
export function openPrintPage(pageIndex = null) {
    // 현재 안내문 ID 가져오기 (currentGuide.id 사용)
    const guideId = state.currentGuide?.id;
    
    if (!guideId) {
        showToast('안내문을 먼저 저장해주세요', 'warning');
        return;
    }
    
    // 저장 여부 확인
    if (state.hasUnsavedChanges) {
        if (!confirm('저장하지 않은 변경사항이 있습니다.\n출력 페이지로 이동하시겠습니까?')) {
            return;
        }
    }
    
    // 출력 페이지 URL 생성
    let url = `leasing-guide-print.html?id=${guideId}`;
    if (pageIndex !== null) {
        url += `&page=${pageIndex}`;
    }
    
    // 새 탭에서 열기
    window.open(url, '_blank');
    showToast('출력 페이지를 새 탭에서 열었습니다', 'success');
}

// ★ 공실 정렬 토글 함수
export function toggleVacancySort(idx) {
    const item = state.tocItems[idx];
    if (!item) return;
    
    // 오름차순 ↔ 내림차순 토글
    item.vacancySortOrder = item.vacancySortOrder === 'asc' ? 'desc' : 'asc';
    
    // 빌딩 에디터 다시 렌더링
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) {
        renderBuildingEditor(item, building);
    }
    
    showToast(`층 정렬: ${item.vacancySortOrder === 'asc' ? '오름차순 (낮은층→높은층)' : '내림차순 (높은층→낮은층)'}`, 'info');
}

// 전역 함수 등록

// ★ 기준가 선택 토글
export function toggleFloorPricing(itemIdx, fpId) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const fps = item.floorPricing || [];
    if (!item.selectedFloorPricingIds) {
        item.selectedFloorPricingIds = fps.length > 0 ? [fps[0].id || '0'] : [];
    }
    const i = item.selectedFloorPricingIds.indexOf(fpId);
    if (i >= 0) item.selectedFloorPricingIds.splice(i, 1);
    else item.selectedFloorPricingIds.push(fpId);
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

export function toggleAllFloorPricing(itemIdx, selectAll) {
    const item = state.tocItems[itemIdx];
    if (!item) return;
    const fps = item.floorPricing || [];
    item.selectedFloorPricingIds = selectAll ? fps.map((fp, i) => fp.id || String(i)) : [];
    const building = state.allBuildings.find(b => b.id === item.buildingId);
    if (building) window.renderBuildingEditor(item, building);
}

export function registerBuildingFunctions() {
    window.renderBuildingEditor = renderBuildingEditor;
    window.uploadImage = uploadImage;
    window.setMainImage = setMainImage;
    window.removeImage = removeImage;
    window.removeMapImage = removeMapImage;
    window.resetToStorageMapImage = resetToStorageMapImage;
    window.switchImageTab = switchImageTab;
    window.saveStandardFloor = saveStandardFloor;
    window.toggleFloorPricing = toggleFloorPricing;
    window.toggleAllFloorPricing = toggleAllFloorPricing;
    window.openBuildingEditModal = openBuildingEditModal;
    window.closeBuildingEditModal = closeBuildingEditModal;
    window.saveBuildingEdit = saveBuildingEdit;
    window.fetchBuildingRegistry = fetchBuildingRegistry;
    window.changeItemRegion = changeItemRegion;
    window.openPrintPage = openPrintPage;
    // ★ v5.0: 상수 노출
    window.MAX_VACANCIES_PER_BUILDING = MAX_VACANCIES_PER_BUILDING;
    // ★ 신규: 안내문 공실 관련
    window.loadLeasingGuideVacancies = loadLeasingGuideVacancies;
    window.toggleGuideVacancy = toggleGuideVacancy;
    // ★ 신규: 공실 정렬
    window.toggleVacancySort = toggleVacancySort;
    window.selectAllGuideVacancies = selectAllGuideVacancies;
    // ★ v5.1: 지도 자동 생성
    window.generateLocationMap = generateLocationMap;
}
