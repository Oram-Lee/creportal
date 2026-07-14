/**
 * CRE Portal - 상세 패널 모듈
 * 빌딩 상세 정보 패널 렌더링
 */

import { state } from './portal-state.js';
import { formatNumber, showToast } from './portal-utils.js';
import { panToBuilding } from './portal-map.js';
import { toggleStar } from './portal-ui.js';

// ===== 상세 패널 열기/닫기 =====

export function openDetail(id) {
    state.selectedBuilding = state.allBuildings.find(b => b.id === id);
    if (!state.selectedBuilding) return;
    
    // 필터 상태 초기화 (새 빌딩 열 때마다)
    state.selectedRentrollDate = null; // 최신 월로 자동 선택되도록
    state.selectedDocSource = 'all';
    state.selectedDocPeriod = 'all';
    
    // 공실 선택 상태 초기화
    state.selectedVacancyIds = new Set();
    state.currentDisplayedVacancies = [];
    
    const b = state.selectedBuilding;
    document.getElementById('detailTitle').textContent = b.name || '이름 없음';
    document.getElementById('detailSubtitle').textContent = b.address || '-';
    document.getElementById('rentrollCount').textContent = b.rentrollCount || 0;
    document.getElementById('memoCount').textContent = b.memoCount || 0;
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

// 삭제/복원 버튼 상태 업데이트
export function updateDeleteButtons() {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const deleteBtn = document.getElementById('buildingDeleteBtn');
    const restoreBtn = document.getElementById('buildingRestoreBtn');
    
    if (deleteBtn && restoreBtn) {
        const isHidden = b.isHidden || b._raw?.isHidden;
        deleteBtn.style.display = isHidden ? 'none' : 'inline-flex';
        restoreBtn.style.display = isHidden ? 'inline-flex' : 'none';
    }
}

// ===== 기본 정보 섹션 =====

export function renderInfoSection() {
    const b = state.selectedBuilding;
    const rentVal = parseFloat(String(b.rentPy || '').replace(/[^\d.]/g, '')) * 10000 || 0;
    const mgmtVal = parseFloat(String(b.maintenancePy || '').replace(/[^\d.]/g, '')) * 10000 || 0;
    const eff = (b.exclusiveRate || 55) / 100;
    const fnoc = eff > 0 ? (rentVal + mgmtVal) / eff : 0;
    
    // 복수 기준가 정보
    const floorPricing = b.floorPricing || [];
    const pricingCount = floorPricing.length;
    
    // 노트 정보
    const buildingNotes = b.notes || '';
    
    // 권역 정보 (자동 감지 여부 확인)
    const rawBuilding = b._raw || {};
    const hasStoredRegion = rawBuilding.region || rawBuilding.regionId;
    const currentRegion = b.region || 'ETC';
    const isAutoDetected = !hasStoredRegion && currentRegion;
    
    const regionLabels = { GBD: '강남권역', CBD: '도심권역', YBD: '여의도권역', BBD: '분당권역', ETC: '기타' };
    const regionColors = { GBD: '#16a34a', CBD: '#0284c7', YBD: '#7c3aed', BBD: '#ea580c', ETC: '#6b7280' };
    
    // 이미지 데이터
    const exteriorImages = b.exteriorImages || [];
    const floorPlanImages = b.floorPlanImages || [];
    const mainImageIndex = b.mainImageIndex || 0;
    const hasImages = exteriorImages.length > 0 || floorPlanImages.length > 0;
    
    // 메인 이미지 (외관 이미지 중 메인)
    const mainImage = exteriorImages[mainImageIndex] || exteriorImages[0] || null;
    
    // 이미지 갤러리 HTML
    const imageGalleryHtml = hasImages ? `
        <div class="image-gallery-section">
            <!-- 메인 이미지 -->
            ${mainImage ? `
            <div class="main-image-container" onclick="openImageViewer('exterior', ${mainImageIndex})">
                <img src="${mainImage.url}" alt="${b.name} 외관" class="main-image">
                <div class="main-image-overlay">
                    <span class="view-icon">🔍</span>
                    <span>클릭하여 크게 보기</span>
                </div>
                ${exteriorImages.length > 1 ? `<span class="image-count">${mainImageIndex + 1}/${exteriorImages.length}</span>` : ''}
            </div>
            ` : ''}
            
            <!-- 이미지 타입 탭 -->
            <div class="image-tabs">
                <button class="image-tab ${exteriorImages.length > 0 ? 'active' : ''}" onclick="switchImageTab('exterior')" ${exteriorImages.length === 0 ? 'disabled' : ''}>
                    🏢 외관 <span class="count">${exteriorImages.length}</span>
                </button>
                <button class="image-tab ${exteriorImages.length === 0 && floorPlanImages.length > 0 ? 'active' : ''}" onclick="switchImageTab('floorplan')" ${floorPlanImages.length === 0 ? 'disabled' : ''}>
                    📐 평면도 <span class="count">${floorPlanImages.length}</span>
                </button>
            </div>
            
            <!-- 외관 이미지 썸네일 -->
            <div class="image-thumbnails" id="exteriorThumbnails" style="${exteriorImages.length > 0 ? '' : 'display:none'}">
                ${exteriorImages.map((img, i) => `
                    <div class="image-thumb-item ${i === mainImageIndex ? 'main' : ''}" onclick="openImageViewer('exterior', ${i})">
                        <img src="${img.url}" alt="외관 ${i+1}">
                        ${i === mainImageIndex ? '<span class="main-badge">메인</span>' : ''}
                    </div>
                `).join('')}
            </div>
            
            <!-- 평면도 썸네일 -->
            <div class="image-thumbnails" id="floorplanThumbnails" style="${exteriorImages.length === 0 && floorPlanImages.length > 0 ? '' : 'display:none'}">
                ${floorPlanImages.map((img, i) => `
                    <div class="image-thumb-item" onclick="openImageViewer('floorplan', ${i})">
                        <img src="${img.url}" alt="평면도 ${i+1}">
                    </div>
                `).join('')}
            </div>
        </div>
    ` : `
        <div class="no-images-placeholder">
            <div class="icon">🖼️</div>
            <div class="text">등록된 이미지가 없습니다</div>
            <div class="hint">임대안내문 관리에서 이미지를 추가할 수 있습니다</div>
        </div>
    `;

    document.getElementById('sectionInfo').innerHTML = `
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
        
        <div class="info-grid">
            <div class="info-card"><div class="label">연면적</div><div class="value">${formatNumber(b.grossFloorPy)}<span class="unit">평</span></div></div>
            <div class="info-card"><div class="label">기준층</div><div class="value">${formatNumber(b.typicalFloorPy)}<span class="unit">평</span></div></div>
            <div class="info-card"><div class="label">기준층 임대</div><div class="value">${formatNumber(b.typicalFloorLeasePy) || '-'}<span class="unit">평</span></div></div>
            <div class="info-card"><div class="label">전용률</div><div class="value">${b.exclusiveRate || '-'}<span class="unit">%</span></div></div>
            <div class="info-card"><div class="label">준공년도</div><div class="value">${b.completionYear || '-'}</div></div>
            <div class="info-card"><div class="label">등급</div><div class="value">${b.grade || '-'}</div></div>
        </div>
        
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center;">
            <span>💰 임대조건</span>
            ${pricingCount > 0 ? `<span style="font-size: 11px; padding: 2px 8px; background: var(--accent-light); color: var(--accent-color); border-radius: 10px;">층별 ${pricingCount}개 기준가</span>` : ''}
        </div>
        
        ${pricingCount > 0 ? `
        <div style="background: var(--bg-secondary); border-radius: 8px; padding: 12px; margin-bottom: 12px;">
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">📊 층별 기준가가 등록되어 있습니다</div>
            <div style="display: flex; flex-wrap: wrap; gap: 6px;">
                ${floorPricing.slice(0, 3).map(fp => `
                    <span style="font-size: 12px; padding: 4px 10px; background: var(--bg-primary); border: 1px solid var(--border-color); border-radius: 4px;">
                        ${fp.label || fp.floorRange}: ${fp.rentPy ? fp.rentPy + '만' : '-'}
                    </span>
                `).join('')}
                ${pricingCount > 3 ? `<span style="font-size: 12px; padding: 4px 10px; color: var(--text-muted);">+${pricingCount - 3}개</span>` : ''}
            </div>
            <button onclick="document.querySelector('[data-section=pricing]').click()" style="margin-top: 8px; font-size: 12px; color: var(--accent-color); background: none; border: none; cursor: pointer; text-decoration: underline;">
                기준가 탭에서 상세 보기 →
            </button>
        </div>
        ` : ''}
        
        <div class="price-table">
            <div class="price-row"><span class="label">보증금</span><span class="value">${b.depositPy || '-'}/평</span></div>
            <div class="price-row"><span class="label">임대료</span><span class="value">${b.rentPy || '-'}/평</span></div>
            <div class="price-row"><span class="label">관리비</span><span class="value">${b.maintenancePy || '-'}/평</span></div>
        </div>
        <div class="noc-card">
            <div class="title">NOC (Net Occupancy Cost)</div>
            <div class="noc-row"><span>F-NOC (전용면적 기준)</span><span class="value">${formatNumber(fnoc)}원/평</span></div>
        </div>
        <div class="section-title">🏢 빌딩 상세</div>
        <div class="spec-list">
            <div class="spec-item"><span class="label">층수</span><span class="value">${b.floors || '-'}</span></div>
            <div class="spec-item"><span class="label">인근역</span><span class="value">${b.nearbyStation || '-'}</span></div>
            <div class="spec-item"><span class="label">주차</span><span class="value">${b.parkingTotal ? (b.parkingTotal + '대' + (b.parkingRatio ? ' (' + b.parkingRatio + ')' : '')) : (b.parking?.display || '-')}</span></div>
            <div class="spec-item"><span class="label">구조</span><span class="value">${b.structure || '-'}</span></div>
            <div class="spec-item"><span class="label">냉난방</span><span class="value">${b.hvac || '-'}</span></div>
            <div class="spec-item"><span class="label">엘리베이터</span><span class="value">${b.passengerElevator || b.freightElevator ? `승객${b.passengerElevator || 0}/화물${b.freightElevator || 0}대` : (b.elevator || '-')}</span></div>
            <div class="spec-item"><span class="label">PM</span><span class="value">${b.pm || '-'}</span></div>
            <div class="spec-item"><span class="label">소유자</span><span class="value">${b.owner || '-'}</span></div>
        </div>
        
        <!-- 빌딩 정보 편집 버튼 -->
        <div style="margin-top: 16px; text-align: center;">
            <button onclick="openBuildingEditModal()" style="padding: 10px 24px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 8px; color: var(--text-primary); cursor: pointer; font-size: 13px;">
                ✏️ 빌딩 정보 편집
            </button>
        </div>
    `;
}

// ===== 기준가 섹션 =====

export function renderPricingSection() {
    const b = state.selectedBuilding;
    const floorPricing = b.floorPricing || [];
    
    // 기준가 개수 업데이트
    document.getElementById('pricingCount').textContent = floorPricing.length;
    
    document.getElementById('sectionPricing').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <span>💰 층별 기준가</span>
            <button class="btn btn-primary btn-sm" onclick="openPricingModal()">+ 추가</button>
        </div>
        
        ${floorPricing.length === 0 ? `
        <div class="empty-state" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 48px; margin-bottom: 16px;">💰</div>
            <div style="color: var(--text-muted); margin-bottom: 16px;">등록된 기준가가 없습니다</div>
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 20px;">
                층별로 다른 임대조건을 관리할 수 있습니다<br>
                (저층부/고층부, 특정 층 프리미엄 등)
            </div>
            <button class="btn btn-primary" onclick="openPricingModal()">+ 첫 기준가 등록</button>
        </div>
        ` : `
        <div style="display: flex; flex-direction: column; gap: 12px;">
            ${floorPricing.map((fp, idx) => `
                <div class="pricing-card" style="background: var(--bg-secondary); border-radius: 10px; padding: 16px; border: 1px solid var(--border-color); position: relative;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px;">
                        <div>
                            <div style="font-size: 15px; font-weight: 600; color: var(--text-primary);">${fp.label || '기준가 ' + (idx + 1)}</div>
                            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">📍 ${fp.floorRange || '-'}</div>
                        </div>
                        <div class="row-actions" style="display: flex; gap: 4px;">
                            <button class="row-action-btn" onclick="editPricing('${fp.id}')" title="수정">✏️</button>
                            <button class="row-action-btn delete" onclick="deletePricing('${fp.id}')" title="삭제">×</button>
                        </div>
                    </div>
                    
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 12px;">
                        <div style="text-align: center; padding: 10px; background: var(--bg-primary); border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">보증금</div>
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${fp.depositPy ? fp.depositPy + '만' : '-'}</div>
                        </div>
                        <div style="text-align: center; padding: 10px; background: var(--bg-primary); border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">임대료</div>
                            <div style="font-size: 14px; font-weight: 600; color: var(--accent-color);">${fp.rentPy ? fp.rentPy + '만' : '-'}</div>
                        </div>
                        <div style="text-align: center; padding: 10px; background: var(--bg-primary); border-radius: 6px;">
                            <div style="font-size: 11px; color: var(--text-muted);">관리비</div>
                            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${fp.maintenancePy ? fp.maintenancePy + '만' : '-'}</div>
                        </div>
                    </div>
                    
                    ${(fp.rentArea || fp.exclusiveArea) ? `
                    <div style="display: flex; gap: 16px; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px;">
                        ${fp.rentArea ? `<span>임대면적: <strong>${formatNumber(fp.rentArea)}평</strong></span>` : ''}
                        ${fp.exclusiveArea ? `<span>전용면적: <strong>${formatNumber(fp.exclusiveArea)}평</strong></span>` : ''}
                    </div>
                    ` : ''}
                    
                    <div style="display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted);">
                        <span>${fp.effectiveDate ? '적용일: ' + fp.effectiveDate : ''}</span>
                        <span>${fp.notes || ''}</span>
                    </div>
                </div>
            `).join('')}
        </div>
        `}
    `;
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
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <span>👤 담당자 목록</span>
            <div style="display: flex; gap: 6px;">
                <button class="btn btn-sm" style="background: var(--bg-tertiary); color: var(--text-primary);" onclick="openAssignManagerModal()">📋 담당자 지정</button>
                <button class="btn btn-primary btn-sm" onclick="openContactModal()">+ 추가</button>
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

// 담당자 카드 렌더링 헬퍼
function renderContactCard(c, typeIcons, typeLabels, isOurManager) {
    const borderColor = c.isPrimary ? 'var(--accent-color)' : (isOurManager ? '#16a34a' : 'var(--border-color)');
    const bgColor = isOurManager ? 'linear-gradient(135deg, #f0fdf4 0%, #dcfce7 100%)' : 'var(--bg-secondary)';
    
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
                    <button class="row-action-btn" onclick="editContact('${c.id}')" title="수정">✏️</button>
                    <button class="row-action-btn delete" onclick="deleteContact('${c.id}')" title="삭제">×</button>
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
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span>렌트롤 목록</span>
            <button class="btn btn-primary btn-sm" onclick="openRentrollModal()">+ 추가</button>
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
                        <td><span class="floor-badge">${r.floor || '-'}F</span></td>
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

export function renderMemoSection() {
    const b = state.selectedBuilding;
    const list = (b.memos || []).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    
    document.getElementById('sectionMemo').innerHTML = `
        <div class="section-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
            <span>메모 목록</span>
            <button class="btn btn-primary btn-sm" onclick="openMemoModal()">+ 추가</button>
        </div>
        ${list.length === 0 ? '<div class="empty-state">메모가 없습니다</div>' : list.map(m => `
            <div class="memo-item ${m.pinned ? 'pinned' : ''}" style="position: relative;">
                <div class="memo-content">
                    ${m.pinned ? '📌 ' : ''}${m.showInLeasingGuide ? '📄 ' : ''}${m.content || ''}
                </div>
                <div class="memo-meta">
                    <span>${((m.author || m.createdBy || '-').split('@')[0])} · ${m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '-'}</span>
                    <div class="row-actions" style="opacity: 1;">
                        <button class="row-action-btn" onclick="editMemo('${m.id}')" title="수정">✏️</button>
                        <button class="row-action-btn delete" onclick="deleteMemo('${m.id}')" title="삭제">×</button>
                    </div>
                </div>
            </div>
        `).join('')}
    `;
}

// ===== 인센티브 섹션 =====

export function renderIncentiveSection() {
    const b = state.selectedBuilding;
    const list = b.incentives || [];
    
    if (list.length === 0) {
        document.getElementById('sectionIncentive').innerHTML = `
            <div class="section-title">인센티브 <button class="btn btn-primary btn-sm" onclick="openIncentiveModal()">+ 추가</button></div>
            <div class="empty-state">인센티브 정보가 없습니다</div>
        `;
        return;
    }
    
    const latest = list[list.length - 1];
    document.getElementById('sectionIncentive').innerHTML = `
        <div class="section-title">인센티브 <button class="btn btn-primary btn-sm" onclick="openIncentiveModal()">+ 추가</button></div>
        <div class="incentive-grid">
            <div class="incentive-card"><div class="type">Rent Free</div><div class="value">${latest.rf || latest.rentFree || 0}</div><div class="unit">개월</div></div>
            <div class="incentive-card"><div class="type">Fit-Out</div><div class="value">${formatNumber(latest.fo || latest.fitOut || 0)}</div><div class="unit">원/평</div></div>
            <div class="incentive-card"><div class="type">TI</div><div class="value">${formatNumber(latest.ti || 0)}</div><div class="unit">원/평</div></div>
        </div>
        ${latest.note ? `<div class="note-text" style="margin-top:12px;">${latest.note}</div>` : ''}
        <div class="meta-info" style="margin-top:8px;">${latest.author || '-'} · ${latest.createdAt ? new Date(latest.createdAt).toLocaleDateString() : latest.targetDate || '-'}</div>
    `;
}

// ===== 임대안내문(문서) 섹션 =====

export function renderDocumentSection() {
    const b = state.selectedBuilding;
    const docs = b.documents || [];
    const vacancies = b.vacancies || [];
    
    if (docs.length === 0) {
        const now = new Date();
        document.getElementById('sectionDocument').innerHTML = `
            <div class="section-title">📄 임대안내문</div>
            <div style="padding: 20px 0;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                    <div style="font-size: 13px; color: var(--text-muted);">
                        등록된 임대안내문이 없습니다
                    </div>
                    <button onclick="addBuildingOnlyToCompList()" 
                            style="padding: 6px 14px; background: var(--bg-tertiary, #f3f4f6); color: var(--text-primary, #333); border: none; border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                        <span>📋</span> 빌딩 정보만 담기
                    </button>
                </div>
                
                <div id="inlineVacancyForm" style="padding: 16px; background: #f0f9ff; border: 2px dashed var(--accent-color, #2563eb); border-radius: 8px;">
                    <div style="font-size: 13px; font-weight: 600; color: var(--accent-color, #2563eb); margin-bottom: 12px;">➕ 공실 정보 직접 입력</div>
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
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="font-size: 11px; color: #888;">
                            📅 ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')} · 사용자 직접입력
                        </div>
                        <button onclick="saveInlineVacancy()" style="padding: 8px 16px; border: none; border-radius: 4px; background: var(--accent-color, #2563eb); color: white; cursor: pointer; font-size: 12px; font-weight: 500;">Comp List에 추가</button>
                    </div>
                </div>
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
    
    // 공실 데이터에 고유 ID 부여 (체크박스 선택용)
    const vacanciesWithId = docVacancies.map((v, idx) => ({
        ...v,
        _vacancyId: `vacancy_${state.selectedBuilding?.id || 'unknown'}_${idx}_${Date.now()}`
    }));
    
    // 전역 상태에 현재 표시 중인 공실 저장 (선택 시 사용)
    state.currentDisplayedVacancies = vacanciesWithId;
    
    // 인라인 입력 폼 HTML
    const inlineInputFormHtml = `
        <div id="inlineVacancyForm" style="display: none; margin-top: 12px; padding: 16px; background: #f0f9ff; border: 2px dashed var(--accent-color); border-radius: 8px;">
            <div style="font-size: 13px; font-weight: 600; color: var(--accent-color); margin-bottom: 12px;">➕ 공실 정보 직접 입력</div>
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
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div style="font-size: 11px; color: #888;">
                    📅 ${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')} · 사용자 직접입력
                </div>
                <div style="display: flex; gap: 8px;">
                    <button onclick="hideInlineVacancyForm()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; font-size: 12px;">취소</button>
                    <button onclick="saveInlineVacancy()" style="padding: 8px 16px; border: none; border-radius: 4px; background: var(--accent-color); color: white; cursor: pointer; font-size: 12px; font-weight: 500;">Comp List에 추가</button>
                </div>
            </div>
        </div>
    `;
    
    // 공실 테이블 HTML
    let vacancyTableHtml = '';
    if (vacanciesWithId.length > 0) {
        const selectedCount = state.selectedVacancyIds?.size || 0;
        vacancyTableHtml = `
            <div class="doc-vacancy-table" style="margin-top: 16px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <div style="font-size: 13px; font-weight: 600; color: var(--text-primary);">
                        📋 추출된 공실 정보 <span style="color: var(--accent-color);">${vacanciesWithId.length}건</span>
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button onclick="showInlineVacancyForm()" 
                                style="padding: 6px 12px; background: white; color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer; font-size: 12px; display: flex; align-items: center; gap: 4px;">
                            <span>➕</span> 공실 추가
                        </button>
                        <button onclick="addSelectedVacanciesToCompList()" 
                                id="addVacanciesToCompListBtn"
                                style="padding: 6px 14px; background: ${selectedCount > 0 ? 'var(--accent-color)' : 'var(--bg-tertiary)'}; 
                                       color: ${selectedCount > 0 ? 'white' : 'var(--text-muted)'}; 
                                       border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500;
                                       display: flex; align-items: center; gap: 4px; transition: all 0.2s;">
                            <span>📋</span> 
                            <span id="vacancySelectCount">${selectedCount > 0 ? selectedCount + '개 ' : ''}</span>Comp List 담기
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
                                <th style="padding: 8px 6px; text-align: left; border-bottom: 1px solid var(--border-color); white-space: nowrap;">층</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">임대면적</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">전용면적</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">보증금/평</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">임대료/평</th>
                                <th style="padding: 8px 6px; text-align: right; border-bottom: 1px solid var(--border-color); white-space: nowrap;">관리비/평</th>
                                <th style="padding: 8px 6px; text-align: center; border-bottom: 1px solid var(--border-color); white-space: nowrap;">입주시기</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${vacanciesWithId.map((v, idx) => {
                                const isChecked = state.selectedVacancyIds?.has(v._vacancyId) || false;
                                return `
                                <tr style="border-bottom: 1px solid var(--border-color); ${isChecked ? 'background: rgba(37, 99, 235, 0.08);' : ''}" 
                                    data-vacancy-id="${v._vacancyId}">
                                    <td style="padding: 8px 6px; text-align: center;">
                                        <input type="checkbox" 
                                               class="vacancy-checkbox"
                                               data-vacancy-idx="${idx}"
                                               ${isChecked ? 'checked' : ''}
                                               onchange="toggleVacancySelect('${v._vacancyId}', ${idx}, this.checked)"
                                               style="width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent-color);">
                                    </td>
                                    <td style="padding: 8px 6px; font-weight: 600; color: var(--accent-color);">${v.floor || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${v.rentArea ? formatNumber(v.rentArea) + '평' : '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${v.exclusiveArea ? formatNumber(v.exclusiveArea) + '평' : '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${v.depositPy || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right; color: var(--accent-color); font-weight: 500;">${v.rentPy || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: right;">${v.maintenancePy || '-'}</td>
                                    <td style="padding: 8px 6px; text-align: center;">${v.moveInDate || '-'}</td>
                                </tr>
                            `}).join('')}
                        </tbody>
                    </table>
                </div>
                ${inlineInputFormHtml}
            </div>
        `;
    } else {
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
    
    document.getElementById('sectionDocument').innerHTML = `
        <div class="section-title" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
            <span>📄 임대안내문</span>
            <span style="font-size:12px; color:var(--text-muted);">총 ${docs.length}건</span>
        </div>
        
        <!-- 회사별 탭 -->
        <div class="doc-filter-section" style="margin-bottom: 12px;">
            <div class="doc-filter-label" style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">🏢 회사별</div>
            <div class="doc-filter-tabs" style="display: flex; gap: 6px; flex-wrap: wrap;">
                ${sourceList.map(source => `
                    <button class="doc-source-tab" 
                            onclick="selectDocSource('${source}')"
                            style="padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; border: 1px solid var(--border-color); transition: all 0.2s;
                                   ${state.selectedDocSource === source ? 'background: var(--accent-color); color: white; border-color: var(--accent-color);' : 'background: var(--bg-secondary); color: var(--text-primary);'}">
                        ${source} <span style="opacity: 0.7;">${sourceGroups[source].length}</span>
                    </button>
                `).join('')}
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
                <div style="display: flex; gap: 8px;">
                    ${imageUrl ? `
                        <button onclick="showPagePreview('${imageUrl.replace(/'/g, "\\'")}', '${state.selectedDocSource.replace(/'/g, "\\'")}', '${state.selectedDocPeriod.replace(/'/g, "\\'")}', ${pageNum})"
                                style="padding: 8px 14px; background: var(--accent-color); color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 4px;">
                            👁️ 원본 보기
                        </button>
                    ` : ''}
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
        tab.addEventListener('click', () => {
            document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.detail-section').forEach(s => s.classList.remove('active'));
            tab.classList.add('active');
            const sectionId = 'section' + tab.dataset.section.charAt(0).toUpperCase() + tab.dataset.section.slice(1);
            const section = document.getElementById(sectionId);
            if (section) section.classList.add('active');
        });
    });
}

export function registerDetailGlobals() {
    window.openDetail = openDetail;
    window.closeDetail = closeDetail;
    window.toggleDetailStar = toggleDetailStar;
    window.filterRentrollByDate = filterRentrollByDate;
    window.selectDocSource = selectDocSource;
    window.selectDocPeriod = selectDocPeriod;
    
    // 공실 선택 관련 전역 함수
    window.toggleVacancySelect = toggleVacancySelect;
    window.toggleAllVacancySelect = toggleAllVacancySelect;
    window.addSelectedVacanciesToCompList = addSelectedVacanciesToCompList;
    
    // 빌딩만 담기 / 인라인 공실 입력 함수
    window.addBuildingOnlyToCompList = addBuildingOnlyToCompList;
    window.showInlineVacancyForm = showInlineVacancyForm;
    window.hideInlineVacancyForm = hideInlineVacancyForm;
    window.saveInlineVacancy = saveInlineVacancy;
    
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

export function showInlineVacancyForm() {
    const form = document.getElementById('inlineVacancyForm');
    if (form) {
        form.style.display = 'block';
        // 첫 번째 입력 필드에 포커스
        const firstInput = document.getElementById('inlineVacancyFloor');
        if (firstInput) firstInput.focus();
    }
}

export function hideInlineVacancyForm() {
    const form = document.getElementById('inlineVacancyForm');
    if (form) {
        form.style.display = 'none';
        // 입력값 초기화
        clearInlineVacancyForm();
    }
}

function clearInlineVacancyForm() {
    const fields = ['inlineVacancyFloor', 'inlineVacancyRentArea', 'inlineVacancyExclusiveArea', 
                    'inlineVacancyRentPy', 'inlineVacancyDepositPy', 'inlineVacancyMaintenancePy', 'inlineVacancyMoveIn'];
    fields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

export function saveInlineVacancy() {
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
    
    const now = new Date();
    const vacancyData = {
        floor: floor,
        rentArea: parseFloat(document.getElementById('inlineVacancyRentArea')?.value) || 0,
        exclusiveArea: parseFloat(document.getElementById('inlineVacancyExclusiveArea')?.value) || 0,
        rentPy: formatNumber(rentPy),
        depositPy: depositPyStr && !isNaN(parseFloat(depositPyStr)) ? formatNumber(parseFloat(depositPyStr)) : '',
        maintenancePy: maintenancePyStr && !isNaN(parseFloat(maintenancePyStr)) ? formatNumber(parseFloat(maintenancePyStr)) : '',
        moveInDate: document.getElementById('inlineVacancyMoveIn')?.value?.trim() || '즉시',
        source: '사용자 직접입력',
        publishDate: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    };
    
    // Comp List에 추가
    if (typeof window.addBuildingToCompList === 'function') {
        // 이미 빌딩이 있으면 공실만 추가, 없으면 빌딩과 함께 추가
        if (typeof window.compListState !== 'undefined') {
            const existingBuilding = window.compListState.currentList.buildings.find(b => b.buildingId === building.id);
            if (existingBuilding) {
                // 기존 빌딩에 공실 추가
                existingBuilding.vacancies.push({
                    id: `v_${Date.now()}`,
                    ...vacancyData,
                    addedBy: {
                        id: state.currentUser?.id || '',
                        name: state.currentUser?.name || state.currentUser?.email || '',
                        addedAt: now.toISOString()
                    }
                });
                // 로컬 스토리지 저장
                try {
                    localStorage.setItem('cre_complist_current', JSON.stringify(window.compListState.currentList));
                } catch (e) { console.warn('저장 실패:', e); }
                
                // 플로팅 버튼 업데이트
                if (typeof window.updateFloatingButton === 'function') {
                    window.updateFloatingButton();
                }
                
                showToast(`${building.name}에 공실 ${floor} 추가됨`, 'success');
            } else {
                // 새 빌딩으로 추가
                window.addBuildingToCompList(building, [vacancyData]);
            }
        } else {
            window.addBuildingToCompList(building, [vacancyData]);
        }
        
        // 입력값 초기화
        clearInlineVacancyForm();
        
        // 공실이 있었던 경우 폼 숨기기
        if (state.currentDisplayedVacancies && state.currentDisplayedVacancies.length > 0) {
            hideInlineVacancyForm();
        }
        
    } else {
        showToast('Comp List 모듈이 로드되지 않았습니다', 'error');
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
    
    const btn = document.getElementById('addVacanciesToCompListBtn');
    const countSpan = document.getElementById('vacancySelectCount');
    
    if (btn) {
        btn.style.background = count > 0 ? 'var(--accent-color)' : 'var(--bg-tertiary)';
        btn.style.color = count > 0 ? 'white' : 'var(--text-muted)';
    }
    
    if (countSpan) {
        countSpan.textContent = count > 0 ? `${count}개 ` : '';
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
