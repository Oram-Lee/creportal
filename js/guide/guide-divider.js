/**
 * Leasing Guide - 간지 에디터
 * 간지 페이지 관리 (Quill 리치텍스트)
 */

import { state, storage, storageRef, uploadString, getDownloadURL } from './guide-state.js?v=5.5';
import { showToast } from './guide-utils.js?v=5.10';
// renderToc은 window 객체를 통해 호출 (순환 의존성 방지)

// Quill 에디터 인스턴스
let dividerQuill = null;

// ★ 이미지를 Firebase Storage에 업로드하고 URL 반환
async function uploadImageToStorage(file, guideId) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async function(e) {
            try {
                const img = new Image();
                img.onload = async function() {
                    // 이미지 리사이즈 (최대 1200px)
                    const canvas = document.createElement('canvas');
                    let width = img.width;
                    let height = img.height;
                    const maxWidth = 1200;
                    
                    if (width > maxWidth) {
                        height = (height * maxWidth) / width;
                        width = maxWidth;
                    }
                    
                    canvas.width = width;
                    canvas.height = height;
                    
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // JPEG로 압축 (품질 0.8)
                    const compressedBase64 = canvas.toDataURL('image/jpeg', 0.8);
                    
                    // Firebase Storage에 업로드
                    const timestamp = Date.now();
                    const fileName = `divider_${timestamp}.jpg`;
                    const storagePath = `leasingGuides/${guideId || 'temp'}/dividers/${fileName}`;
                    
                    // storageRef가 window에서 가져와야 함 (모듈 초기화 타이밍 이슈)
                    const imageRef = window.storageRef(window.storage, storagePath);
                    
                    // base64 데이터만 추출 (data:image/jpeg;base64, 제거)
                    const base64Data = compressedBase64.split(',')[1];
                    
                    await window.uploadString(imageRef, base64Data, 'base64', {
                        contentType: 'image/jpeg'
                    });
                    
                    // 다운로드 URL 가져오기
                    const downloadURL = await window.getDownloadURL(imageRef);
                    
                    console.log(`[Storage] 이미지 업로드 완료: ${Math.round(compressedBase64.length / 1024)}KB → ${downloadURL}`);
                    resolve(downloadURL);
                };
                img.onerror = () => reject(new Error('이미지 로드 실패'));
                img.src = e.target.result;
            } catch (error) {
                console.error('[Storage] 업로드 오류:', error);
                reject(error);
            }
        };
        reader.onerror = () => reject(new Error('파일 읽기 실패'));
        reader.readAsDataURL(file);
    });
}

// 간지 추가
export function addDivider() {
    state.tocItems.push({
        type: 'divider',
        title: '간지',
        template: 'white',
        bgColor: '#ffffff',
        textColor: '#1e3a5f',
        content: ''
    });
    window.renderToc();
    showToast('간지가 추가되었습니다', 'success');
}

// 특정 빌딩 다음에 간지 추가
export function addDividerAfter(buildingId) {
    const idx = state.tocItems.findIndex(i => i.buildingId === buildingId);
    if (idx < 0) return;
    
    state.tocItems.splice(idx + 1, 0, {
        type: 'divider',
        title: '간지',
        template: 'white',
        bgColor: '#ffffff',
        textColor: '#1e3a5f',
        content: ''
    });
    
    window.renderToc();
    showToast('간지가 추가되었습니다', 'success');
}

// 간지 에디터 렌더링 (빌딩 편집 페이지와 동일한 레이아웃)
export function renderDividerEditor(item, idx) {
    const editorMain = document.getElementById('editorMain');
    if (!editorMain) return;
    
    // 앞 빌딩 정보 가져오기
    let prevBuilding = null;
    let prevItem = null;
    for (let i = idx - 1; i >= 0; i--) {
        if (state.tocItems[i].type === 'building' || state.tocItems[i].buildingId) {
            prevItem = state.tocItems[i];
            prevBuilding = state.allBuildings?.find(b => b.id === prevItem.buildingId);
            break;
        }
    }
    
    const buildingName = prevBuilding?.name || '(앞 빌딩 없음)';
    const region = (prevItem?.region || prevBuilding?.region || 'ETC').toUpperCase();
    const REGION_NAMES = {
        'GBD': '강남', 'YBD': '여의도', 'CBD': '도심', 
        'BBD': '분당·판교', 'MBD': '마곡', 'ETC': '기타'
    };
    const regionName = REGION_NAMES[region] || region;
    
    // 페이지 정보
    const pageInfo = window.getPageInfo ? window.getPageInfo() : { current: idx + 3, total: '?' };
    
    editorMain.innerHTML = `
        <!-- 플로팅 메뉴 -->
        <div class="floating-menu no-print">
            <div class="floating-menu-left">
                <div class="floating-nav-buttons">
                    <button class="floating-nav-btn" onclick="navigateToPrev()" title="이전 페이지">
                        ◀ 이전
                    </button>
                    <span class="floating-page-info">${pageInfo.current} / ${pageInfo.total}</span>
                    <button class="floating-nav-btn" onclick="navigateToNext()" title="다음 페이지">
                        다음 ▶
                    </button>
                </div>
                <div class="floating-shortcuts">
                    <button class="floating-shortcut" onclick="openPrintPage()" title="출력 페이지 열기">
                        🖨️ 출력
                    </button>
                </div>
            </div>
            <button class="btn btn-sm btn-danger" onclick="removeDivider(${idx})">
                🗑️ 삭제
            </button>
        </div>
        
        <!-- 간지 편집 영역 (빌딩 프리뷰와 동일한 스타일) -->
        <div class="divider-editor-full">
            <!-- 헤더: 빌딩명 + 권역정보 -->
            <div class="divider-editor-header-bar">
                <div class="divider-title-area">
                    <span class="divider-icon">📑</span>
                    <span class="divider-building-name">${buildingName}</span>
                    <span class="divider-badge">간지</span>
                </div>
                <div class="divider-region-info">${region} · ${regionName}</div>
            </div>
            
            <!-- 편집 본문 -->
            <div class="divider-editor-body">
                <!-- 관리용 제목 -->
                <div class="divider-form-group">
                    <label class="divider-label">
                        <span>📝 관리용 제목</span>
                        <span class="label-hint">(출력에는 표시되지 않음)</span>
                    </label>
                    <input type="text" class="divider-title-input" value="${item.title || ''}" 
                           onchange="updateDividerTitle(${idx}, this.value)"
                           placeholder="예: L7 강남타워 추가설명">
                </div>
                
                <!-- 본문 에디터 -->
                <div class="divider-form-group divider-content-group">
                    <label class="divider-label">
                        <span>📄 본문 내용</span>
                        <span class="label-hint">(텍스트, 이미지 삽입 가능 - 이미지는 자동으로 Storage에 업로드됨)</span>
                    </label>
                    <div id="dividerQuillEditor"></div>
                </div>
            </div>
        </div>
    `;
    
    // Quill 초기화
    setTimeout(() => {
        if (typeof Quill !== 'undefined') {
            dividerQuill = new Quill('#dividerQuillEditor', {
                theme: 'snow',
                placeholder: '간지에 표시할 내용을 입력하세요...\n\n• 이미지 버튼(🖼️)을 클릭하여 사진을 삽입할 수 있습니다.\n• 이미지는 Firebase Storage에 자동 업로드됩니다.',
                modules: {
                    toolbar: [
                        [{ 'header': [1, 2, 3, false] }],
                        ['bold', 'italic', 'underline', 'strike'],
                        [{ 'color': [] }, { 'background': [] }],
                        [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                        [{ 'align': [] }],
                        ['image', 'link'],
                        ['clean']
                    ]
                }
            });
            
            // ★ 이미지 핸들러 커스텀 (Firebase Storage 업로드)
            dividerQuill.getModule('toolbar').addHandler('image', function() {
                const input = document.createElement('input');
                input.setAttribute('type', 'file');
                input.setAttribute('accept', 'image/*');
                input.click();
                
                input.onchange = async function() {
                    const file = input.files[0];
                    if (!file) return;
                    
                    try {
                        showToast('이미지 업로드 중...', 'info');
                        
                        // 현재 가이드 ID 가져오기
                        const guideId = state.currentGuide?.id || 'temp';
                        
                        // Storage에 업로드하고 URL 받기
                        const imageURL = await uploadImageToStorage(file, guideId);
                        
                        // 에디터에 URL로 삽입
                        const range = dividerQuill.getSelection(true);
                        dividerQuill.insertEmbed(range.index, 'image', imageURL);
                        dividerQuill.setSelection(range.index + 1);
                        
                        showToast('이미지 업로드 완료', 'success');
                    } catch (error) {
                        console.error('이미지 업로드 오류:', error);
                        showToast('이미지 업로드 실패: ' + error.message, 'error');
                    }
                };
            });
            
            // 기존 내용 로드
            if (item.content) {
                dividerQuill.root.innerHTML = item.content;
            }
            
            // 변경 시 저장
            dividerQuill.on('text-change', () => {
                state.tocItems[idx].content = dividerQuill.root.innerHTML;
            });
        }
    }, 100);
}

// 템플릿 선택
export function selectDividerTemplate(idx, template) {
    state.tocItems[idx].template = template;
    renderDividerEditor(state.tocItems[idx], idx);
}

// 제목 업데이트
export function updateDividerTitle(idx, value) {
    state.tocItems[idx].title = value;
    const titleEl = document.querySelector('.divider-preview .title-area div');
    if (titleEl) titleEl.textContent = value || '간지 제목';
    window.renderToc();
}

// 배경 이미지 업로드
export function uploadDividerBgImage(idx) {
    const input = document.getElementById('dividerBgInput');
    input.onchange = function(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(ev) {
            state.tocItems[idx].bgImage = ev.target.result;
            renderDividerEditor(state.tocItems[idx], idx);
        };
        reader.readAsDataURL(file);
        e.target.value = '';
    };
    input.click();
}

// 배경 이미지 삭제
export function removeDividerBgImage(idx) {
    state.tocItems[idx].bgImage = null;
    renderDividerEditor(state.tocItems[idx], idx);
}

// 간지 삭제
export function removeDivider(idx) {
    if (!confirm('이 간지를 삭제하시겠습니까?')) return;
    
    state.tocItems.splice(idx, 1);
    state.selectedTocIndex = -1;
    window.renderToc();
    
    // 표지 에디터로 돌아가기
    window.renderCoverEditor();
    
    showToast('간지가 삭제되었습니다', 'success');
}

// 간지 내용 저장
export function saveDividerContent(idx) {
    if (dividerQuill) {
        state.tocItems[idx].content = dividerQuill.root.innerHTML;
        showToast('간지 내용이 저장되었습니다', 'success');
    }
}

// 전역 함수 등록
export function registerDividerFunctions() {
    window.renderDividerEditor = renderDividerEditor;
    window.addDivider = addDivider;
    window.addDividerAfter = addDividerAfter;
    window.selectDividerTemplate = selectDividerTemplate;
    window.updateDividerTitle = updateDividerTitle;
    window.uploadDividerBgImage = uploadDividerBgImage;
    window.removeDividerBgImage = removeDividerBgImage;
    window.removeDivider = removeDivider;
    window.saveDividerContent = saveDividerContent;
}
