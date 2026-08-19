/**
 * Leasing Guide - 목록 및 CRUD
 * 안내문 목록 렌더링, 생성, 삭제 기능
 * 
 * v2.3 수정사항:
 * - saveDraft/saveFinal에서 deep copy 적용 (이미지 저장 버그 수정)
 * - 이미지 데이터 검증 로직 추가
 * - Firebase 저장 전 데이터 크기 경고
 */

import { state, db, ref, get, set, push, update, remove, getGuideType, setGuideType, setRetailRoundUnit } from './guide-state.js?v=5.5';
import { showToast, formatDate, getRegionName } from './guide-utils.js?v=5.10';
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
        
        // ★ 문서 타입 배지 (값이 없는 기존 안내문은 오피스)
        const isRetail = g.guideType === 'retail';
        const typeBadge = `<span class="guide-type-badge" style="font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px; ${
            isRetail ? 'background:#fdf2f8; color:#be185d;' : 'background:#eff6ff; color:#1d4ed8;'
        }">${isRetail ? '리테일' : '오피스'}</span>`;
        
        return `
            <div class="guide-card">
                <div class="guide-card-header">
                    <div class="guide-title">${g.title || '제목없음'}</div>
                    <div style="display:flex; gap:6px; align-items:center;">
                        ${typeBadge}
                        <span class="guide-status ${statusClass}">${statusText}</span>
                    </div>
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
            ${['GBD', 'YBD', 'CBD', 'BBD', 'MBD', 'ETC']
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

        // ★ #4: 모달 열 때 입력값 초기화 (이전 값·브라우저 자동완성에 다른 사용자 제목이 남는 문제 방지)
        const titleInput = document.getElementById('createTitle');
        if (titleInput) { titleInput.value = ''; titleInput.setAttribute('autocomplete', 'off'); }
        selectedTemplate = 'new';
        document.querySelectorAll('.option-card').forEach(c => c.classList.toggle('selected', c.dataset.type === 'new'));
        const prevGroup = document.getElementById('prevGuideGroup');
        if (prevGroup) prevGroup.style.display = 'none';

        // ★ 문서 타입 초기화 — 직전 생성에서 고른 타입이 다음 생성에 승계되는 것을 막는다
        selectedCreateGuideType = 'office';
        refreshCreateGuideTypeButtons();

        const tplSel = document.getElementById('coverTemplateSelect');
        if (tplSel) tplSel.value = '';

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

        // ★ v5.6→Firebase: 캐시 즉시 렌더 + 최신본 비동기 로드
        refreshTemplateSelect();
        refreshTemplatesFromFirebase();
    }
}

// 생성 모달 닫기
export function closeCreateModal() {
    const modal = document.getElementById('createModal');
    if (modal) modal.classList.remove('show');
}

// ★ 신규 생성 시 문서 타입 (HTML은 .position-btn + data-gtype + active 클래스 사용)
//   .option-card 계열과 클래스를 공유하지 않으므로 selectCreateType()의 토글과 간섭하지 않는다.
//   localStorage에 저장하지 않는다 — 문서 고유 속성이므로 승계되면 안 된다(guide-state.js 참조).
let selectedCreateGuideType = 'office';

// 타입 버튼 active 상태 반영 (생성 모달 내부로 한정 — 표지 설정의 타입 버튼과 무관)
function refreshCreateGuideTypeButtons() {
    document.querySelectorAll('#createModal [data-gtype]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.gtype === selectedCreateGuideType);
    });
}

// 문서 타입 선택 — cover 소유의 selectGuideType(생성 후 전환)과는 별개의 함수다
export function selectCreateGuideType(type) {
    selectedCreateGuideType = (type === 'retail') ? 'retail' : 'office';
    refreshCreateGuideTypeButtons();
}

// 생성 방식 선택 (HTML은 .option-card + selected 클래스 사용)
let selectedTemplate = 'new';
export function selectCreateType(type) {
    selectedTemplate = type;
    document.querySelectorAll('.option-card').forEach(c => c.classList.toggle('selected', c.dataset.type === type));
    // 이전호 재활용 선택 시 안내문 목록 노출·채우기
    const prevGroup = document.getElementById('prevGuideGroup');
    if (prevGroup) prevGroup.style.display = (type === 'prev') ? 'block' : 'none';
    if (type === 'prev') {
        const sel = document.getElementById('prevGuideSelect');
        if (sel) {
            const guides = Object.entries(state.leasingGuides || {})
                .map(([id, g]) => ({ id, ...g }))
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
            sel.innerHTML = '<option value="">-- 선택하세요 --</option>'
                + guides.map(g => `<option value="${g.id}">${(g.title || '제목 없음').replace(/</g, '&lt;')}</option>`).join('');
        }
    }
}

// ★ v6: 표지/엔딩 템플릿 — Firebase 저장 (공통 shared / 개별 users/{uid})
//   기존 호출부가 동기 loadSavedTemplates()를 쓰므로, 인메모리 캐시를 두고
//   백그라운드로 Firebase에서 받아와 캐시·UI를 갱신한다.
const TPL_SHARED_PATH = 'guideCoverTemplates/shared';
const TPL_USERS_PATH  = 'guideCoverTemplates/users';
let _templateCache = [];

function _sanitizeUid(u) {
    return String(u || 'unknown').replace(/[.#$\[\]\/@]/g, '_');
}
function _currentUid() {
    const u = state.currentUser || {};
    return _sanitizeUid(u.uid || u.email || u.name || 'unknown');
}
function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// 동기 스냅샷 반환 (기존 호출부 호환)
export function loadSavedTemplates() {
    return _templateCache;
}

// Firebase에서 공통+개별 템플릿을 받아 캐시·UI 갱신
export async function refreshTemplatesFromFirebase() {
    try {
        const uid = _currentUid();
        const [sharedSnap, personalSnap] = await Promise.all([
            get(ref(db, TPL_SHARED_PATH)),
            get(ref(db, `${TPL_USERS_PATH}/${uid}`))
        ]);
        const out = [];
        if (sharedSnap.exists()) {
            Object.entries(sharedSnap.val()).forEach(([id, t]) => out.push({ id, scope: 'shared', ...(t || {}) }));
        }
        if (personalSnap.exists()) {
            Object.entries(personalSnap.val()).forEach(([id, t]) => out.push({ id, scope: 'personal', ...(t || {}) }));
        }
        // 공통 먼저 → 같은 그룹 내 최신순
        out.sort((a, b) => (a.scope === b.scope
            ? String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
            : (a.scope === 'shared' ? -1 : 1)));
        _templateCache = out;
    } catch (e) {
        console.error('템플릿 로드 오류:', e);
    }
    // UI 갱신 (셀렉트 + 열려있으면 관리 모달 목록)
    refreshTemplateSelect();
    if (typeof window._rerenderTemplateManagerList === 'function') window._rerenderTemplateManagerList();
    return _templateCache;
}

// 템플릿 저장 (scope: 'shared'=공통 공유 / 'personal'=개별) — guide-cover.js에서 호출
export async function saveAsTemplate(name, coverSettings, endingSettings, scope) {
    scope = (scope === 'shared') ? 'shared' : 'personal';
    const uid = _currentUid();
    const base = scope === 'shared' ? TPL_SHARED_PATH : `${TPL_USERS_PATH}/${uid}`;
    const newRef = push(ref(db, base));
    const payload = {
        name,
        scope,
        coverSettings: JSON.parse(JSON.stringify(coverSettings || {})),
        endingSettings: JSON.parse(JSON.stringify(endingSettings || {})),
        createdAt: new Date().toISOString(),
        createdBy: state.currentUser?.email || state.currentUser?.name || 'unknown'
    };
    await set(newRef, payload);
    await refreshTemplatesFromFirebase();
    return { id: newRef.key, ...payload };
}

// 템플릿 삭제 (scope 미지정 시 캐시에서 추론)
export async function deleteTemplate(id, scope) {
    if (!scope) {
        const t = _templateCache.find(x => x.id === id);
        scope = t?.scope || 'personal';
    }
    const uid = _currentUid();
    const tplPath = scope === 'shared' ? `${TPL_SHARED_PATH}/${id}` : `${TPL_USERS_PATH}/${uid}/${id}`;
    await remove(ref(db, tplPath));
    await refreshTemplatesFromFirebase();
}

// 신규 생성 모달의 표지/엔딩 셀렉트박스 갱신 (공통/개별 그룹 분리)
function refreshTemplateSelect() {
    const sel = document.getElementById('coverTemplateSelect');
    if (!sel) return;
    const prev = sel.value;
    const shared = _templateCache.filter(t => t.scope === 'shared');
    const personal = _templateCache.filter(t => t.scope === 'personal');
    let html = '<option value="">-- 없음 (기본값) --</option>';
    if (shared.length) {
        html += '<optgroup label="📌 공통 템플릿">';
        shared.forEach(t => { html += `<option value="shared:${t.id}">${_escHtml(t.name)}</option>`; });
        html += '</optgroup>';
    }
    if (personal.length) {
        html += '<optgroup label="👤 내 템플릿">';
        personal.forEach(t => { html += `<option value="personal:${t.id}">${_escHtml(t.name)}</option>`; });
        html += '</optgroup>';
    }
    sel.innerHTML = html;
    // 이전 선택 유지 시도
    if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
    const delBtn = document.getElementById('deleteTemplateBtn');
    if (delBtn) delBtn.style.display = 'none'; // 삭제는 템플릿 관리 모달에서
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

    // ★ 문서 타입 — 저장값(Firebase)과 화면 state가 갈리지 않도록 한 값을 두 곳에 함께 쓴다
    const gt = (selectedCreateGuideType === 'retail') ? 'retail' : 'office';

    // ★ v6: 선택된 표지/엔딩 템플릿 적용 (값 형식: "scope:id")
    const selVal = document.getElementById('coverTemplateSelect')?.value || '';
    let appliedCoverSettings = null;
    let appliedEndingSettings = null;
    if (selVal) {
        const [scope, tid] = selVal.includes(':') ? selVal.split(':') : ['', selVal];
        const tpl = _templateCache.find(t => t.id === tid && (!scope || t.scope === scope));
        if (tpl) {
            appliedCoverSettings = JSON.parse(JSON.stringify(tpl.coverSettings || {}));
            appliedEndingSettings = JSON.parse(JSON.stringify(tpl.endingSettings || {}));
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
            guideType: gt,   // ★ 생성 모달에서 선택한 타입 (생성 후 표지 설정에서 전환 가능)
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
        setGuideType(gt);   // ★ 저장값과 동일하게 — 직전 안내문 타입이 승계되지 않도록 항상 명시 설정

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
        // ★ #4: 편집기 제목칸을 방금 입력한 제목으로 보정 (openEditor가 채우지 않거나 stale 값이 남는 경우 방지)
        setTimeout(() => {
            const et = document.getElementById('editTitle');
            if (et) et.value = title;
        }, 60);
        
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
    
    // ★ 문서 타입 로드 (값이 없는 기존 안내문은 'office')
    setGuideType(guide.guideType || 'office');
    setRetailRoundUnit(guide.retailRoundUnit);   // ★ 절삭 단위 (없으면 원 단위)
    
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
            guideType: getGuideType(),   // ★ 문서 타입
            retailRoundUnit: state.retailRoundUnit ?? 0,   // ★ 리테일 월 총액 절삭 단위(문서 기본)
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
            guideType: getGuideType(),   // ★ 목록 배지 즉시 반영
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
            guideType: getGuideType(),   // ★ 문서 타입
            retailRoundUnit: state.retailRoundUnit ?? 0,   // ★ 리테일 월 총액 절삭 단위(문서 기본)
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
    window.selectCreateGuideType = selectCreateGuideType;   // ★ 생성 모달 문서 타입 선택
    window.createGuide = createGuide;
    window.editGuide = editGuide;
    window.deleteGuide = deleteGuide;
    window.saveDraft = saveDraft;
    window.saveFinal = saveFinal;
    window.renderGuideList = renderGuideList;
    // ★ v6: 템플릿 함수 (Firebase 공통/개별)
    window.loadSavedTemplates = loadSavedTemplates;
    window.saveAsTemplate = saveAsTemplate;
    window.deleteTemplate = deleteTemplate;
    window.refreshTemplateSelect = refreshTemplateSelect;
    window.refreshTemplatesFromFirebase = refreshTemplatesFromFirebase;
    // 시작 시 캐시 1회 채우기 (currentUser·db는 이 시점에 준비됨)
    refreshTemplatesFromFirebase();
}
