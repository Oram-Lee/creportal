/**
 * Leasing Guide - 간지 에디터
 * 간지 페이지 관리 (Quill 리치텍스트)
 */

import { state } from './guide-state.js';
import { showToast } from './guide-utils.js';
// renderToc은 window 객체를 통해 호출 (순환 의존성 방지)

// Quill 에디터 인스턴스
let dividerQuill = null;

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

// 간지 에디터 렌더링
export function renderDividerEditor(item, idx) {
    const editorMain = document.getElementById('editorMain');
    if (!editorMain) return;
    
    // 흰색 배경 단일 템플릿
    const defaultBgColor = '#ffffff';
    const defaultTextColor = '#1e3a5f';
    
    // 기존 템플릿 설정을 흰색으로 강제
    item.template = 'white';
    item.bgColor = defaultBgColor;
    item.textColor = defaultTextColor;
    
    editorMain.innerHTML = `
        <div class="divider-editor">
            <div class="divider-editor-header">
                <h3>📑 간지 편집</h3>
                <button class="btn btn-sm btn-danger" onclick="removeDivider(${idx})">🗑️ 삭제</button>
            </div>
            
            <!-- 제목 -->
            <div class="divider-setting-group">
                <label>제목 (참고용 - 출력에는 앞 빌딩명이 표시됨)</label>
                <input type="text" class="divider-title-input" value="${item.title || ''}" 
                       onchange="updateDividerTitle(${idx}, this.value)"
                       placeholder="간지 제목 (내부 관리용)">
            </div>
            
            <!-- 본문 (Quill) -->
            <div class="divider-setting-group">
                <label>본문 내용 (텍스트, 이미지 삽입 가능)</label>
                <div id="dividerQuillEditor" style="height:300px; background:white; border:1px solid var(--border-color); border-radius:6px;"></div>
            </div>
            
            <!-- 미리보기 (썸네일 스타일) -->
            <div class="divider-setting-group">
                <label>미리보기</label>
                <div class="divider-preview-thumb" style="
                    width: 200px;
                    aspect-ratio: 297/210;
                    background: #ffffff;
                    border: 1px solid var(--border-color);
                    border-radius: 6px;
                    padding: 12px;
                    display: flex;
                    flex-direction: column;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
                    overflow: hidden;
                ">
                    <div style="font-size:8px; color:#6b7280; margin-bottom:2px;">GBD · 강남 (앞 빌딩 권역)</div>
                    <div style="font-size:10px; font-weight:700; color:#1f2937; margin-bottom:6px; padding-bottom:4px; border-bottom:1px solid #e5e7eb;">
                        앞 빌딩명
                    </div>
                    <div id="dividerPreviewContent" style="font-size:8px; color:#1f2937; line-height:1.4; overflow:hidden; flex:1;">
                        ${item.content || '<span style="color:#94a3b8;">본문 내용을 입력하세요...</span>'}
                    </div>
                </div>
            </div>
        </div>
    `;
    
    // Quill 초기화
    setTimeout(() => {
        if (typeof Quill !== 'undefined') {
            dividerQuill = new Quill('#dividerQuillEditor', {
                theme: 'snow',
                placeholder: '간지에 표시할 내용을 입력하세요...',
                modules: {
                    toolbar: [
                        [{ 'header': [1, 2, 3, false] }],
                        ['bold', 'italic', 'underline'],
                        [{ 'color': [] }, { 'background': [] }],
                        [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                        [{ 'align': [] }],
                        ['image'],
                        ['clean']
                    ]
                }
            });
            
            // 기존 내용 로드
            if (item.content) {
                dividerQuill.root.innerHTML = item.content;
            }
            
            // 변경 시 저장
            dividerQuill.on('text-change', () => {
                state.tocItems[idx].content = dividerQuill.root.innerHTML;
                const previewContent = document.getElementById('dividerPreviewContent');
                if (previewContent) {
                    previewContent.innerHTML = dividerQuill.root.innerHTML;
                }
            });
        }
    }, 100);
    
    // 파일 input 추가
    if (!document.getElementById('dividerBgInput')) {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'dividerBgInput';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);
    }
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
    const { renderCoverEditor } = require('./guide-cover.js');
    renderCoverEditor();
    
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
