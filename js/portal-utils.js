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
    const addr = String(address).toLowerCase();

    // ★ v4.6: 서울 여부를 먼저 판정한다.
    //
    // 기존에는 '중구'·'종로구' 같은 자치구 이름만 보고 CBD 로 분류해서
    // 부산·대구·대전·인천 중구 물건이 전부 서울 도심 권역으로 잡혔다.
    // (실측 26건) 광역시는 자치구 이름이 서울과 겹치므로 반드시 시도명을 먼저 본다.

    // 시도명은 '광역시'·'특별자치시'·'도' 등 행정단위까지 붙여서 판정한다.
    // '세종' 만 보면 서울 '세종대로' 가 세종시로 잡히므로 반드시 단위를 포함해야 한다.
    const NON_SEOUL = [
        '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시',
        '세종특별자치시', '제주특별자치도',
        '부산시', '대구시', '인천시', '광주시', '대전시', '울산시',
        // '대전 중구' 처럼 시명을 축약해 쓴 주소도 잡는다 (실측 9건)
        '부산 ', '대구 ', '인천 ', '광주 ', '대전 ', '울산 ', '세종 ', '제주 ',
        '강원특별자치도', '강원도', '충청북도', '충청남도',
        '전북특별자치도', '전라북도', '전라남도', '경상북도', '경상남도',
        '충북 ', '충남 ', '전북 ', '전남 ', '경북 ', '경남 ', '강원 '
    ];

    // 분당·판교는 경기도이지만 별도 권역(BBD)으로 관리한다. 지방 판정보다 먼저 본다.
    if (addr.includes('분당') || addr.includes('판교') ||
        (addr.includes('성남시') && !addr.includes('중원구') && !addr.includes('수정구'))) {
        return 'BBD';
    }

    const isSeoul = addr.includes('서울');

    // 서울 표기가 있으면 지방 판정을 건너뛴다.
    // ('서울특별시 중구 세종대로' 같은 주소가 세종시로 잡히는 것을 막는다)
    if (!isSeoul) {
        if (NON_SEOUL.some(k => addr.includes(k))) return 'ETC';
        if (addr.includes('경기도') || addr.includes('경기 ')) return 'ETC';
    }

    // GBD (강남·서초)
    if (addr.includes('강남구') || addr.includes('서초구')) return 'GBD';

    // YBD (여의도·영등포·마포)
    if (addr.includes('영등포구') || addr.includes('여의도') || addr.includes('마포구')) return 'YBD';

    // CBD (광화문·종로·중구)
    // 서울 표기가 없는 주소에서 '중구'만 보고 판정하면 광역시 중구가 섞이므로,
    // 위의 지방 판정을 통과한 경우에만 도달한다.
    if (addr.includes('종로구') || addr.includes('중구')) return 'CBD';

    // 구 단위 표기가 없는 서울 주소 (예: "역삼동 819-8")
    if (addr.includes('역삼') || addr.includes('삼성동') || addr.includes('논현') ||
        addr.includes('테헤란') || addr.includes('선릉') || addr.includes('도곡')) return 'GBD';
    if (addr.includes('여의') || addr.includes('공덕') || addr.includes('상암')) return 'YBD';
    if (addr.includes('광화문') || addr.includes('을지로') || addr.includes('명동') ||
        addr.includes('시청') || addr.includes('청계천') || addr.includes('세종대로')) return 'CBD';

    // 그 밖의 서울 → Others, 판정 불가 → ETC
    return isSeoul ? 'Others' : 'ETC';
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
