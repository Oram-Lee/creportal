/**
 * ========================================
 * CRE Portal - CRUD 후 갱신 진단 도구
 * 브라우저 콘솔에서 실행
 * ========================================
 */

// ★ 1. 현재 상태 스냅샷 — 빌딩 선택 후 실행
function debugState() {
    const s = window.state;
    if (!s) return console.error('❌ state 없음');
    
    const b = s.selectedBuilding;
    console.group('📊 현재 상태 스냅샷');
    console.log('선택 빌딩:', b?.name, `(${b?.id})`);
    console.log('allBuildings 수:', s.allBuildings?.length);
    console.log('dataCache.buildings 키 수:', Object.keys(s.dataCache?.buildings || {}).length);
    
    if (b) {
        // dataCache vs allBuildings vs selectedBuilding 비교
        const cached = s.dataCache?.buildings?.[b.id];
        const inList = s.allBuildings?.find(x => x.id === b.id);
        
        console.group('🔍 3곳 데이터 비교');
        console.table({
            'selectedBuilding': { name: b.name, grade: b.grade, depositPy: b.depositPy, rentPy: b.rentPy, freeParkingCondition: b.freeParkingCondition },
            'allBuildings[i]': { name: inList?.name, grade: inList?.grade, depositPy: inList?.depositPy, rentPy: inList?.rentPy, freeParkingCondition: inList?.freeParkingCondition },
            'dataCache.buildings': { name: cached?.name, grade: cached?.grade, depositPy: cached?.depositPy, rentPy: cached?.rentPy, freeParkingCondition: cached?.freeParkingCondition }
        });
        console.groupEnd();
        
        // 공실 데이터
        const vacCache = s.dataCache?.vacancies?.[b.id];
        console.log('vacancies (building):', b.vacancies?.length, '건');
        console.log('vacancies (dataCache):', vacCache ? Object.keys(vacCache).length : 0, '건');
    }
    console.groupEnd();
}

// ★ 2. 빌딩명 수정 시뮬레이션 — 캐시 동기화 테스트
function debugEditName(newName) {
    const s = window.state;
    const b = s?.selectedBuilding;
    if (!b) return console.error('❌ 빌딩 먼저 선택');
    
    const oldName = b.name;
    console.group(`✏️ 빌딩명 변경 시뮬레이션: "${oldName}" → "${newName || oldName + '_테스트'}"`);
    
    const testName = newName || oldName + '_테스트';
    
    // 1. selectedBuilding
    console.log('① selectedBuilding.name 변경...');
    b.name = testName;
    console.log('  → selectedBuilding.name:', b.name, b.name === testName ? '✅' : '❌');
    
    // 2. allBuildings
    const idx = s.allBuildings.findIndex(x => x.id === b.id);
    console.log(`② allBuildings[${idx}].name 변경...`);
    if (idx >= 0) {
        s.allBuildings[idx].name = testName;
        console.log('  → allBuildings:', s.allBuildings[idx].name, s.allBuildings[idx].name === testName ? '✅' : '❌');
    } else {
        console.error('  → ❌ allBuildings에서 못 찾음');
    }
    
    // 3. dataCache
    const cached = s.dataCache?.buildings?.[b.id];
    console.log('③ dataCache.buildings 변경...');
    if (cached) {
        cached.name = testName;
        console.log('  → dataCache:', cached.name, cached.name === testName ? '✅' : '❌');
    } else {
        console.error('  → ❌ dataCache에 빌딩 없음 — 이게 갱신 안되는 원인!');
    }
    
    // 4. processBuildings + UI 갱신
    console.log('④ processBuildings 호출 후 결과 확인...');
    if (typeof processBuildings === 'function') {
        processBuildings();
    } else if (window.processBuildings) {
        window.processBuildings();
    } else {
        console.warn('  → processBuildings 함수 접근 불가 (모듈 스코프)');
    }
    
    // 5. refreshAfterCrud 테스트
    console.log('⑤ refreshAfterCrud 접근 테스트...');
    if (typeof refreshAfterCrud === 'function') {
        console.log('  → 직접 접근 가능 ✅');
    } else if (window.refreshAfterCrud) {
        console.log('  → window.refreshAfterCrud 접근 가능 ✅');
    } else {
        console.error('  → ❌ refreshAfterCrud 접근 불가 — window에 노출 필요');
    }
    
    // 6. 목록에서 이름 확인
    const listItems = document.querySelectorAll('.building-name, .building-item-name, [data-building-id]');
    const found = Array.from(listItems).find(el => el.textContent.includes(testName));
    console.log('⑥ DOM에서 변경된 이름 표시:', found ? '✅ 반영됨' : '❌ 미반영 (UI 갱신 누락)');
    
    // 복원
    console.log('\n🔄 원래 이름으로 복원:', oldName);
    b.name = oldName;
    if (idx >= 0) s.allBuildings[idx].name = oldName;
    if (cached) cached.name = oldName;
    
    console.groupEnd();
}

// ★ 3. saveBuildingEdit 흐름 추적
function debugSaveBuildingEdit() {
    const s = window.state;
    const b = s?.selectedBuilding;
    if (!b) return console.error('❌ 빌딩 먼저 선택');
    
    console.group('🔬 saveBuildingEdit 분석');
    
    // saveBuildingEdit 함수 존재 확인
    console.log('window.saveBuildingEdit:', typeof window.saveBuildingEdit);
    
    // 핵심 문제: saveBuildingEdit가 dataCache를 업데이트하는지
    const cached = s.dataCache?.buildings?.[b.id];
    console.log('dataCache에 빌딩 존재:', !!cached);
    
    if (cached) {
        console.log('현재 dataCache.name:', cached.name);
        console.log('현재 selectedBuilding.name:', b.name);
        console.log('동일 참조?:', cached === b, '(false면 별도 객체 → 양쪽 모두 업데이트 필요)');
    }
    
    // refreshAfterCrud 호출 여부 확인
    console.log('\n📋 saveBuildingEdit 코드 내 갱신 호출 확인:');
    console.log('  - refreshAfterCrud 호출:', 'portal.html 내부 함수 → 직접 확인 불가');
    console.log('  - renderInfoSection 호출:', typeof window.renderInfoSection);
    console.log('  - processBuildings 호출:', typeof window.processBuildings);
    
    // 결론
    console.log('\n💡 예상 원인:');
    console.log('  1. saveBuildingEdit가 dataCache를 업데이트 안함');
    console.log('  2. saveBuildingEdit가 refreshAfterCrud를 호출 안함');
    console.log('  3. processBuildings가 dataCache 기반으로 allBuildings를 재구축');
    console.log('  → dataCache 미업데이트 시 processBuildings 호출해도 원래 상태로 복원됨');
    
    console.groupEnd();
}

// ★ 4. 공실 이관 후 상태 확인
function debugTransfer(fromBuildingId, toBuildingId) {
    const s = window.state;
    if (!s) return console.error('❌ state 없음');
    
    const from = fromBuildingId || s.selectedBuilding?.id;
    if (!from) return console.error('❌ fromBuildingId 필요');
    
    console.group('🔄 공실 이관 상태 확인');
    
    const fromBuilding = s.allBuildings.find(b => b.id === from);
    const fromCache = s.dataCache?.vacancies?.[from];
    
    console.log('출발 빌딩:', fromBuilding?.name);
    console.log('  allBuildings 공실:', fromBuilding?.vacancies?.length, '건');
    console.log('  dataCache 공실:', fromCache ? Object.keys(fromCache).length : '없음', '건');
    console.log('  일치?:', fromBuilding?.vacancies?.length === (fromCache ? Object.keys(fromCache).length : 0) ? '✅' : '❌ 불일치');
    
    if (toBuildingId) {
        const toBuilding = s.allBuildings.find(b => b.id === toBuildingId);
        const toCache = s.dataCache?.vacancies?.[toBuildingId];
        console.log('\n도착 빌딩:', toBuilding?.name);
        console.log('  allBuildings 공실:', toBuilding?.vacancies?.length, '건');
        console.log('  dataCache 공실:', toCache ? Object.keys(toCache).length : '없음', '건');
    }
    
    console.groupEnd();
}

// ★ 5. 파일 버전 확인 — 배포 후 캐시 확인용
function debugVersion() {
    console.group('📦 파일 버전 확인');
    
    // portal-complist.js v10.2 마커 확인
    const scripts = document.querySelectorAll('script[src]');
    scripts.forEach(s => {
        if (s.src.includes('portal-complist') || s.src.includes('portal-crud') || s.src.includes('portal-css')) {
            console.log('스크립트:', s.src);
        }
    });
    
    // CSS에서 toast-container 위치 확인 (#5)
    const toastEl = document.querySelector('.toast-container');
    if (toastEl) {
        const style = getComputedStyle(toastEl);
        console.log('토스트 bottom:', style.bottom, style.bottom === '80px' ? '✅ v10.2' : '❌ 구버전');
        console.log('토스트 z-index:', style.zIndex, parseInt(style.zIndex) >= 9999 ? '✅ v10.2' : '❌ 구버전');
    }
    
    // 무료주차 항목 확인
    console.log('\n💡 캐시 무효화: Ctrl+Shift+R (하드 리프레시)');
    console.log('💡 또는: DevTools > Network > Disable cache 체크 후 새로고침');
    
    console.groupEnd();
}

// ★ 전역 등록
window.debugState = debugState;
window.debugEditName = debugEditName;
window.debugSaveBuildingEdit = debugSaveBuildingEdit;
window.debugTransfer = debugTransfer;
window.debugVersion = debugVersion;

console.log('🔧 디버그 도구 로드 완료');
console.log('  debugState()          — 현재 상태 스냅샷');
console.log('  debugEditName("새이름") — 빌딩명 변경 시뮬레이션');
console.log('  debugSaveBuildingEdit() — saveBuildingEdit 흐름 분석');
console.log('  debugTransfer(from, to)  — 공실 이관 상태 확인');
console.log('  debugVersion()         — 파일 버전/캐시 확인');
