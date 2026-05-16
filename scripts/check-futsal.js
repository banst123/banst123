import fetch from "node-fetch";
import { JSDOM } from "jsdom";

// ===== 설정 영역 =====

// 백운포 풋살/인조잔디 구장 설정 (안드로이드 코드 매핑을 그대로 사용한다고 가정)
const placeNames = ["인조잔디(구)", "인조잔디(신)", "풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeParts = ["04", "14", "05", "05", "05", "05"];
const placeIds   = ["2", "26", "6", "7", "8", "9"];

// 19시, 20시, 21시 한 시간씩에 해당하는 세션 ID들
// 안드로이드 코드 규칙: checkbox_time_<id>, 시작시간 = id + 6
// 19시 -> id = 13, 20시 -> 14, 21시 -> 15
const targetSessionIds = [13, 14, 15];

// 모니터링 날짜 범위: 기본은 "이번 달 + 다음 달"
// 속도 문제 시 getNextNDaysDates(N)으로 교체 가능.
const USE_MONTH_RANGE = true;
const NEXT_N_DAYS = 14; // USE_MONTH_RANGE = false 일 때만 사용

// ===== 유틸 함수 =====

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function getMonthRange(year, month0) {
  const start = new Date(year, month0, 1);
  const end = new Date(year, month0 + 1, 0);
  const dates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(formatDate(d));
  }
  return dates;
}

function getCurrentAndNextMonthDates() {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const thisMonth = getMonthRange(y, m);
  const nextMonth = getMonthRange(m === 11 ? y + 1 : y, (m + 1) % 12);
  return [...thisMonth, ...nextMonth];
}

function getNextNDaysDates(n) {
  const dates = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
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

// 예약 페이지 URL 생성
function buildUrl(date, placeIndex) {
  const part = placeParts[placeIndex];
  const place = placeIds[placeIndex];
  return `https://www.bnfmc.or.kr/reservation/www/9?facilities_type=T&base_date=${date}&rent_type=1001&center=NAMGUSPORTS02&part=${part}&place=${place}#regist_list`;
}

// ===== HTTP & 파싱 =====

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000); // 25초 타임아웃 [web:64]
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

// HTML에서 타겟 세션(19,20,21시)만 추려 예약가능 여부 파싱 + 디버그 로그
function parseAvailability(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const rows = Array.from(document.querySelectorAll("tr"));

  const slots = [];

  for (const row of rows) {
    const cb = row.querySelector("input[id^='checkbox_time_']");
    if (!cb) continue;
    const idStr = cb.id.replace("checkbox_time_", "");
    const id = parseInt(idStr, 10);

    // 전체 세션을 보고 싶으면 아래 if를 주석 처리해서 한번 디버깅할 수도 있음
    const isTarget = targetSessionIds.includes(id);

    const cells = row.querySelectorAll("td");
    const rawLast = cells.length > 0 ? (cells[cells.length - 1].textContent || "") : "";
    const cleaned = rawLast.replace(/예약가능|선택|-/g, "").trim();
    const available = !cb.disabled && !cb.checked;
    const booker = available ? "예약가능" : (cleaned || "완료");

    const sessionNo = id + 1;
    const startHour = id + 6;
    const endHour = startHour + 1;
    const time =
      `${String(startHour).padStart(2, "0")}:00~` +
      `${String(endHour).padStart(2, "0")}:00`;

    // 디버그 로그: 모든 세션에 대해 찍되, 타겟 세션은 표시
    console.log(
      `[parse] id=${id}, target=${isTarget}, time=${time}, ` +
        `disabled=${cb.disabled}, checked=${cb.checked}, ` +
        `raw="${rawLast.trim()}", cleaned="${cleaned}", ` +
        `available=${available}, booker=${booker}`
    );

    if (!isTarget) continue;

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
  const dates = USE_MONTH_RANGE
    ? getCurrentAndNextMonthDates()
    : getNextNDaysDates(NEXT_N_DAYS);

  console.log(`=== 모니터링 시작 ===`);
  console.log(`날짜 개수: ${dates.length}일`);
  console.log(`구장 개수: ${placeNames.length}개`);
  console.log(`타겟 세션 IDs: ${targetSessionIds.join(", ")}`);
  console.log(`USE_MONTH_RANGE = ${USE_MONTH_RANGE}, NEXT_N_DAYS = ${NEXT_N_DAYS}`);

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
          `    - 파싱된 타겟 슬롯 수: ${slots.length} (예약가능: ${availCount})`
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
    lines.push("▣ 백운포 풋살 예약 가능 알림 ▣");
    lines.push("");

    for (const alert of alerts) {
      const dateTitle = formatDatePretty(alert.date);
      lines.push(`▶ ${dateTitle} ${alert.placeName}`);
      for (const s of alert.slots) {
        lines.push(` - ${s.sessionNo}회 ${s.time}: ${s.booker}`); // booker는 "예약가능"일 것
      }
      lines.push("");
    }

    message = lines.join("\n");
  } else {
    available = false;
    message = "현재 모니터링 구장/시간대에 예약 가능 슬롯이 없습니다.";
  }

  console.log("\n=== 결과 요약 ===");
  console.log(message);

  // GitHub Actions output (set-output 폐지 → $GITHUB_OUTPUT 사용) [web:39][web:40][web:41][web:43]
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
