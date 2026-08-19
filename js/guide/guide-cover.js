/**
 * Leasing Guide - 표지/엔딩/권역 에디터
 * 표지 템플릿, 엔딩 페이지, 커스텀 권역 관리
 */

import { state, DEFAULT_REGIONS, getAllRegions, addCustomRegion, removeCustomRegion, setEndingSettings, saveSettingsToLocal, loadSettingsFromLocal, setRegionAlias, removeRegionAlias, getRegionAlias, getGuideType, setGuideType } from './guide-state.js?v=5.4';
import { showToast } from './guide-utils.js?v=5.9';

// coverSettings 로드
export function loadCoverSettings(guide) {
    // 먼저 localStorage에서 로드 시도
    const localLoaded = loadSettingsFromLocal();
    
    // ★ v2.0: localStorage의 이미지 데이터 보존
    const localLogoImage = state.coverSettings?.logoImage || null;
    const localEndingImages = state.endingSettings?.images ? [...state.endingSettings.images] : [];
    
    // Firebase 데이터가 있으면 덮어쓰기 (우선순위: Firebase > localStorage)
    if (guide.coverSettings) {
        state.coverSettings = JSON.parse(JSON.stringify(guide.coverSettings));
    } else if (!localLoaded) {
        state.coverSettings = {
            template: 'tpl-sni',
            title: guide.title || 'Leasing Information',
            subtitle: '',
            logoImage: null,
            logoPosition: 'right',
            slogan: 'Best Space For A Better Life'
        };
    }
    
    // 엔딩 설정 로드 (Firebase 데이터가 있으면 덮어쓰기)
    if (guide.endingSettings) {
        state.endingSettings = { ...state.endingSettings, ...guide.endingSettings };
    }
    
    // ★ v2.0: 이미지 복원 - Firebase에 이미지가 없으면 localStorage 이미지 사용
    // 로고 이미지 복원
    if (!state.coverSettings.logoImage && localLogoImage) {
        state.coverSettings.logoImage = localLogoImage;
        console.log('[Cover] 로고 이미지 복원됨 (localStorage)');
    }
    
    // 엔딩 이미지 복원
    if (localEndingImages.length > 0) {
        const firebaseImages = state.endingSettings?.images || [];
        const hasFirebaseImages = firebaseImages.some(img => img && img.length > 0);
        
        if (!hasFirebaseImages) {
            // Firebase에 이미지가 없으면 localStorage 이미지 전체 사용
            state.endingSettings.images = localEndingImages;
            console.log('[Cover] 엔딩 이미지 복원됨 (localStorage):', localEndingImages.filter(Boolean).length, '개');
        } else {
            // Firebase에 이미지가 있으면 빈 슬롯만 localStorage로 채우기
            state.endingSettings.images = firebaseImages.map((img, i) => {
                return img || localEndingImages[i] || null;
            });
            console.log('[Cover] 엔딩 이미지 병합됨 (Firebase + localStorage)');
        }
    }
    
    // 커스텀 권역 로드
    if (guide.customRegions) {
        state.customRegions = guide.customRegions;
    }
    
    console.log('[Cover] 설정 로드 완료 (localStorage:', localLoaded, ')');
}

// 표지 에디터 렌더링
export function renderCoverEditor() {
    const editorMain = document.getElementById('editorMain');
    if (!editorMain) return;
    
    const cs = state.coverSettings;
    
    editorMain.innerHTML = `
        <div class="cover-editor" style="padding: 24px 32px;">
            <div class="cover-editor-header">
                <h3>📋 표지 설정</h3>
                <div style="display:flex; gap:8px;">
                    <button class="btn btn-sm btn-secondary" onclick="openEndingEditor()">📄 엔딩 설정</button>
                    <button class="btn btn-sm btn-secondary" onclick="openRegionManager()">🗺️ 권역 관리</button>
                    <button class="btn btn-sm btn-secondary" style="background:#fdf2f8; color:#be185d; border-color:#f9a8d4;" onclick="openTemplateManager()">💾 템플릿 관리</button>
                    <button class="btn btn-sm btn-primary" onclick="openPrintPage()">🖨️ 출력</button>
                </div>
            </div>
            
            <!-- ★ 문서 타입 (오피스 / 리테일) -->
            <div class="cover-setting-group" style="margin-top: 20px;">
                <label class="cover-setting-label">문서 타입</label>
                <div class="position-btn-group" style="max-width:320px;">
                    <button type="button" class="position-btn ${getGuideType() === 'office' ? 'active' : ''}" onclick="event.stopPropagation(); selectGuideType('office')">🏢 오피스</button>
                    <button type="button" class="position-btn ${getGuideType() === 'retail' ? 'active' : ''}" onclick="event.stopPropagation(); selectGuideType('retail')">🛍️ 리테일</button>
                </div>
                <div style="font-size:11px; color:var(--text-muted); margin-top:6px;">
                    공실표·임대조건 표 구성이 타입에 따라 달라집니다.
                </div>
            </div>
            
            <!-- 로고 업로드 -->
            <div class="cover-setting-group" style="margin-top: 20px;">
                <label class="cover-setting-label">로고 이미지</label>
                <div style="display:flex; gap:24px; align-items:flex-start;">
                    <div class="image-slot-small" onclick="uploadCoverImage('logo')">
                        ${cs.logoImage ? 
                            `<img src="${cs.logoImage}" alt="로고"><button class="remove-btn" onclick="event.stopPropagation(); removeCoverImage('logo')">×</button>` : 
                            '<span class="placeholder">🖼️ 로고</span>'}
                    </div>
                    <div class="logo-position-selector">
                        <span style="font-size:12px; color:var(--text-muted); margin-bottom:8px; display:block;">로고 위치</span>
                        <div class="position-btn-group">
                            <button type="button" class="position-btn ${cs.logoPosition === 'left' ? 'active' : ''}" onclick="event.stopPropagation(); setLogoPosition('left')">◀ 왼쪽</button>
                            <button type="button" class="position-btn ${cs.logoPosition === 'center' ? 'active' : ''}" onclick="event.stopPropagation(); setLogoPosition('center')">● 중앙</button>
                            <button type="button" class="position-btn ${cs.logoPosition === 'right' ? 'active' : ''}" onclick="event.stopPropagation(); setLogoPosition('right')">오른쪽 ▶</button>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- 텍스트 설정 (한 줄에 3개) -->
            <div class="cover-setting-group" style="margin-top: 24px;">
                <label class="cover-setting-label">타이틀 & 슬로건</label>
                <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px;">
                    <div>
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">메인 타이틀</div>
                        <input type="text" class="cover-setting-input" value="${cs.title || ''}" onchange="updateCoverSetting('title', this.value)" placeholder="Leasing Information">
                    </div>
                    <div>
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">서브 타이틀</div>
                        <input type="text" class="cover-setting-input" value="${cs.subtitle || ''}" onchange="updateCoverSetting('subtitle', this.value)" placeholder="2025년 1월">
                    </div>
                    <div>
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:6px;">슬로건</div>
                        <input type="text" class="cover-setting-input" value="${cs.slogan || ''}" onchange="updateCoverSetting('slogan', this.value)" placeholder="Best Space For A Better Life">
                    </div>
                </div>
            </div>
            
            <!-- 실시간 미리보기: 표지 + 엔딩 (크게) -->
            <div class="cover-setting-group" style="margin-top: 28px;">
                <label class="cover-setting-label">미리보기</label>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:24px;">
                    <div>
                        <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px; text-align:center; font-weight:600;">📄 표지</div>
                        <div class="cover-preview-large" id="coverPreviewArea">
                            ${renderCoverPreview(cs)}
                        </div>
                    </div>
                    <div>
                        <div style="font-size:12px; color:var(--text-muted); margin-bottom:8px; text-align:center; font-weight:600;">📄 엔딩</div>
                        <div class="cover-preview-large ending-preview-large" id="endingPreviewMini">
                            ${renderEndingMiniPreview()}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // 파일 input 추가
    if (!document.getElementById('coverImageInput')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'coverImageInput';
        input.accept = 'image/*';
        input.style.display = 'none';
        input.onchange = handleCoverImageUpload;
        document.body.appendChild(input);
    }
}

// 표지 미리보기 렌더링 (인라인)
export function renderCoverPreview(cs) {
    const logoJustify = cs.logoPosition === 'left' ? 'flex-start' : 
                       cs.logoPosition === 'center' ? 'center' : 'flex-end';
    
    return `
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
    `;
}

// 엔딩 미니 미리보기 렌더링 (표지 설정 페이지용)
function renderEndingMiniPreview() {
    const es = state.endingSettings;
    const images = es.images || [];
    const accentColor = es.accentColor || '#ec4899';
    
    if (es.enabled === false) {
        return `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:rgba(255,255,255,0.5); font-size:14px;">엔딩 페이지 비활성화됨</div>`;
    }
    
    return `
        <div style="width:100%; height:100%; background:#1a1f2e; display:grid; grid-template-columns:45% 55%; overflow:hidden;">
            <div style="padding:20px; display:flex; flex-direction:column; justify-content:space-between;">
                <div>
                    <div style="font-size:11px; color:${accentColor}; line-height:1.5;">
                        ${es.headline1 || '사람을 먼저 생각하는,'}<br>
                        ${es.headline2 || '고객의 미래를 위하는,'}<br>
                        ${es.headline3 || '공간을 혁신하는,'}
                    </div>
                    <div style="font-size:16px; font-weight:700; color:white; margin-top:8px;">${es.companyName || '에스앤아이 코퍼레이션'}</div>
                </div>
                <div style="font-size:8px; color:rgba(255,255,255,0.6); line-height:1.5;">
                    ${[1,2,3,4,5].map(n => es['description' + n] || '').filter(Boolean).join('<br>')}
                </div>
                <div>
                    <div style="font-size:22px; font-weight:700; color:${accentColor};">${es.thankYouText || 'THANK YOU'}</div>
                    <div style="font-size:8px; color:rgba(255,255,255,0.5); margin-top:4px;">${es.slogan || ''}</div>
                </div>
            </div>
            <div style="display:grid; grid-template-columns:repeat(2, 1fr); grid-template-rows:repeat(4, 1fr); gap:2px; padding:4px;">
                ${[0,1,2,3,4,5,6,7].map(i => {
                    const img = images[i];
                    return `<div style="background:#2d3748; border-radius:2px; overflow:hidden;">
                        ${img ? `<img src="${img}" style="width:100%; height:100%; object-fit:cover;">` : ''}
                    </div>`;
                }).join('')}
            </div>
        </div>
    `;
}

// 표지 전체 미리보기 모달
export function openCoverPreviewModal() {
    const cs = state.coverSettings;
    const logoJustify = cs.logoPosition === 'left' ? 'flex-start' : 
                       cs.logoPosition === 'center' ? 'center' : 'flex-end';
    
    const modalHtml = `
        <div class="modal-overlay show" id="coverPreviewModal" onclick="if(event.target===this)closeCoverPreviewModal()">
            <div class="cover-preview-full">
                <button class="preview-close-btn" onclick="closeCoverPreviewModal()">×</button>
                <div class="cover-bg">
                    <svg class="skyline" viewBox="0 0 400 60" preserveAspectRatio="none">
                        <path d="M0,60 L0,45 L15,45 L15,30 L25,30 L25,45 L35,45 L35,20 L50,20 L50,45 L60,45 L60,35 L75,35 L75,45 L85,45 L85,15 L100,15 L100,45 L110,45 L110,40 L125,40 L125,45 L135,45 L135,25 L150,25 L150,45 L160,45 L160,10 L180,10 L180,45 L190,45 L190,30 L205,30 L205,45 L215,45 L215,20 L230,20 L230,45 L240,45 L240,35 L255,35 L255,45 L265,45 L265,25 L280,25 L280,45 L290,45 L290,15 L310,15 L310,45 L320,45 L320,40 L335,40 L335,45 L345,45 L345,30 L360,30 L360,45 L370,45 L370,20 L385,20 L385,45 L400,45 L400,60 Z" fill="rgba(255,255,255,0.15)"/>
                    </svg>
                </div>
                <div class="cover-content">
                    <div class="cover-logo" style="justify-content:${logoJustify}">
                        ${cs.logoImage ? `<img src="${cs.logoImage}" alt="Logo">` : '<div class="logo-placeholder">LOGO</div>'}
                    </div>
                    <div class="cover-text">
                        <div class="cover-title">${cs.title || 'Leasing Information'}</div>
                        ${cs.subtitle ? `<div class="cover-subtitle">${cs.subtitle}</div>` : ''}
                    </div>
                    <div class="cover-slogan">${cs.slogan || 'Best Space For A Better Life'}</div>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// 표지 미리보기 모달 닫기
export function closeCoverPreviewModal() {
    const modal = document.getElementById('coverPreviewModal');
    if (modal) modal.remove();
}

// 템플릿 선택
export function selectCoverTemplate(tpl) {
    state.coverSettings.template = tpl;
    renderCoverEditor();
}

// ★ 문서 타입 전환 (오피스 / 리테일)
//   부제(subtitle)는 "비어 있을 때만" 자동으로 채운다 — 사용자가 직접 입력한 값은 보존
export function selectGuideType(type) {
    setGuideType(type);
    
    if (!state.coverSettings.subtitle) {
        const auto = buildAutoSubtitle();
        if (auto) state.coverSettings.subtitle = auto;
    }
    
    renderCoverEditor();
}

// ★ 표지 부제 자동값: 'S&I Corp. YYYY년 M월 리테일 임대안내문'
//   연·월은 안내문 생성 시 입력한 publishYear/publishMonth를 쓰고, 없으면 오늘 날짜로 대체
function buildAutoSubtitle() {
    const g = state.currentGuide || {};
    const now = new Date();
    const y = String(g.publishYear || now.getFullYear()).trim();
    const m = String(g.publishMonth || (now.getMonth() + 1)).trim().replace(/^0+/, '');
    if (!y || !m) return '';
    const label = getGuideType() === 'retail' ? '리테일' : '오피스';
    return `S&I Corp. ${y}년 ${m}월 ${label} 임대안내문`;
}

// 설정 업데이트
export function updateCoverSetting(field, value) {
    state.coverSettings[field] = value;
    saveSettingsToLocal(); // localStorage에 저장
    
    const preview = document.getElementById('coverPreviewArea');
    if (preview) {
        preview.className = 'cover-preview-large ' + state.coverSettings.template;
        preview.innerHTML = renderCoverPreview(state.coverSettings);
    }
}

// 로고 위치 설정
export function setLogoPosition(position) {
    state.coverSettings.logoPosition = position;
    saveSettingsToLocal(); // localStorage에 저장
    renderCoverEditor();
}

// 이미지 업로드
let currentCoverImageType = null;
export function uploadCoverImage(type) {
    currentCoverImageType = type;
    document.getElementById('coverImageInput')?.click();
}

function handleCoverImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(ev) {
        if (currentCoverImageType === 'logo') {
            state.coverSettings.logoImage = ev.target.result;
        } else {
            state.coverSettings.coverImage = ev.target.result;
        }
        saveSettingsToLocal(); // localStorage에 저장
        renderCoverEditor();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

// 이미지 삭제
export function removeCoverImage(type) {
    if (type === 'logo') {
        state.coverSettings.logoImage = null;
    } else {
        state.coverSettings.coverImage = null;
    }
    saveSettingsToLocal(); // localStorage에 저장
    renderCoverEditor();
}

// ========== 엔딩 페이지 에디터 ==========
export function openEndingEditor() {
    const es = state.endingSettings;
    const images = es.images || [];
    
    const modalHtml = `
        <div class="modal-overlay show" id="endingEditorModal" onclick="if(event.target===this)closeEndingEditor()">
            <div class="modal" style="max-width:1100px; max-height:95vh;">
                <div class="modal-header" style="background:linear-gradient(135deg, #ec4899 0%, #be185d 100%); color:white;">
                    <h2 class="modal-title">📄 엔딩 페이지 설정</h2>
                    <button class="modal-close" onclick="closeEndingEditor()" style="color:white;">×</button>
                </div>
                <div class="modal-body" style="max-height:calc(95vh - 140px); overflow-y:auto; padding:0;">
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:0;">
                        <!-- 좌측: 설정 -->
                        <div style="padding:24px; border-right:1px solid var(--border-color);">
                            <!-- 활성화 체크 -->
                            <div class="setting-row" style="margin-bottom:16px;">
                                <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
                                    <input type="checkbox" id="endingEnabled" ${es.enabled !== false ? 'checked' : ''} onchange="updateEndingSetting('enabled', this.checked)">
                                    <span style="font-weight:600;">엔딩 페이지 사용</span>
                                </label>
                            </div>
                            
                            <!-- 헤드라인 -->
                            <div class="setting-group" style="margin-bottom:16px;">
                                <label style="font-weight:600; margin-bottom:8px; display:block;">헤드라인 (3줄)</label>
                                <input type="text" value="${es.headline1 || ''}" placeholder="사람을 먼저 생각하는," onchange="updateEndingSetting('headline1', this.value)" style="width:100%; padding:8px; margin-bottom:6px; border:1px solid var(--border-color); border-radius:4px;">
                                <input type="text" value="${es.headline2 || ''}" placeholder="고객의 미래를 위하는," onchange="updateEndingSetting('headline2', this.value)" style="width:100%; padding:8px; margin-bottom:6px; border:1px solid var(--border-color); border-radius:4px;">
                                <input type="text" value="${es.headline3 || ''}" placeholder="공간을 혁신하는," onchange="updateEndingSetting('headline3', this.value)" style="width:100%; padding:8px; border:1px solid var(--border-color); border-radius:4px;">
                            </div>
                            
                            <!-- 회사명 -->
                            <div class="setting-group" style="margin-bottom:16px;">
                                <label style="font-weight:600; margin-bottom:8px; display:block;">회사명</label>
                                <input type="text" value="${es.companyName || ''}" placeholder="에스앤아이 코퍼레이션" onchange="updateEndingSetting('companyName', this.value)" style="width:100%; padding:8px; border:1px solid var(--border-color); border-radius:4px;">
                            </div>
                            
                            <!-- 설명문 (5줄) -->
                            <div class="setting-group" style="margin-bottom:16px;">
                                <label style="font-weight:600; margin-bottom:8px; display:block;">설명문 (5줄)</label>
                                ${[1,2,3,4,5].map(n => `
                                    <input type="text" value="${es['description' + n] || ''}" placeholder="설명문 ${n}행"
                                           onchange="updateEndingSetting('description${n}', this.value)"
                                           style="width:100%; padding:8px; margin-bottom:6px; border:1px solid var(--border-color); border-radius:4px;">
                                `).join('')}
                            </div>
                            
                            <!-- 감사 인사 & 슬로건 -->
                            <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
                                <div class="setting-group">
                                    <label style="font-weight:600; margin-bottom:8px; display:block;">감사 인사</label>
                                    <input type="text" value="${es.thankYouText || ''}" placeholder="THANK YOU" onchange="updateEndingSetting('thankYouText', this.value)" style="width:100%; padding:8px; border:1px solid var(--border-color); border-radius:4px;">
                                </div>
                                <div class="setting-group">
                                    <label style="font-weight:600; margin-bottom:8px; display:block;">강조 색상</label>
                                    <input type="color" value="${es.accentColor || '#ec4899'}" onchange="updateEndingSetting('accentColor', this.value)" style="width:100%; height:38px; cursor:pointer; border:1px solid var(--border-color); border-radius:4px;">
                                </div>
                            </div>
                            
                            <!-- 슬로건 -->
                            <div class="setting-group" style="margin-bottom:16px;">
                                <label style="font-weight:600; margin-bottom:8px; display:block;">슬로건</label>
                                <input type="text" value="${es.slogan || ''}" placeholder="공간에 가치를 더하는 공/간/관/리/전/문/가" onchange="updateEndingSetting('slogan', this.value)" style="width:100%; padding:8px; border:1px solid var(--border-color); border-radius:4px;">
                            </div>
                            
                            <!-- 이미지 업로드 -->
                            <div class="setting-group">
                                <label style="font-weight:600; margin-bottom:8px; display:block;">이미지 (최대 8개)</label>
                                <div class="ending-images-grid" id="endingImagesGrid">
                                    ${[0,1,2,3,4,5,6,7].map(i => {
                                        const img = images[i];
                                        return `
                                            <div class="ending-image-slot ${img ? 'has-image' : ''}" onclick="uploadEndingImage(${i})">
                                                ${img ? 
                                                    `<img src="${img}" alt="이미지${i+1}"><button class="remove-btn" onclick="event.stopPropagation(); removeEndingImage(${i})">×</button>` : 
                                                    '<span class="placeholder">+</span>'}
                                            </div>
                                        `;
                                    }).join('')}
                                </div>
                            </div>
                        </div>
                        
                        <!-- 우측: 미리보기 -->
                        <div style="padding:24px; background:var(--bg-secondary);">
                            <label style="font-weight:600; margin-bottom:12px; display:block;">미리보기</label>
                            <div class="ending-preview" id="endingPreviewArea">
                                ${renderEndingPreview(es)}
                            </div>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="resetEndingToDefault()">기본값 복원</button>
                    <button class="btn btn-primary" onclick="closeEndingEditor()">확인</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // 이미지 input 추가
    if (!document.getElementById('endingImageInput')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'endingImageInput';
        input.accept = 'image/*';
        input.style.display = 'none';
        input.onchange = handleEndingImageUpload;
        document.body.appendChild(input);
    }
}

// 엔딩 미리보기 렌더링
function renderEndingPreview(es) {
    const images = es.images || [];
    const accentColor = es.accentColor || '#ec4899';
    
    return `
        <div class="ending-preview-content" style="background:#1a1f2e; aspect-ratio:297/210; border-radius:8px; display:grid; grid-template-columns:45% 55%; overflow:hidden;">
            <div class="ending-preview-left" style="padding:20px; display:flex; flex-direction:column; justify-content:space-between;">
                <div>
                    <div style="font-size:12px; color:${accentColor}; line-height:1.6;">
                        ${es.headline1 || ''}<br>
                        ${es.headline2 || ''}<br>
                        ${es.headline3 || ''}
                    </div>
                    <div style="font-size:16px; font-weight:700; color:white; margin-top:8px;">${es.companyName || ''}</div>
                </div>
                <div style="font-size:8px; color:rgba(255,255,255,0.6); line-height:1.5;">
                    ${[1,2,3,4,5].map(n => es['description' + n] || '').filter(Boolean).join('<br>')}
                </div>
                <div>
                    <div style="font-size:24px; font-weight:700; color:${accentColor}; margin-bottom:4px;">${es.thankYouText || 'THANK YOU'}</div>
                    <div style="font-size:8px; color:rgba(255,255,255,0.5); margin-bottom:4px;">${es.closingText || ''}</div>
                    <div style="font-size:9px; color:rgba(255,255,255,0.6);">${es.slogan || ''}</div>
                </div>
            </div>
            <div class="ending-preview-right" style="display:grid; grid-template-columns:repeat(2, 1fr); grid-template-rows:repeat(4, 1fr); gap:2px; padding:4px;">
                ${[0,1,2,3,4,5,6,7].map(i => {
                    const img = images[i];
                    return `
                        <div style="background:#2d3748; border-radius:2px; overflow:hidden;">
                            ${img ? `<img src="${img}" style="width:100%; height:100%; object-fit:cover;">` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

// 엔딩 이미지 업로드
let currentEndingImageIndex = 0;
export function uploadEndingImage(index) {
    currentEndingImageIndex = index;
    document.getElementById('endingImageInput').click();
}

function handleEndingImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (ev) => {
        if (!state.endingSettings.images) {
            state.endingSettings.images = [];
        }
        state.endingSettings.images[currentEndingImageIndex] = ev.target.result;
        saveSettingsToLocal(); // localStorage에 저장
        refreshEndingEditor();
    };
    reader.readAsDataURL(file);
    e.target.value = '';
}

export function removeEndingImage(index) {
    if (state.endingSettings.images) {
        state.endingSettings.images[index] = null;
        saveSettingsToLocal(); // localStorage에 저장
        refreshEndingEditor();
    }
}

function refreshEndingEditor() {
    closeEndingEditor();
    openEndingEditor();
    // 표지 설정 화면의 엔딩 미리보기도 업데이트
    const endingPreview = document.getElementById('endingPreviewMini');
    if (endingPreview) {
        endingPreview.innerHTML = renderEndingMiniPreview();
    }
}

export function closeEndingEditor() {
    const modal = document.getElementById('endingEditorModal');
    if (modal) modal.remove();
}

export function updateEndingSetting(field, value) {
    state.endingSettings[field] = value;
    saveSettingsToLocal(); // localStorage에 저장
}

export function resetEndingToDefault() {
    if (!confirm('엔딩 설정을 기본값으로 복원하시겠습니까?')) return;
    
    state.endingSettings = {
        enabled: true,
        headline1: '사람을 먼저 생각하는,',
        headline2: '고객의 미래를 위하는,',
        headline3: '공간을 혁신하는,',
        companyName: '에스앤아이 코퍼레이션',
        description1: '공간에 대한 전문성과 혁신은 고객을 위한 것이어야 합니다',
        description2: '우리는 공간에 대한 최고의 전문성과 앞선 기술력을 바탕으로',
        description3: '고객의 비즈니스 성공을 지원하고 품격 있는 시간을 제공합니다',
        description4: '사람이 없는 공간은 공허하고 무의미하기에',
        description5: '우리는 언제나 사람을 먼저 생각하는 공간을 만들어 가겠습니다',
        thankYouText: 'THANK YOU',
        closingText: '고객이 신뢰할 수 있는 관리를 수행하겠습니다',
        slogan: '공간에 가치를 더하는 공/간/관/리/전/문/가',
        accentColor: '#ec4899',
        images: []
    };
    
    closeEndingEditor();
    openEndingEditor();
    showToast('기본값으로 복원되었습니다', 'success');
}

// ========== 커스텀 권역 관리 ==========

// 자동 코드 생성 함수
function generateRegionCode(nameEn) {
    const allRegions = getAllRegions();
    
    if (nameEn) {
        // 영문명에서 알파벳만 추출하고 앞 3글자 대문자
        const cleaned = nameEn.replace(/[^a-zA-Z]/g, '').toUpperCase();
        let baseCode = cleaned.substring(0, 3) || 'REG';
        
        // 중복 체크 후 숫자 추가
        let finalCode = baseCode;
        let counter = 1;
        while (allRegions.find(r => r.code === finalCode)) {
            finalCode = baseCode + counter;
            counter++;
        }
        return finalCode;
    }
    
    // 영문명이 없으면 REG + 순차번호
    let counter = 1;
    while (allRegions.find(r => r.code === `REG${counter}`)) {
        counter++;
    }
    return `REG${counter}`;
}

export function openRegionManager() {
    const allRegions = getAllRegions();
    
    const modalHtml = `
        <div class="modal-overlay show" id="regionManagerModal" onclick="if(event.target===this)closeRegionManager()">
            <div class="modal" style="max-width:800px;">
                <div class="modal-header" style="background:linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color:white;">
                    <h2 class="modal-title">🗺️ 권역 관리</h2>
                    <button class="modal-close" onclick="closeRegionManager()" style="color:white;">×</button>
                </div>
                <div class="modal-body" style="max-height:70vh; overflow-y:auto;">
                    <!-- 안내 메시지 -->
                    <div class="region-info-box" style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:14px 16px; margin-bottom:20px;">
                        <div style="font-size:13px; font-weight:600; color:#1e40af; margin-bottom:6px;">💡 권역 관리 안내</div>
                        <ul style="font-size:12px; color:#3b82f6; margin:0; padding-left:18px; line-height:1.7;">
                            <li><strong>기본 권역 별칭</strong>: 이 임대안내문에서만 표시되는 이름을 설정할 수 있습니다 (원본 유지)</li>
                            <li><strong>빌딩 권역 변경</strong>: 목차에서 빌딩을 드래그하거나, 빌딩 편집 화면에서 권역을 변경할 수 있습니다</li>
                            <li><strong>새 권역 추가</strong>: 아래에서 새로운 권역을 추가할 수 있습니다</li>
                        </ul>
                    </div>
                    
                    <!-- 기본 권역 (별칭 수정 가능) -->
                    <div class="region-section">
                        <h4>🏢 기본 권역 <span style="font-weight:400; font-size:12px; color:var(--text-muted);">(별칭 설정으로 표시명 변경 가능)</span></h4>
                        <div class="region-list">
                            ${DEFAULT_REGIONS.map(r => {
                                const alias = getRegionAlias(r.code);
                                const hasAlias = alias && (alias.displayName || alias.displayNameEn);
                                return `
                                    <div class="region-item default ${hasAlias ? 'has-alias' : ''}" style="${hasAlias ? 'background:#fef3c7; border:1px solid #fcd34d;' : ''}">
                                        <span class="region-code">${r.code}</span>
                                        <div class="region-names" style="flex:1; display:flex; flex-direction:column; gap:2px;">
                                            <div style="display:flex; align-items:center; gap:8px;">
                                                <span class="region-name">${r.name}</span>
                                                ${hasAlias ? `<span style="font-size:11px; color:#d97706;">→ <strong>${alias.displayName || r.name}</strong></span>` : ''}
                                            </div>
                                            <div style="display:flex; align-items:center; gap:8px;">
                                                <span class="region-name-en" style="font-size:11px;">${r.nameEn}</span>
                                                ${hasAlias && alias.displayNameEn ? `<span style="font-size:10px; color:#d97706;">→ ${alias.displayNameEn}</span>` : ''}
                                            </div>
                                        </div>
                                        <div style="display:flex; gap:4px;">
                                            <button class="btn btn-xs btn-secondary" onclick="openRegionAliasEditor('${r.code}', '${r.name}', '${r.nameEn}')" title="별칭 수정">✏️ 별칭</button>
                                            ${hasAlias ? `<button class="btn btn-xs btn-warning" onclick="clearRegionAlias('${r.code}')" title="별칭 초기화" style="background:#f59e0b;">↩️</button>` : ''}
                                        </div>
                                    </div>
                                `;
                            }).join('')}
                        </div>
                    </div>
                    
                    <!-- 커스텀 권역 -->
                    <div class="region-section" style="margin-top:24px;">
                        <h4>✨ 커스텀 권역 (${state.customRegions.length}개)</h4>
                        <div class="region-list" id="customRegionList">
                            ${state.customRegions.length === 0 ? 
                                '<div class="empty-state" style="padding:20px; text-align:center; color:var(--text-muted);">추가된 커스텀 권역이 없습니다.</div>' :
                                state.customRegions.map(r => `
                                    <div class="region-item custom">
                                        <span class="region-code">${r.code}</span>
                                        <div style="flex:1;">
                                            <span class="region-name">${r.name}</span>
                                            <span class="region-name-en" style="margin-left:8px; font-size:11px;">${r.nameEn || ''}</span>
                                        </div>
                                        <button class="btn btn-xs btn-danger" onclick="deleteCustomRegion('${r.code}')">🗑️ 삭제</button>
                                    </div>
                                `).join('')
                            }
                        </div>
                    </div>
                    
                    <!-- 새 권역 추가 폼 -->
                    <div class="region-add-form" style="margin-top:24px;">
                        <h4>➕ 새 권역 추가</h4>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:end;">
                            <div>
                                <label>권역명 (국문) <span style="color:#ef4444;">*필수</span></label>
                                <input type="text" id="newRegionName" placeholder="예: 강서권역, 인천권역, 경기남부">
                            </div>
                            <div>
                                <label>권역명 (영문) <span style="color:var(--text-muted);">선택</span></label>
                                <input type="text" id="newRegionNameEn" placeholder="예: Gangseo, Incheon">
                            </div>
                        </div>
                        <p style="font-size:12px; color:var(--text-muted); margin-top:8px;">💡 코드는 영문명 기준으로 자동 생성됩니다</p>
                        <div style="margin-top:12px;">
                            <button class="btn btn-primary" onclick="saveNewRegion()">+ 권역 추가</button>
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-primary" onclick="closeRegionManager()">확인</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

export function closeRegionManager() {
    const modal = document.getElementById('regionManagerModal');
    if (modal) modal.remove();
}

export function saveNewRegion() {
    const name = document.getElementById('newRegionName').value.trim();
    const nameEn = document.getElementById('newRegionNameEn').value.trim();
    
    if (!name) {
        showToast('권역명(국문)을 입력하세요', 'error');
        document.getElementById('newRegionName').focus();
        return;
    }
    
    // 코드 자동 생성
    const code = generateRegionCode(nameEn);
    
    addCustomRegion({ code, name, nameEn: nameEn || name });
    showToast(`${name}(${code}) 권역이 추가되었습니다`, 'success');
    
    // 입력 필드 초기화
    document.getElementById('newRegionName').value = '';
    document.getElementById('newRegionNameEn').value = '';
    
    closeRegionManager();
    openRegionManager(); // 새로고침
}

export function deleteCustomRegion(code) {
    const region = state.customRegions.find(r => r.code === code);
    const name = region ? region.name : code;
    
    if (!confirm(`"${name}(${code})" 권역을 삭제하시겠습니까?`)) return;
    
    removeCustomRegion(code);
    showToast('권역이 삭제되었습니다', 'success');
    
    closeRegionManager();
    openRegionManager(); // 새로고침
}

// ★ 권역 별칭 편집 모달
export function openRegionAliasEditor(code, originalName, originalNameEn) {
    const alias = getRegionAlias(code);
    const currentDisplayName = alias?.displayName || '';
    const currentDisplayNameEn = alias?.displayNameEn || '';
    
    const modalHtml = `
        <div class="modal-overlay show" id="regionAliasModal" onclick="if(event.target===this)closeRegionAliasEditor()" style="z-index:10001;">
            <div class="modal" style="max-width:500px;">
                <div class="modal-header" style="background:linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color:white;">
                    <h2 class="modal-title">✏️ 권역 별칭 설정</h2>
                    <button class="modal-close" onclick="closeRegionAliasEditor()" style="color:white;">×</button>
                </div>
                <div class="modal-body">
                    <div style="background:#fef3c7; border-radius:8px; padding:12px 16px; margin-bottom:20px;">
                        <div style="font-size:13px; color:#92400e;">
                            <strong>${code}</strong> 권역의 표시명을 이 임대안내문에서만 변경합니다.
                            <br>원본 데이터(portal.html)에는 영향을 주지 않습니다.
                        </div>
                    </div>
                    
                    <div style="margin-bottom:16px;">
                        <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">원본 권역명</div>
                        <div style="padding:10px 12px; background:var(--bg-tertiary); border-radius:6px; font-size:14px;">
                            ${originalName} <span style="color:var(--text-muted);">(${originalNameEn})</span>
                        </div>
                    </div>
                    
                    <div style="margin-bottom:16px;">
                        <label style="font-size:12px; color:var(--text-secondary); margin-bottom:6px; display:block;">표시명 (국문)</label>
                        <input type="text" id="aliasDisplayName" class="cover-setting-input" 
                               value="${currentDisplayName}" placeholder="${originalName}">
                        <div style="font-size:11px; color:var(--text-muted); margin-top:4px;">비워두면 원본 이름이 사용됩니다</div>
                    </div>
                    
                    <div style="margin-bottom:16px;">
                        <label style="font-size:12px; color:var(--text-secondary); margin-bottom:6px; display:block;">표시명 (영문)</label>
                        <input type="text" id="aliasDisplayNameEn" class="cover-setting-input" 
                               value="${currentDisplayNameEn}" placeholder="${originalNameEn}">
                    </div>
                    
                    <div style="background:#f0fdf4; border-radius:8px; padding:12px 16px;">
                        <div style="font-size:12px; color:#166534; font-weight:600; margin-bottom:8px;">💡 활용 예시</div>
                        <ul style="font-size:11px; color:#15803d; margin:0; padding-left:16px; line-height:1.6;">
                            <li>CBD → "도심권" 또는 "Central Biz Dist."</li>
                            <li>ETC → "성수권역" 또는 "마곡권역"</li>
                            <li>GBD → "테헤란로" 또는 "Teheran-ro"</li>
                        </ul>
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeRegionAliasEditor()">취소</button>
                    <button class="btn btn-primary" onclick="saveRegionAlias('${code}')">💾 저장</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    // 첫 번째 input에 포커스
    setTimeout(() => {
        document.getElementById('aliasDisplayName')?.focus();
    }, 100);
}

export function closeRegionAliasEditor() {
    const modal = document.getElementById('regionAliasModal');
    if (modal) modal.remove();
}

export function saveRegionAlias(code) {
    const displayName = document.getElementById('aliasDisplayName')?.value.trim() || '';
    const displayNameEn = document.getElementById('aliasDisplayNameEn')?.value.trim() || '';
    
    if (!displayName && !displayNameEn) {
        // 둘 다 비어있으면 별칭 삭제
        removeRegionAlias(code);
        showToast('별칭이 초기화되었습니다', 'info');
    } else {
        setRegionAlias(code, { displayName, displayNameEn });
        showToast(`${code} 권역 별칭이 저장되었습니다`, 'success');
    }
    
    closeRegionAliasEditor();
    closeRegionManager();
    openRegionManager(); // 새로고침
}

export function clearRegionAlias(code) {
    if (!confirm(`${code} 권역의 별칭을 초기화하시겠습니까?`)) return;
    
    removeRegionAlias(code);
    showToast('별칭이 초기화되었습니다', 'success');
    
    closeRegionManager();
    openRegionManager(); // 새로고침
}

// ★ v6: 템플릿 관리 모달 (Firebase 공통/개별)
function _tplScopeBadge(scope) {
    return scope === 'shared'
        ? '<span style="font-size:10px; font-weight:700; color:#15803d; background:#dcfce7; border:1px solid #86efac; border-radius:10px; padding:1px 7px;">📌 공통</span>'
        : '<span style="font-size:10px; font-weight:700; color:#475569; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:10px; padding:1px 7px;">👤 개별</span>';
}

function _tplManagerCardsHtml() {
    const templates = (typeof window.loadSavedTemplates === 'function') ? window.loadSavedTemplates() : [];
    if (templates.length === 0) {
        return `<div style="text-align:center; padding:28px 0; color:var(--text-muted); font-size:13px;">
                    저장된 템플릿이 없습니다.<br>
                    <span style="font-size:12px; opacity:.7;">아래에서 현재 설정을 저장해보세요.</span>
                </div>`;
    }
    return templates.map(tpl => {
        const date = tpl.createdAt
            ? new Date(tpl.createdAt).toLocaleDateString('ko-KR', { year:'numeric', month:'short', day:'numeric' })
            : '';
        const logoHtml = tpl.coverSettings?.logoImage
            ? `<img src="${tpl.coverSettings.logoImage}" style="height:18px; max-width:60px; object-fit:contain; border-radius:2px;">`
            : `<span style="font-size:10px; color:var(--text-muted);">로고 없음</span>`;
        return `
            <div class="tpl-manager-card" id="tpl-card-${tpl.id}"
                 style="display:flex; align-items:center; gap:12px; padding:12px 14px; border:1px solid var(--border-color); border-radius:8px; margin-bottom:8px; background:var(--bg-secondary);">
                <div style="flex:0 0 44px; height:44px; border-radius:6px; overflow:hidden; background:linear-gradient(135deg,#1e3a5f,#2d5a8e); display:flex; align-items:center; justify-content:center;">
                    ${logoHtml}
                </div>
                <div style="flex:1; min-width:0;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        ${_tplScopeBadge(tpl.scope)}
                        <span style="font-size:14px; font-weight:600; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${tpl.name}</span>
                    </div>
                    <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                        ${tpl.coverSettings?.title || '—'} · ${date}
                    </div>
                </div>
                <div style="display:flex; gap:6px; flex-shrink:0;">
                    <button class="btn btn-sm btn-primary" onclick="applyTemplateFromManager('${tpl.id}')" style="font-size:12px; padding:4px 10px;">✅ 적용</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteTemplateFromManager('${tpl.id}')" style="font-size:12px; padding:4px 10px; background:#fef2f2; color:#dc2626; border-color:#fca5a5;">🗑️</button>
                </div>
            </div>`;
    }).join('');
}

// 비동기 로드 완료 후 목록만 다시 그림 (Firebase 갱신 콜백)
export function _rerenderTemplateManagerList() {
    const listEl = document.getElementById('tplManagerList');
    if (listEl) listEl.innerHTML = _tplManagerCardsHtml();
    const cntEl = document.getElementById('tplManagerCount');
    if (cntEl) cntEl.textContent = (typeof window.loadSavedTemplates === 'function') ? window.loadSavedTemplates().length : 0;
}

export function openTemplateManager() {
    const existing = document.getElementById('templateManagerModal');
    if (existing) existing.remove();

    const templates = (typeof window.loadSavedTemplates === 'function') ? window.loadSavedTemplates() : [];

    const modalHtml = `
        <div class="modal-overlay show" id="templateManagerModal"
             onclick="if(event.target===this)closeTemplateManager()" style="z-index:10002;">
            <div class="modal" style="max-width:520px; width:92%;">
                <div class="modal-header" style="background:linear-gradient(135deg,#ec4899 0%,#be185d 100%); color:white;">
                    <h2 class="modal-title">💾 표지/엔딩 템플릿 관리</h2>
                    <button class="modal-close" onclick="closeTemplateManager()" style="color:white;">×</button>
                </div>
                <div class="modal-body" style="padding:20px 22px;">
                    <div style="font-size:12px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:10px;">
                        저장된 템플릿 (<span id="tplManagerCount">${templates.length}</span>개)
                    </div>
                    <div id="tplManagerList" style="max-height:280px; overflow-y:auto; margin-bottom:20px;">
                        ${_tplManagerCardsHtml()}
                    </div>
                    <div style="border-top:1px solid var(--border-color); margin-bottom:18px;"></div>
                    <div style="font-size:12px; font-weight:600; color:var(--text-secondary); text-transform:uppercase; letter-spacing:.05em; margin-bottom:10px;">
                        현재 설정을 새 템플릿으로 저장
                    </div>
                    <div style="display:flex; gap:14px; margin-bottom:10px; font-size:13px;">
                        <label style="display:flex; align-items:center; gap:5px; cursor:pointer;"><input type="radio" name="tplScope" value="personal" checked> 👤 개별 <span style="font-size:11px; color:var(--text-muted);">(나만)</span></label>
                        <label style="display:flex; align-items:center; gap:5px; cursor:pointer;"><input type="radio" name="tplScope" value="shared"> 📌 공통 <span style="font-size:11px; color:var(--text-muted);">(전체 공유·정식용)</span></label>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <input type="text" id="newTemplateName" placeholder="템플릿 이름 (예: 2025 S&I 기본)" autocomplete="off"
                               style="flex:1; padding:8px 12px; border:1px solid var(--border-color); border-radius:6px; font-size:13px; outline:none;"
                               onkeydown="if(event.key==='Enter')saveCurrentAsTemplate()"
                               onfocus="this.style.borderColor='#ec4899'" onblur="this.style.borderColor='var(--border-color)'">
                        <button class="btn btn-primary" onclick="saveCurrentAsTemplate()" style="background:#ec4899; border-color:#ec4899; padding:8px 16px; font-size:13px; flex-shrink:0;">저장</button>
                    </div>
                    <div style="font-size:11px; color:var(--text-muted); margin-top:6px;">
                        현재 표지 설정(로고·타이틀·슬로건)과 엔딩 설정이 함께 저장됩니다. <strong>공통</strong>은 모든 사용자에게 공유됩니다.
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeTemplateManager()">닫기</button>
                </div>
            </div>
        </div>`;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    setTimeout(() => document.getElementById('newTemplateName')?.focus(), 120);
    // 최신본 비동기 로드 → 완료 시 _rerenderTemplateManagerList 호출됨
    if (typeof window.refreshTemplatesFromFirebase === 'function') window.refreshTemplatesFromFirebase();
}

export function closeTemplateManager() {
    const modal = document.getElementById('templateManagerModal');
    if (modal) modal.remove();
}

// 현재 설정을 새 템플릿으로 저장 (공통/개별 scope)
export async function saveCurrentAsTemplate() {
    const nameInput = document.getElementById('newTemplateName');
    const name = nameInput?.value.trim();
    if (!name) {
        nameInput?.focus();
        showToast('템플릿 이름을 입력하세요', 'warning');
        return;
    }
    if (typeof window.saveAsTemplate !== 'function') {
        showToast('템플릿 저장 함수를 찾을 수 없습니다', 'error');
        return;
    }
    const scope = document.querySelector('input[name="tplScope"]:checked')?.value || 'personal';
    try {
        await window.saveAsTemplate(name, state.coverSettings, state.endingSettings, scope);
        showToast(`"${name}" ${scope === 'shared' ? '공통' : '개별'} 템플릿이 저장되었습니다`, 'success');
        if (nameInput) nameInput.value = '';
        _rerenderTemplateManagerList();
    } catch (e) {
        console.error('템플릿 저장 오류:', e);
        showToast('템플릿 저장 중 오류가 발생했습니다', 'error');
    }
}

// 템플릿 적용
export function applyTemplateFromManager(id) {
    const templates = typeof window.loadSavedTemplates === 'function'
        ? window.loadSavedTemplates() : [];
    const tpl = templates.find(t => t.id === id);
    if (!tpl) { showToast('템플릿을 찾을 수 없습니다', 'error'); return; }

    if (tpl.coverSettings)  state.coverSettings  = JSON.parse(JSON.stringify(tpl.coverSettings));
    if (tpl.endingSettings) state.endingSettings = JSON.parse(JSON.stringify(tpl.endingSettings));

    // guide-list.js의 state도 동기화
    if (typeof window.saveAsTemplate === 'function') {
        // loadSavedTemplates가 존재하면 guide-list state도 공유됨 — 에디터 재렌더만 필요
    }

    closeTemplateManager();
    renderCoverEditor();
    showToast(`"${tpl.name}" 템플릿이 적용되었습니다`, 'success');
}

// 템플릿 삭제 후 목록 새로고침
export async function deleteTemplateFromManager(id) {
    const templates = (typeof window.loadSavedTemplates === 'function') ? window.loadSavedTemplates() : [];
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    const scopeLabel = tpl.scope === 'shared' ? '공통(전체 공유)' : '개별';
    if (!confirm(`"${tpl.name}" ${scopeLabel} 템플릿을 삭제하시겠습니까?`)) return;

    if (typeof window.deleteTemplate === 'function') {
        try {
            await window.deleteTemplate(id, tpl.scope);
        } catch (e) {
            console.error('템플릿 삭제 오류:', e);
            showToast('삭제 중 오류가 발생했습니다', 'error');
            return;
        }
    }
    showToast(`"${tpl.name}" 템플릿이 삭제되었습니다`, 'info');
    _rerenderTemplateManagerList();
}

// ★ 하위호환: 기존 promptSaveAsTemplate 호출부가 있을 경우를 위한 alias
export const promptSaveAsTemplate = openTemplateManager;

// 전역 함수 등록
export function registerCoverFunctions() {
    window.renderCoverEditor = renderCoverEditor;
    window.loadCoverSettings = loadCoverSettings;
    window.openCoverPreviewModal = openCoverPreviewModal;
    window.closeCoverPreviewModal = closeCoverPreviewModal;
    window.selectCoverTemplate = selectCoverTemplate;
    window.selectGuideType = selectGuideType;   // ★ 문서 타입 전환
    window.updateCoverSetting = updateCoverSetting;
    window.setLogoPosition = setLogoPosition;
    window.uploadCoverImage = uploadCoverImage;
    window.removeCoverImage = removeCoverImage;
    // 엔딩
    window.openEndingEditor = openEndingEditor;
    window.closeEndingEditor = closeEndingEditor;
    window.updateEndingSetting = updateEndingSetting;
    window.resetEndingToDefault = resetEndingToDefault;
    window.uploadEndingImage = uploadEndingImage;
    window.removeEndingImage = removeEndingImage;
    // 권역
    window.openRegionManager = openRegionManager;
    window.closeRegionManager = closeRegionManager;
    window.saveNewRegion = saveNewRegion;
    window.deleteCustomRegion = deleteCustomRegion;
    // ★ 권역 별칭
    window.openRegionAliasEditor = openRegionAliasEditor;
    window.closeRegionAliasEditor = closeRegionAliasEditor;
    window.saveRegionAlias = saveRegionAlias;
    window.clearRegionAlias = clearRegionAlias;
    // ★ v5.7: 템플릿 관리 모달
    window.openTemplateManager = openTemplateManager;
    window.closeTemplateManager = closeTemplateManager;
    window.saveCurrentAsTemplate = saveCurrentAsTemplate;
    window.applyTemplateFromManager = applyTemplateFromManager;
    window.deleteTemplateFromManager = deleteTemplateFromManager;
    window._rerenderTemplateManagerList = _rerenderTemplateManagerList;
    window.promptSaveAsTemplate = promptSaveAsTemplate; // 하위호환
}
