/**
 * CRE Portal - 미리보기 모듈
 * 페이지 이미지 미리보기 기능
 */

import { state } from './portal-state.js';
import { showToast } from './portal-utils.js';
import { storage, storageRef, getDownloadURL } from './portal-firebase.js';

// 미리보기 상태
let previewState = {
    source: '',
    publishDate: '',
    currentPage: 0,
    totalPages: 200,
    // 캐시: 이미 가져온 URL 저장
    urlCache: {}
};

let currentZoom = 1;

// ★ leasing-docs/ 하위 실제 source 폴더 목록 캐시 (listAll 중복 호출 방지)
let _leasingSourceFolders = null;


// ★ Firebase Storage URL에서 실제 source/publishDate 추출 (이관 빌딩 대응)
function extractPathFromUrl(url) {
    try {
        // URL: .../o/leasing-docs%2FCBRE%2F26_02%2Fpage_098.jpg?alt=media...
        const decoded = decodeURIComponent(url);
        const match = decoded.match(/leasing-docs\/([^/]+)\/([^/]+)\/page_/);
        if (match) {
            return {
                source: match[1],
                // ★ 수정: Storage 경로의 _ 구분자를 그대로 유지 (getPageImageUrl에서 처리)
                publishDate: match[2]  // 26_02 형태 그대로 사용 (getPageImageUrl에서 safePubDate 처리)
            };
        }
    } catch (e) {
        console.warn('URL 경로 추출 실패:', e);
    }
    return null;
}

// ===== 페이지 미리보기 열기 =====

export function showPagePreview(imageUrl, source, publishDate, pageNum) {
    console.log('showPagePreview called:', { imageUrl, source, publishDate, pageNum });
    
    // ★ imageUrl이 있으면 실제 Storage 경로에서 source/publishDate 추출
    // 이관된 빌딩의 경우 source가 변경되어 있으므로 URL 기준이 정확함
    if (imageUrl) {
        const extracted = extractPathFromUrl(imageUrl);
        if (extracted) {
            console.log('[v4.1] URL에서 경로 추출:', extracted, '(전달값:', source, publishDate, ')');
            source = extracted.source;
            publishDate = extracted.publishDate;
        }
    }
    
    // 상태 초기화
    previewState = {
        source: source || '',
        publishDate: publishDate || '',
        currentPage: pageNum || 1,
        totalPages: 200,
        urlCache: {}
    };
    
    // ★ 수정: imageUrl이 실제 download token을 포함한 경우만 캐시 저장
    // 구성된 URL(?alt=media만 있는 경우)은 파일 존재 미검증이므로 캐시 저장 안 함
    // → getPageImageUrl에서 getDownloadURL로 검증 후 저장
    if (imageUrl && pageNum && imageUrl.includes('token=')) {
        previewState.urlCache[pageNum] = imageUrl;
    }
    
    // 줌 초기화
    currentZoom = 1;
    const img = document.getElementById('pagePreviewImage');
    if (img) img.style.transform = 'scale(1)';
    document.getElementById('zoomLevel').textContent = '100%';
    
    // source와 publishDate가 있어야 페이지 이동 가능
    const canNavigate = !!(source && publishDate);
    document.getElementById('prevPageBtn').disabled = !canNavigate;
    document.getElementById('nextPageBtn').disabled = !canNavigate;
    document.getElementById('prevPageBtn').style.opacity = canNavigate ? '1' : '0.5';
    document.getElementById('nextPageBtn').style.opacity = canNavigate ? '1' : '0.5';
    
    updatePreviewImage();
    document.getElementById('pagePreviewModal').style.display = 'flex';
    document.getElementById('pagePreviewModal').classList.add('show');
}

// 문서 ID로 미리보기 열기
export function openPagePreview(documentId) {
    if (!state.selectedBuilding) return;
    
    const doc = state.selectedBuilding.documents?.find(d => d.id === documentId);
    if (!doc) {
        showToast('문서를 찾을 수 없습니다', 'error');
        return;
    }
    
    showPagePreview(null, doc.source, doc.publishDate, 1);
}

// ★ Firebase Storage에서 페이지 이미지 URL 가져오기
async function getPageImageUrl(source, publishDate, pageNum) {
    // ★ 수정: 'in' 연산자로 체크 (null 마커도 캐시로 인정 → 재요청 방지)
    if (pageNum in previewState.urlCache) {
        const cached = previewState.urlCache[pageNum];
        console.log('URL 캐시 히트:', pageNum, cached ? '(URL)' : '(실패 마커)');
        return cached;  // null이면 null 반환 → 로딩 없이 "없음" 표시
    }
    
    // Firebase Storage 경로 생성
    // ★ 수정: /g 플래그로 모든 점/공백 치환 (26.02 → 26_02, 26.02.01 → 26_02_01)
    const safePubDate = (publishDate || '').replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
    const safeSource  = (source || '').replace(/[\s\.]+/g, '_').replace(/__+/g, '_');
    const paddedPage = String(pageNum).padStart(3, '0');
    const filePath = `leasing-docs/${safeSource}/${safePubDate}/page_${paddedPage}.jpg`;
    
    console.log('Firebase Storage 경로:', filePath);
    
    try {
        const fileRef = storageRef(storage, filePath);
        const url = await getDownloadURL(fileRef);
        
        // 캐시에 저장
        previewState.urlCache[pageNum] = url;
        console.log('URL 가져오기 성공:', pageNum, url);
        
        return url;
    } catch (err) {
        if (err.code === 'storage/object-not-found') {
            // ★ source 일괄수정 이력이 있는 빌딩 대응:
            //   vacancy source는 변경됐지만 실제 Storage 파일은 원래 source 폴더에 존재
            //   → 같은 publishDate로 다른 source 폴더 탐색
            console.warn(`[preview] ${filePath} 없음 (source 불일치 가능) → 폴백 탐색...`);
            const fallbackUrl = await _findFallbackUrl(safePubDate, paddedPage, safeSource);
            previewState.urlCache[pageNum] = fallbackUrl;
            return fallbackUrl;
        }
        console.error('URL 가져오기 실패:', filePath, err.code);
        previewState.urlCache[pageNum] = null;
        return null;
    }
}

// ★ source 불일치 시 실제 파일이 있는 폴더를 탐색하는 폴백 함수
async function _findFallbackUrl(safePubDate, paddedPage, excludeSource) {
    try {
        // leasing-docs 하위 폴더 목록 (캐시 사용)
        if (!_leasingSourceFolders) {
            const { listAll } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js');
            const rootRef = storageRef(storage, 'leasing-docs');
            const result = await listAll(rootRef);
            _leasingSourceFolders = result.prefixes.map(p => p.name);
            console.log('[preview] leasing-docs 폴더 목록:', _leasingSourceFolders);
        }

        for (const folderName of _leasingSourceFolders) {
            if (folderName === excludeSource) continue;  // 이미 실패한 source 제외
            const tryPath = `leasing-docs/${folderName}/${safePubDate}/page_${paddedPage}.jpg`;
            try {
                const url = await getDownloadURL(storageRef(storage, tryPath));
                console.log(`[preview] 폴백 발견: ${tryPath} → previewState.source 교정: ${excludeSource} → ${folderName}`);
                // ★ previewState.source를 실제 파일 위치로 교정
                //    (이후 다음/이전 페이지 이동도 올바른 source로 동작)
                previewState.source = folderName;
                return url;
            } catch (e) {
                // 이 폴더엔 없음, 계속 탐색
            }
        }
    } catch (e) {
        console.warn('[preview] 폴백 탐색 오류:', e.message);
    }
    return null;
}

// 이미지 업데이트
async function updatePreviewImage() {
    const img = document.getElementById('pagePreviewImage');
    const info = document.getElementById('pagePreviewInfo');
    const loading = document.getElementById('pagePreviewLoading');
    
    // 로딩 표시
    loading.style.display = 'block';
    loading.textContent = '로딩 중...';
    img.style.opacity = '0.5';
    
    // 페이지 정보 표시
    const sourceText = previewState.source || '';
    const dateText = previewState.publishDate || '';
    info.textContent = `${sourceText} ${dateText} - 페이지 ${previewState.currentPage}`;
    
    // URL 가져오기
    const imageUrl = await getPageImageUrl(
        previewState.source, 
        previewState.publishDate, 
        previewState.currentPage
    );
    
    console.log('updatePreviewImage - page:', previewState.currentPage, 'url:', imageUrl);
    
    if (imageUrl) {
        img.onload = function() {
            loading.style.display = 'none';
            img.style.opacity = '1';
        };
        img.onerror = function() {
            loading.style.display = 'block';
            loading.textContent = '이미지를 불러올 수 없습니다';
            img.style.opacity = '0.3';
        };
        
        img.src = imageUrl;
    } else {
        loading.style.display = 'block';
        loading.textContent = `페이지 ${previewState.currentPage} 이미지를 찾을 수 없습니다`;
        img.style.opacity = '0.3';
        img.src = '';
    }
}

// 이전 페이지
export function prevPagePreview() {
    if (!previewState.source || !previewState.publishDate) {
        showToast('페이지 이동이 지원되지 않는 이미지입니다', 'info');
        return;
    }
    if (previewState.currentPage > 1) {
        previewState.currentPage--;
        updatePreviewImage();
    } else {
        showToast('첫 페이지입니다', 'info');
    }
}

// 다음 페이지
export async function nextPagePreview() {
    if (!previewState.source || !previewState.publishDate) {
        showToast('페이지 이동이 지원되지 않는 이미지입니다', 'info');
        return;
    }
    const nextPage = previewState.currentPage + 1;
    // ★ 수정: 다음 페이지 URL 존재 여부를 먼저 확인 (404 시 "마지막 페이지" 처리)
    if (nextPage in previewState.urlCache && previewState.urlCache[nextPage] === null) {
        showToast('마지막 페이지입니다', 'info');
        return;
    }
    previewState.currentPage = nextPage;
    await updatePreviewImage();
    // 로드 실패(null)면 되돌리고 알림
    if (previewState.urlCache[nextPage] === null) {
        previewState.currentPage--;
        showToast('마지막 페이지입니다', 'info');
    }
}

// 페이지 직접 이동
export function goToPage(pageNum) {
    if (!previewState.source || !previewState.publishDate) return;
    const page = parseInt(pageNum);
    if (page > 0) {
        previewState.currentPage = page;
        updatePreviewImage();
    }
}

// 미리보기 닫기
export function closePagePreview() {
    document.getElementById('pagePreviewModal').style.display = 'none';
    document.getElementById('pagePreviewModal').classList.remove('show');
    document.getElementById('pagePreviewImage').src = '';
    document.getElementById('pagePreviewImage').style.transform = 'scale(1)';
    document.getElementById('zoomLevel').textContent = '100%';
    currentZoom = 1;
    
    // 캐시 클리어
    previewState.urlCache = {};
}

// 확대/축소
export function zoomPreview(delta) {
    currentZoom = Math.max(0.2, Math.min(3, currentZoom + delta));
    const img = document.getElementById('pagePreviewImage');
    img.style.transform = `scale(${currentZoom})`;
    document.getElementById('zoomLevel').textContent = Math.round(currentZoom * 100) + '%';
}

// 다운로드
export function downloadPreviewImage() {
    const img = document.getElementById('pagePreviewImage');
    if (!img.src) {
        showToast('다운로드할 이미지가 없습니다', 'error');
        return;
    }
    
    const fileName = `${previewState.source || 'page'}_${previewState.publishDate || ''}_P${previewState.currentPage}.jpg`;
    
    fetch(img.src)
        .then(response => response.blob())
        .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
            showToast('다운로드 시작', 'success');
        })
        .catch(err => {
            window.open(img.src, '_blank');
            showToast('새 탭에서 이미지를 저장하세요', 'info');
        });
}

// 키보드 이벤트 설정
export function setupPreviewKeyboard() {
    document.addEventListener('keydown', function(e) {
        const modal = document.getElementById('pagePreviewModal');
        if (!modal || !modal.classList.contains('show')) return;
        
        if (e.key === 'ArrowLeft') prevPagePreview();
        else if (e.key === 'ArrowRight') nextPagePreview();
        else if (e.key === 'Escape') closePagePreview();
        else if (e.key === '+' || e.key === '=') zoomPreview(0.2);
        else if (e.key === '-') zoomPreview(-0.2);
    });
}

// ===== 전역 함수 등록 =====

export function registerPreviewGlobals() {
    window.showPagePreview = showPagePreview;
    window.openPagePreview = openPagePreview;
    window.prevPagePreview = prevPagePreview;
    window.nextPagePreview = nextPagePreview;
    window.goToPage = goToPage;
    window.closePagePreview = closePagePreview;
    window.zoomPreview = zoomPreview;
    window.downloadPreviewImage = downloadPreviewImage;
    
    // 키보드 이벤트 설정
    setupPreviewKeyboard();
}
