/**
 * CRE Portal - 유틸리티 함수
 */

// 토스트 메시지
export function showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    document.getElementById('toastContainer').appendChild(t);
    setTimeout(() => t.remove(), 3000);
}

// 숫자 포맷팅
export function formatNumber(n) {
    return n ? new Intl.NumberFormat('ko-KR').format(Math.round(n)) : '-';
}

// 평당 가격 포맷팅
export function formatPyPrice(val) {
    if (!val) return '-';
    const s = String(val).replace(/[^\d.]/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? val : formatNumber(n * 10000) + '원';
}

// 디바운스
export function debounce(fn, delay) {
    let t;
    return (...a) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...a), delay);
    };
}

// 권역 자동 판별
export function detectRegion(address) {
    if (!address) return null;
    const addr = address.toLowerCase();
    
    // GBD (강남)
    if (addr.includes('강남구') || addr.includes('서초구')) {
        if (addr.includes('테헤란') || addr.includes('삼성동') || addr.includes('역삼') || 
            addr.includes('선릉') || addr.includes('강남역') || addr.includes('논현') ||
            addr.includes('신논현') || addr.includes('언주') || addr.includes('도곡')) {
            return 'GBD';
        }
        return 'GBD';
    }
    
    // YBD (여의도)
    if (addr.includes('영등포구') || addr.includes('여의도') || addr.includes('마포구')) {
        if (addr.includes('여의') || addr.includes('국제금융')) {
            return 'YBD';
        }
        if (addr.includes('마포') || addr.includes('공덕') || addr.includes('상암')) {
            return 'YBD';
        }
        return 'YBD';
    }
    
    // CBD (광화문/종로)
    if (addr.includes('종로구') || addr.includes('중구')) {
        if (addr.includes('광화문') || addr.includes('세종대로') || addr.includes('종로') ||
            addr.includes('을지로') || addr.includes('명동') || addr.includes('시청') ||
            addr.includes('청계천')) {
            return 'CBD';
        }
        return 'CBD';
    }
    
    // BBD (분당)
    if (addr.includes('분당') || addr.includes('성남시') || addr.includes('판교')) {
        return 'BBD';
    }
    
    // 기타 서울
    if (addr.includes('서울')) {
        return 'ETC';
    }
    
    return 'ETC';
}

// 권역 자동 설정
export function autoSetRegion(building) {
    if (!building.region && building.address) {
        const detected = detectRegion(building.address);
        if (detected) {
            building.region = detected;
            building.regionAutoDetected = true;
        }
    }
    return building;
}

// 층수 포맷팅
export function formatFloors(b) {
    if (!b.floorBelow && !b.floorAbove) return '-';
    const below = b.floorBelow ? `B${b.floorBelow}` : '';
    const above = b.floorAbove ? `${b.floorAbove}F` : '';
    return [below, above].filter(Boolean).join('/');
}

// 역세권 정보 포맷팅
export function formatStation(b) {
    if (!b.nearestStation) return '-';
    const dist = b.stationDistance ? ` ${b.stationDistance}m` : '';
    return b.nearestStation + dist;
}

// 최근 1개월 체크 함수
export function isRecentlyUpdated(dateStr) {
    if (!dateStr) return false;
    const now = new Date();
    const oneMonthAgo = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
    
    let date;
    if (dateStr.includes('T')) {
        date = new Date(dateStr);
    } else if (dateStr.includes('.')) {
        const parts = dateStr.split('.');
        if (parts[0].length === 2) {
            date = new Date(2000 + parseInt(parts[0]), parseInt(parts[1]) - 1);
        } else {
            date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1);
        }
    } else if (dateStr.includes('-')) {
        date = new Date(dateStr);
    } else {
        return false;
    }
    
    return date >= oneMonthAgo;
}

// window에 등록 (HTML onclick 호환)
window.showToast = showToast;
window.formatNumber = formatNumber;
