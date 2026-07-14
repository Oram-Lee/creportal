/**
 * Leasing Guide - 목록 및 CRUD
 * 안내문 목록 렌더링, 생성, 삭제 기능
 * 
 * v2.3 수정사항:
 * - saveDraft/saveFinal에서 deep copy 적용 (이미지 저장 버그 수정)
 * - 이미지 데이터 검증 로직 추가
 * - Firebase 저장 전 데이터 크기 경고
 */

import { state, db, ref, get, set, push, update, remove } from './guide-state.js?v=5.1';
import { showToast, formatDate, getRegionName } from './guide-utils.js?v=5.1';
// 순환 의존성 방지 - window 객체를 통해 호출
// openEditor, setTocItemsFromGuide, loadCoverSettings

// 안내문 목록 렌더링
export function renderGuideList() {
    const container = document.getElementById('guideList');
    if (!container) return;
    
    let guideList = Object.entries(state.leasingGuides).map(([id, g]) => ({ id, ...g }));

    // 권한에 따른 필터링
    if (state.currentUser?.role !== 'admin') {
        guideList = guideList.filter(g => 
            g.createdBy === state.currentUser?.id || 
            g.createdBy === state.currentUser?.email
        );
    }

    // 필터 적용
    const statusFilter = document.getElementById('filterStatus')?.value || 'all';
    const regionFilter = document.getElementById('filterRegion')?.value || 'all';
    const searchQuery = document.getElementById('searchGuide')?.value?.toLowerCase() || '';

    if (statusFilter !== 'all') {
        guideList = guideList.filter(g => g.status === statusFilter);
    }
    if (regionFilter !== 'all') {
        guideList = guideList.filter(g => g.regionSummary && g.regionSummary[regionFilter]);
    }
    if (searchQuery) {
        guideList = guideList.filter(g => 
            g.title?.toLowerCase().includes(searchQuery) ||
            g.createdBy?.toLowerCase().includes(searchQuery)
        );
    }

    // 정렬 (최신순)
    guideList.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));

    // 빈 목록
    if (guideList.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">📄</div>
                <p>등록된 임대안내문이 없습니다</p>
                <button class="btn btn-primary" onclick="openCreateModal()">+ 새로 만들기</button>
            </div>
        `;
        updateFilterOptions([]);
        return;
    }

    // 카드 목록 렌더링
    container.innerHTML = guideList.map(g => {
        const buildingCount = (g.items || []).filter(i => i.type === 'building').length;
        const regionBadges = g.regionSummary ? 
            Object.entries(g.regionSummary)
                .filter(([_, count]) => count > 0)
                .map(([region, count]) => `<span class="region-badge region-${region}">${region}(${count})</span>`)
                .join('') : '';
        
        const statusClass = g.status === 'published' ? 'status-published' : 'status-draft';
        const statusText = g.status === 'published' ? '발행완료' : '작성중';
        
        return `
            <div class="guide-card">
                <div class="guide-card-header">
                    <div class="guide-title">${g.title || '제목없음'}</div>
                    <span class="guide-status ${statusClass}">${statusText}</span>
                </div>
                <div class="guide-meta">
                    <span>🏢 ${buildingCount}개 빌딩</span>
                    <span>📅 ${formatDate(g.updatedAt || g.createdAt)}</span>
                </div>
                <div class="guide-regions">${regionBadges || '<span style="color:var(--text-muted)">권역 미지정</span>'}</div>
                <div class="guide-actions">
                    <button class="btn btn-sm btn-secondary" onclick="editGuide('${g.id}')">✏️ 편집</button>
                    <button class="btn btn-sm btn-secondary" onclick="window.open('leasing-guide-print.html?id=${g.id}', '_blank')">🖨️ 출력</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteGuide('${g.id}')">🗑️</button>
                </div>
            </div>
        `;
    }).join('');

    updateFilterOptions(guideList);
}

// 필터 옵션 업데이트
export function updateFilterOptions(guideList) {
    const regionSet = new Set();
    guideList.forEach(g => {
        if (g.regionSummary) {
            Object.keys(g.regionSummary).forEach(r => {
                if (g.regionSummary[r] > 0) regionSet.add(r);
            });
        }
    });

    const regionFilter = document.getElementById('filterRegion');
    if (regionFilter) {
        const current = regionFilter.value;
        regionFilter.innerHTML = `
            <option value="all">전체 권역</option>
            ${['GBD', 'YBD', 'CBD', 'PAN', 'ETC']
                .filter(r => regionSet.has(r))
                .map(r => `<option value="${r}" ${current === r ? 'selected' : ''}>${getRegionName(r)}</option>`)
                .join('')}
        `;
    }
}

// 생성 모달 열기
export function openCreateModal() {
    const modal = document.getElementById('createModal');
    if (modal) {
        modal.classList.add('show');
        
        // ★ 발행년도 드롭다운 초기화
        const yearSelect = document.getElementById('createYear');
        if (yearSelect) {
            const currentYear = new Date().getFullYear();
            yearSelect.innerHTML = `<option value="">선택</option>`;
            for (let y = currentYear + 1; y >= currentYear - 5; y--) {
                const selected = y === currentYear ? 'selected' : '';
                yearSelect.innerHTML += `<option value="${y}" ${selected}>${y}년</option>`;
            }
        }
        
        // ★ 발행월 드롭다운 초기화
        const monthSelect = document.getElementById('createMonth');
        if (monthSelect) {
            const currentMonth = new Date().getMonth() + 1;
            monthSelect.innerHTML = `<option value="">선택</option>`;
            for (let m = 1; m <= 12; m++) {
                const selected = m === currentMonth ? 'selected' : '';
                monthSelect.innerHTML += `<option value="${m}" ${selected}>${m}월</option>`;
            }
        }

        // ★ v5.6: 저장된 표지/엔딩 템플릿 목록 갱신
        refreshTemplateSelect();
    }
}

// 생성 모달 닫기
export function closeCreateModal() {
    const modal = document.getElementById('createModal');
    if (modal) modal.classList.remove('show');
}

// 템플릿 선택
let selectedTemplate = 'blank';
export function selectCreateType(type) {
    selectedTemplate = type;
    document.querySelectorAll('.template-card').forEach(c => c.classList.remove('active'));
    document.querySelector(`.template-card[data-type="${type}"]`)?.classList.add('active');
}

// ★ v5.6: 표지/엔딩 템플릿 로컬스토리지 키
const TEMPLATE_STORAGE_KEY = 'cre_leasing_cover_templates';

// 저장된 템플릿 목록 불러오기
export function loadSavedTemplates() {
    try {
        const raw = localStorage.getItem(TEMPLATE_STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch(e) { return []; }
}

// 템플릿 저장 (guide-cover.js에서 호출)
export function saveAsTemplate(name, coverSettings, endingSettings) {
    const templates = loadSavedTemplates();
    const newTpl = {
        id: Date.now().toString(),
        name,
        coverSettings: JSON.parse(JSON.stringify(coverSettings || {})),
        endingSettings: JSON.parse(JSON.stringify(endingSettings || {})),
        createdAt: new Date().toLocaleString('ko-KR')
    };
    templates.push(newTpl);
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
    return newTpl;
}

// 템플릿 삭제
export function deleteTemplate(id) {
    const templates = loadSavedTemplates().filter(t => t.id !== id);
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

// 신규 생성 모달 오픈 시 템플릿 셀렉트박스 갱신
function refreshTemplateSelect() {
    const sel = document.getElementById('coverTemplateSelect');
    if (!sel) return;
    const templates = loadSavedTemplates();
    sel.innerHTML = '<option value="">-- 없음 (기본값) --</option>';
    templates.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = `${t.name}  (${t.createdAt})`;
        sel.appendChild(opt);
    });
    // 삭제 버튼 갱신
    const delBtn = document.getElementById('deleteTemplateBtn');
    if (delBtn) delBtn.style.display = templates.length ? 'inline-block' : 'none';
}

// 안내문 생성
export async function createGuide() {
    const titleInput = document.getElementById('createTitle');
    const title = titleInput?.value?.trim();
    
    if (!title) {
        showToast('제목을 입력하세요', 'error');
        return;
    }
    
    // ★ 발행년도/월 가져오기
    const publishYear = document.getElementById('createYear')?.value || '';
    const publishMonth = document.getElementById('createMonth')?.value || '';

    // ★ v5.6: 선택된 표지/엔딩 템플릿 적용
    const selectedTplId = document.getElementById('coverTemplateSelect')?.value || '';
    let appliedCoverSettings = null;
    let appliedEndingSettings = null;
    if (selectedTplId) {
        const tpl = loadSavedTemplates().find(t => t.id === selectedTplId);
        if (tpl) {
            appliedCoverSettings = JSON.parse(JSON.stringify(tpl.coverSettings));
            appliedEndingSettings = JSON.parse(JSON.stringify(tpl.endingSettings));
        }
    }

    try {
        const newGuideRef = push(ref(db, 'leasingGuides'));
        const newGuide = {
            title,
            template: selectedTemplate,
            publishYear,
            publishMonth,
            items: [],
            regionSummary: {},
            status: 'draft',
            coverSettings: appliedCoverSettings || {},
            endingSettings: appliedEndingSettings || {},
            createdAt: new Date().toISOString(),
            createdBy: state.currentUser?.email || 'unknown',
            updatedAt: new Date().toISOString()
        };

        await set(newGuideRef, newGuide);
        
        state.leasingGuides[newGuideRef.key] = newGuide;
        state.currentGuide = { id: newGuideRef.key, ...newGuide };
        state.tocItems = [];

        // ★ v5.6: state에도 바로 반영 (loadCoverSettings가 openEditor에서 처리)
        if (appliedCoverSettings) {
            state.coverSettings = appliedCoverSettings;
        }
        if (appliedEndingSettings) {
            state.endingSettings = { ...state.endingSettings, ...appliedEndingSettings };
        }
        
        closeCreateModal();
        if (titleInput) titleInput.value = '';
        
        showToast('안내문이 생성되었습니다', 'success');
        window.openEditor();
        
    } catch (error) {
        console.error('안내문 생성 오류:', error);
        showToast('생성 중 오류가 발생했습니다', 'error');
    }
}

// 안내문 편집
export function editGuide(guideId) {
    const guide = state.leasingGuides[guideId];
    if (!guide) {
        showToast('안내문을 찾을 수 없습니다', 'error');
        return;
    }
    
    state.currentGuide = { id: guideId, ...guide };
    state.tocItems = guide.items ? JSON.parse(JSON.stringify(guide.items)) : [];
    
    // coverSettings 로드
    window.loadCoverSettings(guide);
    
    window.openEditor();
}

// 안내문 삭제
export async function deleteGuide(guideId) {
    if (!confirm('정말 이 임대안내문을 삭제하시겠습니까?')) return;
    
    try {
        await remove(ref(db, `leasingGuides/${guideId}`));
        delete state.leasingGuides[guideId];
        renderGuideList();
        showToast('임대안내문이 삭제되었습니다', 'success');
    } catch (error) {
        console.error('삭제 오류:', error);
        showToast('삭제 중 오류가 발생했습니다', 'error');
    }
}

// ★ v2.3: 이미지 데이터 검증 및 준비
function prepareItemsForSave(tocItems) {
    // Deep copy로 참조 문제 방지
    const itemsCopy = JSON.parse(JSON.stringify(tocItems));
    
    // 각 아이템의 이미지 데이터 검증
    let totalSize = 0;
    let imageCount = 0;
    
    itemsCopy.forEach((item, idx) => {
        if (item.type === 'building') {
            // 외관 이미지 검증
            if (item.exteriorImages && item.exteriorImages.length > 0) {
                item.exteriorImages.forEach((img, imgIdx) => {
                    const imgData = typeof img === 'string' ? img : (img.url || '');
                    const size = imgData.length;
                    totalSize += size;
                    imageCount++;
                    console.log(`[이미지 검증] 빌딩 ${idx} 외관 ${imgIdx}: ${(size / 1024).toFixed(1)}KB`);
                });
            }
            
            // 평면도 이미지 검증
            if (item.floorPlanImages && item.floorPlanImages.length > 0) {
                item.floorPlanImages.forEach((img, imgIdx) => {
                    const imgData = typeof img === 'string' ? img : (img.url || '');
                    const size = imgData.length;
                    totalSize += size;
                    imageCount++;
                    console.log(`[이미지 검증] 빌딩 ${idx} 평면도 ${imgIdx}: ${(size / 1024).toFixed(1)}KB`);
                });
            }
            
            // 지도 이미지 검증
            if (item.mapImage) {
                const size = item.mapImage.length;
                totalSize += size;
                imageCount++;
                console.log(`[이미지 검증] 빌딩 ${idx} 지도: ${(size / 1024).toFixed(1)}KB`);
            }
        }
    });
    
    console.log(`[저장 준비] 총 이미지 ${imageCount}개, 총 크기: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);
    
    // Firebase 제한 경고 (약 8MB 이상이면 경고)
    if (totalSize > 8 * 1024 * 1024) {
        console.warn(`[경고] 데이터 크기가 ${(totalSize / 1024 / 1024).toFixed(2)}MB로 큽니다. 저장에 실패할 수 있습니다.`);
        showToast(`이미지 용량이 큽니다 (${(totalSize / 1024 / 1024).toFixed(1)}MB). 저장에 시간이 걸릴 수 있습니다.`, 'info');
    }
    
    return itemsCopy;
}

// 저장 (임시)
export async function saveDraft() {
    if (!state.currentGuide) return;

    try {
        const title = document.getElementById('editTitle')?.value?.trim();
        if (!title) {
            showToast('제목을 입력하세요', 'error');
            return;
        }

        const regionSummary = {};
        state.tocItems.forEach(item => {
            if (item.type === 'building') {
                const r = item.region || 'ETC';
                regionSummary[r] = (regionSummary[r] || 0) + 1;
            }
        });

        // ★ v2.3: Deep copy로 items 준비 (이미지 포함 검증)
        const itemsToSave = prepareItemsForSave(state.tocItems);
        
        console.log('[saveDraft] 저장할 items:', itemsToSave.length, '개');
        console.log('[saveDraft] 첫 번째 빌딩 이미지:', itemsToSave[0]?.exteriorImages?.length || 0, '개');

        // ★ v2.0: endingSettings와 customRegions도 Firebase에 저장
        const updateData = {
            title,
            items: itemsToSave,  // ★ v2.3: deep copy된 데이터 사용
            regionSummary,
            status: 'draft',
            coverSettings: state.coverSettings ? JSON.parse(JSON.stringify(state.coverSettings)) : {},
            endingSettings: state.endingSettings ? JSON.parse(JSON.stringify(state.endingSettings)) : {},
            customRegions: state.customRegions ? JSON.parse(JSON.stringify(state.customRegions)) : [],
            updatedAt: new Date().toISOString(),
            updatedBy: state.currentUser?.email
        };
        
        console.log('[saveDraft] Firebase 업데이트 시작...');
        await update(ref(db, `leasingGuides/${state.currentGuide.id}`), updateData);
        console.log('[saveDraft] Firebase 업데이트 완료!');

        // ★ v2.3: 로컬 상태도 deep copy로 업데이트
        state.leasingGuides[state.currentGuide.id] = {
            ...state.leasingGuides[state.currentGuide.id],
            title,
            items: JSON.parse(JSON.stringify(itemsToSave)),  // deep copy
            regionSummary,
            coverSettings: state.coverSettings ? JSON.parse(JSON.stringify(state.coverSettings)) : {},
            endingSettings: state.endingSettings ? JSON.parse(JSON.stringify(state.endingSettings)) : {},
            customRegions: state.customRegions ? JSON.parse(JSON.stringify(state.customRegions)) : []
        };
        
        showToast('임시 저장되었습니다', 'success');
    } catch (err) {
        console.error('저장 오류:', err);
        console.error('오류 상세:', err.message, err.code);
        showToast(`저장 중 오류가 발생했습니다: ${err.message || '알 수 없는 오류'}`, 'error');
    }
}

// 저장 (최종)
export async function saveFinal() {
    if (!state.currentGuide) return;

    const unconfirmed = state.tocItems.filter(t => t.type === 'building' && !t.closeConfirmed);
    if (unconfirmed.length > 0) {
        if (!confirm(`마감 미확정 빌딩이 ${unconfirmed.length}개 있습니다. 그래도 최종 저장하시겠습니까?`)) {
            return;
        }
    }

    try {
        const title = document.getElementById('editTitle')?.value?.trim();
        if (!title) {
            showToast('제목을 입력하세요', 'error');
            return;
        }

        const regionSummary = {};
        state.tocItems.forEach(item => {
            if (item.type === 'building') {
                const r = item.region || 'ETC';
                regionSummary[r] = (regionSummary[r] || 0) + 1;
            }
        });

        // ★ v2.3: Deep copy로 items 준비 (이미지 포함 검증)
        const itemsToSave = prepareItemsForSave(state.tocItems);
        
        console.log('[saveFinal] 저장할 items:', itemsToSave.length, '개');

        // ★ v2.0: endingSettings와 customRegions도 Firebase에 저장
        const updateData = {
            title,
            items: itemsToSave,  // ★ v2.3: deep copy된 데이터 사용
            regionSummary,
            status: 'published',
            coverSettings: state.coverSettings ? JSON.parse(JSON.stringify(state.coverSettings)) : {},
            endingSettings: state.endingSettings ? JSON.parse(JSON.stringify(state.endingSettings)) : {},
            customRegions: state.customRegions ? JSON.parse(JSON.stringify(state.customRegions)) : [],
            publishedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            updatedBy: state.currentUser?.email
        };
        
        console.log('[saveFinal] Firebase 업데이트 시작...');
        await update(ref(db, `leasingGuides/${state.currentGuide.id}`), updateData);
        console.log('[saveFinal] Firebase 업데이트 완료!');

        showToast('최종 저장되었습니다!', 'success');
        closeEditor();
    } catch (err) {
        console.error('저장 오류:', err);
        console.error('오류 상세:', err.message, err.code);
        showToast(`저장 중 오류가 발생했습니다: ${err.message || '알 수 없는 오류'}`, 'error');
    }
}

// 전역 함수 등록
export function registerListFunctions() {
    window.openCreateModal = openCreateModal;
    window.closeCreateModal = closeCreateModal;
    window.selectCreateType = selectCreateType;
    window.createGuide = createGuide;
    window.editGuide = editGuide;
    window.deleteGuide = deleteGuide;
    window.saveDraft = saveDraft;
    window.saveFinal = saveFinal;
    window.renderGuideList = renderGuideList;
    // ★ v5.6: 템플릿 관련 함수
    window.loadSavedTemplates = loadSavedTemplates;
    window.saveAsTemplate = saveAsTemplate;
    window.deleteTemplate = deleteTemplate;
    window.refreshTemplateSelect = refreshTemplateSelect;
}
