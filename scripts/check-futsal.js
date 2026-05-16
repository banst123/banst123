import fetch from "node-fetch";
import { JSDOM } from "jsdom";

// ===== 설정 영역 (디버그용) =====

// 풋살2구장만 모니터링
const placeNames = ["풋살2구장"];
const placeParts = ["05"];
const placeIds   = ["7"];

// 시간대: 06:00 ~ 23:00 시작까지 전부 (필터를 안 걸고, 다 찍기 전용)
const MONITOR_START_HOUR = 6;
const MONITOR_END_HOUR   = 23;

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

// HTML에서 모든 time 체크박스를 스캔하고, 06~23시 전체 상태를 로그로 출력
function parseAvailability(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // 모든 time 체크박스 수집
  const inputs = Array.from(
    document.querySelectorAll('input[type="checkbox"][name="time"][id^="checkbox_time_"]')
  );
  console.log(`[parse] time 체크박스 개수: ${inputs.length}`);

  const slots = [];

  for (const cb of inputs) {
    const idAttr = cb.id || "";
    const idNum = parseInt(idAttr.replace("checkbox_time_", ""), 10);

    const valueAttr = cb.value || "";
    const parts = valueAttr.split(";");
    // 예: "844;11회;1600;1700;1"
    const sessionLabel = (parts[1] || "").trim(); // "11회"
    const startStr = (parts[2] || "").trim();      // "1600"
    const endStr = (parts[3] || "").trim();        // "1700"

    let startHour = NaN;
    let endHour = NaN;
    if (startStr.length >= 2 && endStr.length >= 2) {
      startHour = parseInt(startStr.slice(0, 2), 10);
      endHour = parseInt(endStr.slice(0, 2), 10);
    }

    const disabled = cb.disabled;
    const checked = cb.checked;
    const available = !disabled && !checked;

    const row = cb.closest("tr");
    const cells = row ? row.querySelectorAll("td") : [];
    const rawLast = cells.length > 0 ? (cells[cells.length - 1].textContent || "") : "";
    const cleaned = rawLast.replace(/예약가능|선택|-/g, "").trim();
    const booker = available ? "예약가능" : (cleaned || "완료");

    // 06~23시 범위인지 여부만 표시 (필터는 안 걸고, 로그만 찍음)
    const inRange =
      !Number.isNaN(startHour) &&
      startHour >= MONITOR_START_HOUR &&
      startHour <= MONITOR_END_HOUR;

    console.log(
      `[parse] id=${idNum}, inRange=${inRange}, value="${valueAttr}", ` +
        `session=${sessionLabel}, time=${startStr}~${endStr}, ` +
        `startHour=${startHour}, endHour=${endHour}, ` +
        `disabled=${disabled}, checked=${checked}, available=${available}, ` +
        `raw="${rawLast.trim()}", cleaned="${cleaned}"`
    );

    // 일단 06~23시 범위면 전부 slots에 넣어둠 (예약 가능/불가 관계없이)
    if (inRange) {
      slots.push({
        id: idNum,
        sessionLabel,
        startHour,
        endHour,
        available,
        booker,
      });
    }
  }

  return slots;
}

// ===== 메인 로직 =====

async function main() {
  const dates = getNextDaysRange(1, 7);

  console.log(`=== 모니터링 시작 (디버그 모드: 풋살2, 오늘+1~7일, 06~23시 전체 체크박스) ===`);
  console.log(`날짜 범위: ${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log(`구장: ${placeNames.join(", ")}`);
  console.log(`체크 대상 시작시: ${MONITOR_START_HOUR}시 ~ ${MONITOR_END_HOUR}시`);

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
          `    - 06~23시 범위 슬롯 수: ${slots.length}, 예약가능: ${availCount}`
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
    lines.push("▣ 백운포 풋살2구장 예약 가능 알림 (디버그 모드: 06~23시) ▣");
    lines.push("");

    for (const alert of alerts) {
      const dateTitle = formatDatePretty(alert.date);
      lines.push(`▶ ${dateTitle} ${alert.placeName}`);
      for (const s of alert.slots) {
        lines.push(
          ` - id=${s.id}, ${s.sessionLabel} ${s.startHour}:00~${s.endHour}:00: ${s.booker}`
        );
      }
      lines.push("");
    }

    message = lines.join("\n");
  } else {
    available = false;
    message =
      "현재(디버그 범위: 풋살2구장, 오늘+1~7일, 06~23시)에서 예약 가능 슬롯이 없습니다.";
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
