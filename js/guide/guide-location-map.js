// ============================================================
// ★ v9.5: 임대안내문 지도 이미지 생성 기능 ★
// guide-building.js 또는 별도 guide-location-map.js에 추가
// ============================================================

// API 서버 URL (기존 설정 사용)
const API_BASE = window.CONFIG?.API_BASE || 'https://portal-dsyl.onrender.com';

/**
 * 단일 빌딩의 지도 이미지 생성
 * @param {Object} building - 빌딩 정보 {id, name, coordinates, nearbyStations}
 * @returns {Promise<Object>} - {success, imageUrl}
 */
async function generateLocationMapImage(building) {
    try {
        const { id, name, coordinates, nearbyStations } = building;
        
        if (!coordinates?.lat || !coordinates?.lng) {
            throw new Error('빌딩 좌표 정보가 없습니다');
        }
        
        console.log(`🗺️ 지도 생성 요청: ${name}`);
        
        // 인근역 정보 파싱 (문자열 → 배열)
        let stationsArray = [];
        if (nearbyStations && typeof nearbyStations === 'string') {
            // "2호선 선릉역 2분, 분당선 선릉역 2분" 형태 파싱
            // 실제 좌표가 필요하므로 일단 빈 배열
            stationsArray = [];
        } else if (Array.isArray(nearbyStations)) {
            stationsArray = nearbyStations;
        }
        
        const response = await fetch(`${API_BASE}/api/generate-location-map`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                buildingId: id,
                lat: coordinates.lat,
                lng: coordinates.lng,
                name: name,
                nearbyStations: stationsArray,
                level: 3,
                width: 600,
                height: 400,
                saveToFirebase: true
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            console.log(`  ✅ 지도 생성 완료: ${result.imageUrl || 'Base64'}`);
            return {
                success: true,
                imageUrl: result.imageUrl || result.imageBase64,
                savedToFirebase: result.savedToFirebase
            };
        } else {
            throw new Error(result.error || '지도 생성 실패');
        }
        
    } catch (error) {
        console.error(`  ❌ 지도 생성 실패:`, error);
        return {
            success: false,
            error: error.message
        };
    }
}


/**
 * 빌딩 에디터에 "지도 생성" 버튼 추가
 * 기존 renderBuildingEditor() 함수 내에서 호출하거나, 
 * DOM 조작으로 버튼 추가
 */
function addLocationMapButton(buildingEditorContainer, buildingData, idx) {
    // 기존 location 섹션 찾기
    const locationSection = buildingEditorContainer.querySelector('.location-section, [data-section="location"]');
    
    if (!locationSection) {
        console.warn('location 섹션을 찾을 수 없습니다');
        return;
    }
    
    // 이미 버튼이 있으면 스킵
    if (locationSection.querySelector('.generate-map-btn')) {
        return;
    }
    
    // 버튼 컨테이너 생성
    const btnContainer = document.createElement('div');
    btnContainer.className = 'location-map-actions';
    btnContainer.style.cssText = 'margin-top: 10px; display: flex; gap: 8px; align-items: center;';
    
    // 자동 생성 버튼
    const generateBtn = document.createElement('button');
    generateBtn.type = 'button';
    generateBtn.className = 'generate-map-btn';
    generateBtn.innerHTML = '🗺️ 지도 자동 생성';
    generateBtn.style.cssText = `
        padding: 8px 16px;
        background: linear-gradient(135deg, #3b82f6, #2563eb);
        color: white;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13px;
        font-weight: 500;
        transition: all 0.2s;
    `;
    
    generateBtn.onmouseover = () => {
        generateBtn.style.transform = 'translateY(-1px)';
        generateBtn.style.boxShadow = '0 4px 12px rgba(59, 130, 246, 0.4)';
    };
    generateBtn.onmouseout = () => {
        generateBtn.style.transform = '';
        generateBtn.style.boxShadow = '';
    };
    
    // 상태 표시
    const statusSpan = document.createElement('span');
    statusSpan.className = 'map-status';
    statusSpan.style.cssText = 'font-size: 12px; color: #666;';
    
    // 현재 이미지 상태 확인
    const hasImage = buildingData?.images?.location;
    if (hasImage) {
        statusSpan.innerHTML = '✅ 이미지 있음';
        statusSpan.style.color = '#10b981';
    } else {
        statusSpan.innerHTML = '❌ 이미지 없음';
        statusSpan.style.color = '#ef4444';
    }
    
    // 버튼 클릭 이벤트
    generateBtn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // 좌표 확인
        if (!buildingData?.coordinates?.lat || !buildingData?.coordinates?.lng) {
            showToast('빌딩 좌표 정보가 없습니다. 먼저 주소를 설정해주세요.', 'error');
            return;
        }
        
        // 로딩 상태
        generateBtn.disabled = true;
        generateBtn.innerHTML = '⏳ 생성 중...';
        statusSpan.innerHTML = '카카오 API 호출 중...';
        statusSpan.style.color = '#6b7280';
        
        try {
            const result = await generateLocationMapImage(buildingData);
            
            if (result.success) {
                statusSpan.innerHTML = '✅ 생성 완료!';
                statusSpan.style.color = '#10b981';
                showToast('지도 이미지가 생성되었습니다', 'success');
                
                // 이미지 URL 업데이트 (state에 반영)
                if (window.state && window.state.tocItems && window.state.tocItems[idx]) {
                    if (!window.state.tocItems[idx].images) {
                        window.state.tocItems[idx].images = {};
                    }
                    window.state.tocItems[idx].images.location = result.imageUrl;
                }
                
                // 미리보기 갱신
                if (typeof renderPreview === 'function') {
                    renderPreview(idx);
                }
                
            } else {
                throw new Error(result.error);
            }
            
        } catch (error) {
            statusSpan.innerHTML = `❌ 실패: ${error.message}`;
            statusSpan.style.color = '#ef4444';
            showToast(`지도 생성 실패: ${error.message}`, 'error');
        } finally {
            generateBtn.disabled = false;
            generateBtn.innerHTML = '🗺️ 지도 자동 생성';
        }
    };
    
    btnContainer.appendChild(generateBtn);
    btnContainer.appendChild(statusSpan);
    locationSection.appendChild(btnContainer);
}


/**
 * 여러 빌딩의 지도 이미지 일괄 생성
 * @param {Array} buildings - 빌딩 목록
 * @param {Function} onProgress - 진행 콜백 (current, total, building)
 */
async function generateLocationMapsBatch(buildings, onProgress) {
    const buildingsWithCoords = buildings.filter(b => 
        b.coordinates?.lat && b.coordinates?.lng
    );
    
    if (buildingsWithCoords.length === 0) {
        showToast('좌표가 있는 빌딩이 없습니다', 'warning');
        return { success: 0, failed: 0, results: [] };
    }
    
    console.log(`🗺️ 일괄 생성 시작: ${buildingsWithCoords.length}개`);
    
    const response = await fetch(`${API_BASE}/api/generate-location-map/batch`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            buildings: buildingsWithCoords.map(b => ({
                buildingId: b.id,
                lat: b.coordinates.lat,
                lng: b.coordinates.lng,
                name: b.name
            })),
            level: 3
        })
    });
    
    const result = await response.json();
    
    if (result.success) {
        showToast(`지도 생성 완료: ${result.successCount}/${result.total} 성공`, 'success');
    }
    
    return result;
}


/**
 * 지도 이미지 없는 빌딩 목록 조회 및 일괄 생성 UI
 */
function showBatchGenerateModal() {
    // 모달 생성
    const modal = document.createElement('div');
    modal.className = 'batch-map-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10000;
    `;
    
    modal.innerHTML = `
        <div style="
            background: white;
            border-radius: 12px;
            padding: 24px;
            max-width: 500px;
            width: 90%;
            max-height: 80vh;
            overflow-y: auto;
        ">
            <h3 style="margin: 0 0 16px 0;">🗺️ 지도 이미지 일괄 생성</h3>
            
            <div id="batch-map-content">
                <p>임대안내문에 추가된 빌딩 중 지도 이미지가 없는 빌딩을 찾고 있습니다...</p>
            </div>
            
            <div style="margin-top: 20px; display: flex; gap: 10px; justify-content: flex-end;">
                <button id="batch-map-cancel" style="
                    padding: 8px 16px;
                    background: #e5e7eb;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                ">닫기</button>
                <button id="batch-map-start" style="
                    padding: 8px 16px;
                    background: #3b82f6;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                " disabled>생성 시작</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    // 닫기 버튼
    modal.querySelector('#batch-map-cancel').onclick = () => {
        modal.remove();
    };
    
    // 이미지 없는 빌딩 찾기
    const contentDiv = modal.querySelector('#batch-map-content');
    const startBtn = modal.querySelector('#batch-map-start');
    
    // state에서 이미지 없는 빌딩 필터링
    const buildingsWithoutImage = (window.state?.tocItems || [])
        .filter(item => item.type === 'building')
        .filter(item => !item.images?.location)
        .filter(item => item.coordinates?.lat && item.coordinates?.lng);
    
    if (buildingsWithoutImage.length === 0) {
        contentDiv.innerHTML = `
            <p style="color: #10b981;">✅ 모든 빌딩에 지도 이미지가 있습니다!</p>
        `;
    } else {
        contentDiv.innerHTML = `
            <p>지도 이미지가 없는 빌딩: <strong>${buildingsWithoutImage.length}개</strong></p>
            <ul style="max-height: 200px; overflow-y: auto; margin: 10px 0; padding-left: 20px;">
                ${buildingsWithoutImage.map(b => `<li>${b.name || b.id}</li>`).join('')}
            </ul>
            <div id="batch-progress" style="display: none; margin-top: 10px;">
                <div style="height: 8px; background: #e5e7eb; border-radius: 4px; overflow: hidden;">
                    <div id="progress-bar" style="height: 100%; width: 0%; background: #3b82f6; transition: width 0.3s;"></div>
                </div>
                <p id="progress-text" style="font-size: 12px; color: #666; margin-top: 5px;">0 / ${buildingsWithoutImage.length}</p>
            </div>
        `;
        startBtn.disabled = false;
    }
    
    // 생성 시작 버튼
    startBtn.onclick = async () => {
        startBtn.disabled = true;
        startBtn.innerHTML = '생성 중...';
        
        const progressDiv = modal.querySelector('#batch-progress');
        const progressBar = modal.querySelector('#progress-bar');
        const progressText = modal.querySelector('#progress-text');
        
        progressDiv.style.display = 'block';
        
        const result = await generateLocationMapsBatch(buildingsWithoutImage);
        
        if (result.success !== undefined) {
            progressBar.style.width = '100%';
            progressBar.style.background = '#10b981';
            progressText.innerHTML = `완료! ${result.successCount}/${result.total} 성공`;
            
            // 3초 후 모달 닫기
            setTimeout(() => modal.remove(), 3000);
        }
    };
}


// ============================================================
// 내보내기 (ES6 모듈 사용 시)
// ============================================================
// export { generateLocationMapImage, addLocationMapButton, generateLocationMapsBatch, showBatchGenerateModal };


// ============================================================
// 전역 함수로 등록 (기존 방식)
// ============================================================
window.generateLocationMapImage = generateLocationMapImage;
window.addLocationMapButton = addLocationMapButton;
window.generateLocationMapsBatch = generateLocationMapsBatch;
window.showBatchGenerateModal = showBatchGenerateModal;
