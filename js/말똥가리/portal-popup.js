/**
 * CRE Portal - 데이터 팝업 모듈
 * 렌트롤/메모/인센티브/임대안내문 팝업
 */

import { state } from './portal-state.js';
import { formatNumber, showToast } from './portal-utils.js';
// ★ Fix: portal-detail.js static import 제거 → window 전역 참조
const openDetail = (...a) => window.openDetail?.(...a);

// 렌트롤 데이터 임시 저장
let _rentrollData = {};
let _currentBuildingId = null;

// ===== 데이터 팝업 열기 =====

export function showDataPopup(buildingId, type) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    const modal = document.getElementById('dataPopupModal');
    const title = document.getElementById('dataPopupTitle');
    const content = document.getElementById('dataPopupContent');
    
    let titleText = '';
    let html = '';
    
    if (type === 'rentroll') {
        titleText = `📊 렌트롤 - ${building.name}`;
        const rentrolls = building.rentrolls || [];
        
        if (rentrolls.length === 0) {
            html = '<div class="popup-empty">등록된 렌트롤이 없습니다</div>';
        } else {
            // 시점별 그룹핑
            const byDate = {};
            rentrolls.forEach(r => {
                const dateKey = r.targetDate || r.date || r.period || r.recordDate || '기타';
                if (!byDate[dateKey]) byDate[dateKey] = [];
                byDate[dateKey].push(r);
            });
            
            // 시점 정렬 (최신순)
            const sortedDates = Object.keys(byDate).sort().reverse();
            const latestDate = sortedDates[0];
            
            // 시계열 선택 UI
            const timelineHtml = `
                <div class="rentroll-timeline" style="display:flex;align-items:center;gap:12px;margin-bottom:16px;padding:12px;background:var(--bg-secondary);border-radius:8px;flex-wrap:wrap;">
                    <label style="font-size:12px;color:var(--text-muted);white-space:nowrap;">📅 시점:</label>
                    <select id="rentrollDateSelect" onchange="updateRentrollTable('${buildingId}')" style="padding:8px 12px;border:1px solid var(--border-color);border-radius:6px;font-size:13px;background:var(--bg-primary);color:var(--text-primary);min-width:120px;">
                        ${sortedDates.map(d => `<option value="${d}" ${d === latestDate ? 'selected' : ''}>${d} (${byDate[d].length}건)</option>`).join('')}
                    </select>
                    <span style="font-size:11px;color:var(--text-muted);">📊 총 ${sortedDates.length}개 시점 | ${rentrolls.length}건</span>
                    <button onclick="openRentrollDetailModal('${buildingId}')" style="margin-left:auto;padding:6px 12px;background:var(--accent-color);color:white;border:none;border-radius:6px;font-size:12px;cursor:pointer;">➕ 추가/편집</button>
                </div>
            `;
            
            // 데이터 저장
            _rentrollData = byDate;
            _currentBuildingId = buildingId;
            
            html = `
                ${timelineHtml}
                <div id="rentrollTableContainer">
                    ${renderRentrollTable(byDate[latestDate] || [])}
                </div>
            `;
        }
    } else if (type === 'memo') {
        titleText = `📝 메모 - ${building.name}`;
        const memos = building.memos || [];
        
        if (memos.length === 0) {
            html = '<div class="popup-empty">등록된 메모가 없습니다</div>';
        } else {
            html = memos.map(m => `
                <div class="popup-memo-item">
                    <div class="memo-header">
                        <span class="memo-author">${m.author || m.createdBy || '작성자'}</span>
                        <span class="memo-date">${m.createdAt ? new Date(m.createdAt).toLocaleDateString('ko-KR') : ''}</span>
                    </div>
                    <div class="memo-content">${m.content || m.text || '-'}</div>
                </div>
            `).join('');
        }
    } else if (type === 'incentive') {
        titleText = `🎁 인센티브 - ${building.name}`;
        const incentives = building.incentives || [];
        
        if (incentives.length === 0) {
            html = '<div class="popup-empty">등록된 인센티브가 없습니다</div>';
        } else {
            // 최신순 정렬
            const sorted = [...incentives].sort((a, b) => {
                const dateA = a.targetDate || a.createdAt || '';
                const dateB = b.targetDate || b.createdAt || '';
                return dateB.localeCompare(dateA);
            });
            
            html = `
                <div class="incentive-popup-grid">
                    ${sorted.map(inc => `
                        <div class="incentive-popup-card" style="background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:12px;border:1px solid var(--border-color);">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                                <span style="font-size:12px;font-weight:600;color:var(--text-muted);">${inc.targetDate || '-'}</span>
                                <span style="font-size:11px;color:var(--text-muted);">${inc.author || ''}</span>
                            </div>
                            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
                                <div style="text-align:center;">
                                    <div style="font-size:11px;color:var(--text-muted);">Rent Free</div>
                                    <div style="font-size:18px;font-weight:600;color:var(--accent-color);">${inc.rf || inc.rentFree || 0}</div>
                                    <div style="font-size:10px;color:var(--text-muted);">개월</div>
                                </div>
                                <div style="text-align:center;">
                                    <div style="font-size:11px;color:var(--text-muted);">Fit-Out</div>
                                    <div style="font-size:18px;font-weight:600;color:var(--text-primary);">${formatNumber(inc.fo || inc.fitOut || 0)}</div>
                                    <div style="font-size:10px;color:var(--text-muted);">원/평</div>
                                </div>
                                <div style="text-align:center;">
                                    <div style="font-size:11px;color:var(--text-muted);">TI</div>
                                    <div style="font-size:18px;font-weight:600;color:var(--text-primary);">${formatNumber(inc.ti || 0)}</div>
                                    <div style="font-size:10px;color:var(--text-muted);">원/평</div>
                                </div>
                            </div>
                            ${inc.note ? `<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border-color);font-size:12px;color:var(--text-secondary);">${inc.note}</div>` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        }
    } else if (type === 'document') {
        titleText = `📄 임대안내문 - ${building.name}`;
        const docs = building.documents || [];
        
        if (docs.length === 0) {
            html = '<div class="popup-empty">등록된 임대안내문이 없습니다</div>';
        } else {
            // 최신순 정렬
            const sorted = [...docs].sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
            
            html = `
                <div class="doc-popup-list">
                    ${sorted.map(d => `
                        <div class="doc-popup-item" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:8px;cursor:pointer;" onclick="openPagePreview('${d.id}')">
                            <div style="width:40px;height:40px;background:var(--accent-light);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:18px;">📄</div>
                            <div style="flex:1;">
                                <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${d.source || '기타'}</div>
                                <div style="font-size:11px;color:var(--text-muted);">📅 ${d.publishDate || '-'} · ${d.pageCount || 1}페이지</div>
                            </div>
                            <div style="font-size:20px;color:var(--text-muted);">›</div>
                        </div>
                    `).join('')}
                </div>
            `;
        }
    }
    
    title.textContent = titleText;
    content.innerHTML = html;
    modal.classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

// 데이터 팝업 닫기
export function closeDataPopup() {
    const modal = document.getElementById('dataPopupModal');
    modal.classList.remove('show');
    // ★ 공실 팝업에서 확장했던 스타일 복원
    if (modal.dataset.popupType === 'vacancy') {
        modal.style.maxWidth = '700px';
        delete modal.dataset.popupType;
        const content = document.getElementById('dataPopupContent');
        if (content) {
            content.style.padding = '16px 20px';
            content.style.maxHeight = '60vh';
            content.style.overflow = 'auto';
        }
    }
    document.getElementById('modalOverlay').classList.remove('show');
    // ★ 전체화면 이미지 오버레이 제거
    const imgOverlay = document.getElementById('vacPopupImageOverlay');
    if (imgOverlay) imgOverlay.remove();
}

// ===== 렌트롤 테이블 렌더링 =====

export function renderRentrollTable(rentrolls) {
    if (!rentrolls || rentrolls.length === 0) {
        return '<div class="popup-empty">선택한 시점의 렌트롤이 없습니다</div>';
    }
    
    // 층 정렬 (높은 층 → 낮은 층)
    const sorted = [...rentrolls].sort((a, b) => {
        const floorA = parseInt(String(a.floor || '').replace(/[^-\d]/g, '')) || 0;
        const floorB = parseInt(String(b.floor || '').replace(/[^-\d]/g, '')) || 0;
        return floorB - floorA;
    });
    
    // 헬퍼 함수들
    const getAreaValue = (area) => {
        if (!area) return '-';
        if (typeof area === 'object') {
            return area.py ? formatNumber(area.py) + '평' : (area.sqm ? formatNumber(area.sqm) + '㎡' : '-');
        }
        return formatNumber(area) + '평';
    };
    
    const getTenantName = (tenant) => {
        if (!tenant) return '-';
        if (typeof tenant === 'object') return tenant.name || '-';
        return tenant;
    };
    
    const getRentValue = (rent) => {
        if (!rent) return '-';
        if (typeof rent === 'object') {
            return rent.py ? formatNumber(rent.py) + '만/평' : '-';
        }
        const num = parseFloat(String(rent).replace(/[^\d.]/g, ''));
        return isNaN(num) ? rent : formatNumber(num) + '만/평';
    };
    
    return `
        <table class="popup-table rentroll-popup-table">
            <thead>
                <tr>
                    <th>층</th>
                    <th>면적</th>
                    <th>입주사</th>
                    <th>시작일</th>
                    <th>종료일</th>
                    <th>임대료</th>
                    <th>특이사항</th>
                </tr>
            </thead>
            <tbody>
                ${sorted.map(r => {
                    const noteText = r.note || r.remark || r.memo || r.remarks || '';
                    const hasNote = noteText && noteText.trim().length > 0;
                    
                    return `
                        <tr>
                            <td style="font-weight:600;color:var(--accent-color);white-space:nowrap;">${r.floor || '-'}</td>
                            <td style="white-space:nowrap;">${getAreaValue(r.area || r.exclusiveArea || r.rentArea)}</td>
                            <td>${getTenantName(r.tenant || r.company || r.tenantName)}</td>
                            <td style="white-space:nowrap;">${r.startDate || r.contractStart || r.leaseStart || (r.contract?.startDate) || '-'}</td>
                            <td style="white-space:nowrap;">${r.endDate || r.contractEnd || r.leaseEnd || (r.contract?.endDate) || '-'}</td>
                            <td style="white-space:nowrap;">${getRentValue(r.rent || r.rentPy || r.monthlyRent)}</td>
                            <td class="note-cell">
                                ${hasNote ? `
                                    <div class="note-content" title="${noteText.replace(/"/g, '&quot;')}">${noteText}</div>
                                ` : '-'}
                            </td>
                        </tr>
                    `;
                }).join('')}
            </tbody>
        </table>
        <style>
            .note-cell { max-width: 200px; }
            .note-content { 
                font-size: 12px; 
                line-height: 1.4; 
                color: var(--text-secondary);
                word-break: break-word;
                white-space: pre-wrap;
                max-height: 60px;
                overflow: hidden;
                transition: max-height 0.3s;
            }
            .note-content.expanded { max-height: none; }
        </style>
        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border-color);display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:11px;color:var(--text-muted);">
                총 ${sorted.length}개 층
                ${sorted[0]?.author ? ` | 입력: ${sorted[0].author.split('@')[0]}` : ''}
                ${sorted[0]?.createdAt ? ` (${new Date(sorted[0].createdAt).toLocaleDateString('ko-KR')})` : ''}
            </div>
        </div>
    `;
}

// 렌트롤 시점 변경
export function updateRentrollTable(buildingId) {
    const select = document.getElementById('rentrollDateSelect');
    if (!select || !_rentrollData) return;
    
    const selectedDate = select.value;
    const rentrolls = _rentrollData[selectedDate] || [];
    
    const container = document.getElementById('rentrollTableContainer');
    if (container) {
        container.innerHTML = renderRentrollTable(rentrolls);
    }
}

// 렌트롤 추가/편집 모달
export function openRentrollDetailModal(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    // 기존 팝업 닫기
    closeDataPopup();
    
    // 상세 패널로 이동하고 렌트롤 탭 활성화
    openDetail(buildingId);
    setTimeout(() => {
        const rentrollTab = document.querySelector('.detail-tabs .tab-btn:nth-child(2)');
        if (rentrollTab) rentrollTab.click();
    }, 300);
    
    showToast('렌트롤 탭에서 추가/편집하세요', 'info');
}

// ===== 공실 팝업 =====

export function showVacancyPopup(buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    const vacancies = building.vacancies || [];
    if (vacancies.length === 0) {
        showToast('공실 정보가 없습니다', 'error');
        return;
    }
    
    // 출처별 그룹핑
    const groups = {};
    vacancies.forEach(v => {
        const key = `${v.source || '기타'}_${v.publishDate || ''}`;
        if (!groups[key]) groups[key] = { source: v.source || '기타', publishDate: v.publishDate || '', items: [] };
        groups[key].items.push(v);
    });
    
    const sortedGroups = Object.values(groups).sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
    
    const modal = document.getElementById('dataPopupModal');
    const title = document.getElementById('dataPopupTitle');
    const content = document.getElementById('dataPopupContent');
    
    // ★ 모달 너비 확장 (공실용)
    modal.style.maxWidth = '1100px';
    modal.dataset.popupType = 'vacancy';
    
    title.textContent = `🏢 공실 현황 - ${building.name}`;
    
    // ★ 이미지 URL 헬퍼
    const getImageUrl = (group) => {
        // 1) 공실 데이터에 pageImageUrl이 있으면 사용
        const firstWithImg = group.items.find(v => v.pageImageUrl);
        if (firstWithImg?.pageImageUrl) return firstWithImg.pageImageUrl;
        
        // 2) pageNum으로 URL 생성
        const pageNum = group.items[0]?.pageNum || group.items[0]?.page || null;
        if (pageNum && group.source !== '기타') {
            const folder = (group.source + '_' + group.publishDate).replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
            return 'https://firebasestorage.googleapis.com/v0/b/cre-unified.firebasestorage.app/o/leasing-docs%2F' 
                + encodeURIComponent(folder) + '%2Fpage_' + String(pageNum).padStart(3, '0') + '.jpg?alt=media';
        }
        return '';
    };
    
    // 초기 이미지 URL
    const firstImageUrl = getImageUrl(sortedGroups[0]);
    
    // ★ 좌우 분할 레이아웃
    content.innerHTML = `
        <div style="display: flex; gap: 0; height: calc(80vh - 70px); min-height: 400px;">
            <!-- 좌측: 공실 리스트 -->
            <div style="flex: 1; min-width: 0; overflow-y: auto; border-right: 1px solid var(--border-color); padding: 16px;">
                <!-- 출처 탭 -->
                ${sortedGroups.length > 1 ? `
                <div style="display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap;">
                    ${sortedGroups.map((g, i) => `
                        <button class="vacancy-popup-tab ${i === 0 ? 'active' : ''}" 
                                data-group-idx="${i}"
                                onclick="switchVacancyPopupTab(${i})"
                                style="padding: 6px 12px; border: 1px solid ${i === 0 ? 'var(--accent-color)' : 'var(--border-color)'}; 
                                       border-radius: 16px; font-size: 12px; cursor: pointer; white-space: nowrap;
                                       background: ${i === 0 ? 'var(--accent-color)' : 'var(--bg-secondary)'}; 
                                       color: ${i === 0 ? '#fff' : 'var(--text-primary)'}; font-weight: 600;">
                            ${g.source} <span style="opacity:0.8;">${g.publishDate}</span> 
                            <span style="font-weight:700;">${g.items.length}</span>
                        </button>
                    `).join('')}
                </div>` : ''}
                
                <!-- 그룹별 테이블 -->
                ${sortedGroups.map((g, i) => `
                    <div class="vacancy-popup-group" data-group-idx="${i}" style="${i > 0 ? 'display:none;' : ''}">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                            <span style="background:var(--accent-color); color:#fff; padding:2px 10px; border-radius:10px; font-size:12px; font-weight:700;">${g.source}</span>
                            <span style="font-size:12px; color:var(--text-muted);">${g.publishDate}</span>
                            ${g.items[0]?.pageNum || g.items[0]?.page ? `<span style="font-size:11px; background:var(--bg-tertiary); padding:2px 6px; border-radius:4px;">P.${g.items[0]?.pageNum || g.items[0]?.page}</span>` : ''}
                        </div>
                        <div style="font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--text-muted);">📋 공실 정보 (${g.items.length}건)</div>
                        <table class="popup-table">
                            <thead><tr>
                                <th>층</th><th>임대면적</th><th>전용면적</th>
                                <th>보증금/평</th><th>임대료/평</th><th>관리비/평</th><th>입주시기</th>
                            </tr></thead>
                            <tbody>${g.items.map(v => `
                                <tr>
                                    <td style="font-weight:600; color:var(--accent-color);">${v.floor || '-'}</td>
                                    <td style="text-align:right;">${v.rentArea ? formatNumber(v.rentArea) + '평' : '-'}</td>
                                    <td style="text-align:right;">${v.exclusiveArea ? formatNumber(v.exclusiveArea) + '평' : '-'}</td>
                                    <td style="text-align:right;">${v.depositPy ? formatNumber(v.depositPy) : '-'}</td>
                                    <td style="text-align:right;">${v.rentPy ? formatNumber(v.rentPy) : '-'}</td>
                                    <td style="text-align:right;">${v.maintenancePy ? formatNumber(v.maintenancePy) : '-'}</td>
                                    <td style="text-align:center;">${v.moveInDate || '-'}</td>
                                </tr>
                            `).join('')}</tbody>
                        </table>
                    </div>
                `).join('')}
            </div>
            
            <!-- 우측: 원본 이미지 -->
            <div style="flex: 0 0 45%; min-width: 0; display: flex; flex-direction: column; background: var(--bg-secondary);">
                <div style="padding: 10px 14px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                    <span style="font-size: 12px; font-weight: 600; color: var(--text-muted);">📄 원본 이미지</span>
                    <button id="vacPopupFullscreenBtn" onclick="openVacPopupImageFull()" 
                            style="font-size: 11px; padding: 4px 10px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary); cursor: pointer; color: var(--text-primary);"
                            title="원본 크기로 보기">🔍 확대</button>
                </div>
                <div id="vacPopupImageContainer" style="flex: 1; overflow: auto; display: flex; align-items: flex-start; justify-content: center; padding: 8px;">
                    ${firstImageUrl ? 
                        `<img id="vacPopupImage" src="${firstImageUrl}" 
                              style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" 
                              onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                              onclick="openVacPopupImageFull()">
                         <div style="display:none; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--text-muted); font-size:13px; gap:8px;">
                            <span style="font-size:40px;">📄</span>
                            <span>이미지를 불러올 수 없습니다</span>
                         </div>` :
                        `<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--text-muted); font-size:13px; gap:8px;">
                            <span style="font-size:40px;">📄</span>
                            <span>원본 이미지 없음</span>
                         </div>`
                    }
                </div>
            </div>
        </div>
    `;
    
    // ★ 이미지 URL 목록을 window에 저장 (탭 전환용)
    window._vacPopupImageUrls = sortedGroups.map(g => getImageUrl(g));
    window._vacPopupCurrentIdx = 0;
    
    // ★ content 스타일 오버라이드 (좌우분할용)
    content.style.padding = '0';
    content.style.maxHeight = 'none';
    content.style.overflow = 'hidden';
    
    modal.classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
}

// ★ 공실 팝업 탭 전환
function switchVacancyPopupTab(idx) {
    // 탭 active 전환
    document.querySelectorAll('.vacancy-popup-tab').forEach(tab => {
        const isActive = parseInt(tab.dataset.groupIdx) === idx;
        tab.classList.toggle('active', isActive);
        tab.style.background = isActive ? 'var(--accent-color)' : 'var(--bg-secondary)';
        tab.style.color = isActive ? '#fff' : 'var(--text-primary)';
        tab.style.borderColor = isActive ? 'var(--accent-color)' : 'var(--border-color)';
    });
    
    // 그룹 표시 전환
    document.querySelectorAll('.vacancy-popup-group').forEach(group => {
        group.style.display = parseInt(group.dataset.groupIdx) === idx ? '' : 'none';
    });
    
    // 이미지 전환
    const imageUrl = window._vacPopupImageUrls?.[idx] || '';
    const container = document.getElementById('vacPopupImageContainer');
    if (container) {
        if (imageUrl) {
            container.innerHTML = `
                <img id="vacPopupImage" src="${imageUrl}" 
                     style="max-width: 100%; height: auto; border-radius: 4px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);" 
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';"
                     onclick="openVacPopupImageFull()">
                <div style="display:none; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--text-muted); font-size:13px; gap:8px;">
                    <span style="font-size:40px;">📄</span>
                    <span>이미지를 불러올 수 없습니다</span>
                </div>`;
        } else {
            container.innerHTML = `
                <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; color:var(--text-muted); font-size:13px; gap:8px;">
                    <span style="font-size:40px;">📄</span>
                    <span>원본 이미지 없음</span>
                </div>`;
        }
    }
    window._vacPopupCurrentIdx = idx;
}

// ★ 이미지 전체화면 보기
function openVacPopupImageFull() {
    const img = document.getElementById('vacPopupImage');
    if (!img?.src) return;
    
    const overlay = document.createElement('div');
    overlay.id = 'vacPopupImageOverlay';
    overlay.style.cssText = 'position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.85); z-index:10002; display:flex; align-items:center; justify-content:center; cursor:zoom-out;';
    overlay.onclick = () => overlay.remove();
    overlay.innerHTML = `<img src="${img.src}" style="max-width:95vw; max-height:95vh; object-fit:contain; border-radius:8px; box-shadow:0 0 40px rgba(0,0,0,0.5);">`;
    document.body.appendChild(overlay);
}

// ===== 안내문 미리보기 팝업 =====

export function showDocumentPreview(buildingId, index, selectEl) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    const docs = building.documents || [];
    const sorted = [...docs].sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
    const doc = sorted[parseInt(index)];
    
    if (!doc) return;
    
    // 해당 문서의 공실 정보
    const vacancies = (building.vacancies || []).filter(v => 
        (v.source || '') === doc.source && (v.publishDate || '') === doc.publishDate
    );
    
    const modal = document.getElementById('dataPopupModal');
    const title = document.getElementById('dataPopupTitle');
    const content = document.getElementById('dataPopupContent');
    
    const pageNum = doc.pageNum || doc.page || 1;
    const hasPreview = doc.pageImageUrl || pageNum > 0;
    
    // 이미지 URL 생성
    let imageUrl = doc.pageImageUrl || '';
    if (!imageUrl && doc.source && doc.publishDate) {
        const formattedFolder = (doc.source + '_' + doc.publishDate).replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
        imageUrl = 'https://firebasestorage.googleapis.com/v0/b/cre-unified.firebasestorage.app/o/leasing-docs%2F' + encodeURIComponent(formattedFolder) + '%2Fpage_' + String(pageNum).padStart(3, '0') + '.jpg?alt=media';
    }
    
    title.textContent = `📄 ${doc.source || '기타'} - ${doc.publishDate || ''} | ${building.name}`;
    content.innerHTML = `
        <div class="doc-preview-container">
            <!-- 상단 정보 및 버튼 -->
            <div class="doc-preview-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding:12px;background:var(--bg-secondary);border-radius:8px;">
                <div class="doc-preview-info" style="display:flex;gap:8px;align-items:center;">
                    <span class="mini-badge badge-vacancy">${doc.source || '기타'}</span>
                    <span style="font-size:12px;color:var(--text-muted);">${doc.publishDate || '-'}</span>
                    ${pageNum > 0 ? `<span style="font-size:11px;padding:2px 6px;background:var(--accent-color);color:white;border-radius:4px;">P.${pageNum}</span>` : ''}
                </div>
                <div class="doc-preview-actions" style="display:flex;gap:8px;">
                    ${hasPreview ? `
                        <button class="btn btn-primary btn-sm" onclick="showPagePreview('${imageUrl}', '${doc.source || ''}', '${doc.publishDate || ''}', ${pageNum})">
                            👁️ 원본 보기
                        </button>
                    ` : ''}
                </div>
            </div>
            
            <!-- 공실 정보 테이블 -->
            ${vacancies.length > 0 ? `
            <div class="doc-vacancy-section">
                <div style="font-size:13px;font-weight:600;margin-bottom:12px;">📋 공실 정보 (${vacancies.length}건)</div>
                <table class="popup-table">
                    <thead>
                        <tr><th>층</th><th>임대면적</th><th>전용면적</th><th>보증금/평</th><th>임대료/평</th><th>관리비/평</th><th>입주시기</th></tr>
                    </thead>
                    <tbody>
                        ${vacancies.map(v => `
                            <tr>
                                <td style="font-weight:600;color:var(--accent-color);">${v.floor || '-'}</td>
                                <td>${v.rentArea ? formatNumber(v.rentArea) + '평' : '-'}</td>
                                <td>${v.exclusiveArea ? formatNumber(v.exclusiveArea) + '평' : '-'}</td>
                                <td>${v.depositPy || '-'}</td>
                                <td>${v.rentPy || '-'}</td>
                                <td>${v.maintenancePy || '-'}</td>
                                <td>${v.moveInDate || '-'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ` : '<div class="popup-empty" style="padding:20px;text-align:center;color:var(--text-muted);">해당 안내문의 공실 정보가 없습니다</div>'}
        </div>
    `;
    
    modal.classList.add('show');
    document.getElementById('modalOverlay').classList.add('show');
    
    // 셀렉트 박스 초기화
    if (selectEl) {
        setTimeout(() => { selectEl.selectedIndex = 0; }, 100);
    }
}

// ===== 이미지 뷰어 =====

let currentImageType = 'exterior';
let currentImageIndex = 0;
let currentImages = [];

export function openImageViewer(type, index) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    currentImageType = type;
    currentImageIndex = index;
    currentImages = type === 'exterior' ? (b.exteriorImages || []) : (b.floorPlanImages || []);
    
    if (currentImages.length === 0) return;
    
    renderImageViewer();
    
    const modal = document.getElementById('imageViewerModal');
    if (modal) {
        modal.classList.add('show');
    }
}

function renderImageViewer() {
    const modal = document.getElementById('imageViewerModal');
    if (!modal || currentImages.length === 0) return;
    
    const img = currentImages[currentImageIndex];
    const typeName = currentImageType === 'exterior' ? '외관 이미지' : '평면도';
    const hasPrev = currentImageIndex > 0;
    const hasNext = currentImageIndex < currentImages.length - 1;
    
    modal.innerHTML = `
        <div class="image-viewer-container">
            <button class="image-viewer-close" onclick="closeImageViewer()">×</button>
            ${hasPrev ? `<button class="image-viewer-nav prev" onclick="prevImage()">‹</button>` : ''}
            <img src="${img.url}" alt="${typeName} ${currentImageIndex + 1}">
            ${hasNext ? `<button class="image-viewer-nav next" onclick="nextImage()">›</button>` : ''}
            <div class="image-viewer-info">
                <div>${typeName} ${currentImageIndex + 1} / ${currentImages.length}</div>
                <div class="image-viewer-dots">
                    ${currentImages.map((_, i) => `
                        <span class="image-viewer-dot ${i === currentImageIndex ? 'active' : ''}" onclick="goToImage(${i})"></span>
                    `).join('')}
                </div>
            </div>
        </div>
    `;
}

export function closeImageViewer() {
    const modal = document.getElementById('imageViewerModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

export function prevImage() {
    if (currentImageIndex > 0) {
        currentImageIndex--;
        renderImageViewer();
    }
}

export function nextImage() {
    if (currentImageIndex < currentImages.length - 1) {
        currentImageIndex++;
        renderImageViewer();
    }
}

export function goToImage(index) {
    if (index >= 0 && index < currentImages.length) {
        currentImageIndex = index;
        renderImageViewer();
    }
}

export function switchImageTab(type) {
    const b = state.selectedBuilding;
    if (!b) return;
    
    const exteriorThumbs = document.getElementById('exteriorThumbnails');
    const floorplanThumbs = document.getElementById('floorplanThumbnails');
    const tabs = document.querySelectorAll('.image-tab');
    
    tabs.forEach(tab => tab.classList.remove('active'));
    
    if (type === 'exterior') {
        if (exteriorThumbs) exteriorThumbs.style.display = '';
        if (floorplanThumbs) floorplanThumbs.style.display = 'none';
        tabs[0]?.classList.add('active');
    } else {
        if (exteriorThumbs) exteriorThumbs.style.display = 'none';
        if (floorplanThumbs) floorplanThumbs.style.display = '';
        tabs[1]?.classList.add('active');
    }
}

// ===== 전역 함수 등록 =====

export function registerPopupGlobals() {
    window.showDataPopup = showDataPopup;
    window.closeDataPopup = closeDataPopup;
    window.updateRentrollTable = updateRentrollTable;
    window.openRentrollDetailModal = openRentrollDetailModal;
    window.showVacancyPopup = showVacancyPopup;
    window.showDocumentPreview = showDocumentPreview;
    
    // ★ 공실 팝업 좌우분할 관련
    window.switchVacancyPopupTab = switchVacancyPopupTab;
    window.openVacPopupImageFull = openVacPopupImageFull;
    
    // 이미지 뷰어 함수
    window.openImageViewer = openImageViewer;
    window.closeImageViewer = closeImageViewer;
    window.prevImage = prevImage;
    window.nextImage = nextImage;
    window.goToImage = goToImage;
    window.switchImageTab = switchImageTab;
}
