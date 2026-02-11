/**
 * CRE Portal - 상세 패널 모듈
 * 빌딩 상세 정보 패널 렌더링
 * 
 * v3.6: 층 표기 정규화 함수 추가 (FF 중복 방지)
 * v3.10: 담당자 수정/삭제 기능 연동 (portal.html의 전역 함수 사용)
 * v3.12: 공실 이관 후 새로고침 개선 (대상 빌딩 로컬 상태 업데이트, 빈 공실 시 신규입력 UI)
 * v3.13: 공실없음(만실) 처리 - _meta.noVacancy 플래그로 만실 구분, 원문보기 지원
 * v3.14: 공실없음 표시 개선 + 이관 시 기준가 매칭 로직 수정 (sourceCompany/effectiveDate 정규화)
 */

import { state } from './portal-state.js';
import { formatNumber, showToast } from './portal-utils.js';
import { panToBuilding } from './portal-map.js';
import { toggleStar } from './portal-ui.js';
import { db, ref, update, remove, set, get, push } from './portal-firebase.js';

// ★ v3.10: state를 전역으로 노출 (portal.html의 담당자 CRUD 함수에서 사용)
window.state = state;

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

// ===== ★ v2.0: 소숫점 표기 토글 =====
// 기본값: 소숫점 숨김 (정수 표시)
if (typeof state.showDecimalArea === 'undefined') {
    state.showDecimalArea = false;
}

// ===== ★ v3.11: 공실 리스트 정렬 상태 =====
// 기본값: 오름차순 (asc), 내림차순 (desc)
if (typeof state.vacancySortOrder === 'undefined') {
    state.vacancySortOrder = 'asc';
}

// ★ Sprint3-NEW2: 주차정보 포맷 함수
function formatParkingDisplay(b) {
    // 건축물대장 데이터 우선
    if (b.parking?.total) {
        let display = b.parking.total + '대';
        if (b.parking.ratio) display += ` (${b.parking.ratio})`;
        return display;
    }
    // OCR 추출 데이터
    if (b.parkingTotal) {
        let parts = [b.parkingTotal + '대'];
        if (b.parkingFree) parts.push(`무료 ${b.parkingFree}`);
        if (b.parkingPaid) parts.push(`유료 ${b.parkingPaid}`);
        if (b.parkingNote) parts.push(b.parkingNote);
        return parts.length > 1 ? `${b.parkingTotal}대 (${parts.slice(1).join(', ')})` : parts[0];
    }
    if (b.parking?.display) return b.parking.display;
    // 무료/유료만 있는 경우
    if (b.parkingFree || b.parkingPaid) {
        const parts = [];
        if (b.parkingFree) parts.push(`무료 ${b.parkingFree}`);
        if (b.parkingPaid) parts.push(`유료 ${b.parkingPaid}`);
        return parts.join(', ');
    }
    return '-';
}

/**
 * 면적 포맷 (소숫점 토글 반영)
 * @param {number|string} value - 면적 값
 * @param {boolean} forceDecimal - 강제 소숫점 표시 (편집 모드용)
 * @returns {string} - 포맷된 문자열
 */
function formatArea(value, forceDecimal = false) {
    if (!value && value !== 0) return '-';
    const num = parseFloat(value);
    if (isNaN(num)) return '-';
    
    // 강제 소숫점 또는 토글 ON인 경우 소숫점 2자리까지
    if (forceDecimal || state.showDecimalArea) {
        return num.toFixed(2) + '평';
    }
    // 토글 OFF인 경우 정수로 표시
    return Math.round(num).toLocaleString() + '평';
}

/**
 * 소숫점 표기 토글
 */
export function toggleDecimalArea() {
    state.showDecimalArea = !state.showDecimalArea;
    
    // 공실 테이블 다시 렌더링
    if (state.selectedBuilding) {
        renderDocumentSection();
    }
    
    showToast(state.showDecimalArea ? '소숫점 표기 ON' : '소숫점 표기 OFF', 'info');
}

/**
 * ★ v3.11: 층 문자열을 숫자로 파싱 (정렬용)
 * "10F" → 10, "B1" → -1, "B2F" → -2, "지하3층" → -3
 */
function parseFloorNumber(floorStr) {
    if (!floorStr || floorStr === '-') return 999; // 정보 없으면 맨 뒤로
    
    const str = String(floorStr).trim().toUpperCase();
    
    // 지하층: B1, B2, B1F, B2F, 지하1층, 지하2 등
    const basementMatch = str.match(/^B(\d+)F?$/) || str.match(/지하\s*(\d+)/);
    if (basementMatch) {
        return -parseInt(basementMatch[1], 10);
    }
    
    // 지상층: 10F, 10층, 10 등
    const floorMatch = str.match(/^(\d+)F?층?$/);
    if (floorMatch) {
        return parseInt(floorMatch[1], 10);
    }
    
    // 숫자만 추출 시도
    const numOnly = str.replace(/[^\d-]/g, '');
    if (numOnly) {
        return parseInt(numOnly, 10);
    }
    
    return 998; // 파싱 실패 시 거의 맨 뒤로
}

/**
 * ★ v3.11: 공실 리스트 정렬 토글 (오름차순 ↔ 내림차순)
 */
export function toggleVacancySortOrder() {
    state.vacancySortOrder = state.vacancySortOrder === 'asc' ? 'desc' : 'asc';
    
    // 공실 테이블 다시 렌더링
    if (state.selectedBuilding) {
        renderDocumentSection();
    }
    
    showToast(state.vacancySortOrder === 'asc' ? '층 오름차순 ↑' : '층 내림차순 ↓', 'info');
}

// 전역으로 노출 (onclick에서 사용)
window.toggleVacancySortOrder = toggleVacancySortOrder;

// ===== 단위 변환 헬퍼 함수 (마이그레이션 호환) =====
/**
 * 가격 값을 원 단위로 정규화
 * - 마이그레이션 후 데이터: 이미 원 단위 (예: 119500)
 * - 기존/OCR 데이터: 만원 단위일 수 있음 (예: 11.95)
 */
function toWon(value) {
    const num = parseFloat(String(value || '').replace(/[^\d.]/g, '')) || 0;
    if (num === 0) return 0;
    // 1000 미만이면 만원 단위로 간주 (×10000)
    return num < 1000 ? num * 10000 : num;
}

// ===== 상세 패널 열기/닫기 =====

export function openDetail(id) {
    state.selectedBuilding = state.allBuildings.find(b => b.id === id);
    if (!state.selectedBuilding) return;
    
    // 필터 상태 초기화 (새 빌딩 열 때마다)
    state.selectedRentrollDate = null; // 최신 월로 자동 선택되도록
    state.selectedPricingDate = 'all'; // ★ 기준가 필터 초기화
    state.selectedDocSource = 'all';
    state.selectedDocPeriod = 'all';
    
    // 공실 선택 상태 초기화
    state.selectedVacancyIds = new Set();
    state.currentDisplayedVacancies = [];
    
    const b = state.selectedBuilding;
    document.getElementById('detailTitle').textContent = b.name || '이름 없음';
    document.getElementById('detailSubtitle').textContent = b.address || '-';
    document.getElementById('rentrollCount').textContent = b.rentrollCount || 0;
    // ★ v3.3: 메모 개수는 실제 memos 배열 길이로 계산
    document.getElementById('memoCount').textContent = (b.memos || []).length;
    document.getElementById('documentCount').textContent = (b.documents || []).length;
    document.getElementById('pricingCount').textContent = (b.floorPricing || []).length;
    document.getElementById('contactCount').textContent = (b.contactPoints || []).length;
    
    // 즐겨찾기 별 상태 업데이트
    updateDetailStarBtn();
    
    // 삭제/복원 버튼 상태 업데이트
    updateDeleteButtons();
    
    renderInfoSection();
    renderPricingSection();
    renderRentrollSection();
    renderMemoSection();
    renderIncentiveSection();
    renderDocumentSection();
    renderContactSection();
    
    document.getElementById('detailOverlay').classList.add('show');
    document.getElementById('detailPanel').classList.add('open');
    
    // 리스트/테이블 선택 상태 업데이트
    document.querySelectorAll('.list-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    document.querySelectorAll('.data-grid tbody tr').forEach(el => el.classList.remove('selected'));
    
    if (state.currentViewMode === 'map') panToBuilding(state.selectedBuilding);
}

export function closeDetail() {
    document.getElementById('detailOverlay').classList.remove('show');
    document.getElementById('detailPanel').classList.remove('open');
    state.selectedBuilding = null;
}

// 상세 패널 별 버튼 상태 업데이트
export function updateDetailStarBtn() {
    const btn = document.getElementById('detailStarBtn');
    if (!btn || !state.selectedBuilding) return;
    const isStarred = state.starredBuildings.has(state.selectedBuilding.id);
    btn.textContent = isStarred ? '★' : '☆';
    btn.classList.toggle('starred', isStarred);
}

// 상세 패널에서 즐겨찾기 토글
export function toggleDetailStar() {
    if (!state.selectedBuilding) return;
    toggleStar(state.selectedBuilding.id);
    updateDetailStarBtn();
}

// 삭제/숨기기/복원 버튼 상태 업데이트
export function updateDeleteButtons() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const hideBtn = document.getElementById('detailHideBtn');
    const deleteBtn = document.getElementById('detailDeleteBtn');
    const restoreBtn = document.getElementById('detailRestoreBtn');
    
    const isHidden = b.isHidden || b._raw?.isHidden || b.status === 'hidden';
    
    // 관리자 여부 확인
    const adminEmails = ['admin@snimgt.com', 'system@snimgt.com', 'oramlee@sni.co.kr'];
    const isAdminUser = adminEmails.includes(state.currentUser?.email);
    
    if (hideBtn) {
        // 숨기기 버튼: 숨겨지지 않은 빌딩에서만 표시
        hideBtn.style.display = isHidden ? 'none' : 'inline-flex';
    }
    
    if (deleteBtn) {
        // 완전삭제 버튼: 관리자이고 숨겨지지 않은 빌딩에서만 표시
        deleteBtn.style.display = (isAdminUser && !isHidden) ? 'inline-flex' : 'none';
    }
    
    if (restoreBtn) {
        // 복원 버튼: 숨겨진 빌딩에서만 표시
        restoreBtn.style.display = isHidden ? 'inline-flex' : 'none';
    }
}

// ===== 기본 정보 섹션 =====

export function renderInfoSection() {
    const b = state.selectedBuilding;
    // ★ 마이그레이션 호환: toWon()으로 원 단위 정규화, * 10000 제거
    const rentVal = toWon(b.rentPy);
    const mgmtVal = toWon(b.maintenancePy);
    const eff = (b.exclusiveRate || 55) / 100;
    const fnoc = eff > 0 ? (rentVal + mgmtVal) / eff : 0;
    
    // 복수 기준가 정보
    const floorPricing = b.floorPricing || [];
    const pricingCount = floorPricing.length;
    
    // 노트 정보
    const buildingNotes = b.notes || '';
    
    // ★ v3.2: 권역 자동 감지 함수
    function detectRegionFromAddress(address) {
        if (!address) return 'ETC';
        // GBD: 강남, 서초, 삼성
        if (address.includes('강남') || address.includes('서초') || address.includes('삼성') || address.includes('역삼') || address.includes('테헤란')) return 'GBD';
        // YBD: 여의도, 영등포, 마포, 공덕
        if (address.includes('여의도') || address.includes('영등포') || address.includes('마포') || address.includes('공덕')) return 'YBD';
        // CBD: 종로, 중구, 을지로, 광화문, 시청
        if (address.includes('종로') || address.includes('중구') || address.includes('을지로') || address.includes('광화문') || address.includes('시청')) return 'CBD';
        // BBD: 분당, 판교, 성남
        if (address.includes('분당') || address.includes('판교') || address.includes('성남')) return 'BBD';
        return 'ETC';
    }
    
    // 권역 정보 (자동 감지 여부 확인)
    const rawBuilding = b._raw || {};
    const hasStoredRegion = rawBuilding.region || rawBuilding.regionId || b.region;
    // ★ 저장된 권역이 없으면 주소 기반 자동 감지
    const currentRegion = hasStoredRegion ? (b.region || 'ETC') : detectRegionFromAddress(b.address);
    const isAutoDetected = !hasStoredRegion;
    
    const regionLabels = { GBD: '강남권역', CBD: '도심권역', YBD: '여의도권역', BBD: '분당권역', ETC: '기타' };
    const regionColors = { GBD: '#16a34a', CBD: '#0284c7', YBD: '#7c3aed', BBD: '#ea580c', ETC: '#6b7280' };
    
    // 이미지 데이터
    const exteriorImages = b.exteriorImages || [];
    const floorPlanImages = b.floorPlanImages || [];
    
    // ★ 2컬럼 이미지 갤러리 (외관 5:5 평면도)
    const imageGalleryHtml = `
        <div class="image-gallery-dual">
            <!-- 외관 이미지 영역 -->
            <div class="image-column">
                <div class="column-header">
                    <span class="column-title">🏢 외관</span>
                    <span class="column-count">${exteriorImages.length}장</span>
                </div>
                ${exteriorImages.length > 0 ? `
                    <div class="image-main-area" onclick="openImageViewer('exterior', window._exteriorIdx || 0)">
                        <img id="exteriorMainImg" src="${exteriorImages[0].url}" alt="외관">
                        <div class="image-overlay">
                            <span>🔍 크게 보기</span>
                        </div>
                        ${exteriorImages.length > 1 ? `
                            <button class="carousel-btn prev" onclick="event.stopPropagation(); carouselNav('exterior', -1)">‹</button>
                            <button class="carousel-btn next" onclick="event.stopPropagation(); carouselNav('exterior', 1)">›</button>
                            <span class="image-counter" id="exteriorCounter">1 / ${exteriorImages.length}</span>
                        ` : ''}
                    </div>
                    ${exteriorImages.length > 1 ? `
                        <div class="image-thumbs-row" id="exteriorThumbsRow">
                            ${exteriorImages.map((img, i) => `
                                <div class="thumb-item ${i === 0 ? 'active' : ''}" onclick="selectImage('exterior', ${i})">
                                    <img src="${img.url}" alt="외관 ${i+1}">
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                    <button class="btn-add-image" onclick="addExteriorImage()">➕ 외관 사진 추가</button>
                ` : `
                    <div class="image-empty-area" onclick="addExteriorImage()">
                        <div class="empty-icon">🏢</div>
                        <div class="empty-text">외관 사진 없음</div>
                        <button class="btn-add-empty">➕ 사진 추가</button>
                    </div>
                `}
            </div>
            
            <!-- 평면도 이미지 영역 -->
            <div class="image-column">
                <div class="column-header">
                    <span class="column-title">📐 평면도</span>
                    <span class="column-count">${floorPlanImages.length}장</span>
                </div>
                ${floorPlanImages.length > 0 ? `
                    <div class="image-main-area" onclick="openImageViewer('floorplan', window._floorplanIdx || 0)">
                        <img id="floorplanMainImg" src="${floorPlanImages[0].url}" alt="평면도">
                        <div class="image-overlay">
                            <span>🔍 크게 보기</span>
                        </div>
                        ${floorPlanImages.length > 1 ? `
                            <button class="carousel-btn prev" onclick="event.stopPropagation(); carouselNav('floorplan', -1)">‹</button>
                            <button class="carousel-btn next" onclick="event.stopPropagation(); carouselNav('floorplan', 1)">›</button>
                            <span class="image-counter" id="floorplanCounter">1 / ${floorPlanImages.length}</span>
                        ` : ''}
                    </div>
                    ${floorPlanImages.length > 1 ? `
                        <div class="image-thumbs-row" id="floorplanThumbsRow">
                            ${floorPlanImages.map((img, i) => `
                                <div class="thumb-item ${i === 0 ? 'active' : ''}" onclick="selectImage('floorplan', ${i})">
                                    <img src="${img.url}" alt="평면도 ${i+1}">
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}
                    <button class="btn-add-image" onclick="addFloorPlanImage()">➕ 평면도 추가</button>
                ` : `
                    <div class="image-empty-area" onclick="addFloorPlanImage()">
                        <div class="empty-icon">📐</div>
                        <div class="empty-text">평면도 없음</div>
                        <button class="btn-add-empty">➕ 평면도 추가</button>
                    </div>
                `}
            </div>
        </div>
    `;
    
    // 캐러셀 인덱스 초기화
    window._exteriorIdx = 0;
    window._floorplanIdx = 0;

    document.getElementById('sectionInfo').innerHTML = `
        <!-- ★ 기본정보 헤더 (새로고침 버튼) -->
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border-color);">
            <span style="font-size: 14px; font-weight: 600; color: var(--text-primary);">📋 기본정보</span>
            <button onclick="refreshInfoSection()" style="padding: 4px 10px; font-size: 11px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                🔄 새로고침
            </button>
        </div>
        
        <!-- 이미지 갤러리 -->
        ${imageGalleryHtml}
        
        ${buildingNotes ? `
        <div class="building-note-card" style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; border-left: 4px solid #f59e0b;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div>
                    <div style="font-size: 11px; font-weight: 600; color: #92400e; margin-bottom: 4px;">📝 빌딩 노트</div>
                    <div style="font-size: 13px; color: #78350f; line-height: 1.5; white-space: pre-wrap;">${buildingNotes}</div>
                </div>
                <button onclick="openBuildingNoteModal()" style="background: none; border: none; cursor: pointer; font-size: 14px; color: #92400e;" title="편집">✏️</button>
            </div>
        </div>
        ` : `
        <div style="margin-bottom: 16px;">
            <button onclick="openBuildingNoteModal()" style="width: 100%; padding: 10px; border: 1px dashed var(--border-color); border-radius: 8px; background: var(--bg-secondary); color: var(--text-muted); cursor: pointer; font-size: 13px;">
                📝 빌딩 노트 추가하기
            </button>
        </div>
        `}
        
        <!-- 임대안내문 포함 표시 -->
        ${state.leasingGuideBuildings.has(b.id) ? `
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding: 12px 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; color: white;">
            <span style="font-size: 18px;">📄</span>
            <div style="flex: 1;">
                <div style="font-size: 13px; font-weight: 600;">우리 임대안내문 포함</div>
                <div style="font-size: 11px; opacity: 0.9;">이 빌딩은 현재 임대안내문에 포함되어 있습니다</div>
            </div>
            <a href="leasing-guide.html" style="padding: 6px 12px; background: rgba(255,255,255,0.2); border-radius: 6px; color: white; text-decoration: none; font-size: 12px; font-weight: 500;">안내문 관리 →</a>
        </div>
        ` : ''}
        
        <!-- 권역 정보 -->
        <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding: 10px 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 4px solid ${regionColors[currentRegion] || '#6b7280'};">
            <span style="font-size: 13px; color: var(--text-secondary);">📍 권역:</span>
            <span style="font-size: 14px; font-weight: 600; color: ${regionColors[currentRegion] || '#6b7280'};">${currentRegion}</span>
            <span style="font-size: 12px; color: var(--text-muted);">(${regionLabels[currentRegion] || '기타'})</span>
            ${isAutoDetected ? `
                <span style="font-size: 10px; padding: 2px 6px; background: #fef3c7; color: #92400e; border-radius: 4px; margin-left: auto;">자동감지</span>
                <button onclick="saveAutoDetectedRegion('${currentRegion}')" style="font-size: 11px; padding: 4px 10px; background: var(--accent-color); color: white; border: none; border-radius: 4px; cursor: pointer;">저장</button>
            ` : ''}
        </div>
        
        <!-- ★ #13: 빌딩 별칭 표시 -->
        ${typeof renderAliasesSection === 'function' ? renderAliasesSection(b) : ((b.aliases && b.aliases.length > 0) ? `
        <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 12px; padding: 8px 12px; background: #faf5ff; border: 1px solid #e9d5ff; border-radius: 8px;">
            <span style="font-size: 11px; color: #7c3aed; font-weight: 600; white-space: nowrap;">🏷️ 별칭:</span>
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
                ${b.aliases.map(al => '<span style="padding: 2px 8px; background: #ede9fe; color: #6d28d9; border-radius: 4px; font-size: 11px;">' + al + '</span>').join('')}
            </div>
        </div>
        ` : '')}
        
        <!-- 빌딩 설명 (있을 경우만 표시) -->
        ${b.description ? `
        <div style="margin-bottom: 16px; padding: 14px 16px; background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border-radius: 10px; border: 1px solid #e2e8f0;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
                <span style="font-size: 13px;">📝</span>
                <span style="font-size: 12px; font-weight: 600; color: var(--text-secondary);">빌딩 설명</span>
                <button onclick="openBuildingEditModal()" style="margin-left: auto; padding: 2px 8px; font-size: 11px; background: none; border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-muted); cursor: pointer;">편집</button>
            </div>
            <div style="font-size: 13px; color: var(--text-primary); line-height: 1.6; white-space: pre-wrap;">${b.description}</div>
        </div>
        ` : ''}
        
        <!-- 면적 정보 (평 크게 + ㎡ 괄호 표시) -->
        <div class="info-grid" style="grid-template-columns: repeat(3, 1fr);">
            <div class="info-card">
                <div class="label">연면적</div>
                <div class="value">${formatNumber(b.area?.grossFloorPy || b.grossFloorPy)}<span class="unit">평</span></div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">(${formatNumber(b.area?.grossFloorSqm || b.grossFloorSqm)}㎡)</div>
            </div>
            <div class="info-card">
                <div class="label">대지면적</div>
                <div class="value">${formatNumber(Math.round((b.area?.landArea || b.landArea || 0) / 3.3058))}<span class="unit">평</span></div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">(${formatNumber(b.area?.landArea || b.landArea)}㎡)</div>
            </div>
            <div class="info-card">
                <div class="label">건축면적</div>
                <div class="value">${formatNumber(Math.round((b.area?.buildingArea || b.buildingArea || 0) / 3.3058))}<span class="unit">평</span></div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">(${formatNumber(b.area?.buildingArea || b.buildingArea)}㎡)</div>
            </div>
        </div>
        
        <!-- 기준층/전용률 정보 -->
        <div class="info-grid" style="grid-template-columns: repeat(3, 1fr); margin-top: 8px;">
            <div class="info-card"><div class="label">기준층 전용</div><div class="value">${(() => { const floorPy = b.area?.typicalFloorPy || b.typicalFloorPy || 0; const rate = b.area?.exclusiveRate || b.exclusiveRate || 0; return floorPy && rate ? formatNumber(Math.round(floorPy * rate / 100 * 1000) / 1000) : '-'; })()}<span class="unit">평</span></div></div>
            <div class="info-card"><div class="label">기준층 임대</div><div class="value">${formatNumber(b.area?.typicalFloorPy || b.typicalFloorPy || b.typicalFloorLeasePy) || '-'}<span class="unit">평</span></div></div>
            <div class="info-card"><div class="label">전용률</div><div class="value">${b.area?.exclusiveRate || b.exclusiveRate || '-'}<span class="unit">%</span></div></div>
        </div>
        
        <!-- 건물 기본정보 -->
        <div class="info-grid" style="grid-template-columns: repeat(3, 1fr); margin-top: 8px;">
            <div class="info-card"><div class="label">준공년도</div><div class="value">${b.completionYear || '-'}</div></div>
            <div class="info-card"><div class="label">등급</div><div class="value">${b.grade || '-'}</div></div>
            <div class="info-card"><div class="label">주용도</div><div class="value" style="font-size: 13px;">${b.specs?.buildingUse || b.buildingUse || b.mainPurpose || '-'}</div></div>
        </div>
        
        <!-- 용적률/건폐율 -->
        <div class="info-grid" style="grid-template-columns: repeat(2, 1fr); margin-top: 8px;">
            <div class="info-card"><div class="label">용적률</div><div class="value">${b.vlRat || b.floorAreaRatio || '-'}<span class="unit">${b.vlRat || b.floorAreaRatio ? '%' : ''}</span></div></div>
            <div class="info-card"><div class="label">건폐율</div><div class="value">${b.bcRat || b.buildingCoverageRatio || '-'}<span class="unit">${b.bcRat || b.buildingCoverageRatio ? '%' : ''}</span></div></div>
        </div>
        
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
            <span>💰 임대조건</span>
            ${pricingCount > 0 ? `<span style="font-size: 11px; padding: 2px 8px; background: var(--accent-light); color: var(--accent-color); border-radius: 10px;">층별 ${pricingCount}개 기준가</span>` : ''}
        </div>
        
        ${pricingCount > 0 ? `
        <div style="background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div style="font-size: 11px; color: var(--text-muted);">📊 층별 기준가 (최신 ${Math.min(pricingCount, 5)}개)</div>
                <button onclick="document.querySelector('[data-section=pricing]').click()" style="font-size: 11px; color: var(--accent-color); background: none; border: none; cursor: pointer; text-decoration: underline;">
                    전체보기 →
                </button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${floorPricing.slice(0, 5).map(fp => {
                    // 날짜 포맷팅
                    const d = fp.effectiveDate || fp.createdAt || '';
                    let displayDate = '-';
                    if (d.includes('-')) {
                        const [y, m] = d.split('-');
                        displayDate = y.slice(-2) + '.' + m;
                    } else if (d) {
                        displayDate = d.slice(0, 5);
                    }
                    
                    return `
                    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 12px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px;">
                        <div>
                            <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">${fp.label || fp.floorRange || '기준가'}</div>
                            <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;">📅 ${displayDate}${fp.sourceCompany ? ' · ' + fp.sourceCompany : ''}</div>
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 14px; font-weight: 600; color: var(--accent-color);">${fp.rentPy ? formatNumber(fp.rentPy) + '원/평' : '-'}</div>
                            <div style="font-size: 10px; color: var(--text-muted);">임대료</div>
                        </div>
                    </div>
                `}).join('')}
                ${pricingCount > 5 ? `<div style="text-align: center; font-size: 11px; color: var(--text-muted); padding: 6px;">+${pricingCount - 5}개 더 있음</div>` : ''}
            </div>
        </div>
        ` : ''}
        
        <div class="price-table">
            <div class="price-row"><span class="label">보증금</span><span class="value">${b.depositPy ? formatNumber(b.depositPy) + '원' : '-'}/평</span></div>
            <div class="price-row"><span class="label">임대료</span><span class="value">${b.rentPy ? formatNumber(b.rentPy) + '원' : '-'}/평</span></div>
            <div class="price-row"><span class="label">관리비</span><span class="value">${b.maintenancePy ? formatNumber(b.maintenancePy) + '원' : '-'}/평</span></div>
        </div>
        <div class="noc-card">
            <div class="title">NOC (Net Occupancy Cost)</div>
            <div class="noc-row"><span>F-NOC (전용면적 기준)</span><span class="value">${formatNumber(fnoc)}원/평</span></div>
        </div>
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
            <span>🏢 빌딩 상세</span>
            <button onclick="refreshBuildingLedger()" style="padding: 4px 10px; font-size: 11px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                🔄 건축물대장 불러오기
            </button>
        </div>
        <div class="spec-list">
            <div class="spec-item"><span class="label">층수</span><span class="value">${typeof b.floors === 'object' ? (b.floors?.display || `지하${b.floors?.below || 0}층/지상${b.floors?.above || 0}층`) : (b.floors || '-')}</span></div>
            <div class="spec-item"><span class="label">인근역</span><span class="value">${b.nearbyStation || b.nearestStation || '-'}</span></div>
            <div class="spec-item"><span class="label">주차</span><span class="value">${formatParkingDisplay(b)}</span></div>
            <div class="spec-item"><span class="label">구조</span><span class="value">${b.specs?.structure || b.structure || '-'}</span></div>
            <div class="spec-item"><span class="label">건물용도</span><span class="value">${b.specs?.buildingUse || b.buildingUse || b.usage || '-'}</span></div>
            <div class="spec-item"><span class="label">냉난방</span><span class="value">${b.hvac || '-'}</span></div>
            <div class="spec-item"><span class="label">엘리베이터</span><span class="value">${b.specs?.passengerElevator || b.specs?.freightElevator ? `승객${b.specs?.passengerElevator || 0}/화물${b.specs?.freightElevator || 0}대` : (b.passengerElevator || b.freightElevator ? `승객${b.passengerElevator || 0}/화물${b.freightElevator || 0}대` : (b.specs?.elevator || b.elevator || '-'))}</span></div>
            <div class="spec-item"><span class="label">PM</span><span class="value">${b.pm || '-'}</span></div>
            <div class="spec-item"><span class="label">소유자</span><span class="value">${b.owner || '-'}</span></div>
        </div>
        
        <!-- ★ 건축물대장 전유부/층별개요 조회 버튼 -->
        <div style="margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button onclick="fetchBuildingFloorDetail('floorOutline')" 
                    style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                🏗️ 층별개요 조회
            </button>
            <button onclick="fetchBuildingFloorDetail('exposeInfo')" 
                    style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, #059669 0%, #047857 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                📋 전유부 조회
            </button>
            <button onclick="fetchBuildingFloorDetail('exposeAreaInfo')" 
                    style="padding: 6px 12px; font-size: 11px; background: linear-gradient(135deg, #d97706 0%, #b45309 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;">
                📐 전유공용면적 조회
            </button>
        </div>
        <div id="floorDetailContainer" style="margin-top: 8px;"></div>
        
        <!-- 빌딩 정보 편집 버튼 -->
        <div style="margin-top: 16px; text-align: center;">
            <button onclick="openBuildingEditModal()" style="padding: 10px 24px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); cursor: pointer; font-size: 13px;">
                ✏️ 빌딩 정보 편집
            </button>
        </div>
    `;
}

// ★ 기본정보 새로고침 (Firebase에서 최신 데이터 다시 불러오기)
export async function refreshInfoSection() {
    if (!state.selectedBuilding) return;
    
    const buildingId = state.selectedBuilding.id;
    console.log('🔄 기본정보 새로고침:', buildingId);
    
    try {
        // Firebase에서 최신 데이터 가져오기
        const snapshot = await get(ref(db, `buildings/${buildingId}`));
        if (snapshot.exists()) {
            const freshData = snapshot.val();
            freshData.id = buildingId;
            freshData._raw = freshData;
            
            // state 업데이트
            state.selectedBuilding = freshData;
            
            // allBuildings에서도 업데이트
            const idx = state.allBuildings.findIndex(b => b.id === buildingId);
            if (idx >= 0) {
                state.allBuildings[idx] = freshData;
            }
            
            // 화면 다시 렌더링
            renderInfoSection();
            
            if (window.showToast) {
                showToast('기본정보가 새로고침 되었습니다', 'success');
            }
        }
    } catch (e) {
        console.error('기본정보 새로고침 실패:', e);
        if (window.showToast) {
            showToast('새로고침 실패', 'error');
        }
    }
}

// ★ 공실(안내문) 새로고침 (vacancies 컬렉션에서 최신 데이터 다시 불러오기)
export async function refreshVacanciesSection() {
    if (!state.selectedBuilding) return;
    
    const buildingId = state.selectedBuilding.id;
    console.log('🔄 공실 데이터 새로고침:', buildingId);
    
    try {
        // vacancies 컬렉션에서 해당 빌딩 데이터 가져오기
        const snapshot = await get(ref(db, `vacancies/${buildingId}`));
        if (snapshot.exists()) {
            const vacancyData = snapshot.val();
            
            // 배열로 변환 (_key 보존)
            const entries = [];
            Object.entries(vacancyData).forEach(([key, val]) => {
                if (val && typeof val === 'object') {
                    entries.push({ _key: key, id: key, ...val });
                }
            });
            
            // ★ documents와 vacancies 모두 업데이트
            state.selectedBuilding.documents = entries;
            state.selectedBuilding.vacancies = entries;
            state.selectedBuilding.vacancyCount = entries.length;
            
            // allBuildings에서도 업데이트
            const buildingInAll = state.allBuildings?.find(b => b.id === buildingId);
            if (buildingInAll) {
                buildingInAll.vacancies = entries;
                buildingInAll.vacancyCount = entries.length;
            }
            
            // 안내문 섹션 다시 렌더링
            renderDocumentSection();
            
            if (window.showToast) {
                showToast(`공실 데이터 새로고침 완료 (${entries.length}건)`, 'success');
            }
        } else {
            state.selectedBuilding.documents = [];
            state.selectedBuilding.vacancies = [];
            state.selectedBuilding.vacancyCount = 0;
            renderDocumentSection();
            showToast('공실 데이터 없음', 'info');
        }
    } catch (e) {
        console.error('공실 새로고침 실패:', e);
        if (window.showToast) {
            showToast('새로고침 실패', 'error');
        }
    }
}

// ===== 기준가 섹션 =====

export function renderPricingSection() {
    const b = state.selectedBuilding;
    const allPricing = b.floorPricing || [];
    
    // 기본 임대조건 확인 (buildings 컬렉션의 최상위 필드)
    const hasBasePricing = b.depositPy || b.rentPy || b.maintenancePy;
    
    // ★ 공식 기준가 (isOfficial: true인 항목들)
    const officialPricing = allPricing.filter(fp => fp.isOfficial);
    
    // ★ 시계열: effectiveDate에서 연월 추출하여 날짜 목록 생성
    const availableDates = [...new Set(allPricing.map(fp => {
        const d = fp.effectiveDate || fp.createdAt || '';
        if (d.includes('-')) {
            const [y, m] = d.split('-');
            return `${y.slice(-2)}.${m}`;
        }
        return d.slice(0, 5);
    }).filter(Boolean))].sort((a, b) => b.localeCompare(a));
    
    // ★ 출처별 목록
    const availableSources = [...new Set(allPricing.map(fp => fp.sourceCompany).filter(Boolean))];
    
    // 날짜별 개수 계산
    const countByDate = {};
    allPricing.forEach(fp => {
        const d = fp.effectiveDate || fp.createdAt || '';
        let dateKey;
        if (d.includes('-')) {
            const [y, m] = d.split('-');
            dateKey = `${y.slice(-2)}.${m}`;
        } else {
            dateKey = d.slice(0, 5);
        }
        if (dateKey) countByDate[dateKey] = (countByDate[dateKey] || 0) + 1;
    });
    
    // 출처별 개수 계산
    const countBySource = {};
    allPricing.forEach(fp => {
        const src = fp.sourceCompany || '직접입력';
        countBySource[src] = (countBySource[src] || 0) + 1;
    });
    
    // 선택된 필터로 필터링
    const selectedDate = state.selectedPricingDate || 'all';
    const selectedSource = state.selectedPricingSource || 'all';
    
    let filteredPricing = allPricing;
    
    // 날짜 필터
    if (selectedDate !== 'all') {
        filteredPricing = filteredPricing.filter(fp => {
            const d = fp.effectiveDate || fp.createdAt || '';
            let dateKey;
            if (d.includes('-')) {
                const [y, m] = d.split('-');
                dateKey = `${y.slice(-2)}.${m}`;
            } else {
                dateKey = d.slice(0, 5);
            }
            return dateKey === selectedDate;
        });
    }
    
    // 출처 필터
    if (selectedSource !== 'all') {
        filteredPricing = filteredPricing.filter(fp => {
            const src = fp.sourceCompany || '직접입력';
            return src === selectedSource;
        });
    }
    
    // 필터된 목록을 최신순으로 정렬 (공식 기준가 우선)
    const sortedPricing = [...filteredPricing].sort((a, b) => {
        // 공식 기준가 우선
        if (a.isOfficial && !b.isOfficial) return -1;
        if (!a.isOfficial && b.isOfficial) return 1;
        // 날짜순
        const dateA = a.effectiveDate || a.createdAt || '';
        const dateB = b.effectiveDate || b.createdAt || '';
        return dateB.localeCompare(dateA);
    });
    
    // 기준가 개수 업데이트
    document.getElementById('pricingCount').textContent = allPricing.length;
    
    document.getElementById('sectionPricing').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px;">
            <span style="flex-shrink: 0;">💰 층별 기준가</span>
            <button class="btn btn-primary btn-sm" style="flex-shrink: 0; padding: 6px 16px; white-space: nowrap;" onclick="openPricingModal()">+ 추가</button>
        </div>
        
        ${/* 공식 기준가 요약 */ ''}
        ${officialPricing.length > 0 ? `
        <div style="background: linear-gradient(135deg, #fef9c3 0%, #fde047 100%); border-radius: 10px; padding: 16px; margin-bottom: 16px; border: 2px solid #eab308;">
            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                <span style="font-size: 18px;">⭐</span>
                <span style="font-size: 14px; font-weight: 600; color: #854d0e;">공식 기준가</span>
                <span style="font-size: 11px; color: #a16207;">(${officialPricing.length}개)</span>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                ${officialPricing.map(fp => `
                    <div style="background: white; border-radius: 8px; padding: 10px 14px; border: 1px solid #fbbf24;">
                        <div style="font-size: 12px; font-weight: 600; color: #78350f;">${fp.label || fp.floorRange || '기준가'}</div>
                        <div style="font-size: 14px; font-weight: 700; color: #d97706; margin-top: 4px;">${fp.rentPy ? formatNumber(fp.rentPy) + '원/평' : '-'}</div>
                        <div style="font-size: 10px; color: #92400e; margin-top: 2px;">
                            ${fp.depositPy ? '보증금 ' + formatNumber(fp.depositPy) : ''} 
                            ${fp.maintenancePy ? '| 관리비 ' + formatNumber(fp.maintenancePy) : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        ` : ''}
        
        ${/* 필터 UI */ ''}
        ${allPricing.length > 0 ? `
        <div style="background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-bottom: 16px;">
            ${/* 기준월 필터 */ ''}
            <div style="margin-bottom: ${availableSources.length > 1 ? '12px' : '0'};">
                <span style="font-size: 11px; color: var(--text-muted); margin-right: 8px;">📅 기준월</span>
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
                    <button onclick="filterPricingByDate('all')"
                            style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                   background: ${selectedDate === 'all' ? 'var(--accent-color)' : 'var(--bg-primary)'}; 
                                   color: ${selectedDate === 'all' ? 'white' : 'var(--text-primary)'};">
                        전체 ${allPricing.length}
                    </button>
                    ${availableDates.map(date => `
                        <button onclick="filterPricingByDate('${date}')"
                                style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                       background: ${selectedDate === date ? 'var(--accent-color)' : 'var(--bg-primary)'}; 
                                       color: ${selectedDate === date ? 'white' : 'var(--text-primary)'};">
                            ${date} ${countByDate[date] || 0}
                        </button>
                    `).join('')}
                </div>
            </div>
            
            ${/* 출처 필터 */ ''}
            ${availableSources.length > 1 ? `
            <div>
                <span style="font-size: 11px; color: var(--text-muted); margin-right: 8px;">🏢 출처</span>
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;">
                    <button onclick="filterPricingBySource('all')"
                            style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                   background: ${selectedSource === 'all' ? '#8b5cf6' : 'var(--bg-primary)'}; 
                                   color: ${selectedSource === 'all' ? 'white' : 'var(--text-primary)'};">
                        전체
                    </button>
                    ${availableSources.map(src => `
                        <button onclick="filterPricingBySource('${src.replace(/'/g, "\\'")}')"
                                style="padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; border: none;
                                       background: ${selectedSource === src ? '#8b5cf6' : 'var(--bg-primary)'}; 
                                       color: ${selectedSource === src ? 'white' : 'var(--text-primary)'};">
                            ${src} ${countBySource[src] || 0}
                        </button>
                    `).join('')}
                </div>
            </div>
            ` : ''}
        </div>
        ` : ''}
        
        ${/* 기본 임대조건이 있고 floorPricing이 비어있을 때 */ ''}
        ${hasBasePricing && allPricing.length === 0 ? `
        <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 10px; padding: 16px; margin-bottom: 16px; border: 1px solid #fbbf24;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <div>
                    <div style="font-size: 14px; font-weight: 600; color: #92400e;">📋 기본 임대조건</div>
                    <div style="font-size: 11px; color: #a16207; margin-top: 2px;">기본정보에 등록된 임대조건입니다</div>
                </div>
                <button onclick="migrateBasePricingToFloorPricing()" 
                        style="padding: 6px 12px; background: #f59e0b; color: white; border: none; border-radius: 6px; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 4px;"
                        title="기본 임대조건을 층별 기준가로 변환">
                    <span>↗️</span> 기준가로 등록
                </button>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px;">
                <div style="text-align: center; padding: 10px; background: white; border-radius: 6px;">
                    <div style="font-size: 11px; color: #92400e;">보증금</div>
                    <div style="font-size: 14px; font-weight: 600; color: #78350f;">${b.depositPy ? formatNumber(b.depositPy) + '원/평' : '-'}</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 6px;">
                    <div style="font-size: 11px; color: #92400e;">임대료</div>
                    <div style="font-size: 14px; font-weight: 600; color: #d97706;">${b.rentPy ? formatNumber(b.rentPy) + '원/평' : '-'}</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 6px;">
                    <div style="font-size: 11px; color: #92400e;">관리비</div>
                    <div style="font-size: 14px; font-weight: 600; color: #78350f;">${b.maintenancePy ? formatNumber(b.maintenancePy) + '원/평' : '-'}</div>
                </div>
            </div>
        </div>
        ` : ''}
        
        ${sortedPricing.length === 0 && !hasBasePricing ? `
        <div class="empty-state" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 48px; margin-bottom: 16px;">💰</div>
            <div style="color: var(--text-muted); margin-bottom: 16px;">등록된 기준가가 없습니다</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 20px;">
                층별로 다른 임대조건을 관리할 수 있습니다<br>
                (저층부/고층부, 특정 층 프리미엄 등)
            </div>
            <button class="btn btn-primary" onclick="openPricingModal()">+ 첫 기준가 등록</button>
        </div>
        ` : sortedPricing.length === 0 ? `
        <div style="text-align: center; padding: 20px; color: var(--text-muted); font-size: 13px;">
            선택한 필터 조건에 해당하는 기준가가 없습니다.
        </div>
        ` : `
        <div style="display: flex; flex-direction: column; gap: 12px;">
            ${sortedPricing.map((fp, idx) => {
                // 날짜 포맷팅
                const d = fp.effectiveDate || fp.createdAt || '';
                let displayDate = '-';
                if (d.includes('-')) {
                    const [y, m] = d.split('-');
                    displayDate = `${y.slice(-2)}.${m}`;
                } else if (d) {
                    displayDate = d.slice(0, 5);
                }
                
                const isOfficial = fp.isOfficial;
                const isOcr = fp.sourceType === 'ocr';
                
                return `
                <div class="pricing-card" style="background: ${isOfficial ? 'linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%)' : 'var(--bg-secondary)'}; 
                     border-radius: 10px; padding: 16px; 
                     border: 2px solid ${isOfficial ? '#eab308' : (isOcr ? '#3b82f6' : 'var(--border-color)')}; 
                     position: relative;">
                    
                    ${/* 배지 */ ''}
                    <div style="position: absolute; top: -10px; right: 12px; display: flex; gap: 4px;">
                        ${isOfficial ? `<span style="padding: 2px 8px; background: linear-gradient(135deg, #eab308 0%, #ca8a04 100%); color: white; font-size: 10px; border-radius: 4px; font-weight: 600;">⭐ 공식</span>` : ''}
                        ${isOcr ? `<span style="padding: 2px 8px; background: #3b82f6; color: white; font-size: 10px; border-radius: 4px;">OCR</span>` : ''}
                    </div>
                    
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                        <div>
                            <div style="font-size: 15px; font-weight: 600; color: var(--text-primary);">${fp.label || '기준가 ' + (idx + 1)}</div>
                            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">📍 ${fp.floorRange || '-'}</div>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
                        <div style="text-align: center; padding: 10px; background: ${isOfficial ? 'white' : 'var(--bg-primary)'}; border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">보증금</div>
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${fp.depositPy ? formatNumber(fp.depositPy) + '원/평' : '-'}</div>
                        </div>
                        <div style="text-align: center; padding: 10px; background: ${isOfficial ? 'white' : 'var(--bg-primary)'}; border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">임대료</div>
                            <div style="font-size: 14px; font-weight: 600; color: ${isOfficial ? '#d97706' : 'var(--accent-color)'};">${fp.rentPy ? formatNumber(fp.rentPy) + '원/평' : '-'}</div>
                        </div>
                        <div style="text-align: center; padding: 10px; background: ${isOfficial ? 'white' : 'var(--bg-primary)'}; border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">관리비</div>
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${fp.maintenancePy ? formatNumber(fp.maintenancePy) + '원/평' : '-'}</div>
                        </div>
                    </div>
                    
                    ${(fp.rentArea || fp.exclusiveArea) ? `
                    <div style="display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
                        ${fp.rentArea ? `<span>임대면적: <strong>${formatNumber(fp.rentArea)}평</strong></span>` : ''}
                        ${fp.exclusiveArea ? `<span>전용면적: <strong>${formatNumber(fp.exclusiveArea)}평</strong></span>` : ''}
                    </div>
                    ` : ''}
                    
                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); padding-top: 8px; border-top: 1px solid ${isOfficial ? '#fde68a' : 'var(--border-color)'};">
                        <span>📅 ${displayDate}${fp.sourceCompany ? ' · <strong style="color: var(--text-secondary)">' + fp.sourceCompany + '</strong>' : ''}</span>
                        <span>${fp.notes || ''}</span>
                    </div>
                    
                    ${/* ★ 액션 버튼 영역 */ ''}
                    <div style="display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px dashed ${isOfficial ? '#fde68a' : 'var(--border-color)'};">
                        ${!isOfficial ? `
                            <button onclick="setOfficialPricing('${fp.id}')" 
                                    style="flex: 1; padding: 8px 12px; background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%); color: white; border: none; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 4px;">
                                ⭐ 공식 기준가로 적용
                            </button>
                        ` : `
                            <button onclick="unsetOfficialPricing('${fp.id}')" 
                                    style="flex: 1; padding: 8px 12px; background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; border-radius: 6px; font-size: 12px; font-weight: 500; cursor: pointer;">
                                ✕ 공식 해제
                            </button>
                        `}
                        <button onclick="editPricing('${fp.id}')" 
                                style="padding: 8px 12px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 6px; font-size: 12px; cursor: pointer;" 
                                title="수정">
                            ✏️
                        </button>
                        <button onclick="deletePricing('${fp.id}')" 
                                style="padding: 8px 12px; background: #fee2e2; border: 1px solid #fca5a5; border-radius: 6px; font-size: 12px; cursor: pointer; color: #dc2626;" 
                                title="삭제">
                            🗑️
                        </button>
                    </div>
                </div>
            `}).join('')}
        </div>
        `}
        
        ${/* 공실 정보에서 기준가 추출 안내 */ ''}
        ${allPricing.length === 0 ? `
        <div style="margin-top: 16px; padding: 12px 16px; background: var(--bg-secondary); border-radius: 8px; font-size: 12px; color: var(--text-muted);">
            <strong>💡 Tip:</strong> 안내문 탭의 공실 정보에서도 기준가를 등록할 수 있습니다.
        </div>
        ` : ''}
    `;
}

// ★ 기준가 날짜 필터
export function filterPricingByDate(date) {
    state.selectedPricingDate = date;
    renderPricingSection();
}

// ★ 기준가 출처 필터
export function filterPricingBySource(source) {
    state.selectedPricingSource = source;
    renderPricingSection();
}

// ★ 공식 기준가로 등록
export async function setOfficialPricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b || !b.floorPricing) return;
    
    const pricingIdx = b.floorPricing.findIndex(fp => fp.id === pricingId);
    if (pricingIdx === -1) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        // 기존 공식 기준가 해제 (같은 층 범위가 아닌 경우에만)
        // 여러 층별로 공식 기준가를 가질 수 있도록 함
        
        // 해당 기준가를 공식으로 설정
        b.floorPricing[pricingIdx].isOfficial = true;
        b.floorPricing[pricingIdx].officialAt = new Date().toISOString();
        
        // 기본 임대조건도 업데이트
        const officialPricing = b.floorPricing[pricingIdx];
        const updateData = {
            floorPricing: b.floorPricing,
            // 루트 레벨 업데이트
            depositPy: officialPricing.depositPy || b.depositPy,
            rentPy: officialPricing.rentPy || b.rentPy,
            maintenancePy: officialPricing.maintenancePy || b.maintenancePy,
            // pricing 객체도 업데이트
            'pricing/depositPy': officialPricing.depositPy || b.depositPy,
            'pricing/rentPy': officialPricing.rentPy || b.rentPy,
            'pricing/maintenancePy': officialPricing.maintenancePy || b.maintenancePy
        };
        
        await update(ref(db, `buildings/${b.id}`), updateData);
        
        // 로컬 상태 업데이트
        state.selectedBuilding.depositPy = updateData.depositPy;
        state.selectedBuilding.rentPy = updateData.rentPy;
        state.selectedBuilding.maintenancePy = updateData.maintenancePy;
        
        // _raw도 업데이트
        if (state.selectedBuilding._raw) {
            state.selectedBuilding._raw.depositPy = updateData.depositPy;
            state.selectedBuilding._raw.rentPy = updateData.rentPy;
            state.selectedBuilding._raw.maintenancePy = updateData.maintenancePy;
            if (!state.selectedBuilding._raw.pricing) {
                state.selectedBuilding._raw.pricing = {};
            }
            state.selectedBuilding._raw.pricing.depositPy = updateData.depositPy;
            state.selectedBuilding._raw.pricing.rentPy = updateData.rentPy;
            state.selectedBuilding._raw.pricing.maintenancePy = updateData.maintenancePy;
        }
        
        // allBuildings에서도 업데이트 (목록 표시용)
        const buildingInAll = state.allBuildings.find(bd => bd.id === b.id);
        if (buildingInAll) {
            buildingInAll.depositPy = updateData.depositPy;
            buildingInAll.rentPy = updateData.rentPy;
            buildingInAll.maintenancePy = updateData.maintenancePy;
        }
        
        showToast(`'${officialPricing.label || '기준가'}'가 공식 기준가로 적용되었습니다`, 'success');
        renderPricingSection();
        renderInfoSection();
        
        // 빌딩 목록도 새로고침
        if (window.renderBuildingList) {
            window.renderBuildingList();
        }
        
    } catch (error) {
        console.error('공식 기준가 등록 오류:', error);
        showToast('등록 중 오류가 발생했습니다', 'error');
    }
}

// ★ 공식 기준가 해제
export async function unsetOfficialPricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b || !b.floorPricing) return;
    
    const pricingIdx = b.floorPricing.findIndex(fp => fp.id === pricingId);
    if (pricingIdx === -1) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        // 공식 해제
        b.floorPricing[pricingIdx].isOfficial = false;
        delete b.floorPricing[pricingIdx].officialAt;
        
        await set(ref(db, `buildings/${b.id}/floorPricing`), b.floorPricing);
        
        showToast('공식 기준가가 해제되었습니다', 'success');
        renderPricingSection();
        
    } catch (error) {
        console.error('공식 기준가 해제 오류:', error);
        showToast('해제 중 오류가 발생했습니다', 'error');
    }
}

// ★ 기준가 수정 모달 열기
export function editPricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b || !b.floorPricing) return;
    
    const pricing = b.floorPricing.find(fp => fp.id === pricingId);
    if (!pricing) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 모달에 데이터 채우기
    document.getElementById('editPricingId').value = pricingId;
    document.getElementById('editPricingLabel').value = pricing.label || '';
    document.getElementById('editPricingFloorRange').value = pricing.floorRange || '';
    document.getElementById('editPricingDepositPy').value = pricing.depositPy || '';
    document.getElementById('editPricingRentPy').value = pricing.rentPy || '';
    document.getElementById('editPricingMaintenancePy').value = pricing.maintenancePy || '';
    document.getElementById('editPricingDate').value = pricing.effectiveDate || '';
    document.getElementById('editPricingNotes').value = pricing.notes || '';
    
    // 출처 정보 표시
    const sourceInfo = document.getElementById('editPricingSourceInfo');
    if (pricing.sourceType === 'ocr') {
        sourceInfo.innerHTML = `<span style="color: #3b82f6;">📄 OCR 추출 (${pricing.sourceCompany || '알 수 없음'})</span>`;
    } else if (pricing.sourceType === 'migration') {
        sourceInfo.innerHTML = `<span style="color: #8b5cf6;">🔄 마이그레이션</span>`;
    } else {
        sourceInfo.innerHTML = `<span style="color: #6b7280;">✏️ 수동 입력</span>`;
    }
    
    // 공식 여부 표시
    const officialInfo = document.getElementById('editPricingOfficialInfo');
    if (pricing.isOfficial) {
        officialInfo.innerHTML = `<span style="color: #eab308; font-weight: 600;">⭐ 공식 기준가로 지정됨</span>`;
    } else {
        officialInfo.innerHTML = `<span style="color: #9ca3af;">일반 기준가</span>`;
    }
    
    // 모달 표시
    document.getElementById('editPricingModal').style.display = 'block';
    document.getElementById('modalOverlay').style.display = 'block';
}

// ★ 기준가 수정 저장
export async function saveEditPricing() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const pricingId = document.getElementById('editPricingId').value;
    const pricingIdx = b.floorPricing?.findIndex(fp => fp.id === pricingId);
    
    if (pricingIdx === -1 || pricingIdx === undefined) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 입력값 수집
    const label = document.getElementById('editPricingLabel').value.trim();
    const floorRange = document.getElementById('editPricingFloorRange').value.trim();
    const depositPy = parseFloat(document.getElementById('editPricingDepositPy').value) || 0;
    const rentPy = parseFloat(document.getElementById('editPricingRentPy').value) || 0;
    const maintenancePy = parseFloat(document.getElementById('editPricingMaintenancePy').value) || 0;
    const effectiveDate = document.getElementById('editPricingDate').value.trim();
    const notes = document.getElementById('editPricingNotes').value.trim();
    
    // 검증
    if (!label) {
        showToast('라벨을 입력해주세요', 'warning');
        return;
    }
    if (!rentPy) {
        showToast('임대료를 입력해주세요', 'warning');
        return;
    }
    
    try {
        // 데이터 업데이트
        const updatedPricing = {
            ...b.floorPricing[pricingIdx],
            label,
            floorRange,
            depositPy,
            rentPy,
            maintenancePy,
            effectiveDate,
            notes,
            updatedAt: new Date().toISOString()
        };
        
        b.floorPricing[pricingIdx] = updatedPricing;
        
        // Firebase 저장
        await update(ref(db, `buildings/${b.id}`), { floorPricing: b.floorPricing });
        
        // 공식 기준가면 기본 임대조건도 업데이트
        if (updatedPricing.isOfficial) {
            await update(ref(db, `buildings/${b.id}`), {
                depositPy: depositPy,
                rentPy: rentPy,
                maintenancePy: maintenancePy
            });
            state.selectedBuilding.depositPy = depositPy;
            state.selectedBuilding.rentPy = rentPy;
            state.selectedBuilding.maintenancePy = maintenancePy;
        }
        
        showToast('기준가가 수정되었습니다', 'success');
        closeEditPricingModal();
        renderPricingSection();
        renderBasicInfo();
        
    } catch (error) {
        console.error('기준가 수정 오류:', error);
        showToast('수정 중 오류가 발생했습니다', 'error');
    }
}

// ★ 기준가 수정 모달 닫기
export function closeEditPricingModal() {
    document.getElementById('editPricingModal').style.display = 'none';
    document.getElementById('modalOverlay').style.display = 'none';
}

// ★ 기준가 삭제
export async function deletePricing(pricingId) {
    const b = state.selectedBuilding;
    if (!b || !b.floorPricing) return;
    
    const pricingIdx = b.floorPricing.findIndex(fp => fp.id === pricingId);
    if (pricingIdx === -1) {
        showToast('기준가를 찾을 수 없습니다', 'error');
        return;
    }
    
    const pricing = b.floorPricing[pricingIdx];
    
    // 공식 기준가면 경고
    let confirmMsg = `"${pricing.label || '기준가'}"을(를) 삭제하시겠습니까?`;
    if (pricing.isOfficial) {
        confirmMsg = `⚠️ "${pricing.label}"은(는) 공식 기준가입니다.\n\n삭제하면 기본 임대조건에 영향을 줄 수 있습니다.\n정말 삭제하시겠습니까?`;
    }
    
    if (!confirm(confirmMsg)) return;
    
    try {
        // 배열에서 제거
        b.floorPricing.splice(pricingIdx, 1);
        
        // Firebase 저장
        await set(ref(db, `buildings/${b.id}/floorPricing`), b.floorPricing);
        
        showToast('기준가가 삭제되었습니다', 'success');
        renderPricingSection();
        
    } catch (error) {
        console.error('기준가 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

// ===== 담당자 섹션 =====

export function renderContactSection() {
    const b = state.selectedBuilding;
    const contacts = b.contactPoints || [];
    
    // 담당자 수 업데이트
    document.getElementById('contactCount').textContent = contacts.length;
    
    // 타입별 아이콘 & 라벨
    const typeIcons = { owner: '🏢', manager: '🔧', broker: '🤝', sni: '🏷️', other: '👤' };
    const typeLabels = { owner: '빌딩주/임대팀', manager: '관리사무소', broker: '중개사', sni: 'S&I 담당자', other: '기타' };
    
    // 우리 담당자 / 기타 분리
    const ourManagers = contacts.filter(c => c.isOurManager || c.type === 'sni');
    const otherContacts = contacts.filter(c => !c.isOurManager && c.type !== 'sni');
    
    // 현재 지정된 담당자
    const assignedManager = b.assignedManager || b._raw?.assignedManager;
    const assignedContact = assignedManager ? contacts.find(c => c.id === assignedManager.contactId) : null;
    
    document.getElementById('sectionContact').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px;">
            <span style="flex-shrink: 0;">👤 담당자 목록</span>
            <div style="display: flex; gap: 6px; flex-shrink: 0;">
                <button class="btn btn-sm" style="background: var(--bg-tertiary); color: var(--text-primary); padding: 6px 12px; white-space: nowrap;" onclick="openAssignManagerModal()">📋 담당자 지정</button>
                <button class="btn btn-primary btn-sm" style="padding: 6px 12px; white-space: nowrap;" onclick="openContactModal()">+ 추가</button>
            </div>
        </div>
        
        <!-- 현재 지정된 임대안내문 담당자 -->
        ${assignedContact ? `
        <div style="background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%); border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; border-left: 4px solid #2563eb;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 11px; font-weight: 600; color: #1e40af; margin-bottom: 4px;">📋 임대안내문 담당자</div>
                    <div style="font-size: 14px; font-weight: 600; color: #1e3a8a;">${assignedContact.name}</div>
                    <div style="font-size: 12px; color: #3b82f6;">${assignedContact.phone} ${assignedContact.company ? '· ' + assignedContact.company : ''}</div>
                </div>
                <div style="font-size: 11px; color: #6b7280;">
                    ${assignedManager.assignedAt ? new Date(assignedManager.assignedAt).toLocaleDateString('ko-KR') : ''} 지정
                </div>
            </div>
        </div>
        ` : ''}
        
        ${contacts.length === 0 ? `
        <div class="empty-state" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 48px; margin-bottom: 16px;">👤</div>
            <div style="color: var(--text-muted); margin-bottom: 16px;">등록된 담당자가 없습니다</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 20px;">
                빌딩 임대팀, 관리사무소, 중개사 등<br>
                연락처를 관리할 수 있습니다
            </div>
            <button class="btn btn-primary" onclick="openContactModal()">+ 첫 담당자 등록</button>
        </div>
        ` : `
        
        <!-- 우리 담당자 (S&I) -->
        ${ourManagers.length > 0 ? `
        <div style="margin-bottom: 16px;">
            <div style="font-size: 12px; font-weight: 600; color: #16a34a; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                🏷️ 우리 담당자 (S&I)
                <span style="font-size: 10px; padding: 2px 6px; background: #dcfce7; border-radius: 10px;">${ourManagers.length}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${ourManagers.map(c => renderContactCard(c, typeIcons, typeLabels, true)).join('')}
            </div>
        </div>
        ` : ''}
        
        <!-- 기타 담당자 -->
        ${otherContacts.length > 0 ? `
        <div>
            <div style="font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                👤 기타 담당자
                <span style="font-size: 10px; padding: 2px 6px; background: var(--bg-tertiary); border-radius: 10px;">${otherContacts.length}</span>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                ${otherContacts.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0)).map(c => renderContactCard(c, typeIcons, typeLabels, false)).join('')}
            </div>
        </div>
        ` : ''}
        `}
    `;
}

// ★ v3.10: 담당자 카드 렌더링 헬퍼 (수정/삭제 파라미터 추가)
function renderContactCard(c, typeIcons, typeLabels, isOurManager) {
    const borderColor = c.isPrimary ? 'var(--accent-color)' : (isOurManager ? '#16a34a' : 'var(--border-color)');
    const bgColor = isOurManager ? 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)' : 'var(--bg-secondary)';
    const buildingId = state.selectedBuilding?.id || '';
    const contactName = (c.name || '').replace(/'/g, "\\'");
    
    return `
        <div class="contact-card" style="background: ${bgColor}; border-radius: 10px; padding: 14px 16px; border: 1px solid ${borderColor}; ${c.isPrimary ? 'box-shadow: 0 0 0 1px var(--accent-color);' : ''}">
            <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                <div style="display: flex; gap: 12px; align-items: flex-start;">
                    <div style="width: 40px; height: 40px; border-radius: 50%; background: ${isOurManager ? '#bbf7d0' : 'var(--bg-tertiary)'}; display: flex; align-items: center; justify-content: center; font-size: 18px;">
                        ${typeIcons[c.type] || '👤'}
                    </div>
                    <div>
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                            <span style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${c.name}</span>
                            ${c.position ? `<span style="font-size: 10px; padding: 2px 6px; background: #e5e7eb; color: #374151; border-radius: 4px;">${c.position}</span>` : ''}
                            ${c.isPrimary ? '<span style="font-size: 10px; padding: 2px 6px; background: var(--accent-color); color: white; border-radius: 4px;">주 담당</span>' : ''}
                            ${isOurManager ? '<span style="font-size: 10px; padding: 2px 6px; background: #16a34a; color: white; border-radius: 4px;">S&I</span>' : ''}
                        </div>
                        <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">${typeLabels[c.type] || c.type} ${c.company ? '· ' + c.company : ''}</div>
                        <div style="display: flex; gap: 12px; margin-top: 8px; font-size: 13px;">
                            <a href="tel:${c.phone}" style="color: var(--accent-color); text-decoration: none;">📞 ${c.phone}</a>
                            ${c.email ? `<a href="mailto:${c.email}" style="color: var(--text-secondary); text-decoration: none;">✉️ ${c.email}</a>` : ''}
                        </div>
                        ${c.notes ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 6px; font-style: italic;">${c.notes}</div>` : ''}
                    </div>
                </div>
                <div class="row-actions" style="display: flex; gap: 4px;">
                    <button class="row-action-btn" onclick="editContact('${c.id}', '${buildingId}')" title="수정">✏️</button>
                    <button class="row-action-btn delete" onclick="deleteContact('${c.id}', '${buildingId}', '${contactName}')" title="삭제">🗑️</button>
                </div>
            </div>
        </div>
    `;
}

// ===== 렌트롤 섹션 =====

export function renderRentrollSection() {
    const b = state.selectedBuilding;
    const allRentrolls = b.rentrolls || [];
    
    // 사용 가능한 기준월 추출 (다양한 날짜 필드 지원)
    const dateSet = new Set();
    allRentrolls.forEach(r => {
        const dateValue = r.targetDate || r.date || r.recordDate || r.month || r.baseMonth || r.baseDate;
        if (dateValue) {
            dateSet.add(dateValue);
            r._displayDate = dateValue;
        }
    });
    const availableDates = Array.from(dateSet).sort().reverse();
    
    // 기본값: 가장 최신 월
    if (!state.selectedRentrollDate || (state.selectedRentrollDate !== 'all' && !availableDates.includes(state.selectedRentrollDate))) {
        state.selectedRentrollDate = availableDates.length > 0 ? availableDates[0] : 'all';
    }
    
    // 필터링
    let filteredList = allRentrolls;
    if (state.selectedRentrollDate !== 'all' && availableDates.length > 0) {
        filteredList = allRentrolls.filter(r => r._displayDate === state.selectedRentrollDate);
    }
    
    // 층별 정렬 (높은 층 먼저)
    filteredList = [...filteredList].sort((a, b) => (parseInt(b.floor) || 0) - (parseInt(a.floor) || 0));
    
    // 각 월별 건수 계산
    const countByDate = {};
    allRentrolls.forEach(r => {
        const d = r._displayDate || 'unknown';
        countByDate[d] = (countByDate[d] || 0) + 1;
    });
    
    document.getElementById('sectionRentroll').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px;">
            <span style="flex-shrink: 0;">렌트롤 목록</span>
            <button class="btn btn-primary btn-sm" style="flex-shrink: 0; padding: 6px 16px; white-space: nowrap;" onclick="openRentrollModal()">+ 추가</button>
        </div>
        
        ${availableDates.length > 0 ? `
        <div class="timeline-filter">
            <span class="timeline-label">📅 기준월</span>
            <div class="timeline-tabs">
                <div class="timeline-tab timeline-all ${state.selectedRentrollDate === 'all' ? 'active' : ''}" onclick="filterRentrollByDate('all')">
                    전체<span class="count">${allRentrolls.length}</span>
                </div>
                ${availableDates.slice(0, 6).map(d => `
                    <div class="timeline-tab ${state.selectedRentrollDate === d ? 'active' : ''}" onclick="filterRentrollByDate('${d}')">
                        ${d}<span class="count">${countByDate[d] || 0}</span>
                    </div>
                `).join('')}
                ${availableDates.length > 6 ? `<div class="timeline-tab" style="color: var(--text-muted);">+${availableDates.length - 6}개</div>` : ''}
            </div>
        </div>
        ` : '<div style="padding:8px 12px;background:var(--bg-secondary);border-radius:6px;font-size:12px;color:var(--text-muted);margin-bottom:12px;">⚠️ 기준월(targetDate) 정보가 없어 시계열 필터를 사용할 수 없습니다</div>'}
        
        ${filteredList.length === 0 ? '<div class="empty-state">렌트롤 정보가 없습니다</div>' : `
        <div class="rentroll-summary">
            <div class="rentroll-summary-item"><span class="dot occupied"></span> 입주 ${filteredList.length}건</div>
            ${state.selectedRentrollDate !== 'all' && availableDates.length > 0 ? `<div class="rentroll-summary-item" style="color: var(--accent-color);">📌 ${state.selectedRentrollDate} 기준</div>` : ''}
        </div>
        <table class="rentroll-table">
            <thead><tr><th style="width:60px;">층</th><th>입주사</th><th style="width:120px;">계약기간</th><th>비고</th><th style="width:50px;"></th></tr></thead>
            <tbody>
                ${filteredList.map(r => `
                    <tr>
                        <td><span class="floor-badge">${formatFloorDisplay(r.floor)}</span></td>
                        <td>
                            <div class="tenant-name">${r.tenant?.name || r.tenant || '-'}</div>
                            <div class="meta-info">${(r.author || '-').split('@')[0]} · ${r._displayDate || r.targetDate || '-'}</div>
                        </td>
                        <td><div class="contract-period">${r.contract?.period || (r.contract?.startDate ? r.contract.startDate + '~' + (r.contract.endDate || '') : '-')}</div></td>
                        <td>${r.note ? `<div class="note-text">${r.note}</div>` : '<span style="color:var(--text-muted);">-</span>'}</td>
                        <td>
                            <div class="row-actions">
                                <button class="row-action-btn" onclick="editRentroll('${r.id}')" title="수정">✏️</button>
                                <button class="row-action-btn delete" onclick="deleteRentroll('${r.id}')" title="삭제">×</button>
                            </div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`}
    `;
}

// 렌트롤 날짜 필터
export function filterRentrollByDate(date) {
    state.selectedRentrollDate = date;
    renderRentrollSection();
}

// ===== 메모 섹션 =====

// ★ v3.2: 메모 새로고침 (Firebase에서 최신 데이터 다시 불러오기)
export async function refreshMemoSection() {
    if (!state.selectedBuilding) return;
    
    const buildingId = state.selectedBuilding.id;
    console.log('🔄 메모 새로고침:', buildingId);
    
    try {
        // Firebase에서 최신 memos 데이터 가져오기
        const snapshot = await get(ref(db, `buildings/${buildingId}/memos`));
        if (snapshot.exists()) {
            const memosData = snapshot.val();
            // 배열로 변환 (객체인 경우)
            state.selectedBuilding.memos = Array.isArray(memosData) 
                ? memosData 
                : Object.values(memosData);
        } else {
            state.selectedBuilding.memos = [];
        }
        
        // 화면 다시 렌더링
        renderMemoSection();
        
        // 메모 개수 배지 업데이트
        const countEl = document.getElementById('memoCount');
        if (countEl) {
            countEl.textContent = state.selectedBuilding.memos.length;
        }
    } catch (e) {
        console.error('메모 새로고침 실패:', e);
    }
}

export function renderMemoSection() {
    const b = state.selectedBuilding;
    const list = (b.memos || []).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    // 메모 개수 배지 업데이트
    const countEl = document.getElementById('memoCount');
    if (countEl) {
        countEl.textContent = list.length;
    }
    
    document.getElementById('sectionMemo').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; gap: 12px;">
            <span style="flex-shrink: 0;">메모 목록</span>
            <div style="display: flex; gap: 8px;">
                <button class="btn btn-secondary btn-sm" style="padding: 6px 12px;" onclick="refreshMemoSection()" title="새로고침">🔄</button>
                <button class="btn btn-primary btn-sm" style="flex-shrink: 0; padding: 6px 16px; white-space: nowrap;" onclick="openMemoModal()">+ 추가</button>
            </div>
        </div>
        ${list.length === 0 ? '<div class="empty-state">메모가 없습니다</div>' : list.map(m => `
            <div class="memo-item ${m.pinned ? 'pinned' : ''}" style="position: relative; padding: 10px 12px !important; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; border: 1px solid var(--border-color); text-align: left !important; display: block !important;">
                <div class="memo-content" style="font-size: 13px; line-height: 1.5; margin: 0 0 6px 0 !important; padding: 0 !important; text-align: left !important; white-space: pre-wrap; word-break: break-word; display: block !important;">
                    ${m.pinned ? '📌 ' : ''}${m.showInLeasingGuide ? '<span style="background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:4px; font-size:10px; margin-right:4px; font-weight:500;">안내문</span>' : ''}${m.content || ''}
                </div>
                <div class="memo-meta" style="display: flex; justify-content: space-between; align-items: center; padding: 0 !important; margin: 0 !important;">
                    <span style="font-size: 11px; color: var(--text-muted);">${((m.author || m.createdBy || '-').split('@')[0])} · ${m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '-'}</span>
                    <div style="display: flex !important; gap: 6px; opacity: 1 !important; visibility: visible !important;">
                        <button onclick="editMemo('${m.id}')" title="수정" style="padding: 4px 10px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; cursor: pointer; font-size: 12px;">✏️</button>
                        <button onclick="deleteMemo('${m.id}')" title="삭제" style="padding: 4px 10px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; cursor: pointer; font-size: 12px; color: #dc2626;">×</button>
                    </div>
                </div>
            </div>
        `).join('')}
    `;
}

// ★ v3.2: 메모 모달 열기
window.openMemoModal = function(memoId = null) {
    if (!state.selectedBuilding) return;
    
    const modal = document.getElementById('memoModal');
    const title = modal.querySelector('.modal-title');
    
    // 폼 초기화
    document.getElementById('memoId').value = '';
    document.getElementById('memoText').value = '';
    document.getElementById('memoPinned').checked = false;
    document.getElementById('memoShowInGuide').checked = false;
    
    if (memoId) {
        // 수정 모드
        const memo = (state.selectedBuilding.memos || []).find(m => m.id === memoId);
        if (memo) {
            title.textContent = '메모 수정';
            document.getElementById('memoId').value = memo.id;
            document.getElementById('memoText').value = memo.content || '';
            document.getElementById('memoPinned').checked = memo.pinned || false;
            document.getElementById('memoShowInGuide').checked = memo.showInLeasingGuide || false;
        }
    } else {
        title.textContent = '메모 추가';
    }
    
    modal.classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
};

// ★ v3.2: 메모 수정
window.editMemo = function(memoId) {
    window.openMemoModal(memoId);
};

// ★ v3.3: 메모 저장 (임대안내문 표기는 1개만 허용 - 라디오 방식)
window.saveMemo = async function() {
    if (!state.selectedBuilding) return;
    
    const memoId = document.getElementById('memoId').value;
    const content = document.getElementById('memoText').value.trim();
    const pinned = document.getElementById('memoPinned').checked;
    const showInLeasingGuide = document.getElementById('memoShowInGuide').checked;
    
    if (!content) {
        showToast('메모 내용을 입력하세요', 'warning');
        return;
    }
    
    try {
        const b = state.selectedBuilding;
        let memos = [...(b.memos || [])];
        
        // ★ v3.3: 임대안내문 표기 체크 시, 기존 메모들의 체크 해제 (라디오 방식)
        if (showInLeasingGuide) {
            memos = memos.map(m => ({
                ...m,
                showInLeasingGuide: false  // 모든 기존 메모의 체크 해제
            }));
        }
        
        if (memoId) {
            // 수정
            const idx = memos.findIndex(m => m.id === memoId);
            if (idx >= 0) {
                memos[idx] = {
                    ...memos[idx],
                    content,
                    pinned,
                    showInLeasingGuide,
                    updatedAt: new Date().toISOString(),
                    updatedBy: state.currentUser?.email
                };
            }
        } else {
            // 추가
            const newMemo = {
                id: 'memo_' + Date.now(),
                content,
                pinned,
                showInLeasingGuide,
                createdAt: new Date().toISOString(),
                createdBy: state.currentUser?.email,
                author: state.currentUser?.email
            };
            memos.push(newMemo);
        }
        
        // ★ v3.4: 저장 시간 기록 (새로고침 스킵용)
        state.lastMemoDeleteTime = Date.now();
        
        // Firebase에 저장
        await update(ref(db, `buildings/${b.id}`), { memos });
        
        // 로컬 상태 업데이트
        state.selectedBuilding.memos = memos;
        
        // allBuildings에서도 업데이트
        const idx = state.allBuildings.findIndex(building => building.id === b.id);
        if (idx >= 0) {
            state.allBuildings[idx].memos = memos;
        }
        
        // ★ v3.4: 메모 개수 배지 업데이트
        const countEl = document.getElementById('memoCount');
        if (countEl) {
            countEl.textContent = memos.length;
        }
        
        // 모달 닫기
        document.getElementById('memoModal').classList.remove('show');
        document.getElementById('modalOverlay').classList.remove('show');
        
        // 화면 갱신
        renderMemoSection();
        showToast(memoId ? '메모가 수정되었습니다' : '메모가 추가되었습니다', 'success');
    } catch (e) {
        console.error('메모 저장 오류:', e);
        showToast('저장 실패', 'error');
    }
};

// ★ v3.4: 메모 삭제
window.deleteMemo = async function(memoId) {
    console.log('🗑️ 메모 삭제 시도:', memoId);
    if (!state.selectedBuilding) {
        console.log('❌ selectedBuilding 없음');
        return;
    }
    if (!confirm('이 메모를 삭제하시겠습니까?')) {
        console.log('❌ 사용자 취소');
        return;
    }
    
    try {
        const b = state.selectedBuilding;
        const beforeCount = (b.memos || []).length;
        let memos = (b.memos || []).filter(m => m.id !== memoId);
        const afterCount = memos.length;
        
        console.log(`📝 메모 개수: ${beforeCount} → ${afterCount}`);
        
        // ★ 삭제 시간 기록 (새로고침 스킵용)
        state.lastMemoDeleteTime = Date.now();
        
        // Firebase에 저장
        await update(ref(db, `buildings/${b.id}`), { memos });
        console.log('✅ Firebase 업데이트 완료');
        
        // 로컬 상태 업데이트
        state.selectedBuilding.memos = memos;
        
        // allBuildings에서도 업데이트
        const idx = state.allBuildings.findIndex(building => building.id === b.id);
        if (idx >= 0) {
            state.allBuildings[idx].memos = memos;
        }
        
        // ★ 메모 개수 배지 업데이트
        const countEl = document.getElementById('memoCount');
        if (countEl) {
            countEl.textContent = memos.length;
        }
        
        // 화면 갱신 (로컬 데이터로)
        renderMemoSection();
        showToast('메모가 삭제되었습니다', 'success');
    } catch (e) {
        console.error('❌ 메모 삭제 오류:', e);
        showToast('삭제 실패: ' + e.message, 'error');
    }
};

// 메모 폼 제출 이벤트 등록
document.addEventListener('DOMContentLoaded', function() {
    const memoForm = document.getElementById('memoForm');
    if (memoForm) {
        memoForm.addEventListener('submit', function(e) {
            e.preventDefault();
            window.saveMemo();
        });
    }
});

// 전역 함수 등록
window.refreshMemoSection = refreshMemoSection;

// ===== 인센티브 섹션 =====

export function renderIncentiveSection() {
    const b = state.selectedBuilding;
    const list = b.incentives || [];
    
    // 인센티브 개수 배지 업데이트
    const countEl = document.getElementById('incentiveCount');
    if (countEl) {
        countEl.textContent = list.length;
    }
    
    if (list.length === 0) {
        document.getElementById('sectionIncentive').innerHTML = `
            <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
                <span style="flex-shrink: 0;">🎁 인센티브</span>
                <button class="btn btn-primary btn-sm" style="flex-shrink: 0; padding: 6px 16px; white-space: nowrap;" onclick="openIncentiveModal()">+ 추가</button>
            </div>
            <div class="empty-state" style="text-align: center; padding: 40px 20px;">
                <div style="font-size: 48px; margin-bottom: 16px;">🎁</div>
                <div style="color: var(--text-muted); margin-bottom: 16px;">등록된 인센티브가 없습니다</div>
                <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 20px;">
                    Rent Free, Fit-Out, TI 등<br>임차인 혜택 조건을 관리합니다
                </div>
                <button class="btn btn-primary" onclick="openIncentiveModal()">+ 첫 인센티브 등록</button>
            </div>
        `;
        return;
    }
    
    // 최신순 정렬
    const sortedList = [...list].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    document.getElementById('sectionIncentive').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 12px;">
            <span style="flex-shrink: 0;">🎁 인센티브</span>
            <button class="btn btn-primary btn-sm" style="flex-shrink: 0; padding: 6px 16px; white-space: nowrap;" onclick="openIncentiveModal()">+ 추가</button>
        </div>
        
        <div style="display: flex; flex-direction: column; gap: 12px;">
            ${sortedList.map((item, idx) => `
                <div class="incentive-item" style="background: var(--bg-secondary); border-radius: 10px; padding: 16px; border: 1px solid var(--border-color); position: relative;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                        <div>
                            <div style="font-size: 12px; color: var(--text-muted);">
                                ${item.startDate || item.createdAt ? (item.startDate || new Date(item.createdAt).toLocaleDateString()) : '-'}
                                ${item.endDate ? ' ~ ' + item.endDate : ''}
                            </div>
                            ${item.condition ? `<div style="font-size: 13px; color: var(--accent-color); margin-top: 4px;">📋 ${item.condition}</div>` : ''}
                        </div>
                        <div class="row-actions" style="display: flex; gap: 4px;">
                            <button class="row-action-btn" onclick="editIncentive('${item.id}')" title="수정">✏️</button>
                            <button class="row-action-btn delete" onclick="deleteIncentive('${item.id}')" title="삭제">×</button>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
                        <div style="text-align: center; padding: 12px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 8px;">
                            <div style="font-size: 11px; color: #92400e; margin-bottom: 4px;">Rent Free</div>
                            <div style="font-size: 18px; font-weight: 700; color: #78350f;">${item.rf || item.rentFree || 0}</div>
                            <div style="font-size: 10px; color: #a16207;">개월</div>
                        </div>
                        <div style="text-align: center; padding: 12px; background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%); border-radius: 8px;">
                            <div style="font-size: 11px; color: #1e40af; margin-bottom: 4px;">Fit-Out</div>
                            <div style="font-size: 18px; font-weight: 700; color: #1e3a8a;">${formatNumber(item.fo || item.fitOut || 0)}</div>
                            <div style="font-size: 10px; color: #3b82f6;">원/평</div>
                        </div>
                        <div style="text-align: center; padding: 12px; background: linear-gradient(135deg, #f3e8ff 0%, #e9d5ff 100%); border-radius: 8px;">
                            <div style="font-size: 11px; color: #6b21a8; margin-bottom: 4px;">TI</div>
                            <div style="font-size: 18px; font-weight: 700; color: #581c87;">${formatNumber(item.ti || 0)}</div>
                            <div style="font-size: 10px; color: #8b5cf6;">원/평</div>
                        </div>
                    </div>
                    
                    ${item.note ? `<div style="font-size: 12px; color: var(--text-secondary); padding: 8px; background: var(--bg-primary); border-radius: 6px;">${item.note}</div>` : ''}
                    
                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">
                        ${(item.author || item.createdBy || '-').split('@')[0]} · ${item.createdAt ? new Date(item.createdAt).toLocaleDateString() : '-'}
                    </div>
                </div>
            `).join('')}
        </div>
    `;
}

// ===== 임대안내문(문서) 섹션 =====

export function renderDocumentSection() {
    const b = state.selectedBuilding;
    let docs = [...(b.documents || [])];
    let vacancies = [...(b.vacancies || [])];
    const leasingGuideVacancies = b.leasingGuideVacancies || [];
    
    // ★ v3.13: vacancies에서 _meta 정보 분리 (공실없음/만실 판단용)
    const vacancyMetas = {};  // { 'source_publishDate': { noVacancy, pageImageUrl, ... } }
    vacancies = vacancies.filter(v => {
        if (v._key && v._key.endsWith('_meta')) {
            // _meta 정보 저장 (source_publishDate 키로)
            const metaKey = v.source && v.publishDate 
                ? `${v.source}_${v.publishDate}` 
                : v._key.replace('_meta', '');
            vacancyMetas[metaKey] = v;
            return false;  // _meta는 vacancies에서 제외
        }
        return true;  // 실제 공실 데이터만 유지
    });
    
    // ★ v3.8: leasingGuides 컬렉션 데이터를 기존 구조에 합치기
    if (leasingGuideVacancies.length > 0) {
        // vacancies에 합치기 (중복 방지)
        leasingGuideVacancies.forEach(lgv => {
            const exists = vacancies.some(v => 
                v.floor === lgv.floor && 
                v.source === lgv.source && 
                v.publishDate === lgv.publishDate
            );
            if (!exists) {
                vacancies.push(lgv);
            }
        });
        
        // docs에 해당 문서 정보 추가 (중복 방지)
        const lgSource = leasingGuideVacancies[0]?.source || '임대안내문';
        const lgDate = leasingGuideVacancies[0]?.publishDate || '';
        const docExists = docs.some(d => d.source === lgSource && d.publishDate === lgDate);
        if (!docExists && (lgSource || lgDate)) {
            docs.push({
                source: lgSource,
                publishDate: lgDate,
                vacancyCount: leasingGuideVacancies.length,
                floors: leasingGuideVacancies.map(v => v.floor),
                fromLeasingGuide: true
            });
        }
    }
    
    // ★ v3.13: docs가 없을 때만 early return (vacancies 없어도 _meta로 만실 여부 확인 가능)
    // ★ v3.15: vacancies에는 있지만 docs에 없는 출처/기간 조합을 합성 doc으로 추가
    // (직접입력 등 수동 추가된 공실이 출처 탭에 나타나도록)
    const docKeySet = new Set(docs.map(d => `${d.source || '기타'}|${d.publishDate || ''}`));
    const vacancySourceMap = {};
    vacancies.forEach(v => {
        const key = `${v.source || '기타'}|${v.publishDate || ''}`;
        if (!docKeySet.has(key)) {
            if (!vacancySourceMap[key]) {
                vacancySourceMap[key] = { source: v.source || '기타', publishDate: v.publishDate || '', floors: [], count: 0 };
            }
            vacancySourceMap[key].floors.push(v.floor);
            vacancySourceMap[key].count++;
        }
    });
    Object.values(vacancySourceMap).forEach(synth => {
        docs.push({
            source: synth.source,
            publishDate: synth.publishDate,
            vacancyCount: synth.count,
            floors: synth.floors,
            fromManualEntry: true  // 수동 추가 표시
        });
    });
    
    if (docs.length === 0) {
        document.getElementById('sectionDocument').innerHTML = `
            <div class="section-title">📄 임대안내문</div>
            <div style="padding: 20px 0;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <div style="font-size: 13px; color: var(--text-muted);">
                        등록된 임대안내문이 없습니다
                    </div>
                    <div style="display: flex; gap: 6px;">
                        <button onclick="showInlineVacancyForm('manual')" 
                                style="padding: 6px 14px; background: var(--accent-color, #2563eb); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                            <span>➕</span> 공실 직접입력
                        </button>
                        <button onclick="addBuildingOnlyToCompList()" 
                                style="padding: 6px 14px; background: var(--bg-tertiary, #f3f4f6); color: var(--text-primary, #333); border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                            <span>📋</span> 빌딩 정보만 담기
                        </button>
                    </div>
                </div>
                <div id="inlineVacancyForm" style="display: none; margin-top: 12px; padding: 16px; background: #f0f9ff; border: 2px dashed var(--accent-color, #2563eb); border-radius: 8px;"></div>
            </div>
        `;
        return;
    }
    
    // 출처(회사)별 그룹핑
    const sourceGroups = {};
    docs.forEach(d => {
        const source = d.source || '기타';
        if (!sourceGroups[source]) sourceGroups[source] = [];
        sourceGroups[source].push(d);
    });
    
    // 각 그룹 내 최신순 정렬
    Object.keys(sourceGroups).forEach(source => {
        sourceGroups[source].sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
    });
    
    // 출처 목록 (문서 수 많은 순)
    const sourceList = Object.keys(sourceGroups).sort((a, b) => sourceGroups[b].length - sourceGroups[a].length);
    
    // 선택된 출처가 없으면 첫 번째 출처 선택
    if (!state.selectedDocSource || state.selectedDocSource === 'all') {
        state.selectedDocSource = sourceList[0];
    }
    
    // 현재 출처의 기간 목록
    const currentSourceDocs = sourceGroups[state.selectedDocSource] || [];
    const periodList = [...new Set(currentSourceDocs.map(d => d.publishDate || '미정'))].sort((a, b) => (b || '').localeCompare(a || ''));
    
    // 선택된 기간이 없으면 최신 기간 선택
    if (!state.selectedDocPeriod || state.selectedDocPeriod === 'all' || !periodList.includes(state.selectedDocPeriod)) {
        state.selectedDocPeriod = periodList[0] || 'all';
    }
    
    // 현재 선택된 문서
    const selectedDoc = currentSourceDocs.find(d => (d.publishDate || '미정') === state.selectedDocPeriod);
    
    // 해당 문서의 공실 정보 가져오기
    const docVacancies = vacancies.filter(v => 
        (v.source || '') === state.selectedDocSource && 
        (v.publishDate || '') === state.selectedDocPeriod
    );
    
    // 이미지 URL 생성
    let imageUrl = '';
    let pageNum = 1;
    if (selectedDoc) {
        pageNum = parseInt(selectedDoc.pageNum) || selectedDoc.page || 1;
        imageUrl = selectedDoc.pageImageUrl || '';
        if (!imageUrl && selectedDoc.source && selectedDoc.publishDate) {
            const formattedFolder = (selectedDoc.source + '_' + selectedDoc.publishDate).replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
            imageUrl = 'https://firebasestorage.googleapis.com/v0/b/cre-unified.firebasestorage.app/o/leasing-docs%2F' + encodeURIComponent(formattedFolder) + '%2Fpage_' + String(pageNum).padStart(3, '0') + '.jpg?alt=media';
        }
    }
    
    // 공실 데이터에 고유 ID 부여 (체크박스 선택용) + _key 보존/생성
    const vacanciesWithId = docVacancies.map((v, idx) => {
        // _key가 없으면 source_publishDate_floor로 생성
        let vacancyKey = v._key;
        if (!vacancyKey) {
            const floor = (v.floor || 'UNK').replace(/[\/\s\.]/g, '_');
            const source = (v.source || 'UNKNOWN').replace(/[\/\s\.]/g, '_');
            const publishDate = (v.publishDate || '').replace(/[\/\s\.]/g, '_');
            vacancyKey = `${source}_${publishDate}_${floor}`;
        }
        
        return {
            ...v,
            _key: vacancyKey,
            _vacancyId: `vacancy_${state.selectedBuilding?.id || 'unknown'}_${idx}_${Date.now()}`
        };
    });
    
    // ★ v3.11: 층별 정렬 적용
    vacanciesWithId.sort((a, b) => {
        const floorA = parseFloorNumber(a.floor);
        const floorB = parseFloorNumber(b.floor);
        return state.vacancySortOrder === 'asc' ? floorA - floorB : floorB - floorA;
    });
    
    // 전역 상태에 현재 표시 중인 공실 저장 (선택 시 사용)
    state.currentDisplayedVacancies = vacanciesWithId;
    
    // ★ v3.15: 인라인 입력 폼 컨테이너 (showInlineVacancyForm()이 동적으로 내용 채움)
    const inlineInputFormHtml = `
        <div id="inlineVacancyForm" style="display: none; margin-top: 12px; padding: 16px; background: #f0f9ff; border: 2px dashed var(--accent-color); border-radius: 8px;"></div>
    `;
    
    // 공실 테이블 HTML
    let vacancyTableHtml = '';
    if (vacanciesWithId.length > 0) {
        const selectedCount = state.selectedVacancyIds?.size || 0;
        vacancyTableHtml = `
            <div class="doc-vacancy-table" style="margin-top: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-wrap: wrap; gap: 8px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">
                            📋 추출된 공실 정보 <span style="color: var(--accent-color);">${vacanciesWithId.length}건</span>
                        </div>
                        <!-- ★ v2.0: 소숫점 표기 토글 -->
                        <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); cursor: pointer; user-select: none;">
                            <input type="checkbox" 
                                   id="decimalAreaToggle"
                                   ${state.showDecimalArea ? 'checked' : ''}
                                   onchange="toggleDecimalArea()"
                                   style="width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent-color);">
                            소숫점 표기
                        </label>
                    </div>
                    <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
                        <button onclick="showInlineVacancyForm()" 
                                style="padding: 6px 10px; background: white; color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 4px;">
                            <span>➕</span> 공실 추가
                        </button>
                        <!-- ★ v2.0: 선택 항목 일괄 작업 버튼 (항상 표시) -->
                        <div style="display: flex; gap: 4px; padding: 4px 8px; background: var(--bg-secondary); border-radius: 6px; align-items: center;">
                            <span style="font-size: 11px; color: var(--text-muted);" id="selectedVacancyCount">${selectedCount > 0 ? selectedCount + '개 선택' : '선택없음'}</span>
                            <button onclick="deleteSelectedVacancies()" 
                                    id="deleteSelectedVacanciesBtn"
                                    ${selectedCount === 0 ? 'disabled' : ''}
                                    style="padding: 5px 8px; background: ${selectedCount > 0 ? '#fee2e2' : '#f3f4f6'}; 
                                           color: ${selectedCount > 0 ? '#dc2626' : '#9ca3af'}; 
                                           border: 1px solid ${selectedCount > 0 ? '#fecaca' : '#e5e7eb'}; 
                                           border-radius: 4px; cursor: ${selectedCount > 0 ? 'pointer' : 'not-allowed'}; 
                                           font-size: 11px; display: flex; align-items: center; gap: 3px;"
                                    title="선택한 공실 삭제">
                                <span>🗑️</span> 삭제
                            </button>
                            <button onclick="transferSelectedVacancies()" 
                                    id="transferSelectedVacanciesBtn"
                                    ${selectedCount === 0 ? 'disabled' : ''}
                                    style="padding: 5px 8px; background: ${selectedCount > 0 ? '#fef3c7' : '#f3f4f6'}; 
                                           color: ${selectedCount > 0 ? '#d97706' : '#9ca3af'}; 
                                           border: 1px solid ${selectedCount > 0 ? '#fde68a' : '#e5e7eb'}; 
                                           border-radius: 4px; cursor: ${selectedCount > 0 ? 'pointer' : 'not-allowed'}; 
                                           font-size: 11px; display: flex; align-items: center; gap: 3px;"
                                    title="선택한 공실을 다른 빌딩으로 이관">
                                <span>↗️</span> 이관
                            </button>
                        </div>
                        <button onclick="addSelectedVacanciesToCompList()" 
                                id="addVacanciesToCompListBtn"
                                style="padding: 6px 12px; background: ${selectedCount > 0 ? 'var(--accent-color)' : 'var(--bg-tertiary)'}; 
                                       color: ${selectedCount > 0 ? 'white' : 'var(--text-muted)'}; 
                                       border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500;
                                       display: flex; align-items: center; gap: 4px; transition: all 0.2s;">
                            <span>📋</span> 
                            <span id="vacancySelectCount">${selectedCount > 0 ? selectedCount + '개 ' : ''}</span>Comp List
                        </button>
                    </div>
                </div>
                <div style="overflow-x: auto;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
                        <thead>
                            <tr style="background: var(--bg-tertiary);">
                                <th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); width: 36px;">
                                    <input type="checkbox" 
                                           id="selectAllVacancies"
                                           onchange="toggleAllVacancySelect(this.checked)"
                                           style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent-color);"
                                           title="전체 선택">
                                </th>
                                <th style="padding: 8px 6px; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap; cursor: pointer;" onclick="toggleVacancySortOrder()" title="클릭하여 정렬 변경">
                                    층 <span style="font-size: 10px; opacity: 0.7;">${state.vacancySortOrder === 'asc' ? '↑' : '↓'}</span>
                                </th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">임대면적</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">전용면적</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">보증금/평</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">임대료/평</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">관리비/평</th>
                                <th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); white-space: nowrap;">입주시기</th>
                                <th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); white-space: nowrap; width: 80px;">액션</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${vacanciesWithId.map((v, idx) => {
                                const isChecked = state.selectedVacancyIds?.has(v._vacancyId) || false;
                                return `
                                <tr style="border-bottom: 1px solid var(--border-color); ${isChecked ? 'background: rgba(37, 99, 235, 0.08);' : ''}" 
                                    data-vacancy-id="${v._vacancyId}"
                                    data-vacancy-key="${v._key || ''}">
                                    <td style="padding: 8px 6px; text-align: center;">
                                        <input type="checkbox" 
                                               class="vacancy-checkbox"
                                               data-vacancy-idx="${idx}"
                                               ${isChecked ? 'checked' : ''}
                                               onchange="toggleVacancySelect('${v._vacancyId}', ${idx}, this.checked)"
                                               style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent-color);">
                                    </td>
                                    <td style="padding: 8px 6px; font-weight: 600; color: var(--accent-color);">${v.floor || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${formatArea(v.rentArea)}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${formatArea(v.exclusiveArea)}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${v.depositPy || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right; color: var(--accent-color); font-weight: 500;">${v.rentPy || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${v.maintenancePy || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: center;">${v.moveInDate || '-'}</td>
                                    <td style="padding: 4px 2px; text-align: center;">
                                        <div style="display: flex; gap: 2px; justify-content: center;">
                                            <button onclick="openVacancyEditModal(${idx})" 
                                                    title="편집"
                                                    style="padding: 3px 5px; background: #eff6ff; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">✏️</button>
                                            <button onclick="deleteVacancyByIdx(${idx})" 
                                                    title="삭제"
                                                    style="padding: 3px 5px; background: #fee2e2; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">🗑️</button>
                                            <button onclick="openTransferVacancyModalByIdx(${idx})" 
                                                    title="이관"
                                                    style="padding: 3px 5px; background: #fef3c7; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">↗️</button>
                                            <button onclick="openPricingFromVacancyModal(${idx})" 
                                                    title="기준가 등록"
                                                    style="padding: 3px 5px; background: #d1fae5; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">💰</button>
                                        </div>
                                    </td>
                                </tr>
                            `}).join('')}
                        </tbody>
                    </table>
                </div>
                ${inlineInputFormHtml}
            </div>
        `;
    } else {
        // ★ v3.14: 해당 임대안내문에 공실이 없는 경우 "공실 없음" 표시
        // selectedDoc이 존재 = 해당 회사/연월의 문서는 있지만 공실이 0개
        const metaKey = `${state.selectedDocSource}_${state.selectedDocPeriod}`;
        const docMeta = vacancyMetas[metaKey];
        const metaImageUrl = docMeta?.pageImageUrl || imageUrl;
        
        if (selectedDoc) {
            // 문서는 있지만 공실이 없는 경우 → "공실 없음" 표시
            vacancyTableHtml = `
                <div style="margin-top: 16px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding: 16px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-radius: 8px; border: 1px solid #f59e0b;">
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 24px;">🏢</span>
                            <div>
                                <div style="font-size: 14px; font-weight: 600; color: #92400e;">공실 없음</div>
                                <div style="font-size: 12px; color: #b45309; margin-top: 2px;">
                                    ${state.selectedDocSource} · ${state.selectedDocPeriod}
                                </div>
                            </div>
                        </div>
                        <div style="display: flex; gap: 8px;">
                            ${metaImageUrl ? `
                                <button onclick="window.open('${metaImageUrl}', '_blank')" 
                                        style="padding: 8px 14px; background: white; color: #92400e; border: 1px solid #f59e0b; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                                    <span>📄</span> 원문보기
                                </button>
                            ` : ''}
                            <button onclick="addBuildingOnlyToCompList()" 
                                    style="padding: 8px 14px; background: #92400e; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                                <span>📋</span> 빌딩 정보만 담기
                            </button>
                        </div>
                    </div>
                    ${inlineInputFormHtml}
                </div>
            `;
        } else {
            // 문서 자체가 선택되지 않은 경우 (이관됨 또는 데이터 없음)
            vacancyTableHtml = `
                <div style="margin-top: 16px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <div style="font-size: 13px; color: var(--text-muted);">
                            추출된 공실 정보가 없습니다
                        </div>
                        <button onclick="addBuildingOnlyToCompList()" 
                                style="padding: 6px 14px; background: var(--bg-tertiary); color: var(--text-primary); border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                            <span>📋</span> 빌딩 정보만 담기
                        </button>
                    </div>
                    ${inlineInputFormHtml.replace('display: none;', 'display: block;')}
                </div>
            `;
        }
    }
    
    document.getElementById('sectionDocument').innerHTML = `
        <div class="section-title" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <span>📄 임대안내문</span>
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="font-size:12px; color:var(--text-muted);">총 ${docs.length}건</span>
                <button onclick="refreshVacanciesSection()" 
                        style="padding: 4px 10px; font-size: 11px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 4px;"
                        title="공실 데이터 새로고침">
                    🔄 새로고침
                </button>
                <button onclick="openOcrManageModal()" 
                        style="padding: 5px 10px; background: #f1f5f9; border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer; font-size: 11px; display: flex; align-items: center; gap: 4px;"
                        title="OCR 데이터 관리">
                    ⚙️ 관리
                </button>
            </div>
        </div>
        
        <!-- 회사별 탭 -->
        <div class="doc-filter-section" style="margin-bottom: 12px;">
            <div class="doc-filter-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">🏢 회사별</div>
            <div class="doc-filter-tabs" style="display: flex; gap: 6px; flex-wrap: wrap;">
                ${sourceList.map(source => {
                    const isManual = source === '직접입력';
                    const icon = isManual ? '✏️ ' : '';
                    return `
                    <button class="doc-source-tab" 
                            onclick="selectDocSource('${source}')"
                            style="padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid var(--border-color); transition: all 0.2s;
                                   ${state.selectedDocSource === source 
                                       ? 'background: var(--accent-color); color: white; border-color: var(--accent-color);' 
                                       : isManual 
                                           ? 'background: #f0fdf4; color: #166534; border-color: #bbf7d0;' 
                                           : 'background: var(--bg-secondary); color: var(--text-primary);'}">
                        ${icon}${source} <span style="opacity: 0.7;">${sourceGroups[source].length}</span>
                    </button>`;
                }).join('')}
            </div>
        </div>
        
        <!-- 기간별 셀렉트 -->
        <div class="doc-filter-section" style="margin-bottom: 16px;">
            <div class="doc-filter-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">📅 발행월</div>
            <select onchange="selectDocPeriod(this.value)" 
                    style="padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 13px; background: var(--bg-primary); color: var(--text-primary); width: 100%; max-width: 200px;">
                ${periodList.map(period => `
                    <option value="${period}" ${state.selectedDocPeriod === period ? 'selected' : ''}>${period}</option>
                `).join('')}
            </select>
        </div>
        
        <!-- 선택된 문서 정보 -->
        ${selectedDoc ? `
        <div class="selected-doc-info" style="background: var(--bg-secondary); border-radius: 10px; padding: 14px; margin-bottom: 12px; border: 1px solid var(--border-color);">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
                        ${state.selectedDocSource} - ${state.selectedDocPeriod}
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted);">
                        ${pageNum}페이지 | 공실 ${docVacancies.length}건
                    </div>
                </div>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${imageUrl ? `
                        <button onclick="showPagePreview('${imageUrl.replace(/'/g, "\\'")}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}', ${pageNum})"
                                style="padding: 6px 12px; background: var(--accent-color); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;">
                            👁️ 원본
                        </button>
                        <button onclick="openPageMappingModal('${state.selectedBuilding?.id || ''}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}', ${pageNum}, '${imageUrl.replace(/'/g, "\\'")}')"
                                style="padding: 6px 12px; background: #fef3c7; color: #92400e; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;"
                                title="페이지 이미지가 일치하지 않을 경우 변경">
                            🔄 변경
                        </button>
                    ` : ''}
                    <button onclick="openPdfUploadModal('${state.selectedBuilding?.id || ''}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}', ${pageNum})"
                            style="padding: 6px 12px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;"
                            title="PDF에서 해당 페이지 이미지 업로드">
                        📤 수동 등록
                    </button>
                    <button onclick="deleteOcrData('${state.selectedBuilding?.id || ''}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}')"
                            style="padding: 6px 12px; background: #fee2e2; color: #dc2626; border: none; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 500; display: flex; align-items: center; gap: 4px;"
                            title="이 발간회사/발간일의 공실 데이터 전체 삭제">
                        🗑️ 삭제
                    </button>
                </div>
            </div>
        </div>
        ` : ''}
        
        <!-- 공실 정보 테이블 -->
        ${vacancyTableHtml}
        
        <!-- 다른 문서 목록 (접힌 상태) -->
        ${currentSourceDocs.length > 1 ? `
        <details style="margin-top: 16px;">
            <summary style="cursor: pointer; font-size: 12px; color: var(--text-muted); padding: 8px 0;">
                📚 ${state.selectedDocSource}의 다른 발행호 보기 (${currentSourceDocs.length - 1}건)
            </summary>
            <div style="display: flex; flex-direction: column; gap: 6px; margin-top: 8px;">
                ${currentSourceDocs.filter(d => (d.publishDate || '미정') !== state.selectedDocPeriod).map(d => {
                    const pNum = parseInt(d.pageNum) || d.page || 1;
                    const vCount = vacancies.filter(v => v.source === d.source && v.publishDate === d.publishDate).length;
                    return `
                        <div onclick="selectDocPeriod('${d.publishDate || '미정'}')" 
                             style="padding: 10px 12px; background: var(--bg-secondary); border-radius: 6px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 13px;">${d.publishDate || '미정'} (${pNum}페이지)</span>
                            <span style="font-size: 11px; color: var(--text-muted);">공실 ${vCount}건</span>
                        </div>
                    `;
                }).join('')}
            </div>
        </details>
        ` : ''}
    `;
}

// 문서 출처 선택
export function selectDocSource(source) {
    state.selectedDocSource = source;
    state.selectedDocPeriod = 'all'; // 출처 변경 시 기간 초기화
    
    // 공실 선택 상태 초기화
    if (state.selectedVacancyIds) {
        state.selectedVacancyIds.clear();
    }
    
    renderDocumentSection();
}

// 문서 기간 선택
export function selectDocPeriod(period) {
    state.selectedDocPeriod = period;
    
    // 공실 선택 상태 초기화
    if (state.selectedVacancyIds) {
        state.selectedVacancyIds.clear();
    }
    
    renderDocumentSection();
}

// ===== 상세 패널 탭 설정 =====

export function setupDetailTabs() {
    document.querySelectorAll('.detail-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.detail-section').forEach(s => s.classList.remove('active'));
            tab.classList.add('active');
            const sectionId = 'section' + tab.dataset.section.charAt(0).toUpperCase() + tab.dataset.section.slice(1);
            const section = document.getElementById(sectionId);
            if (section) section.classList.add('active');
            
            // ★ v3.4: 메모 탭 클릭 시 자동 새로고침 (삭제 직후가 아닐 때만)
            if (tab.dataset.section === 'memo' && state.selectedBuilding) {
                // 삭제 직후 2초 이내면 새로고침 스킵
                if (state.lastMemoDeleteTime && (Date.now() - state.lastMemoDeleteTime < 2000)) {
                    console.log('🚫 삭제 직후 새로고침 스킵');
                    return;
                }
                await refreshMemoSection();
            }
        });
    });
}

export function registerDetailGlobals() {
    window.openDetail = openDetail;
    window.closeDetail = closeDetail;
    window.toggleDetailStar = toggleDetailStar;
    window.filterRentrollByDate = filterRentrollByDate;
    window.filterPricingByDate = filterPricingByDate;  // ★ 기준가 날짜 필터
    window.filterPricingBySource = filterPricingBySource;  // ★ 기준가 출처 필터
    window.setOfficialPricing = setOfficialPricing;  // ★ 공식 기준가 등록
    window.unsetOfficialPricing = unsetOfficialPricing;  // ★ 공식 기준가 해제
    window.editPricing = editPricing;  // ★ 기준가 수정 모달
    window.saveEditPricing = saveEditPricing;  // ★ 기준가 수정 저장
    window.closeEditPricingModal = closeEditPricingModal;  // ★ 기준가 수정 모달 닫기
    window.deletePricing = deletePricing;  // ★ 기준가 삭제
    window.selectDocSource = selectDocSource;
    window.selectDocPeriod = selectDocPeriod;
    
    // ★ 페이지 매핑 변경 후 새로고침용
    window.renderDocumentSection = renderDocumentSection;
    
    // ★ 기본정보 새로고침
    window.refreshInfoSection = refreshInfoSection;
    
    // ★ 공실(안내문) 새로고침
    window.refreshVacanciesSection = refreshVacanciesSection;
    
    // 공실 선택 관련 전역 함수
    window.toggleVacancySelect = toggleVacancySelect;
    window.toggleAllVacancySelect = toggleAllVacancySelect;
    window.addSelectedVacanciesToCompList = addSelectedVacanciesToCompList;
    
    // 빌딩만 담기 / 인라인 공실 입력 함수
    window.addBuildingOnlyToCompList = addBuildingOnlyToCompList;
    window.showInlineVacancyForm = showInlineVacancyForm;
    window.hideInlineVacancyForm = hideInlineVacancyForm;
    window.saveInlineVacancy = saveInlineVacancy;
    
    // ★ v2.0: 소숫점 토글 및 공실 편집/삭제/이관 함수
    window.toggleDecimalArea = toggleDecimalArea;
    window.openVacancyEditModal = openVacancyEditModal;
    window.closeVacancyEditModal = closeVacancyEditModal;
    window.saveVacancyEditFromModal = saveVacancyEditFromModal;
    window.deleteVacancyByIdx = deleteVacancyByIdx;
    window.deleteSelectedVacancies = deleteSelectedVacancies;
    window.openTransferVacancyModalByIdx = openTransferVacancyModalByIdx;
    window.transferSelectedVacancies = transferSelectedVacancies;
    window.searchTransferBuilding = searchTransferBuilding;
    window.selectTransferBuilding = selectTransferBuilding;
    window.executeVacancyTransfer = executeVacancyTransfer;
    window.closeTransferModal = closeTransferModal;
    window.validateExclusiveArea = validateExclusiveArea;
    
    // ★ v2.1: 기준가 통합 기능
    window.migrateBasePricingToFloorPricing = migrateBasePricingToFloorPricing;
    window.openPricingFromVacancyModal = openPricingFromVacancyModal;
    window.savePricingFromVacancy = savePricingFromVacancy;
    window.closePricingFromVacancyModal = closePricingFromVacancyModal;
    
    // ★ PDF 페이지 이미지 수동 등록
    window.openPdfUploadModal = openPdfUploadModal;
    window.closePdfUploadModal = closePdfUploadModal;
    window.handlePdfFileSelect = handlePdfFileSelect;
    window.pdfPrevPage = pdfPrevPage;
    window.pdfNextPage = pdfNextPage;
    window.goToPdfPage = goToPdfPage;
    window.uploadPdfPageImage = uploadPdfPageImage;
    
    // 탭 이벤트 설정
    setupDetailTabs();
}

// ===== 빌딩 정보만 Comp List에 담기 =====

export function addBuildingOnlyToCompList() {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩 정보가 없습니다', 'error');
        return;
    }
    
    if (typeof window.addBuildingToCompList === 'function') {
        window.addBuildingToCompList(building, []); // 빈 공실 배열로 추가
        showToast(`${building.name}이(가) Comp List에 추가되었습니다`, 'success');
    } else {
        showToast('Comp List 모듈이 로드되지 않았습니다', 'error');
    }
}

// ===== 인라인 공실 입력 폼 =====

export function showInlineVacancyForm(mode) {
    // mode: 'current' = 현재 출처에 추가, 'manual' = 새로 직접입력, undefined = 선택 UI 표시
    
    const form = document.getElementById('inlineVacancyForm');
    if (!form) return;
    
    if (!mode) {
        // ★ 유형 선택 UI 표시
        const currentSource = state.selectedDocSource;
        const currentPeriod = state.selectedDocPeriod;
        const hasCurrentSource = currentSource && currentSource !== 'all' && currentSource !== '직접입력';
        
        form.style.display = 'block';
        form.innerHTML = `
            <div style="font-size: 13px; font-weight: 600; color: var(--accent-color); margin-bottom: 14px;">➕ 공실 추가 유형 선택</div>
            <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                ${hasCurrentSource ? `
                <button onclick="showInlineVacancyForm('current')" 
                        style="flex: 1; min-width: 200px; padding: 16px; background: #eff6ff; border: 2px solid #bfdbfe; border-radius: 10px; cursor: pointer; text-align: left;">
                    <div style="font-size: 13px; font-weight: 700; color: #1e40af; margin-bottom: 6px;">📋 현재 출처에 추가</div>
                    <div style="font-size: 12px; color: #3b82f6; margin-bottom: 8px;">
                        <strong>${currentSource}</strong> ${currentPeriod !== 'all' ? currentPeriod : ''} 리스트에 누락된 공실 추가
                    </div>
                    <div style="font-size: 11px; color: #64748b;">OCR 처리가 누락된 공실을 해당 출처 리스트에 직접 추가합니다</div>
                </button>` : ''}
                <button onclick="showInlineVacancyForm('manual')" 
                        style="flex: 1; min-width: 200px; padding: 16px; background: #f0fdf4; border: 2px solid #bbf7d0; border-radius: 10px; cursor: pointer; text-align: left;">
                    <div style="font-size: 13px; font-weight: 700; color: #166534; margin-bottom: 6px;">✏️ 새로 직접입력</div>
                    <div style="font-size: 12px; color: #16a34a; margin-bottom: 8px;">
                        출처 없이 새로운 공실 정보를 직접 입력
                    </div>
                    <div style="font-size: 11px; color: #64748b;">별도 출처 정보 없이 수동으로 공실을 등록합니다</div>
                </button>
            </div>
            <div style="text-align: right; margin-top: 10px;">
                <button onclick="hideInlineVacancyForm()" style="padding: 6px 14px; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; font-size: 12px; color: #666;">취소</button>
            </div>
        `;
        return;
    }
    
    // ★ 출처 결정
    let sourceLabel, sourceValue, periodValue;
    if (mode === 'current') {
        sourceValue = state.selectedDocSource;
        periodValue = state.selectedDocPeriod !== 'all' ? state.selectedDocPeriod : '';
        sourceLabel = `${sourceValue} ${periodValue}`.trim();
    } else {
        sourceValue = '직접입력';
        const now = new Date();
        periodValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        sourceLabel = `직접입력 · ${periodValue}`;
    }
    
    form.style.display = 'block';
    form.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <div style="font-size: 13px; font-weight: 600; color: var(--accent-color);">
                ➕ 공실 정보 입력 
                <span style="font-size: 11px; padding: 2px 8px; background: ${mode === 'current' ? '#dbeafe' : '#dcfce7'}; color: ${mode === 'current' ? '#1e40af' : '#166534'}; border-radius: 10px; margin-left: 6px;">
                    ${mode === 'current' ? '📋 ' + sourceValue : '✏️ 직접입력'}
                </span>
            </div>
            <button onclick="showInlineVacancyForm()" style="font-size: 11px; color: var(--accent-color); background: none; border: none; cursor: pointer; text-decoration: underline;">← 유형 변경</button>
        </div>
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px;">
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">공실층 *</label>
                <input type="text" id="inlineVacancyFloor" placeholder="예: 10F" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">임대면적(평)</label>
                <input type="number" id="inlineVacancyRentArea" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">전용면적(평)</label>
                <input type="number" id="inlineVacancyExclusiveArea" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">임대료/평 *</label>
                <input type="number" id="inlineVacancyRentPy" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">보증금/평</label>
                <input type="number" id="inlineVacancyDepositPy" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">관리비/평</label>
                <input type="number" id="inlineVacancyMaintenancePy" placeholder="0" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
            <div>
                <label style="display: block; font-size: 11px; color: #666; margin-bottom: 3px;">입주시기</label>
                <input type="text" id="inlineVacancyMoveIn" placeholder="즉시, 25년3월" style="width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 13px; box-sizing: border-box;">
            </div>
        </div>
        <input type="hidden" id="inlineVacancySource" value="${sourceValue}">
        <input type="hidden" id="inlineVacancyPeriod" value="${periodValue}">
        <input type="hidden" id="inlineVacancyMode" value="${mode}">
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <div style="font-size: 11px; color: #888;">
                📅 ${sourceLabel}
            </div>
            <div style="display: flex; gap: 8px;">
                <button onclick="hideInlineVacancyForm()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; font-size: 12px;">취소</button>
                <button onclick="saveInlineVacancy()" style="padding: 8px 16px; border: none; border-radius: 4px; background: var(--accent-color); color: white; cursor: pointer; font-size: 12px; font-weight: 500;">💾 저장</button>
            </div>
        </div>
    `;
    
    // 첫 번째 입력 필드에 포커스
    setTimeout(() => {
        const firstInput = document.getElementById('inlineVacancyFloor');
        if (firstInput) firstInput.focus();
    }, 100);
}

export function hideInlineVacancyForm() {
    const form = document.getElementById('inlineVacancyForm');
    if (form) {
        form.style.display = 'none';
        form.innerHTML = '';  // ★ 동적 컨텐츠 초기화
    }
}

function clearInlineVacancyForm() {
    // 동적 폼이므로 hideInlineVacancyForm에서 처리
    hideInlineVacancyForm();
}

export async function saveInlineVacancy() {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩 정보가 없습니다', 'error');
        return;
    }
    
    // 입력값 수집
    const floor = document.getElementById('inlineVacancyFloor')?.value?.trim();
    const rentPyStr = document.getElementById('inlineVacancyRentPy')?.value?.trim();
    
    // 필수값 확인 - 공실층
    if (!floor) {
        showToast('공실층을 입력해주세요', 'warning');
        document.getElementById('inlineVacancyFloor')?.focus();
        return;
    }
    
    // 필수값 확인 - 임대료
    if (!rentPyStr || isNaN(parseFloat(rentPyStr))) {
        showToast('임대료를 입력해주세요', 'warning');
        document.getElementById('inlineVacancyRentPy')?.focus();
        return;
    }
    
    const rentPy = parseFloat(rentPyStr);
    const depositPyStr = document.getElementById('inlineVacancyDepositPy')?.value?.trim();
    const maintenancePyStr = document.getElementById('inlineVacancyMaintenancePy')?.value?.trim();
    
    // ★ 출처/기간 정보
    const source = document.getElementById('inlineVacancySource')?.value || '직접입력';
    const publishDate = document.getElementById('inlineVacancyPeriod')?.value || '';
    const mode = document.getElementById('inlineVacancyMode')?.value || 'manual';
    
    const now = new Date();
    const vacancyData = {
        floor: floor,
        rentArea: parseFloat(document.getElementById('inlineVacancyRentArea')?.value) || 0,
        exclusiveArea: parseFloat(document.getElementById('inlineVacancyExclusiveArea')?.value) || 0,
        rentPy: formatNumber(rentPy),
        depositPy: depositPyStr && !isNaN(parseFloat(depositPyStr)) ? formatNumber(parseFloat(depositPyStr)) : '',
        maintenancePy: maintenancePyStr && !isNaN(parseFloat(maintenancePyStr)) ? formatNumber(parseFloat(maintenancePyStr)) : '',
        moveInDate: document.getElementById('inlineVacancyMoveIn')?.value?.trim() || '즉시',
        source: source,
        publishDate: publishDate,
        addedManually: true,
        addedBy: state.currentUser?.email || state.currentUser?.name || 'unknown',
        addedAt: now.toISOString()
    };
    
    try {
        // ★ Firebase에 저장
        const newVacancyRef = push(ref(db, `vacancies/${building.id}`));
        await set(newVacancyRef, vacancyData);
        
        console.log('✅ 공실 Firebase 저장 완료:', `vacancies/${building.id}`, vacancyData);
        
        // ★ 로컬 상태 업데이트 (즉시 반영)
        const newEntry = { ...vacancyData, _key: newVacancyRef.key };
        
        if (!building.vacancies) building.vacancies = [];
        building.vacancies.push(newEntry);
        building.vacancyCount = building.vacancies.length;
        
        // allBuildings에서도 업데이트 (같은 객체가 아닌 경우에만)
        const buildingInAll = state.allBuildings?.find(b => b.id === building.id);
        if (buildingInAll && buildingInAll !== building) {
            if (!buildingInAll.vacancies) buildingInAll.vacancies = [];
            buildingInAll.vacancies.push({ ...newEntry });
            buildingInAll.vacancyCount = buildingInAll.vacancies.length;
        }
        
        showToast(`${building.name} ${floor} 공실 추가 완료 (${source})`, 'success');
        
        // ★ 폼 숨기고 안내문 섹션 새로고침
        hideInlineVacancyForm();
        
        // 현재 선택된 출처를 저장된 출처로 설정 (새로 추가한 공실이 바로 보이도록)
        if (mode === 'current') {
            state.selectedDocSource = source;
        } else if (mode === 'manual') {
            state.selectedDocSource = source; // '직접입력'
        }
        
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 저장 오류:', error);
        showToast('저장 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

// ===== 공실 선택 기능 (Comp List 연동) =====

// 개별 공실 선택 토글
export function toggleVacancySelect(vacancyId, idx, checked) {
    if (!state.selectedVacancyIds) {
        state.selectedVacancyIds = new Set();
    }
    
    if (checked) {
        state.selectedVacancyIds.add(vacancyId);
    } else {
        state.selectedVacancyIds.delete(vacancyId);
    }
    
    updateVacancySelectUI();
    
    // 행 배경색 업데이트
    const row = document.querySelector(`tr[data-vacancy-id="${vacancyId}"]`);
    if (row) {
        row.style.background = checked ? 'rgba(37, 99, 235, 0.08)' : '';
    }
    
    // 전체 선택 체크박스 상태 업데이트
    updateSelectAllCheckbox();
}

// 전체 선택/해제
export function toggleAllVacancySelect(checked) {
    if (!state.selectedVacancyIds) {
        state.selectedVacancyIds = new Set();
    }
    
    const vacancies = state.currentDisplayedVacancies || [];
    
    if (checked) {
        vacancies.forEach(v => state.selectedVacancyIds.add(v._vacancyId));
    } else {
        vacancies.forEach(v => state.selectedVacancyIds.delete(v._vacancyId));
    }
    
    // 모든 체크박스 업데이트
    document.querySelectorAll('.vacancy-checkbox').forEach((cb, idx) => {
        cb.checked = checked;
        const row = cb.closest('tr');
        if (row) {
            row.style.background = checked ? 'rgba(37, 99, 235, 0.08)' : '';
        }
    });
    
    updateVacancySelectUI();
}

// 전체 선택 체크박스 상태 업데이트
function updateSelectAllCheckbox() {
    const selectAllCheckbox = document.getElementById('selectAllVacancies');
    if (!selectAllCheckbox) return;
    
    const vacancies = state.currentDisplayedVacancies || [];
    const selectedCount = state.selectedVacancyIds?.size || 0;
    
    if (selectedCount === 0) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
    } else if (selectedCount === vacancies.length) {
        selectAllCheckbox.checked = true;
        selectAllCheckbox.indeterminate = false;
    } else {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = true;
    }
}

// 선택된 공실 수 및 버튼 UI 업데이트
function updateVacancySelectUI() {
    const count = state.selectedVacancyIds?.size || 0;
    
    // Comp List 버튼 업데이트
    const btn = document.getElementById('addVacanciesToCompListBtn');
    const countSpan = document.getElementById('vacancySelectCount');
    
    if (btn) {
        btn.style.background = count > 0 ? 'var(--accent-color)' : 'var(--bg-tertiary)';
        btn.style.color = count > 0 ? 'white' : 'var(--text-muted)';
    }
    
    if (countSpan) {
        countSpan.textContent = count > 0 ? `${count}개 ` : '';
    }
    
    // ★ v2.0: 선택 개수 표시 및 삭제/이관 버튼 상태 업데이트
    const selectedCountEl = document.getElementById('selectedVacancyCount');
    if (selectedCountEl) {
        selectedCountEl.textContent = count > 0 ? `${count}개 선택` : '선택없음';
        selectedCountEl.style.color = count > 0 ? 'var(--accent-color)' : 'var(--text-muted)';
        selectedCountEl.style.fontWeight = count > 0 ? '600' : '400';
    }
    
    // 삭제 버튼 상태 업데이트
    const deleteBtn = document.getElementById('deleteSelectedVacanciesBtn');
    if (deleteBtn) {
        deleteBtn.disabled = count === 0;
        deleteBtn.style.background = count > 0 ? '#fee2e2' : '#f3f4f6';
        deleteBtn.style.color = count > 0 ? '#dc2626' : '#9ca3af';
        deleteBtn.style.borderColor = count > 0 ? '#fecaca' : '#e5e7eb';
        deleteBtn.style.cursor = count > 0 ? 'pointer' : 'not-allowed';
    }
    
    // 이관 버튼 상태 업데이트
    const transferBtn = document.getElementById('transferSelectedVacanciesBtn');
    if (transferBtn) {
        transferBtn.disabled = count === 0;
        transferBtn.style.background = count > 0 ? '#fef3c7' : '#f3f4f6';
        transferBtn.style.color = count > 0 ? '#d97706' : '#9ca3af';
        transferBtn.style.borderColor = count > 0 ? '#fde68a' : '#e5e7eb';
        transferBtn.style.cursor = count > 0 ? 'pointer' : 'not-allowed';
    }
}

// 선택된 공실을 Comp List에 추가
export function addSelectedVacanciesToCompList() {
    const selectedIds = state.selectedVacancyIds;
    
    if (!selectedIds || selectedIds.size === 0) {
        showToast('공실을 먼저 선택해주세요', 'warning');
        return;
    }
    
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩 정보가 없습니다', 'error');
        return;
    }
    
    // 선택된 공실 데이터 수집
    const selectedVacancies = (state.currentDisplayedVacancies || [])
        .filter(v => selectedIds.has(v._vacancyId))
        .map(v => ({
            floor: v.floor || '',
            rentArea: v.rentArea || 0,
            exclusiveArea: v.exclusiveArea || 0,
            rentPy: v.rentPy || '',
            depositPy: v.depositPy || '',
            maintenancePy: v.maintenancePy || '',
            moveInDate: v.moveInDate || '',
            source: v.source || state.selectedDocSource || '',
            publishDate: v.publishDate || state.selectedDocPeriod || ''
        }));
    
    // Comp List에 추가 (window.addBuildingToCompList 사용)
    if (typeof window.addBuildingToCompList === 'function') {
        window.addBuildingToCompList(building, selectedVacancies);
        
        // 선택 초기화
        state.selectedVacancyIds.clear();
        
        // UI 업데이트
        document.querySelectorAll('.vacancy-checkbox').forEach(cb => {
            cb.checked = false;
            const row = cb.closest('tr');
            if (row) row.style.background = '';
        });
        
        const selectAllCheckbox = document.getElementById('selectAllVacancies');
        if (selectAllCheckbox) {
            selectAllCheckbox.checked = false;
            selectAllCheckbox.indeterminate = false;
        }
        
        updateVacancySelectUI();
        
        showToast(`${building.name}의 ${selectedVacancies.length}개 공실이 Comp List에 추가되었습니다`, 'success');
    } else {
        showToast('Comp List 모듈이 로드되지 않았습니다', 'error');
    }
}

// ===== 건축물대장 불러오기 =====
// 참고: refreshBuildingLedger 함수는 portal-misc.js에서 전역으로 등록됨

// ===== ★ 건축물대장 전유부/층별개요 조회 =====

/**
 * 건축물대장 층별상세 데이터 조회
 * @param {string} viewType - 'floorOutline' | 'exposeInfo' | 'exposeAreaInfo'
 */
export async function fetchBuildingFloorDetail(viewType = 'floorOutline') {
    const building = state.selectedBuilding;
    if (!building) {
        showToast('빌딩을 먼저 선택하세요', 'error');
        return;
    }
    
    const address = building.address || building.addressJibun || building.addressRoad;
    if (!address) {
        showToast('주소 정보가 없습니다', 'error');
        return;
    }
    
    const container = document.getElementById('floorDetailContainer');
    if (!container) return;
    
    // 로딩 표시
    const typeLabels = {
        'floorOutline': '층별개요',
        'exposeInfo': '전유부',
        'exposeAreaInfo': '전유공용면적'
    };
    container.innerHTML = `
        <div style="text-align: center; padding: 20px; color: var(--text-muted);">
            <div style="font-size: 20px; margin-bottom: 8px;">⏳</div>
            <div style="font-size: 12px;">건축물대장 ${typeLabels[viewType]} 조회 중...</div>
        </div>
    `;
    
    try {
        const API_URL = window.API_BASE_URL || 'https://portal-dsyl.onrender.com';
        const response = await fetch(`${API_URL}/api/building-register/floor-detail?address=${encodeURIComponent(address)}`);
        const data = await response.json();
        
        if (!data.success || !data.results) {
            throw new Error(data.error || '조회 결과가 없습니다');
        }
        
        const results = data.results;
        const targetData = results[viewType];
        
        if (!targetData || targetData.length === 0) {
            // 다른 데이터 타입에는 있는지 체크
            const available = Object.keys(results).filter(k => results[k] && results[k].length > 0);
            let altMsg = '';
            if (available.length > 0) {
                const altLabels = available.map(k => typeLabels[k] || k).join(', ');
                altMsg = `<div style="margin-top: 8px; font-size: 11px;">사용 가능한 데이터: ${altLabels}</div>`;
            }
            container.innerHTML = `
                <div style="text-align: center; padding: 20px; background: #fef3c7; border-radius: 8px; border: 1px solid #fbbf24;">
                    <div style="font-size: 18px; margin-bottom: 6px;">📭</div>
                    <div style="font-size: 12px; color: #92400e;">
                        ${typeLabels[viewType]} 데이터가 없습니다.<br>
                        <span style="font-size: 11px; color: #a16207;">집합건축물(구분소유)이 아닌 경우 전유부 데이터가 없을 수 있습니다.</span>
                    </div>
                    ${altMsg}
                </div>
            `;
            return;
        }
        
        // 데이터 렌더링
        renderFloorDetailData(container, viewType, targetData, typeLabels[viewType]);
        
        // 캐시 저장 (같은 빌딩 재조회 방지)
        if (!building._floorDetailCache) building._floorDetailCache = {};
        building._floorDetailCache[viewType] = targetData;
        
    } catch (error) {
        console.error('건축물대장 층별상세 조회 오류:', error);
        container.innerHTML = `
            <div style="text-align: center; padding: 16px; background: #fef2f2; border-radius: 8px; border: 1px solid #fca5a5;">
                <div style="font-size: 12px; color: #dc2626;">❌ 조회 실패: ${error.message}</div>
            </div>
        `;
    }
}

/**
 * 층별상세 데이터 렌더링
 */
function renderFloorDetailData(container, viewType, data, label) {
    if (viewType === 'floorOutline') {
        renderFloorOutline(container, data, label);
    } else if (viewType === 'exposeInfo') {
        renderExposeInfo(container, data, label);
    } else if (viewType === 'exposeAreaInfo') {
        renderExposeAreaInfo(container, data, label);
    }
}

/**
 * 층별개요 렌더링 - 층별 면적/용도 테이블
 */
function renderFloorOutline(container, data, label) {
    // 지상 → 내림차순, 지하 → 오름차순 정렬
    const above = data.filter(d => d.flrGbCdNm === '지상').sort((a, b) => b.flrNo - a.flrNo);
    const below = data.filter(d => d.flrGbCdNm === '지하').sort((a, b) => a.flrNo - b.flrNo);
    const sorted = [...above, ...below];
    
    // 총면적 계산
    const totalArea = data.reduce((sum, d) => sum + (d.area || 0), 0);
    const totalPy = (totalArea / 3.3058).toFixed(1);
    
    let html = `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden;">
            <div style="padding: 8px 12px; background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: white; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; font-weight: 600;">🏗️ ${label} (${data.length}개 층)</span>
                <span style="font-size: 11px; opacity: 0.9;">총 ${formatNumber(Math.round(totalArea))}㎡ (${formatNumber(totalPy)}평)</span>
                <button onclick="document.getElementById('floorDetailContainer').innerHTML=''" 
                        style="background: none; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0 4px;">✕</button>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
                    <thead style="position: sticky; top: 0; background: #f8f9fa;">
                        <tr>
                            <th style="padding: 6px 8px; text-align: center; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 60px;">층</th>
                            <th style="padding: 6px 8px; text-align: center; border-bottom: 2px solid #e5e7eb; font-weight: 600;">구조</th>
                            <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600;">용도</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 80px;">면적(㎡)</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 70px;">면적(평)</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    
    sorted.forEach((item, idx) => {
        const floorLabel = item.flrGbCdNm === '지하' ? `B${item.flrNo}` : `${item.flrNo}F`;
        const areaPy = item.area ? (item.area / 3.3058).toFixed(1) : '-';
        const usage = item.mainPurpsCdNm || item.etcPurps || '-';
        const bgColor = idx % 2 === 0 ? 'white' : '#f9fafb';
        const isBelow = item.flrGbCdNm === '지하';
        
        html += `
            <tr style="background: ${bgColor};">
                <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; font-weight: 600; color: ${isBelow ? '#dc2626' : '#1d4ed8'};">${floorLabel}</td>
                <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; color: #6b7280; font-size: 10px;">${item.strctCdNm || '-'}</td>
                <td style="padding: 5px 8px; text-align: left; border-bottom: 1px solid #f0f0f0;">${usage}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace;">${item.area ? formatNumber(Math.round(item.area)) : '-'}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace; color: #6b7280;">${areaPy}</td>
            </tr>
        `;
    });
    
    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

/**
 * 전유부 렌더링 - 호실별 목록 (층별 그룹핑)
 */
function renderExposeInfo(container, data, label) {
    // 층별 그룹핑
    const floorMap = {};
    data.forEach(item => {
        const floorKey = `${item.flrGbCdNm}_${item.flrNo}`;
        if (!floorMap[floorKey]) {
            floorMap[floorKey] = {
                flrGbCdNm: item.flrGbCdNm,
                flrNo: item.flrNo,
                units: []
            };
        }
        floorMap[floorKey].units.push(item);
    });
    
    // 정렬: 지상 내림차순, 지하 오름차순
    const floors = Object.values(floorMap).sort((a, b) => {
        if (a.flrGbCdNm === '지상' && b.flrGbCdNm === '지하') return -1;
        if (a.flrGbCdNm === '지하' && b.flrGbCdNm === '지상') return 1;
        if (a.flrGbCdNm === '지상') return b.flrNo - a.flrNo;
        return a.flrNo - b.flrNo;
    });
    
    let html = `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden;">
            <div style="padding: 8px 12px; background: linear-gradient(135deg, #059669, #047857); color: white; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; font-weight: 600;">📋 ${label} (총 ${data.length}개 호실)</span>
                <button onclick="document.getElementById('floorDetailContainer').innerHTML=''" 
                        style="background: none; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0 4px;">✕</button>
            </div>
            <div style="max-height: 400px; overflow-y: auto; padding: 8px;">
    `;
    
    floors.forEach(floor => {
        const floorLabel = floor.flrGbCdNm === '지하' ? `B${floor.flrNo}` : `${floor.flrNo}F`;
        const isBelow = floor.flrGbCdNm === '지하';
        const unitNames = floor.units.map(u => u.hoNm || '?').sort();
        
        html += `
            <div style="margin-bottom: 6px; padding: 6px 10px; background: ${isBelow ? '#fef2f2' : '#eff6ff'}; border-radius: 6px; border-left: 3px solid ${isBelow ? '#dc2626' : '#3b82f6'};">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 12px; font-weight: 700; color: ${isBelow ? '#dc2626' : '#1d4ed8'};">${floorLabel}</span>
                    <span style="font-size: 10px; color: #6b7280;">${floor.units.length}개 호실</span>
                </div>
                <div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">
                    ${unitNames.map(name => `
                        <span style="padding: 2px 6px; background: white; border-radius: 3px; font-size: 10px; color: #374151; border: 1px solid #e5e7eb;">${name}</span>
                    `).join('')}
                </div>
            </div>
        `;
    });
    
    html += `
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

/**
 * 전유공용면적 렌더링 - 호실별 면적 테이블
 */
function renderExposeAreaInfo(container, data, label) {
    // 전유부만 필터 (공용부 제외하고 보여줄 수도 있음)
    const privateOnly = data.filter(d => d.exposPubuseGbCdNm === '전유');
    const publicOnly = data.filter(d => d.exposPubuseGbCdNm === '공용');
    
    // 층별 그룹핑 (전유 기준)
    const displayData = privateOnly.length > 0 ? privateOnly : data;
    
    // 호실별로 그룹핑 → 같은 호실의 면적 합산
    const unitMap = {};
    displayData.forEach(item => {
        const key = `${item.flrGbCdNm}_${item.flrNo}_${item.hoNm || 'unknown'}`;
        if (!unitMap[key]) {
            unitMap[key] = { ...item, totalArea: 0 };
        }
        unitMap[key].totalArea += item.area || 0;
    });
    
    const units = Object.values(unitMap).sort((a, b) => {
        if (a.flrGbCdNm === '지상' && b.flrGbCdNm === '지하') return -1;
        if (a.flrGbCdNm === '지하' && b.flrGbCdNm === '지상') return 1;
        if (a.flrGbCdNm === '지상') return b.flrNo - a.flrNo || (a.hoNm || '').localeCompare(b.hoNm || '');
        return a.flrNo - b.flrNo || (a.hoNm || '').localeCompare(b.hoNm || '');
    });
    
    const totalArea = displayData.reduce((sum, d) => sum + (d.area || 0), 0);
    const totalPy = (totalArea / 3.3058).toFixed(1);
    
    let html = `
        <div style="background: white; border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden;">
            <div style="padding: 8px 12px; background: linear-gradient(135deg, #d97706, #b45309); color: white; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-size: 12px; font-weight: 600;">📐 ${label} ${privateOnly.length > 0 ? '(전유)' : ''}</span>
                <span style="font-size: 11px; opacity: 0.9;">총 ${formatNumber(Math.round(totalArea))}㎡ (${formatNumber(totalPy)}평)</span>
                <button onclick="document.getElementById('floorDetailContainer').innerHTML=''" 
                        style="background: none; border: none; color: white; cursor: pointer; font-size: 14px; padding: 0 4px;">✕</button>
            </div>
            <div style="max-height: 400px; overflow-y: auto;">
                <table style="width: 100%; border-collapse: collapse; font-size: 11px;">
                    <thead style="position: sticky; top: 0; background: #f8f9fa;">
                        <tr>
                            <th style="padding: 6px 8px; text-align: center; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 50px;">층</th>
                            <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600;">호실</th>
                            <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #e5e7eb; font-weight: 600;">용도</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 75px;">면적(㎡)</th>
                            <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #e5e7eb; font-weight: 600; width: 65px;">면적(평)</th>
                        </tr>
                    </thead>
                    <tbody>
    `;
    
    units.forEach((item, idx) => {
        const floorLabel = item.flrGbCdNm === '지하' ? `B${item.flrNo}` : `${item.flrNo}F`;
        const areaPy = item.totalArea ? (item.totalArea / 3.3058).toFixed(1) : '-';
        const usage = item.mainPurpsCdNm || item.etcPurps || '-';
        const bgColor = idx % 2 === 0 ? 'white' : '#f9fafb';
        const isBelow = item.flrGbCdNm === '지하';
        
        html += `
            <tr style="background: ${bgColor};">
                <td style="padding: 5px 8px; text-align: center; border-bottom: 1px solid #f0f0f0; font-weight: 600; color: ${isBelow ? '#dc2626' : '#1d4ed8'};">${floorLabel}</td>
                <td style="padding: 5px 8px; text-align: left; border-bottom: 1px solid #f0f0f0; font-weight: 500;">${item.hoNm || '-'}</td>
                <td style="padding: 5px 8px; text-align: left; border-bottom: 1px solid #f0f0f0; color: #6b7280;">${usage}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace;">${item.totalArea ? formatNumber(Math.round(item.totalArea)) : '-'}</td>
                <td style="padding: 5px 8px; text-align: right; border-bottom: 1px solid #f0f0f0; font-family: monospace; color: #6b7280;">${areaPy}</td>
            </tr>
        `;
    });
    
    // 공용면적 합계 행
    if (publicOnly.length > 0) {
        const publicArea = publicOnly.reduce((sum, d) => sum + (d.area || 0), 0);
        const publicPy = (publicArea / 3.3058).toFixed(1);
        html += `
            <tr style="background: #f0fdf4; font-weight: 600;">
                <td colspan="3" style="padding: 5px 8px; text-align: right; border-top: 2px solid #e5e7eb; font-size: 10px; color: #059669;">공용면적 합계</td>
                <td style="padding: 5px 8px; text-align: right; border-top: 2px solid #e5e7eb; font-family: monospace; color: #059669;">${formatNumber(Math.round(publicArea))}</td>
                <td style="padding: 5px 8px; text-align: right; border-top: 2px solid #e5e7eb; font-family: monospace; color: #059669;">${publicPy}</td>
            </tr>
        `;
    }
    
    html += `
                    </tbody>
                </table>
            </div>
        </div>
    `;
    
    container.innerHTML = html;
}

// 전역 등록
window.fetchBuildingFloorDetail = fetchBuildingFloorDetail;

// ===== 이미지 뷰어 & 갤러리 =====

// 2컬럼 이미지 갤러리 스타일 주입
(function injectImageGalleryStyles() {
    if (document.getElementById('imageGalleryStyles')) return;
    const style = document.createElement('style');
    style.id = 'imageGalleryStyles';
    style.textContent = `
        /* 2컬럼 이미지 갤러리 */
        .image-gallery-dual {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            margin-bottom: 16px;
        }
        .image-column {
            display: flex;
            flex-direction: column;
            gap: 8px;
        }
        .column-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 6px 0;
            border-bottom: 2px solid #e5e7eb;
        }
        .column-title {
            font-size: 13px;
            font-weight: 600;
            color: #374151;
        }
        .column-count {
            font-size: 11px;
            color: #9ca3af;
        }
        
        /* 메인 이미지 영역 */
        .image-main-area {
            position: relative;
            width: 100%;
            height: 140px;
            background: #f8f9fa;
            border: 1px solid #e5e7eb;
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
        }
        .image-main-area img {
            width: 100%;
            height: 100%;
            object-fit: contain;
        }
        .image-main-area .image-overlay {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-size: 13px;
            opacity: 0;
            transition: opacity 0.2s;
        }
        .image-main-area:hover .image-overlay {
            opacity: 1;
        }
        
        /* 캐러셀 버튼 */
        .carousel-btn {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            width: 28px;
            height: 28px;
            background: rgba(255,255,255,0.9);
            border: none;
            border-radius: 50%;
            font-size: 16px;
            color: #374151;
            cursor: pointer;
            z-index: 10;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .carousel-btn:hover {
            background: white;
        }
        .carousel-btn.prev { left: 6px; }
        .carousel-btn.next { right: 6px; }
        .image-counter {
            position: absolute;
            bottom: 6px;
            right: 6px;
            background: rgba(0,0,0,0.6);
            color: white;
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 10px;
        }
        
        /* 썸네일 행 */
        .image-thumbs-row {
            display: flex;
            gap: 6px;
            overflow-x: auto;
            padding: 4px 0;
        }
        .image-thumbs-row::-webkit-scrollbar {
            height: 4px;
        }
        .image-thumbs-row::-webkit-scrollbar-thumb {
            background: #d1d5db;
            border-radius: 2px;
        }
        .thumb-item {
            flex-shrink: 0;
            width: 48px;
            height: 36px;
            border: 2px solid transparent;
            border-radius: 4px;
            overflow: hidden;
            cursor: pointer;
            transition: border-color 0.2s;
        }
        .thumb-item:hover {
            border-color: #93c5fd;
        }
        .thumb-item.active {
            border-color: #3b82f6;
        }
        .thumb-item img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        
        /* 추가 버튼 */
        .btn-add-image {
            width: 100%;
            padding: 6px;
            background: #f8f9fa;
            border: 1px dashed #d1d5db;
            border-radius: 6px;
            color: #6b7280;
            font-size: 12px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-add-image:hover {
            background: #f0f9ff;
            border-color: #3b82f6;
            color: #3b82f6;
        }
        
        /* 빈 상태 영역 */
        .image-empty-area {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 140px;
            background: #f8f9fa;
            border: 2px dashed #d1d5db;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .image-empty-area:hover {
            background: #f0f9ff;
            border-color: #3b82f6;
        }
        .empty-icon {
            font-size: 32px;
            margin-bottom: 8px;
            opacity: 0.5;
        }
        .empty-text {
            font-size: 12px;
            color: #9ca3af;
            margin-bottom: 8px;
        }
        .btn-add-empty {
            padding: 6px 12px;
            background: #3b82f6;
            border: none;
            border-radius: 6px;
            color: white;
            font-size: 12px;
            cursor: pointer;
        }
        .btn-add-empty:hover {
            background: #2563eb;
        }
        
        /* 이미지 뷰어 모달 */
        .image-viewer-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.95);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .viewer-container {
            position: relative;
            width: 90%;
            height: 90%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .viewer-close {
            position: absolute;
            top: -40px;
            right: 0;
            width: 36px;
            height: 36px;
            background: rgba(255,255,255,0.1);
            border: none;
            border-radius: 50%;
            color: white;
            font-size: 24px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .viewer-close:hover { background: rgba(255,255,255,0.2); }
        .viewer-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            width: 50px;
            height: 50px;
            background: rgba(255,255,255,0.1);
            border: none;
            border-radius: 50%;
            color: white;
            font-size: 28px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .viewer-nav:hover { background: rgba(255,255,255,0.2); }
        .viewer-nav.prev { left: 10px; }
        .viewer-nav.next { right: 10px; }
        .viewer-image-wrapper {
            max-width: calc(100% - 140px);
            max-height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .viewer-image-wrapper img {
            max-width: 100%;
            max-height: 80vh;
            object-fit: contain;
            border-radius: 4px;
        }
        .viewer-info {
            position: absolute;
            bottom: -40px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            gap: 16px;
            color: rgba(255,255,255,0.8);
            font-size: 14px;
        }
        .viewer-actions {
            position: absolute;
            bottom: -40px;
            right: 0;
            display: flex;
            gap: 8px;
        }
        .viewer-actions button {
            padding: 6px 12px;
            border: none;
            border-radius: 4px;
            font-size: 13px;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-add-viewer {
            background: #3b82f6;
            color: white;
        }
        .btn-add-viewer:hover { background: #2563eb; }
        .btn-delete-viewer {
            background: #ef4444;
            color: white;
        }
        .btn-delete-viewer:hover { background: #dc2626; }
    `;
    document.head.appendChild(style);
})();

// 캐러셀 네비게이션
window.carouselNav = function(type, direction) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const images = type === 'exterior' ? (b.exteriorImages || []) : (b.floorPlanImages || []);
    if (images.length <= 1) return;
    
    const idxKey = type === 'exterior' ? '_exteriorIdx' : '_floorplanIdx';
    let currentIdx = window[idxKey] || 0;
    
    currentIdx += direction;
    if (currentIdx < 0) currentIdx = images.length - 1;
    if (currentIdx >= images.length) currentIdx = 0;
    
    window[idxKey] = currentIdx;
    
    // 메인 이미지 업데이트
    const mainImg = document.getElementById(type === 'exterior' ? 'exteriorMainImg' : 'floorplanMainImg');
    if (mainImg) mainImg.src = images[currentIdx].url;
    
    // 카운터 업데이트
    const counter = document.getElementById(type === 'exterior' ? 'exteriorCounter' : 'floorplanCounter');
    if (counter) counter.textContent = `${currentIdx + 1} / ${images.length}`;
    
    // 썸네일 active 상태 업데이트
    const thumbsRow = document.getElementById(type === 'exterior' ? 'exteriorThumbsRow' : 'floorplanThumbsRow');
    if (thumbsRow) {
        thumbsRow.querySelectorAll('.thumb-item').forEach((thumb, i) => {
            thumb.classList.toggle('active', i === currentIdx);
        });
    }
};

// 썸네일 클릭으로 이미지 선택
window.selectImage = function(type, index) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const images = type === 'exterior' ? (b.exteriorImages || []) : (b.floorPlanImages || []);
    if (index >= images.length) return;
    
    const idxKey = type === 'exterior' ? '_exteriorIdx' : '_floorplanIdx';
    window[idxKey] = index;
    
    // 메인 이미지 업데이트
    const mainImg = document.getElementById(type === 'exterior' ? 'exteriorMainImg' : 'floorplanMainImg');
    if (mainImg) mainImg.src = images[index].url;
    
    // 카운터 업데이트
    const counter = document.getElementById(type === 'exterior' ? 'exteriorCounter' : 'floorplanCounter');
    if (counter) counter.textContent = `${index + 1} / ${images.length}`;
    
    // 썸네일 active 상태 업데이트
    const thumbsRow = document.getElementById(type === 'exterior' ? 'exteriorThumbsRow' : 'floorplanThumbsRow');
    if (thumbsRow) {
        thumbsRow.querySelectorAll('.thumb-item').forEach((thumb, i) => {
            thumb.classList.toggle('active', i === index);
        });
    }
};

// 이미지 탭 전환 (하위 호환용)
window.switchImageTab = function(tab) {
    const exteriorTab = document.querySelector('.image-tab:first-child');
    const floorplanTab = document.querySelector('.image-tab:last-child');
    const exteriorThumbs = document.getElementById('exteriorThumbnails');
    const floorplanThumbs = document.getElementById('floorplanThumbnails');
    
    if (tab === 'exterior') {
        exteriorTab?.classList.add('active');
        floorplanTab?.classList.remove('active');
        if (exteriorThumbs) exteriorThumbs.style.display = '';
        if (floorplanThumbs) floorplanThumbs.style.display = 'none';
    } else {
        exteriorTab?.classList.remove('active');
        floorplanTab?.classList.add('active');
        if (exteriorThumbs) exteriorThumbs.style.display = 'none';
        if (floorplanThumbs) floorplanThumbs.style.display = '';
    }
};

// 이미지 뷰어 열기
window.openImageViewer = function(type, index) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const images = type === 'exterior' ? (b.exteriorImages || []) : (b.floorPlanImages || []);
    if (images.length === 0) return;
    
    let currentIndex = index;
    
    const viewerHtml = `
        <div id="imageViewerModal" class="image-viewer-modal" onclick="if(event.target === this) closeImageViewer()">
            <div class="viewer-container">
                <button class="viewer-close" onclick="closeImageViewer()">×</button>
                <button class="viewer-nav prev" onclick="navigateImage(-1)" ${images.length <= 1 ? 'style="display:none"' : ''}>‹</button>
                <div class="viewer-image-wrapper">
                    <img id="viewerMainImage" src="${images[currentIndex]?.url || images[currentIndex]}" alt="">
                </div>
                <button class="viewer-nav next" onclick="navigateImage(1)" ${images.length <= 1 ? 'style="display:none"' : ''}>›</button>
                <div class="viewer-info">
                    <span id="viewerImageCount">${currentIndex + 1} / ${images.length}</span>
                    <span class="viewer-type">${type === 'exterior' ? '🏢 외관' : '📐 평면도'}</span>
                </div>
                <div class="viewer-actions">
                    ${type === 'exterior' ? `
                        <button class="btn-add-viewer" onclick="addExteriorImage()">➕ 외관 추가</button>
                        <button class="btn-delete-viewer" onclick="deleteExteriorImage()">🗑️ 이 이미지 삭제</button>
                    ` : `
                        <button class="btn-add-viewer" onclick="addFloorPlanImage()">➕ 평면도 추가</button>
                        <button class="btn-delete-viewer" onclick="deleteFloorPlanImage()">🗑️ 이 이미지 삭제</button>
                    `}
                </div>
            </div>
        </div>
    `;
    
    // 기존 모달 제거
    const existing = document.getElementById('imageViewerModal');
    if (existing) existing.remove();
    
    document.body.insertAdjacentHTML('beforeend', viewerHtml);
    
    // 전역 상태 저장 (네비게이션용)
    window._imageViewerState = { type, images, currentIndex };
    
    // ESC 키로 닫기
    document.addEventListener('keydown', handleViewerKeydown);
};

function handleViewerKeydown(e) {
    if (e.key === 'Escape') closeImageViewer();
    if (e.key === 'ArrowLeft') navigateImage(-1);
    if (e.key === 'ArrowRight') navigateImage(1);
}

window.closeImageViewer = function() {
    const modal = document.getElementById('imageViewerModal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', handleViewerKeydown);
    window._imageViewerState = null;
};

window.navigateImage = function(direction) {
    const state = window._imageViewerState;
    if (!state) return;
    
    let newIndex = state.currentIndex + direction;
    if (newIndex < 0) newIndex = state.images.length - 1;
    if (newIndex >= state.images.length) newIndex = 0;
    
    state.currentIndex = newIndex;
    
    const img = document.getElementById('viewerMainImage');
    const count = document.getElementById('viewerImageCount');
    
    if (img) img.src = state.images[newIndex]?.url || state.images[newIndex];
    if (count) count.textContent = `${newIndex + 1} / ${state.images.length}`;
};

// 평면도 이미지 추가
window.addFloorPlanImage = function() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // 파일 크기 체크 (5MB)
        if (file.size > 5 * 1024 * 1024) {
            showToast('파일 크기는 5MB 이하여야 합니다', 'warning');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const imageData = ev.target.result;
            const b = state.selectedBuilding;
            if (!b) return;
            
            // 현재 평면도 배열 가져오기
            let floorPlanImages = b.images?.floorPlan || [];
            floorPlanImages = [...floorPlanImages, imageData];
            
            try {
                // Firebase 업데이트
                await update(ref(db, `buildings/${b.id}/images`), {
                    floorPlan: floorPlanImages
                });
                
                // 로컬 상태 업데이트
                if (!b.images) b.images = {};
                b.images.floorPlan = floorPlanImages;
                b.floorPlanImages = floorPlanImages.map(img => typeof img === 'string' ? { url: img } : img);
                
                showToast('평면도가 추가되었습니다', 'success');
                closeImageViewer();
                renderInfoSection();
            } catch (err) {
                console.error('평면도 추가 실패:', err);
                showToast('평면도 추가 실패', 'error');
            }
        };
        reader.readAsDataURL(file);
    };
    input.click();
};

// 평면도 이미지 삭제
window.deleteFloorPlanImage = async function() {
    // 뷰어 상태에서 현재 인덱스 가져오기
    const viewerState = window._imageViewerState;
    const index = viewerState?.currentIndex ?? 0;
    
    if (!confirm('이 평면도 이미지를 삭제하시겠습니까?')) return;
    
    const b = state.selectedBuilding;
    if (!b) return;
    
    let floorPlanImages = b.images?.floorPlan || [];
    floorPlanImages = floorPlanImages.filter((_, i) => i !== index);
    
    try {
        // Firebase 업데이트
        await update(ref(db, `buildings/${b.id}/images`), {
            floorPlan: floorPlanImages
        });
        
        // 로컬 상태 업데이트
        if (!b.images) b.images = {};
        b.images.floorPlan = floorPlanImages;
        b.floorPlanImages = floorPlanImages.map(img => typeof img === 'string' ? { url: img } : img);
        
        showToast('평면도가 삭제되었습니다', 'success');
        closeImageViewer();
        renderInfoSection();
    } catch (err) {
        console.error('평면도 삭제 실패:', err);
        showToast('평면도 삭제 실패', 'error');
    }
};

// 외관 이미지 추가
window.addExteriorImage = function() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        // 파일 크기 체크 (5MB)
        if (file.size > 5 * 1024 * 1024) {
            showToast('파일 크기는 5MB 이하여야 합니다', 'warning');
            return;
        }
        
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const imageData = ev.target.result;
            const b = state.selectedBuilding;
            if (!b) return;
            
            // 현재 외관 이미지 배열 가져오기
            let exteriorImages = b.images?.exterior || [];
            exteriorImages = [...exteriorImages, imageData];
            
            try {
                // Firebase 업데이트
                await update(ref(db, `buildings/${b.id}/images`), {
                    exterior: exteriorImages
                });
                
                // 로컬 상태 업데이트
                if (!b.images) b.images = {};
                b.images.exterior = exteriorImages;
                b.exteriorImages = exteriorImages.map(img => typeof img === 'string' ? { url: img } : img);
                
                showToast('외관 사진이 추가되었습니다', 'success');
                closeImageViewer();
                renderInfoSection();
            } catch (err) {
                console.error('외관 사진 추가 실패:', err);
                showToast('외관 사진 추가 실패', 'error');
            }
        };
        reader.readAsDataURL(file);
    };
    input.click();
};

// 외관 이미지 삭제
window.deleteExteriorImage = async function() {
    // 뷰어 상태에서 현재 인덱스 가져오기
    const viewerState = window._imageViewerState;
    const index = viewerState?.currentIndex ?? 0;
    
    if (!confirm('이 외관 이미지를 삭제하시겠습니까?')) return;
    
    const b = state.selectedBuilding;
    if (!b) return;
    
    let exteriorImages = b.images?.exterior || [];
    exteriorImages = exteriorImages.filter((_, i) => i !== index);
    
    try {
        // Firebase 업데이트
        await update(ref(db, `buildings/${b.id}/images`), {
            exterior: exteriorImages
        });
        
        // 로컬 상태 업데이트
        if (!b.images) b.images = {};
        b.images.exterior = exteriorImages;
        b.exteriorImages = exteriorImages.map(img => typeof img === 'string' ? { url: img } : img);
        
        showToast('외관 사진이 삭제되었습니다', 'success');
        closeImageViewer();
        renderInfoSection();
    } catch (err) {
        console.error('외관 사진 삭제 실패:', err);
        showToast('외관 사진 삭제 실패', 'error');
    }
};

// ===== ★ v2.0: 공실 편집/삭제/이관 기능 =====

/**
 * 공실 편집 모달 열기
 * 편집 모드에서는 자동으로 소숫점 표기로 전환
 */
export function openVacancyEditModal(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    // 편집 모드 진입 시 소숫점 표기 자동 ON
    if (!state.showDecimalArea) {
        state.showDecimalArea = true;
        const toggle = document.getElementById('decimalAreaToggle');
        if (toggle) toggle.checked = true;
    }
    
    state.editingVacancyIdx = idx;
    
    const modalHtml = `
        <div class="modal-overlay show" id="vacancyEditModalOverlay" onclick="if(event.target===this)closeVacancyEditModal()"></div>
        <div class="modal show" id="vacancyEditModal" style="max-width: 480px; z-index: 10001;">
            <div class="modal-header">
                <h3 class="modal-title">✏️ 공실 정보 편집</h3>
                <button class="close-btn" onclick="closeVacancyEditModal()">×</button>
            </div>
            <div style="padding: 20px;">
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">층 <span style="color:#dc2626">*</span></label>
                        <input type="text" id="editVacFloor" value="${vacancy.floor || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">입주시기</label>
                        <input type="text" id="editVacMoveIn" value="${vacancy.moveInDate || ''}" placeholder="즉시, 25년3월"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">임대면적 (평)</label>
                        <input type="number" step="0.01" id="editVacRentArea" value="${vacancy.rentArea || ''}" 
                               onchange="validateExclusiveArea()"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">전용면적 (평)</label>
                        <input type="number" step="0.01" id="editVacExclusiveArea" value="${vacancy.exclusiveArea || ''}" 
                               onchange="validateExclusiveArea()"
                               placeholder="임대면적보다 작아야 함"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                        <div id="exclusiveAreaError" style="display: none; color: #dc2626; font-size: 11px; margin-top: 4px;">
                            ⚠️ 전용면적은 임대면적보다 클 수 없습니다
                        </div>
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">보증금/평</label>
                        <input type="text" id="editVacDeposit" value="${vacancy.depositPy || ''}" placeholder="80"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">임대료/평 <span style="color:#dc2626">*</span></label>
                        <input type="text" id="editVacRent" value="${vacancy.rentPy || ''}" placeholder="8.5"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">관리비/평</label>
                        <input type="text" id="editVacMaintenance" value="${vacancy.maintenancePy || ''}" placeholder="3.5"
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="margin-top: 16px; padding: 12px; background: #f8fafc; border-radius: 8px; font-size: 12px; color: #64748b;">
                    <div><strong>출처:</strong> ${vacancy.source || '-'}</div>
                    <div><strong>발행일:</strong> ${vacancy.publishDate || '-'}</div>
                </div>
            </div>
            <div class="form-actions" style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" class="btn btn-secondary" onclick="closeVacancyEditModal()">취소</button>
                <button type="button" class="btn btn-primary" onclick="saveVacancyEditFromModal()">저장</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * 전용면적 유효성 검사
 */
export function validateExclusiveArea() {
    const rentArea = parseFloat(document.getElementById('editVacRentArea')?.value) || 0;
    const exclusiveArea = parseFloat(document.getElementById('editVacExclusiveArea')?.value) || 0;
    const errorDiv = document.getElementById('exclusiveAreaError');
    const exclusiveInput = document.getElementById('editVacExclusiveArea');
    
    if (exclusiveArea > 0 && rentArea > 0 && exclusiveArea > rentArea) {
        if (errorDiv) errorDiv.style.display = 'block';
        if (exclusiveInput) exclusiveInput.style.borderColor = '#dc2626';
        return false;
    } else {
        if (errorDiv) errorDiv.style.display = 'none';
        if (exclusiveInput) exclusiveInput.style.borderColor = 'var(--border-color)';
        return true;
    }
}

/**
 * 공실 편집 모달 닫기
 */
export function closeVacancyEditModal() {
    const modal = document.getElementById('vacancyEditModal');
    const overlay = document.getElementById('vacancyEditModalOverlay');
    if (modal) modal.remove();
    if (overlay) overlay.remove();
    state.editingVacancyIdx = null;
}

/**
 * 공실 편집 저장
 */
export async function saveVacancyEditFromModal() {
    const idx = state.editingVacancyIdx;
    if (idx === null || idx === undefined) {
        console.error('editingVacancyIdx가 없습니다');
        return;
    }
    
    // 유효성 검사
    if (!validateExclusiveArea()) {
        showToast('전용면적은 임대면적보다 클 수 없습니다', 'error');
        return;
    }
    
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) {
        console.error('vacancy를 찾을 수 없습니다. idx:', idx);
        return;
    }
    
    const buildingId = state.selectedBuilding?.id;
    let vacancyKey = vacancy._key;
    
    // ★ _key가 없을 경우 source_publishDate_floor로 키 생성
    if (!vacancyKey) {
        const floor = (vacancy.floor || 'UNK').replace(/[\/\s\.]/g, '_');
        const source = (vacancy.source || 'UNKNOWN').replace(/[\/\s\.]/g, '_');
        const publishDate = (vacancy.publishDate || '').replace(/[\/\s\.]/g, '_');
        vacancyKey = `${source}_${publishDate}_${floor}`;
        console.log('_key가 없어서 생성:', vacancyKey);
    }
    
    if (!buildingId || !vacancyKey) {
        console.error('buildingId 또는 vacancyKey가 없습니다:', { buildingId, vacancyKey });
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        const updatedData = {
            floor: document.getElementById('editVacFloor')?.value || '',
            rentArea: document.getElementById('editVacRentArea')?.value || '',
            exclusiveArea: document.getElementById('editVacExclusiveArea')?.value || '',
            depositPy: document.getElementById('editVacDeposit')?.value || '',
            rentPy: document.getElementById('editVacRent')?.value || '',
            maintenancePy: document.getElementById('editVacMaintenance')?.value || '',
            moveInDate: document.getElementById('editVacMoveIn')?.value || '',
            updatedAt: new Date().toISOString()
        };
        
        console.log('Firebase 업데이트 경로:', `vacancies/${buildingId}/${vacancyKey}`);
        console.log('업데이트 데이터:', updatedData);
        
        // Firebase 업데이트
        await update(ref(db, `vacancies/${buildingId}/${vacancyKey}`), updatedData);
        
        // 로컬 상태 업데이트
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (building && building.vacancies) {
            const localVacancy = building.vacancies.find(v => v._key === vacancyKey || 
                (v.source === vacancy.source && v.publishDate === vacancy.publishDate && v.floor === vacancy.floor));
            if (localVacancy) {
                Object.assign(localVacancy, updatedData);
            }
        }
        
        // currentDisplayedVacancies도 업데이트
        if (state.currentDisplayedVacancies && state.currentDisplayedVacancies[idx]) {
            Object.assign(state.currentDisplayedVacancies[idx], updatedData);
        }
        
        showToast('공실 정보가 수정되었습니다', 'success');
        closeVacancyEditModal();
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 수정 오류:', error);
        showToast('수정 중 오류가 발생했습니다: ' + error.message, 'error');
    }
}

/**
 * 개별 공실 삭제
 */
export async function deleteVacancyByIdx(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) return;
    
    if (!confirm(`${vacancy.floor || '해당'} 층 공실 정보를 삭제하시겠습니까?`)) return;
    
    const buildingId = state.selectedBuilding?.id;
    let vacancyKey = vacancy._key;
    
    // ★ _key가 없을 경우 source_publishDate_floor로 키 생성
    if (!vacancyKey) {
        const floor = (vacancy.floor || 'UNK').replace(/[\/\s\.]/g, '_');
        const source = (vacancy.source || 'UNKNOWN').replace(/[\/\s\.]/g, '_');
        const publishDate = (vacancy.publishDate || '').replace(/[\/\s\.]/g, '_');
        vacancyKey = `${source}_${publishDate}_${floor}`;
    }
    
    if (!buildingId || !vacancyKey) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    try {
        await remove(ref(db, `vacancies/${buildingId}/${vacancyKey}`));
        
        // ★ 로컬 상태 업데이트 - selectedBuilding 직접 업데이트
        const filterFn = v => v._key !== vacancyKey && 
            !(v.source === vacancy.source && v.publishDate === vacancy.publishDate && v.floor === vacancy.floor);
        
        if (state.selectedBuilding) {
            if (state.selectedBuilding.vacancies) {
                state.selectedBuilding.vacancies = state.selectedBuilding.vacancies.filter(filterFn);
                state.selectedBuilding.vacancyCount = state.selectedBuilding.vacancies.length;
            }
            if (state.selectedBuilding.documents) {
                state.selectedBuilding.documents = state.selectedBuilding.documents.filter(filterFn);
            }
        }
        
        // allBuildings도 업데이트
        const building = state.allBuildings?.find(b => b.id === buildingId);
        if (building && building !== state.selectedBuilding) {
            if (building.vacancies) {
                building.vacancies = building.vacancies.filter(filterFn);
                building.vacancyCount = building.vacancies.length;
            }
        }
        
        showToast('공실 정보가 삭제되었습니다', 'success');
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 선택된 공실 일괄 삭제
 */
export async function deleteSelectedVacancies() {
    const selectedIds = state.selectedVacancyIds;
    if (!selectedIds || selectedIds.size === 0) {
        showToast('삭제할 공실을 선택하세요', 'error');
        return;
    }
    
    if (!confirm(`선택된 ${selectedIds.size}개 공실을 삭제하시겠습니까?`)) return;
    
    const buildingId = state.selectedBuilding?.id;
    if (!buildingId) return;
    
    const vacancies = state.currentDisplayedVacancies || [];
    const toDelete = vacancies.filter(v => selectedIds.has(v._vacancyId) && v._key);
    
    try {
        // Firebase에서 삭제
        for (const vacancy of toDelete) {
            await remove(ref(db, `vacancies/${buildingId}/${vacancy._key}`));
        }
        
        // ★ 로컬 상태 업데이트 - selectedBuilding 직접 업데이트
        const keysToDelete = new Set(toDelete.map(v => v._key));
        const filterFn = v => !keysToDelete.has(v._key);
        
        if (state.selectedBuilding) {
            if (state.selectedBuilding.vacancies) {
                state.selectedBuilding.vacancies = state.selectedBuilding.vacancies.filter(filterFn);
                state.selectedBuilding.vacancyCount = state.selectedBuilding.vacancies.length;
            }
            if (state.selectedBuilding.documents) {
                state.selectedBuilding.documents = state.selectedBuilding.documents.filter(filterFn);
            }
        }
        
        // allBuildings도 업데이트
        const building = state.allBuildings?.find(b => b.id === buildingId);
        if (building && building !== state.selectedBuilding) {
            if (building.vacancies) {
                building.vacancies = building.vacancies.filter(filterFn);
                building.vacancyCount = building.vacancies.length;
            }
        }
        
        // 선택 상태 초기화
        state.selectedVacancyIds.clear();
        
        showToast(`${toDelete.length}개 공실이 삭제되었습니다`, 'success');
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 일괄 삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 공실 이관 모달 열기 (개별)
 */
export function openTransferVacancyModalByIdx(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) return;
    
    state.transferVacancyIndices = [idx];
    openTransferModal([vacancy]);
}

/**
 * 선택된 공실 이관
 */
export function transferSelectedVacancies() {
    const selectedIds = state.selectedVacancyIds;
    if (!selectedIds || selectedIds.size === 0) {
        showToast('이관할 공실을 선택하세요', 'error');
        return;
    }
    
    const vacancies = state.currentDisplayedVacancies || [];
    const toTransfer = vacancies.filter(v => selectedIds.has(v._vacancyId));
    
    if (toTransfer.length === 0) return;
    
    state.transferVacancyIndices = toTransfer.map((_, i) => 
        vacancies.findIndex(v => v._vacancyId === toTransfer[i]._vacancyId)
    );
    
    openTransferModal(toTransfer);
}

/**
 * 이관 모달 열기
 */
function openTransferModal(vacanciesToTransfer) {
    state.transferTargetBuilding = null;
    
    const modalHtml = `
        <div class="modal-overlay show" id="transferModalOverlay" onclick="if(event.target===this)closeTransferModal()"></div>
        <div class="modal show" id="transferModal" style="max-width: 500px; z-index: 10001;">
            <div class="modal-header" style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white;">
                <h3 class="modal-title">↗️ 공실 이관</h3>
                <button class="close-btn" onclick="closeTransferModal()" style="color: white;">×</button>
            </div>
            <div style="padding: 20px;">
                <div style="padding: 12px; background: #fef3c7; border-radius: 8px; margin-bottom: 16px;">
                    <div style="font-size: 12px; font-weight: 600; color: #92400e; margin-bottom: 8px;">📋 이관할 공실 (${vacanciesToTransfer.length}건)</div>
                    <div style="font-size: 12px; color: #78350f;">
                        ${vacanciesToTransfer.map(v => `• ${v.floor || '-'} (${v.rentArea ? v.rentArea + '평' : '-'})`).join('<br>')}
                    </div>
                    <div style="font-size: 11px; color: #92400e; margin-top: 8px;">
                        <strong>현재 빌딩:</strong> ${state.selectedBuilding?.name || '-'}
                    </div>
                </div>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 6px;">🔍 대상 빌딩 검색</label>
                    <input type="text" id="transferBuildingSearch" 
                           placeholder="빌딩명 또는 주소로 검색 (2글자 이상)"
                           oninput="searchTransferBuilding()"
                           style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 14px; box-sizing: border-box;">
                </div>
                
                <div id="transferBuildingResults" style="max-height: 200px; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 6px;">
                    <div style="padding: 20px; text-align: center; color: #666; font-size: 13px;">
                        빌딩명 또는 주소로 검색하세요
                    </div>
                </div>
                
                <div id="selectedTransferBuilding" style="display: none; margin-top: 12px; padding: 12px; background: #dbeafe; border-radius: 8px;">
                    <div style="font-size: 12px; color: #1e40af;">
                        <strong>선택된 빌딩:</strong> <span id="selectedBuildingName"></span>
                    </div>
                </div>
            </div>
            <div class="form-actions" style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" class="btn btn-secondary" onclick="closeTransferModal()">취소</button>
                <button type="button" class="btn btn-primary" id="executeTransferBtn" onclick="executeVacancyTransfer()" disabled 
                        style="background: #d97706;">이관 실행</button>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * 이관 대상 빌딩 검색
 */
export function searchTransferBuilding() {
    const query = (document.getElementById('transferBuildingSearch')?.value || '').trim().toLowerCase();
    const resultsDiv = document.getElementById('transferBuildingResults');
    
    if (query.length < 2) {
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-size: 13px;">2글자 이상 입력하세요</div>`;
        return;
    }
    
    const currentBuildingId = state.selectedBuilding?.id;
    const results = state.allBuildings.filter(b => 
        b.id !== currentBuildingId &&
        !b.isHidden &&
        (b.name?.toLowerCase().includes(query) || b.address?.toLowerCase().includes(query))
    ).slice(0, 10);
    
    if (results.length === 0) {
        resultsDiv.innerHTML = `<div style="padding: 20px; text-align: center; color: #666; font-size: 13px;">검색 결과가 없습니다</div>`;
        return;
    }
    
    resultsDiv.innerHTML = results.map(b => `
        <div class="transfer-building-item" 
             onclick="selectTransferBuilding('${b.id}')"
             data-building-id="${b.id}"
             style="padding: 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer; transition: background 0.2s;"
             onmouseenter="this.style.background='#f1f5f9'"
             onmouseleave="this.style.background='${state.transferTargetBuilding?.id === b.id ? '#dbeafe' : ''}'">
            <div style="font-weight: 500; color: var(--text-primary);">${b.name}</div>
            <div style="font-size: 12px; color: #666; margin-top: 4px;">${b.address || '-'}</div>
            <div style="font-size: 11px; color: #999; margin-top: 2px;">현재 공실 ${b.vacancyCount || 0}건</div>
        </div>
    `).join('');
}

/**
 * 이관 대상 빌딩 선택
 */
export function selectTransferBuilding(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    state.transferTargetBuilding = building;
    
    // UI 업데이트
    document.querySelectorAll('.transfer-building-item').forEach(el => {
        el.style.background = el.dataset.buildingId === buildingId ? '#dbeafe' : '';
    });
    
    const selectedDiv = document.getElementById('selectedTransferBuilding');
    const nameSpan = document.getElementById('selectedBuildingName');
    const executeBtn = document.getElementById('executeTransferBtn');
    
    if (selectedDiv) selectedDiv.style.display = 'block';
    if (nameSpan) nameSpan.textContent = building.name;
    if (executeBtn) executeBtn.disabled = false;
}

/**
 * 공실 이관 실행 (기준가 포함)
 */
export async function executeVacancyTransfer() {
    const targetBuilding = state.transferTargetBuilding;
    if (!targetBuilding) {
        showToast('이관할 빌딩을 선택하세요', 'error');
        return;
    }
    
    const sourceBuildingId = state.selectedBuilding?.id;
    const targetBuildingId = targetBuilding.id;
    
    if (!sourceBuildingId || sourceBuildingId === targetBuildingId) return;
    
    const vacancies = state.currentDisplayedVacancies || [];
    const indices = state.transferVacancyIndices || [];
    const toTransfer = indices.map(i => vacancies[i]).filter(Boolean);
    
    if (toTransfer.length === 0) return;
    
    // ★ v3.14: 이관할 공실들의 source + publishDate 조합 수집 (월 기준 정규화)
    const sourceKeys = new Set();
    toTransfer.forEach(v => {
        if (v.source && v.publishDate) {
            // publishDate를 YYYY-MM 형식으로 정규화 (예: "25.01" → "2025-01")
            let normalizedMonth = v.publishDate;
            if (/^\d{2}\.\d{2}$/.test(v.publishDate)) {
                // "25.01" → "2025-01"
                const [yy, mm] = v.publishDate.split('.');
                normalizedMonth = `20${yy}-${mm}`;
            } else if (/^\d{4}-\d{2}/.test(v.publishDate)) {
                // "2025-01-01" → "2025-01"
                normalizedMonth = v.publishDate.slice(0, 7);
            }
            sourceKeys.add(`${v.source}|${normalizedMonth}`);
        }
    });
    
    // ★ v3.14: 원본 빌딩의 기준가에서 해당하는 것 필터링 (sourceCompany + effectiveDate 월 기준)
    const sourceBuilding = state.selectedBuilding;
    const sourcePricings = sourceBuilding?.floorPricing || [];
    const pricingsToTransfer = sourcePricings.filter(fp => {
        // sourceCompany 또는 source 필드 확인
        const fpSource = fp.sourceCompany || fp.source || '';
        // effectiveDate에서 월 추출 (예: "2025-01-01" → "2025-01")
        let fpMonth = '';
        if (fp.effectiveDate) {
            fpMonth = fp.effectiveDate.slice(0, 7);  // "2025-01-01" → "2025-01"
        } else if (fp.publishDate) {
            // publishDate가 "25.01" 형식일 경우
            if (/^\d{2}\.\d{2}$/.test(fp.publishDate)) {
                const [yy, mm] = fp.publishDate.split('.');
                fpMonth = `20${yy}-${mm}`;
            } else {
                fpMonth = fp.publishDate.slice(0, 7);
            }
        }
        const fpKey = `${fpSource}|${fpMonth}`;
        return sourceKeys.has(fpKey);
    });
    
    console.log('📋 이관 정보:', {
        공실수: toTransfer.length,
        공실sourceKeys: Array.from(sourceKeys),
        원본빌딩기준가수: sourcePricings.length,
        원본빌딩기준가: sourcePricings.map(fp => ({
            sourceCompany: fp.sourceCompany || fp.source,
            effectiveDate: fp.effectiveDate,
            label: fp.label
        })),
        매칭된기준가수: pricingsToTransfer.length,
        매칭된기준가: pricingsToTransfer.map(fp => ({
            sourceCompany: fp.sourceCompany || fp.source,
            effectiveDate: fp.effectiveDate,
            label: fp.label
        }))
    });
    
    const confirmMsg = pricingsToTransfer.length > 0
        ? `${toTransfer.length}개 공실 + ${pricingsToTransfer.length}개 기준가를\n"${targetBuilding.name}"으로 이관하시겠습니까?`
        : `${toTransfer.length}개 공실을 "${targetBuilding.name}"으로 이관하시겠습니까?`;
    
    if (!confirm(confirmMsg)) return;
    
    try {
        const { push, set, get } = await import('./portal-firebase.js');
        
        // 1. 공실 이관
        for (const vacancy of toTransfer) {
            const oldKey = vacancy._key;
            if (!oldKey) continue;
            
            // 새 빌딩에 추가
            const newVacancyRef = push(ref(db, `vacancies/${targetBuildingId}`));
            const newVacancyData = {
                ...vacancy,
                _key: undefined,
                _vacancyId: undefined,
                transferredFrom: sourceBuildingId,
                transferredAt: new Date().toISOString()
            };
            delete newVacancyData._key;
            delete newVacancyData._vacancyId;
            
            await set(newVacancyRef, newVacancyData);
            
            // 기존 빌딩에서 삭제
            await remove(ref(db, `vacancies/${sourceBuildingId}/${oldKey}`));
        }
        
        // 2. 기준가 이관 (해당하는 것이 있을 경우)
        if (pricingsToTransfer.length > 0) {
            // 대상 빌딩의 현재 기준가 가져오기
            const targetBuildingSnap = await get(ref(db, `buildings/${targetBuildingId}`));
            const targetBuildingData = targetBuildingSnap.val() || {};
            const existingPricings = targetBuildingData.floorPricing || [];
            
            // ★ v3.14: 중복 체크용 키 생성 (sourceCompany 사용)
            const existingKeys = new Set(existingPricings.map(fp => 
                `${fp.sourceCompany || fp.source || ''}|${fp.effectiveDate || ''}|${fp.label || ''}`
            ));
            
            // 새 기준가 추가 (중복 제외)
            const newPricings = [];
            pricingsToTransfer.forEach(fp => {
                const fpKey = `${fp.sourceCompany || fp.source || ''}|${fp.effectiveDate || ''}|${fp.label || ''}`;
                if (!existingKeys.has(fpKey)) {
                    newPricings.push({
                        ...fp,
                        id: `fp_transfer_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                        transferredFrom: sourceBuildingId,
                        transferredAt: new Date().toISOString()
                    });
                    existingKeys.add(fpKey);
                }
            });
            
            if (newPricings.length > 0) {
                const updatedPricings = [...existingPricings, ...newPricings];
                await set(ref(db, `buildings/${targetBuildingId}/floorPricing`), updatedPricings);
                console.log(`✅ 기준가 ${newPricings.length}개 이관 완료`);
            }
        }
        
        // 로컬 상태 업데이트 - 원본 빌딩
        const sourceBuildingLocal = state.allBuildings.find(b => b.id === sourceBuildingId);
        if (sourceBuildingLocal && sourceBuildingLocal.vacancies) {
            const keysToRemove = new Set(toTransfer.map(v => v._key));
            sourceBuildingLocal.vacancies = sourceBuildingLocal.vacancies.filter(v => !keysToRemove.has(v._key));
            sourceBuildingLocal.vacancyCount = sourceBuildingLocal.vacancies.length;
        }
        
        // ★ v3.12: 로컬 상태 업데이트 - 대상 빌딩 (이관 후 바로 열었을 때 보이도록)
        const targetBuildingLocal = state.allBuildings.find(b => b.id === targetBuildingId);
        if (targetBuildingLocal) {
            // 공실 추가
            if (!targetBuildingLocal.vacancies) targetBuildingLocal.vacancies = [];
            toTransfer.forEach(v => {
                const newVacancy = {
                    ...v,
                    transferredFrom: sourceBuildingId,
                    transferredAt: new Date().toISOString()
                };
                delete newVacancy._key;
                delete newVacancy._vacancyId;
                targetBuildingLocal.vacancies.push(newVacancy);
            });
            targetBuildingLocal.vacancyCount = targetBuildingLocal.vacancies.length;
            
            // ★ v3.14: 기준가도 로컬에 추가
            if (pricingsToTransfer.length > 0) {
                if (!targetBuildingLocal.floorPricing) targetBuildingLocal.floorPricing = [];
                pricingsToTransfer.forEach(fp => {
                    // 중복 체크
                    const fpKey = `${fp.sourceCompany || fp.source || ''}|${fp.effectiveDate || ''}|${fp.label || ''}`;
                    const exists = targetBuildingLocal.floorPricing.some(efp => 
                        `${efp.sourceCompany || efp.source || ''}|${efp.effectiveDate || ''}|${efp.label || ''}` === fpKey
                    );
                    if (!exists) {
                        targetBuildingLocal.floorPricing.push({
                            ...fp,
                            id: `fp_transfer_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                            transferredFrom: sourceBuildingId,
                            transferredAt: new Date().toISOString()
                        });
                    }
                });
            }
            
            // 문서 정보도 추가 (source/publishDate 기준)
            if (!targetBuildingLocal.documents) targetBuildingLocal.documents = [];
            const sourceKeysArray = Array.from(sourceKeys);
            sourceKeysArray.forEach(sk => {
                const [source, publishDate] = sk.split('|');
                const docExists = targetBuildingLocal.documents.some(d => 
                    d.source === source && d.publishDate === publishDate
                );
                if (!docExists) {
                    targetBuildingLocal.documents.push({
                        source,
                        publishDate,
                        transferredFrom: sourceBuildingId,
                        transferredAt: new Date().toISOString()
                    });
                }
            });
        }
        
        // 선택 상태 초기화
        if (state.selectedVacancyIds) {
            state.selectedVacancyIds.clear();
        }
        
        const successMsg = pricingsToTransfer.length > 0
            ? `${toTransfer.length}개 공실 + ${pricingsToTransfer.length}개 기준가 이관 완료`
            : `${toTransfer.length}개 공실이 "${targetBuilding.name}"으로 이관되었습니다`;
        
        showToast(successMsg, 'success');
        closeTransferModal();
        renderDocumentSection();
        
    } catch (error) {
        console.error('공실 이관 오류:', error);
        showToast('이관 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 이관 모달 닫기
 */
export function closeTransferModal() {
    const modal = document.getElementById('transferModal');
    const overlay = document.getElementById('transferModalOverlay');
    if (modal) modal.remove();
    if (overlay) overlay.remove();
    state.transferTargetBuilding = null;
    state.transferVacancyIndices = null;
}

// ===== ★ v2.1: 기준가 통합 기능 =====

/**
 * 기본 임대조건을 층별 기준가(floorPricing)로 이관
 */
export async function migrateBasePricingToFloorPricing() {
    const b = state.selectedBuilding;
    if (!b) {
        showToast('빌딩을 선택해주세요', 'error');
        return;
    }
    
    // 기본 임대조건 확인
    if (!b.depositPy && !b.rentPy && !b.maintenancePy) {
        showToast('이관할 기본 임대조건이 없습니다', 'warning');
        return;
    }
    
    // 이미 floorPricing에 데이터가 있는지 확인
    if (b.floorPricing && b.floorPricing.length > 0) {
        if (!confirm('이미 등록된 기준가가 있습니다. 기본 임대조건을 추가로 등록하시겠습니까?')) {
            return;
        }
    }
    
    const newPricing = {
        id: 'fp_' + Date.now(),
        label: '기준층',
        floorRange: '전체',
        floorStart: '1',
        floorEnd: 'RF',
        depositPy: parseFloat(b.depositPy) || null,
        rentPy: parseFloat(b.rentPy) || null,
        maintenancePy: parseFloat(b.maintenancePy) || null,
        rentArea: b.rentableArea || b.grossArea || null,
        exclusiveArea: b.exclusiveArea || null,
        effectiveDate: new Date().toISOString().split('T')[0],
        notes: '기본 임대조건에서 이관',
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.email || 'unknown',
        migratedFromBase: true
    };
    
    try {
        let floorPricing = b.floorPricing || [];
        floorPricing.push(newPricing);
        
        await update(ref(db, `buildings/${b.id}`), { floorPricing });
        state.selectedBuilding.floorPricing = floorPricing;
        
        renderPricingSection();
        renderInfoSection();
        showToast('기본 임대조건이 기준가로 등록되었습니다', 'success');
    } catch (error) {
        console.error('기준가 이관 오류:', error);
        showToast('이관 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 공실 정보에서 기준가 등록 모달 열기
 */
export function openPricingFromVacancyModal(idx) {
    const vacancies = state.currentDisplayedVacancies || [];
    const vacancy = vacancies[idx];
    if (!vacancy) {
        showToast('공실 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    const modalHtml = `
        <div class="modal-overlay show" id="pricingFromVacancyOverlay" onclick="if(event.target===this)closePricingFromVacancyModal()"></div>
        <div class="modal show" id="pricingFromVacancyModal" style="max-width: 480px; z-index: 10001;">
            <div class="modal-header" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white;">
                <h3 class="modal-title">💰 기준가로 등록</h3>
                <button class="close-btn" onclick="closePricingFromVacancyModal()" style="color: white;">×</button>
            </div>
            <div style="padding: 20px;">
                <div style="background: #f0fdf4; border: 1px solid #86efac; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
                    <div style="font-size: 12px; color: #166534; margin-bottom: 8px;">
                        <strong>${vacancy.floor || '-'}층</strong> 공실 정보를 기준가로 등록합니다
                    </div>
                    <div style="font-size: 11px; color: #15803d;">
                        출처: ${vacancy.source || '-'} (${vacancy.publishDate || '-'})
                    </div>
                </div>
                
                <div class="form-row" style="margin-bottom: 12px;">
                    <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">구분명 <span style="color:#dc2626">*</span></label>
                    <input type="text" id="pfvLabel" value="${vacancy.floor ? vacancy.floor + '층' : '기준층'}" 
                           style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">층 범위 시작</label>
                        <input type="text" id="pfvFloorStart" value="${vacancy.floor || '1'}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 12px; color: #666; margin-bottom: 4px;">층 범위 종료</label>
                        <input type="text" id="pfvFloorEnd" value="${vacancy.floor || 'RF'}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">보증금/평</label>
                        <input type="number" step="0.1" id="pfvDeposit" value="${vacancy.depositPy || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">임대료/평 <span style="color:#dc2626">*</span></label>
                        <input type="number" step="0.1" id="pfvRent" value="${vacancy.rentPy || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box; background: #fef3c7;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">관리비/평</label>
                        <input type="number" step="0.1" id="pfvMaintenance" value="${vacancy.maintenancePy || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">임대면적 (평)</label>
                        <input type="number" step="0.01" id="pfvRentArea" value="${vacancy.rentArea || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                    <div>
                        <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">전용면적 (평)</label>
                        <input type="number" step="0.01" id="pfvExclusiveArea" value="${vacancy.exclusiveArea || ''}" 
                               style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                    </div>
                </div>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; font-size: 11px; color: #666; margin-bottom: 4px;">비고</label>
                    <input type="text" id="pfvNotes" value="공실 정보에서 추출 (${vacancy.source || '-'})" 
                           style="width: 100%; padding: 10px; border: 1px solid var(--border-color); border-radius: 6px; box-sizing: border-box;">
                </div>
            </div>
            <div class="form-actions" style="padding: 16px 20px; border-top: 1px solid var(--border-color); display: flex; justify-content: flex-end; gap: 8px;">
                <button type="button" class="btn btn-secondary" onclick="closePricingFromVacancyModal()">취소</button>
                <button type="button" class="btn btn-primary" onclick="savePricingFromVacancy()" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">기준가 등록</button>
            </div>
        </div>
    `;
    
    state.pricingFromVacancyIdx = idx;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

/**
 * 공실에서 기준가 저장
 */
export async function savePricingFromVacancy() {
    const b = state.selectedBuilding;
    if (!b) {
        showToast('빌딩 정보를 찾을 수 없습니다', 'error');
        return;
    }
    
    const label = document.getElementById('pfvLabel')?.value?.trim();
    const rentPy = parseFloat(document.getElementById('pfvRent')?.value);
    
    if (!label) {
        showToast('구분명을 입력해주세요', 'warning');
        return;
    }
    
    if (!rentPy || isNaN(rentPy)) {
        showToast('임대료를 입력해주세요', 'warning');
        return;
    }
    
    const floorStart = document.getElementById('pfvFloorStart')?.value?.trim() || '';
    const floorEnd = document.getElementById('pfvFloorEnd')?.value?.trim() || '';
    
    const newPricing = {
        id: 'fp_' + Date.now(),
        label: label,
        floorRange: floorStart && floorEnd ? `${floorStart}-${floorEnd}` : (floorStart || floorEnd || '전체'),
        floorStart: floorStart,
        floorEnd: floorEnd,
        depositPy: parseFloat(document.getElementById('pfvDeposit')?.value) || null,
        rentPy: rentPy,
        maintenancePy: parseFloat(document.getElementById('pfvMaintenance')?.value) || null,
        rentArea: parseFloat(document.getElementById('pfvRentArea')?.value) || null,
        exclusiveArea: parseFloat(document.getElementById('pfvExclusiveArea')?.value) || null,
        notes: document.getElementById('pfvNotes')?.value?.trim() || null,
        effectiveDate: new Date().toISOString().split('T')[0],
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.email || 'unknown',
        sourceType: 'vacancy'
    };
    
    try {
        let floorPricing = b.floorPricing || [];
        floorPricing.push(newPricing);
        
        await update(ref(db, `buildings/${b.id}`), { floorPricing });
        state.selectedBuilding.floorPricing = floorPricing;
        
        closePricingFromVacancyModal();
        renderPricingSection();
        renderInfoSection();
        showToast('기준가가 등록되었습니다', 'success');
    } catch (error) {
        console.error('기준가 등록 오류:', error);
        showToast('등록 중 오류가 발생했습니다', 'error');
    }
}

/**
 * 공실→기준가 모달 닫기
 */
export function closePricingFromVacancyModal() {
    const modal = document.getElementById('pricingFromVacancyModal');
    const overlay = document.getElementById('pricingFromVacancyOverlay');
    if (modal) modal.remove();
    if (overlay) overlay.remove();
    state.pricingFromVacancyIdx = null;
}

// ===== PDF 페이지 이미지 수동 등록 =====

// PDF 관련 상태
let pdfState = {
    buildingId: null,
    source: null,
    period: null,
    targetPageNum: null,
    pdfDoc: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.5
};

/**
 * PDF 업로드 모달 열기
 */
export function openPdfUploadModal(buildingId, source, period, pageNum) {
    pdfState.buildingId = buildingId;
    pdfState.source = source;
    pdfState.period = period;
    pdfState.targetPageNum = pageNum;
    pdfState.pdfDoc = null;
    pdfState.currentPage = pageNum || 1;
    
    // UI 업데이트
    const building = state.selectedBuilding;
    document.getElementById('pdfUploadBuildingName').textContent = building?.name || '빌딩명';
    document.getElementById('pdfUploadSource').textContent = source || '-';
    document.getElementById('pdfUploadPeriod').textContent = period || '-';
    document.getElementById('pdfUploadPageNum').textContent = pageNum || '-';
    document.getElementById('pdfUploadInfo').style.display = 'block';
    
    // 초기화
    document.getElementById('pdfFileInput').value = '';
    document.getElementById('pdfPageSelector').style.display = 'none';
    document.getElementById('pdfLoadingState').style.display = 'none';
    document.getElementById('pdfUploadProgress').style.display = 'none';
    document.getElementById('pdfUploadBtn').disabled = true;
    
    // 모달 표시
    const modal = document.getElementById('pdfUploadModal');
    const overlay = document.getElementById('modalOverlay');
    if (modal) modal.style.display = 'block';
    if (overlay) overlay.classList.add('show');
}

/**
 * PDF 업로드 모달 닫기
 */
export function closePdfUploadModal() {
    const modal = document.getElementById('pdfUploadModal');
    const overlay = document.getElementById('modalOverlay');
    if (modal) modal.style.display = 'none';
    if (overlay) overlay.classList.remove('show');
    
    // 상태 초기화
    pdfState.pdfDoc = null;
}

/**
 * PDF 파일 선택 핸들러
 */
export async function handlePdfFileSelect(event) {
    const file = event.target.files[0];
    if (!file || file.type !== 'application/pdf') {
        showToast('PDF 파일을 선택해주세요', 'error');
        return;
    }
    
    // 로딩 상태 표시
    document.getElementById('pdfLoadingState').style.display = 'block';
    document.getElementById('pdfPageSelector').style.display = 'none';
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        
        // PDF.js 로드
        if (typeof pdfjsLib === 'undefined') {
            throw new Error('PDF.js 라이브러리를 로드할 수 없습니다');
        }
        
        // PDF 문서 로드
        const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
        pdfState.pdfDoc = await loadingTask.promise;
        pdfState.totalPages = pdfState.pdfDoc.numPages;
        
        // 대상 페이지가 전체 페이지 수보다 크면 1로 설정
        if (pdfState.currentPage > pdfState.totalPages) {
            pdfState.currentPage = 1;
        }
        
        // UI 업데이트
        document.getElementById('pdfTotalPages').textContent = pdfState.totalPages;
        document.getElementById('pdfPageInput').max = pdfState.totalPages;
        document.getElementById('pdfPageInput').value = pdfState.currentPage;
        
        // 페이지 렌더링
        await renderPdfPage(pdfState.currentPage);
        
        // 로딩 숨기고 선택 영역 표시
        document.getElementById('pdfLoadingState').style.display = 'none';
        document.getElementById('pdfPageSelector').style.display = 'block';
        const uploadBtn = document.getElementById('pdfUploadBtn');
        uploadBtn.disabled = false;
        uploadBtn.style.opacity = '1';
        
    } catch (error) {
        console.error('PDF 로드 오류:', error);
        document.getElementById('pdfLoadingState').style.display = 'none';
        showToast('PDF 파일을 불러올 수 없습니다: ' + error.message, 'error');
    }
}

/**
 * PDF 페이지 렌더링
 */
async function renderPdfPage(pageNum) {
    if (!pdfState.pdfDoc) return;
    
    try {
        const page = await pdfState.pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: pdfState.scale });
        
        const canvas = document.getElementById('pdfPreviewCanvas');
        const context = canvas.getContext('2d');
        
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
        
        // 현재 페이지 업데이트
        pdfState.currentPage = pageNum;
        document.getElementById('pdfCurrentPage').textContent = pageNum;
        document.getElementById('pdfPageInput').value = pageNum;
        
    } catch (error) {
        console.error('페이지 렌더링 오류:', error);
        showToast('페이지를 렌더링할 수 없습니다', 'error');
    }
}

/**
 * 이전 페이지
 */
export function pdfPrevPage() {
    if (pdfState.currentPage > 1) {
        renderPdfPage(pdfState.currentPage - 1);
    }
}

/**
 * 다음 페이지
 */
export function pdfNextPage() {
    if (pdfState.currentPage < pdfState.totalPages) {
        renderPdfPage(pdfState.currentPage + 1);
    }
}

/**
 * 특정 페이지로 이동
 */
export function goToPdfPage(pageNum) {
    const page = parseInt(pageNum);
    if (page >= 1 && page <= pdfState.totalPages) {
        renderPdfPage(page);
    }
}

/**
 * PDF 페이지를 이미지로 변환하여 Firebase Storage에 업로드
 */
export async function uploadPdfPageImage() {
    if (!pdfState.pdfDoc || !pdfState.buildingId) {
        showToast('PDF를 먼저 선택해주세요', 'error');
        return;
    }
    
    const uploadBtn = document.getElementById('pdfUploadBtn');
    uploadBtn.disabled = true;
    uploadBtn.textContent = '⏳ 업로드 중...';
    
    // 진행 상태 표시
    document.getElementById('pdfUploadProgress').style.display = 'block';
    const progressBar = document.getElementById('pdfUploadProgressBar');
    progressBar.style.width = '10%';
    
    try {
        // 고해상도 캔버스 생성 (업로드용)
        const page = await pdfState.pdfDoc.getPage(pdfState.currentPage);
        const scale = 2.0; // 고해상도
        const viewport = page.getViewport({ scale });
        
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        
        progressBar.style.width = '30%';
        
        await page.render({
            canvasContext: context,
            viewport: viewport
        }).promise;
        
        progressBar.style.width = '50%';
        
        // Canvas를 Blob으로 변환
        const blob = await new Promise(resolve => {
            canvas.toBlob(resolve, 'image/jpeg', 0.9);
        });
        
        progressBar.style.width = '70%';
        
        // Firebase Storage 경로 생성
        const source = pdfState.source || 'unknown';
        const period = pdfState.period || 'unknown';
        const pageNum = String(pdfState.targetPageNum || pdfState.currentPage).padStart(3, '0');
        const folderName = `${source.replace(/[\s\.]+/g, '_')}_${period.replace(/[\s\.]+/g, '_')}`.replace(/__+/g, '_');
        const storagePath = `leasing-docs/${folderName}/page_${pageNum}.jpg`;
        
        console.log('업로드 경로:', storagePath);
        
        // Firebase Storage에 업로드 (전역 함수 사용)
        if (typeof window.uploadImageToStorage !== 'function') {
            throw new Error('Firebase Storage 업로드 함수를 찾을 수 없습니다');
        }
        
        const downloadUrl = await window.uploadImageToStorage(blob, storagePath);
        
        progressBar.style.width = '100%';
        
        console.log('업로드 완료:', downloadUrl);
        
        // 문서 정보 업데이트 (pageImageUrl 저장)
        const building = state.allBuildings.find(b => b.id === pdfState.buildingId);
        if (building && building.documents) {
            const doc = building.documents.find(d => 
                d.source === pdfState.source && d.publishDate === pdfState.period
            );
            if (doc) {
                doc.pageImageUrl = downloadUrl;
                // Firebase에도 업데이트
                await update(ref(db, `buildings/${pdfState.buildingId}/documents`), building.documents);
            }
        }
        
        showToast('페이지 이미지가 업로드되었습니다', 'success');
        closePdfUploadModal();
        
        // 문서 섹션 새로고침
        renderDocumentSection();
        
    } catch (error) {
        console.error('업로드 오류:', error);
        showToast('업로드 중 오류가 발생했습니다: ' + error.message, 'error');
    } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '📤 이 페이지 업로드';
        document.getElementById('pdfUploadProgress').style.display = 'none';
    }
}

// ===== 빌딩 노트 CRUD =====

// 빌딩 노트 모달 열기
window.openBuildingNoteModal = function() {
    if (!state.selectedBuilding) return;
    
    const notes = state.selectedBuilding.notes || '';
    document.getElementById('buildingNoteText').value = notes;
    
    document.getElementById('buildingNoteModal').classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
};

// 빌딩 노트 저장
window.saveBuildingNote = async function(noteText) {
    if (!state.selectedBuilding) return;
    
    try {
        const updates = {
            notes: noteText,
            updatedAt: new Date().toISOString(),
            updatedBy: state.currentUser?.email
        };
        
        await update(ref(db, `buildings/${state.selectedBuilding.id}`), updates);
        
        // 로컬 상태 업데이트
        state.selectedBuilding.notes = noteText;
        
        // allBuildings에서도 업데이트
        const idx = state.allBuildings.findIndex(b => b.id === state.selectedBuilding.id);
        if (idx >= 0) {
            state.allBuildings[idx].notes = noteText;
        }
        
        document.getElementById('buildingNoteModal').classList.remove('show');
        document.getElementById('modalOverlay').classList.remove('show');
        
        // 화면 갱신
        renderInfoSection();
        showToast('빌딩 노트가 저장되었습니다', 'success');
    } catch (e) {
        console.error('빌딩 노트 저장 오류:', e);
        showToast('저장 실패', 'error');
    }
};

// 빌딩 노트 폼 제출 이벤트 (DOMContentLoaded에서 등록)
document.addEventListener('DOMContentLoaded', function() {
    const noteForm = document.getElementById('buildingNoteForm');
    if (noteForm) {
        noteForm.addEventListener('submit', function(e) {
            e.preventDefault();
            const noteText = document.getElementById('buildingNoteText').value.trim();
            window.saveBuildingNote(noteText);
        });
    }
});
