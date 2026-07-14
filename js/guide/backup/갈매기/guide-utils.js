/**
 * Leasing Guide - 유틸리티 함수
 * 
 * v2.2 수정사항:
 * - formatPrice: 금액 자동 포맷팅 (콤마 추가)
 * - formatPriceWithComma: 숫자에 콤마 자동 추가
 */

// 토스트 메시지 표시
export function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = `toast show ${type}`;
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// 숫자 포맷팅 (콤마)
export function formatNumber(n) {
    if (!n && n !== 0) return '-';
    return Number(n).toLocaleString();
}

// ★ 금액 포맷팅 (콤마 자동 추가)
export function formatPrice(value) {
    if (!value && value !== 0) return '-';
    
    // 이미 문자열인 경우
    if (typeof value === 'string') {
        // "만", "억" 단위가 포함된 경우 그대로 반환
        if (value.includes('만') || value.includes('억') || value.includes('문의') || value.includes('협의')) {
            return value;
        }
        
        // 숫자만 추출해서 콤마 추가
        const numStr = value.replace(/[^0-9.]/g, '');
        if (numStr) {
            const num = parseFloat(numStr);
            if (!isNaN(num)) {
                return formatNumber(num);
            }
        }
        return value;
    }
    
    // 숫자인 경우 콤마 추가
    if (typeof value === 'number') {
        return formatNumber(value);
    }
    
    return String(value);
}

// ★ 금액 입력값 정규화 (콤마 추가 + 단위 유지)
export function formatPriceInput(value) {
    if (!value) return '';
    
    const str = String(value).trim();
    
    // "만", "억" 단위 처리
    const unitMatch = str.match(/(만|억)/);
    const unit = unitMatch ? unitMatch[1] : '';
    
    // 숫자 부분 추출
    const numPart = str.replace(/[^0-9.]/g, '');
    if (!numPart) return str;
    
    const num = parseFloat(numPart);
    if (isNaN(num)) return str;
    
    // 소수점이 있으면 그대로, 없으면 콤마 추가
    if (numPart.includes('.')) {
        return numPart + unit;
    }
    
    return formatNumber(num) + unit;
}

// ★ 가격 표시용 (원/평 단위)
export function formatPriceWon(value) {
    if (!value) return '-';
    
    const str = String(value).trim();
    
    // 이미 포맷된 경우
    if (str.includes('만') || str.includes('억')) {
        return str;
    }
    
    // 숫자만 있는 경우 콤마 추가
    const num = parseFloat(str.replace(/[^0-9.]/g, ''));
    if (!isNaN(num) && num > 0) {
        return formatNumber(num);
    }
    
    return str || '-';
}

// ★ 가격을 원 단위로 변환
export function toWon(value) {
    if (!value) return 0;
    
    const str = String(value).trim();
    const numPart = parseFloat(str.replace(/[^0-9.]/g, '')) || 0;
    
    if (str.includes('억')) {
        return numPart * 100000000;
    } else if (str.includes('만')) {
        return numPart * 10000;
    }
    
    return numPart;
}

// 권역 감지
export function detectRegion(address) {
    if (!address) return 'ETC';
    if (address.includes('강남') || address.includes('서초') || address.includes('삼성')) return 'GBD';
    if (address.includes('여의도') || address.includes('영등포') || address.includes('마포')) return 'YBD';
    if (address.includes('종로') || address.includes('중구') || address.includes('을지로') || address.includes('광화문')) return 'CBD';
    if (address.includes('판교') || address.includes('분당') || address.includes('성남')) return 'PAN';
    return 'ETC';
}

// 권역 한글명
export function getRegionName(region) {
    const names = {
        'GBD': '강남',
        'YBD': '여의도',
        'CBD': '도심',
        'PAN': '판교',
        'ETC': '기타'
    };
    return names[region] || region;
}

// 빌딩 데이터 정규화 (Firebase 원본 구조 → 플랫)
export function normalizeBuilding(building) {
    if (!building) return building;
    
    // ★ v3.2: 층수 파싱 개선 - 건축물대장 API 결과 지원
    // 1. floors.above/below가 숫자로 있는 경우 (건축물대장 API 결과)
    if (!building.floorsAbove && building.floors?.above) {
        building.floorsAbove = parseInt(building.floors.above) || 0;
    }
    if (!building.floorsBelow && building.floors?.below) {
        building.floorsBelow = parseInt(building.floors.below) || 0;
    }
    
    // 2. floors.display가 있는 경우 (예: "지하6층/지상27층", "지하6층, 지상27층")
    if ((!building.floorsAbove || !building.floorsBelow) && building.floors?.display) {
        const display = building.floors.display;
        // "지상27층" 또는 "지상 27층" 패턴
        const aboveMatch = display.match(/지상\s*(\d+)\s*층/);
        if (aboveMatch && !building.floorsAbove) {
            building.floorsAbove = parseInt(aboveMatch[1]);
        }
        // "지하6층" 또는 "지하 6층" 패턴
        const belowMatch = display.match(/지하\s*(\d+)\s*층/);
        if (belowMatch && !building.floorsBelow) {
            building.floorsBelow = parseInt(belowMatch[1]);
        }
    }
    
    // 3. floors가 문자열인 경우 (예: "B6/50F")
    if (!building.floorsAbove && building.floors && typeof building.floors === 'string') {
        const match = building.floors.match(/(\d+)F/);
        if (match) building.floorsAbove = parseInt(match[1]);
        const belowMatch = building.floors.match(/B(\d+)/);
        if (belowMatch) building.floorsBelow = parseInt(belowMatch[1]);
    }
    
    // 4. floorsDisplay 저장 (편집 페이지 표시용)
    if (!building.floorsDisplay && (building.floorsAbove || building.floorsBelow)) {
        building.floorsDisplay = `B${building.floorsBelow || 0} / ${building.floorsAbove || 0}F`;
    }
    if (!building.floorsDisplay && building.floors?.display) {
        building.floorsDisplay = building.floors.display;
    }
    
    // 연면적 (area.grossFloorPy → grossFloorPy)
    if (!building.grossFloorPy && building.area?.grossFloorPy) {
        building.grossFloorPy = building.area.grossFloorPy;
    }
    // 구버전 호환
    if (!building.grossFloorPy && building.grossFloor?.grossFloorPy) {
        building.grossFloorPy = building.grossFloor.grossFloorPy;
    }
    
    // 기준층 (area.typicalFloorPy → typicalFloorPy)
    if (!building.typicalFloorPy && building.area?.typicalFloorPy) {
        building.typicalFloorPy = building.area.typicalFloorPy;
    }
    // 구버전 호환
    if (!building.typicalFloorPy && building.typicalFloor?.typicalFloorPy) {
        building.typicalFloorPy = building.typicalFloor.typicalFloorPy;
    }
    
    // 전용률 (area.exclusiveRate → exclusiveRate)
    if (!building.exclusiveRate && building.area?.exclusiveRate) {
        building.exclusiveRate = building.area.exclusiveRate;
    }
    
    // 엘리베이터 (specs.passengerElevator + freightElevator → elevatorTotal)
    if (!building.elevatorTotal) {
        if (building.specs?.passengerElevator || building.specs?.freightElevator) {
            building.elevatorTotal = (parseInt(building.specs.passengerElevator) || 0) + 
                                     (parseInt(building.specs.freightElevator) || 0);
        } else if (building.passengerElevator || building.freightElevator) {
            building.elevatorTotal = (parseInt(building.passengerElevator) || 0) + 
                                     (parseInt(building.freightElevator) || 0);
        } else if (building.elevator) {
            // elevator가 숫자인 경우
            if (typeof building.elevator === 'number') {
                building.elevatorTotal = building.elevator;
            }
            // elevator가 객체인 경우
            else if (typeof building.elevator === 'object') {
                building.elevatorTotal = (parseInt(building.elevator.passengerElevator) || 0) + 
                                         (parseInt(building.elevator.freightElevator) || 0);
            }
        }
        // ★ v3.1: specs.elevator가 문자열인 경우 (예: "총 3대(승용 2대 비상화물용 1대)")
        if (!building.elevatorTotal && building.specs?.elevator && typeof building.specs.elevator === 'string') {
            const match = building.specs.elevator.match(/총\s*(\d+)\s*대/);
            if (match) {
                building.elevatorTotal = parseInt(match[1]);
            }
        }
    }
    
    // 주차 (parking.total → parkingTotal)
    if (!building.parkingTotal && building.parking?.total) {
        building.parkingTotal = building.parking.total;
    }
    // ★ v3.1: parking.display가 문자열인 경우 (예: "총 93대(자주식 93대 )")
    if (!building.parkingTotal && building.parking?.display && typeof building.parking.display === 'string') {
        const match = building.parking.display.match(/총\s*(\d+)\s*대/);
        if (match) {
            building.parkingTotal = parseInt(match[1]);
        }
    }
    if (!building.parkingNote && building.parking?.ratio) {
        building.parkingNote = `(${building.parking.ratio})`;
    }
    if (!building.parkingNote && building.parkingRatio) {
        building.parkingNote = `(${building.parkingRatio})`;
    }
    
    // 준공년도 (specs.completionYear → completionYear)
    if (!building.completionYear && building.specs?.completionYear) {
        building.completionYear = building.specs.completionYear;
    }
    // 구버전 호환
    if (!building.completionYear && building.completion?.year) {
        building.completionYear = building.completion.year;
    }
    
    // 주소
    if (!building.address && building.roadAddress) {
        building.address = building.roadAddress;
    }
    
    // 인근역 (nearbyStation은 이미 플랫)
    if (!building.nearbyStation && building.nearestStation) {
        building.nearbyStation = building.nearestStation;
    }
    
    // ★ v3.0: floorPricing에서 기준가 추출
    if (building.floorPricing) {
        // 객체 형태인 경우 배열로 변환
        if (!Array.isArray(building.floorPricing)) {
            building.floorPricing = Object.values(building.floorPricing);
        }
        // 첫 번째 항목에서 기준가 추출
        if (building.floorPricing.length > 0) {
            const firstPricing = building.floorPricing[0];
            if (!building.depositPy && firstPricing.depositPy) {
                building.depositPy = firstPricing.depositPy;
            }
            if (!building.rentPy && firstPricing.rentPy) {
                building.rentPy = firstPricing.rentPy;
            }
            if (!building.maintenancePy && firstPricing.maintenancePy) {
                building.maintenancePy = firstPricing.maintenancePy;
            }
        }
    }
    
    return building;
}

// 날짜 포맷팅
export function formatDate(dateStr) {
    if (!dateStr) return '-';
    try {
        const date = new Date(dateStr);
        return date.toLocaleDateString('ko-KR');
    } catch {
        return dateStr;
    }
}

// 파일 크기 포맷팅
export function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 이미지 리사이즈 (압축)
export function resizeImage(dataUrl, maxWidth = 1200, quality = 0.8) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;
            
            if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = dataUrl;
    });
}

// 외관 이미지 가져오기
export function getExteriorImages(building) {
    if (!building) return [];
    
    const images = [];
    
    // images.exterior 배열
    if (building.images?.exterior && Array.isArray(building.images.exterior)) {
        building.images.exterior.forEach(img => {
            if (typeof img === 'string') {
                images.push({ url: img });
            } else if (img.url) {
                images.push(img);
            }
        });
    }
    
    // exteriorImages 배열 (플랫 구조)
    if (building.exteriorImages && Array.isArray(building.exteriorImages)) {
        building.exteriorImages.forEach(img => {
            if (typeof img === 'string') {
                images.push({ url: img });
            } else if (img.url) {
                images.push(img);
            }
        });
    }
    
    // 단일 이미지
    if (building.exteriorImage) {
        images.push({ url: building.exteriorImage });
    }
    if (building.mainImage) {
        images.push({ url: building.mainImage });
    }
    
    return images;
}

// 평면도 이미지 가져오기
export function getFloorPlanImages(building) {
    if (!building) return [];
    
    const images = [];
    
    // images.floorPlan 배열
    if (building.images?.floorPlan && Array.isArray(building.images.floorPlan)) {
        building.images.floorPlan.forEach(img => {
            if (typeof img === 'string') {
                images.push({ url: img });
            } else if (img.url) {
                images.push(img);
            }
        });
    }
    
    // floorPlanImages 배열 (플랫 구조)
    if (building.floorPlanImages && Array.isArray(building.floorPlanImages)) {
        building.floorPlanImages.forEach(img => {
            if (typeof img === 'string') {
                images.push({ url: img });
            } else if (img.url) {
                images.push(img);
            }
        });
    }
    
    // 단일 이미지
    if (building.floorPlanImage) {
        images.push({ url: building.floorPlanImage });
    }
    
    return images;
}

// 디바운스 함수
export function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// UUID 생성
export function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// 클립보드 복사
export async function copyToClipboard(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Fallback
        const textArea = document.createElement('textarea');
        textArea.value = text;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        return true;
    }
}

// 날짜 범위 체크
export function isWithinDays(dateStr, days) {
    if (!dateStr) return false;
    const date = new Date(dateStr);
    const now = new Date();
    const diff = Math.abs(now - date);
    const diffDays = Math.ceil(diff / (1000 * 60 * 60 * 24));
    return diffDays <= days;
}

// 스크롤 애니메이션
export function smoothScrollTo(element, offset = 0) {
    if (!element) return;
    const top = element.getBoundingClientRect().top + window.pageYOffset - offset;
    window.scrollTo({ top, behavior: 'smooth' });
}

// ========== 테마 관리 ==========
// 테마 초기화
export function initTheme() {
    const saved = localStorage.getItem('crePortalTheme');
    if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
    }
}

// 테마 토글
export function toggleTheme() {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('crePortalTheme', next);
}
