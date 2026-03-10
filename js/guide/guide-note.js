/**
 * Leasing Guide - NOTE 관리
 * 임대안내문 표시용 메모 연동
 */

import { state, db, ref, set, update } from './guide-state.js?v=5.1';
import { showToast } from './guide-utils.js?v=5.1';
// renderBuildingEditor는 window 객체를 통해 호출 (순환 의존성 방지)

// NOTE 모달 열기
export function openNoteModal(idx, buildingId) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building) return;
    
    // 임대안내문 표시용 메모만 필터
    const guideMemos = (building.memos || []).filter(m => m.showInLeasingGuide);
    
    const modalHtml = `
        <div class="modal-overlay show" id="noteModal" onclick="if(event.target===this)closeNoteModal()">
            <div class="modal" style="max-width:600px;">
                <div class="modal-header">
                    <h2 class="modal-title">📝 NOTE 관리</h2>
                    <button class="modal-close" onclick="closeNoteModal()">×</button>
                </div>
                <div class="modal-body" style="max-height:60vh; overflow-y:auto;">
                    <p style="font-size:12px; color:var(--text-muted); margin-bottom:16px;">
                        임대안내문에 표시할 메모입니다. Portal 메모 탭에서도 "📄 임대안내문에 표기" 옵션으로 관리할 수 있습니다.
                    </p>
                    
                    <!-- 새 노트 추가 -->
                    <div style="margin-bottom:16px; padding:12px; background:var(--bg-secondary); border-radius:8px;">
                        <div style="font-size:13px; font-weight:600; margin-bottom:8px;">➕ 새 노트 추가</div>
                        <textarea id="newNoteContent" placeholder="임대안내문에 표시할 내용을 입력하세요" 
                            style="width:100%; height:60px; padding:8px; border:1px solid var(--border-color); border-radius:6px; resize:none;"></textarea>
                        <button class="btn btn-primary btn-sm" onclick="addNote('${buildingId}', ${idx})" style="margin-top:8px;">
                            추가
                        </button>
                    </div>
                    
                    <!-- 기존 노트 목록 -->
                    <div style="font-size:13px; font-weight:600; margin-bottom:8px;">📋 등록된 노트 (${guideMemos.length}개)</div>
                    <div id="noteList">
                        ${guideMemos.length === 0 ? `
                            <div style="text-align:center; padding:20px; color:var(--text-muted);">
                                등록된 노트가 없습니다
                            </div>
                        ` : guideMemos.map(m => `
                            <div class="note-list-item" style="display:flex; gap:8px; padding:10px; background:var(--bg-secondary); border-radius:6px; margin-bottom:8px;">
                                <div style="flex:1;">
                                    <div style="font-size:13px; margin-bottom:4px;">${m.content}</div>
                                    <div style="font-size:11px; color:var(--text-muted);">
                                        ${(m.author || m.createdBy || '-').split('@')[0]} · ${m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '-'}
                                    </div>
                                </div>
                                <div style="display:flex; gap:4px;">
                                    <button class="btn btn-sm btn-secondary" onclick="editNote('${buildingId}', '${m.id}', ${idx})">✏️</button>
                                    <button class="btn btn-sm btn-danger" onclick="deleteNote('${buildingId}', '${m.id}', ${idx})">×</button>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" onclick="closeNoteModal()">닫기</button>
                </div>
            </div>
        </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

// NOTE 모달 닫기
export function closeNoteModal() {
    const modal = document.getElementById('noteModal');
    if (modal) modal.remove();
}

// 노트 추가
export async function addNote(buildingId, idx) {
    const content = document.getElementById('newNoteContent')?.value?.trim();
    if (!content) {
        showToast('내용을 입력하세요', 'error');
        return;
    }
    
    try {
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (!building) return;
        
        if (!building.memos) building.memos = [];
        
        const newMemo = {
            id: 'memo_' + Date.now(),
            content: content,
            showInLeasingGuide: true,
            pinned: false,
            author: state.currentUser?.email || 'unknown',
            createdBy: state.currentUser?.email || 'unknown',
            createdAt: new Date().toISOString()
        };
        
        building.memos.push(newMemo);
        
        // Firebase 저장 (set 사용 - 배열 전체 저장)
        await set(ref(db, `buildings/${buildingId}/memos`), building.memos);
        
        showToast('노트가 추가되었습니다', 'success');
        closeNoteModal();
        
        // 프리뷰 갱신
        if (idx >= 0) {
            const item = state.tocItems[idx];
            if (item) window.renderBuildingEditor(item, building);
        }
    } catch (error) {
        console.error('노트 추가 오류:', error);
        showToast('노트 추가 중 오류가 발생했습니다', 'error');
    }
}

// 노트 수정
export function editNote(buildingId, memoId, idx) {
    const building = state.allBuildings.find(b => b.id === buildingId);
    if (!building || !building.memos) return;
    
    const memo = building.memos.find(m => m.id === memoId);
    if (!memo) return;
    
    const newContent = prompt('노트 내용 수정:', memo.content);
    if (newContent === null) return;  // 취소
    if (!newContent.trim()) {
        showToast('내용을 입력하세요', 'error');
        return;
    }
    
    updateNote(buildingId, memoId, newContent.trim(), idx);
}

// 노트 업데이트
async function updateNote(buildingId, memoId, content, idx) {
    try {
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (!building || !building.memos) return;
        
        const memo = building.memos.find(m => m.id === memoId);
        if (!memo) return;
        
        memo.content = content;
        memo.updatedAt = new Date().toISOString();
        
        // Firebase 저장 (set 사용)
        await set(ref(db, `buildings/${buildingId}/memos`), building.memos);
        
        showToast('노트가 수정되었습니다', 'success');
        closeNoteModal();
        
        // 프리뷰 갱신
        if (idx >= 0) {
            const item = state.tocItems[idx];
            if (item) window.renderBuildingEditor(item, building);
        }
    } catch (error) {
        console.error('노트 수정 오류:', error);
        showToast('노트 수정 중 오류가 발생했습니다', 'error');
    }
}

// 노트 삭제
export async function deleteNote(buildingId, memoId, idx) {
    if (!confirm('이 노트를 삭제하시겠습니까?')) return;
    
    try {
        const building = state.allBuildings.find(b => b.id === buildingId);
        if (!building || !building.memos) return;
        
        building.memos = building.memos.filter(m => m.id !== memoId);
        
        // Firebase 업데이트
        await set(ref(db, `buildings/${buildingId}/memos`), building.memos);
        
        showToast('노트가 삭제되었습니다', 'success');
        closeNoteModal();
        
        // 프리뷰 갱신
        if (idx >= 0) {
            const item = state.tocItems[idx];
            if (item) window.renderBuildingEditor(item, building);
        }
    } catch (error) {
        console.error('노트 삭제 오류:', error);
        showToast('노트 삭제 중 오류가 발생했습니다', 'error');
    }
}

// 전역 함수 등록
export function registerNoteFunctions() {
    window.openNoteModal = openNoteModal;
    window.closeNoteModal = closeNoteModal;
    window.addNote = addNote;
    window.editNote = editNote;
    window.deleteNote = deleteNote;
}
