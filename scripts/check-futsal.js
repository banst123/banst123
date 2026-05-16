import fetch from "node-fetch";
import { JSDOM } from "jsdom";

// ===== 설정 영역 (테스트용) =====

// 테스트: 풋살2구장만 모니터링
// 기존 배열: ["인조잔디(구)", "인조잔디(신)", "풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"]
// placeParts = ["04", "14", "05", "05", "05", "05"]
// placeIds   = ["2", "26", "6", "7", "8", "9"]

const placeNames = ["풋살2구장"];
const placeParts = ["05"];
const placeIds   = ["7"];

// 19시, 20시, 21시 (각 1시간) 세션 ID
// 안드로이드 로직: 시작시간 = id + 6 이라면,
// 19시 -> 19-6=13, 20시 -> 14, 21시 -> 15
const targetSessionIds = [13, 14, 15];

// 날짜 범위: "오늘+1일"부터 "오늘+7일"까지만 (총 7일)
function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function getNextDaysRange(startOffset, days) {
  const dates = [];
  const today = new Date();
  for (let i = startOffset; i < startOffset + days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(formatDate(d));
  }
  return dates;
}

// yyyyMMdd -> "MM/DD(요일)" 한글 요일
function formatDatePretty(dateStr) {
  try {
    const yyyy = parseInt(dateStr.slice(0, 4), 10);
    const mm = parseInt(dateStr.slice(4, 6), 10) - 1;
    const dd = parseInt(dateStr.slice(6, 8), 10);
    const d = new Date(yyyy, mm, dd);
    const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
    const day = dayNames[d.getDay()];
    const mmStr = String(mm + 1).padStart(2, "0");
    const ddStr = String(dd).padStart(2, "0");
    return `${mmStr}/${ddStr}(${day})`;
  } catch {
    return dateStr;
  }
}

// 예약 페이지 URL 생성 (풋살2구장 전용)
function buildUrl(date, placeIndex) {
  const part = placeParts[placeIndex];
  const place = placeIds[placeIndex];
  return `https://www.bnfmc.or.kr/reservation/www/9?facilities_type=T&base_date=${date}&rent_type=1001&center=NAMGUSPORTS02&part=${part}&place=${place}#regist_list`;
}

// ===== HTTP & 파싱 =====

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

// HTML에서 checkbox_time_13/14/15의 disabled/checked를 직접 확인
function parseAvailability(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const slots = [];

  for (const id of targetSessionIds) {
    const cb = document.querySelector(`input[id="checkbox_time_${id}"]`);

    if (!cb) {
      console.log(`[parse] checkbox_time_${id} 를 찾지 못함`);
      continue;
    }

    // 체크박스가 포함된 행
    const row = cb.closest("tr");
    const cells = row ? row.querySelectorAll("td") : [];
    const rawLast = cells.length > 0 ? (cells[cells.length - 1].textContent || "") : "";
    const cleaned = rawLast.replace(/예약가능|선택|-/g, "").trim();

    const disabled = cb.disabled;
    const checked = cb.checked;
    const available = !disabled && !checked;
    const booker = available ? "예약가능" : (cleaned || "완료");

    const sessionNo = id + 1;
    const startHour = id + 6;
    const endHour = startHour + 1;
    const time =
      `${String(startHour).padStart(2, "0")}:00~` +
      `${String(endHour).padStart(2, "0")}:00`;

    console.log(
      `[parse] id=${id}, time=${time}, disabled=${disabled}, checked=${checked}, ` +
        `raw="${rawLast.trim()}", cleaned="${cleaned}", available=${available}, booker=${booker}`
    );

    slots.push({
      id,
      sessionNo,
      time,
      available,
      booker,
    });
  }

  return slots;
}

// ===== 메인 로직 =====

async function main() {
  // 오늘+1일 ~ 오늘+7일
  const dates = getNextDaysRange(1, 7);

  console.log(`=== 모니터링 시작 (테스트 모드) ===`);
  console.log(`날짜 범위: ${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log(`구장: ${placeNames.join(", ")}`);
  console.log(`타겟 세션 IDs: ${targetSessionIds.join(", ")}`);

  const alerts = [];

  for (const date of dates) {
    console.log(`\n[날짜] ${date} (${formatDatePretty(date)}) 처리 시작`);

    for (let pIdx = 0; pIdx < placeNames.length; pIdx++) {
      const url = buildUrl(date, pIdx);
      console.log(`  [구장] ${placeNames[pIdx]} URL: ${url}`);

      try {
        const html = await fetchHtml(url);
        console.log(`    - HTML 길이: ${html.length}`);

        const slots = parseAvailability(html);
        const availCount = slots.filter((s) => s.available).length;
        console.log(
          `    - 타겟 세션 수: ${slots.length}, 예약가능: ${availCount}`
        );

        const availableSlots = slots.filter((s) => s.available);

        if (availableSlots.length > 0) {
          alerts.push({
            date,
            placeIndex: pIdx,
            placeName: placeNames[pIdx],
            slots: availableSlots,
          });
        }
      } catch (e) {
        console.error(`    ! Error for ${date} ${placeNames[pIdx]}:`, e.message);
      }
    }
  }

  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    const lines = [];
    lines.push("▣ 백운포 풋살2구장 예약 가능 알림 (테스트 모드) ▣");
    lines.push("");

    for (const alert of alerts) {
      const dateTitle = formatDatePretty(alert.date);
      lines.push(`▶ ${dateTitle} ${alert.placeName}`);
      for (const s of alert.slots) {
        lines.push(` - ${s.sessionNo}회 ${s.time}: ${s.booker}`);
      }
      lines.push("");
    }

    message = lines.join("\n");
  } else {
    available = false;
    message =
      "현재(테스트 범위: 풋살2구장, 오늘+1~7일, 19/20/21시)에 예약 가능 슬롯이 없습니다.";
  }

  console.log("\n=== 결과 요약 ===");
  console.log(message);

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const fs = await import("fs");
    fs.appendFileSync(ghOutput, `available=${available}\n`);
    fs.appendFileSync(ghOutput, `message<<EOF\n${message}\nEOF\n`);
  }
}

main().catch((e) => {
  console.error("check-futsal.js failed:", e);
  process.exit(1);
});
