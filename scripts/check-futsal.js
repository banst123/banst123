import puppeteer from "puppeteer";

// ===== 설정 영역 =====

// 풋살 1~4구장 (part는 모두 05, placeId는 안드로이드 기준)
const placeNames = ["풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeParts = ["05", "05", "05", "05"];
const placeIds   = ["6",  "7",  "8",  "9"]; // 1~4구장 place id

// 모니터링 대상 요일: 월(1), 목(4), 금(5)
// 기준: "내일"부터 시작해서 4주간 범위 내에서 이 요일만 선택
const TARGET_WEEKDAYS = [1, 4, 5]; // 월, 목, 금
const WEEKS_AHEAD = 4;

// ===== 날짜 유틸 =====

function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
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

// 오늘 기준: 내일~4주 뒤까지 중에서 월·목·금만 추출
function getTargetDates() {
  const dates = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() + 1); // 내일부터

  const end = new Date(start);
  end.setDate(end.getDate() + WEEKS_AHEAD * 7); // 4주간

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay(); // 0=일, 1=월, ..., 6=토
    if (TARGET_WEEKDAYS.includes(dow)) {
      dates.push(formatDate(d));
    }
  }
  return dates;
}

// 예약 페이지 URL 생성
function buildUrl(date, placeIndex) {
  const part = placeParts[placeIndex];
  const place = placeIds[placeIndex];
  return `https://www.bnfmc.or.kr/reservation/www/9?facilities_type=T&base_date=${date}&rent_type=1001&center=NAMGUSPORTS02&part=${part}&place=${place}#regist_list`;
}

// ===== Puppeteer에서 한 날짜+구장 처리 =====

async function checkPageForSlots(page, url) {
  console.log(`    [브라우저] 페이지 로딩: ${url}`);

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  const slots = await page.evaluate(() => {
    const TARGET_START_HOURS = [19, 20, 21, 22];
    const result = [];

    const tables = Array.from(document.querySelectorAll("table"));
    let targetTable = null;
    for (const tbl of tables) {
      const headerText = tbl.innerText || "";
      if (
        headerText.includes("회차") &&
        headerText.includes("시간") &&
        headerText.includes("예약상태")
      ) {
        targetTable = tbl;
        break;
      }
    }

    if (!targetTable) {
      console.log("[eval] 예약 테이블을 찾지 못함");
      return result;
    }

    const rows = Array.from(targetTable.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th,td")).map((c) =>
        (c.innerText || "").trim()
      );
      if (cells.length < 4) continue;

      // 헤더 행 건너뛰기
      if (
        cells[0].includes("선택") ||
        cells[0].includes("회차") ||
        cells[1].includes("시간")
      ) {
        continue;
      }

      // 구조 가정: [선택, 회차, 시간, 이용금액, 예약상태, 예약자] 순 또는 유사
      const sessionText = cells[1]; // 예: "14회"
      const timeText = cells[2];    // 예: "19:00~20:00"
      const statusText = cells[4] || cells[3] || ""; // 예약상태 위치 보정

      const status = statusText.trim();

      // "19:00~20:00" 같은 형식에서 시작 시각 추출
      const m = timeText.match(/^(\d{2}):\d{2}/);
      if (!m) continue;
      const startHour = parseInt(m[1], 10);

      if (!TARGET_START_HOURS.includes(startHour)) {
        continue;
      }

      if (status === "예약가능") {
        result.push({
          session: sessionText,
          time: timeText,
          status: status,
        });
      }
    }

    return result;
  });

  console.log(
    `    [브라우저] 19~22시 시작 & 예약가능 슬롯 수: ${slots.length}`
  );
  return slots;
}

// ===== 메인 =====

async function main() {
  const dates = getTargetDates(); // 내일부터 4주간, 월·목·금만
  console.log("=== Puppeteer 기반 풋살1~4 예약 체크 시작 (월/목/금, 19~22시, 예약가능만) ===");
  console.log(`대상 날짜 수: ${dates.length}일`);
  console.log(`구장: ${placeNames.join(", ")}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const alerts = [];

  try {
    for (const date of dates) {
      console.log(`\n[날짜] ${date} (${formatDatePretty(date)}) 처리 시작`);

      // 이 날짜에 대해 1~4구장을 동시에 처리
      const tasks = placeNames.map(async (_name, pIdx) => {
        const page = await browser.newPage();
        try {
          const url = buildUrl(date, pIdx);
          console.log(`  [구장] ${placeNames[pIdx]} URL: ${url}`);

          await page.setUserAgent(
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
          );

          const slots = await checkPageForSlots(page, url);
          if (slots.length > 0) {
            alerts.push({
              date,
              placeIndex: pIdx,
              placeName: placeNames[pIdx],
              slots,
            });
          }
        } catch (e) {
          console.error(
            `  ! Puppeteer 에러 (${date} ${placeNames[pIdx]}):`,
            e.message
          );
        } finally {
          await page.close();
        }
      });

      // 이 날짜의 4개 구장을 병렬 실행
      await Promise.all(tasks);
    }
  } finally {
    await browser.close();
  }

  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    const lines = [];
    lines.push("▣ 백운포 풋살1~4구장 예약 가능 알림 (월·목·금, 19~22시) ▣");
    lines.push("");

    for (const alert of alerts) {
      const dateTitle = formatDatePretty(alert.date);
      lines.push(`▶️ ${dateTitle} ${alert.placeName}`);
      for (const s of alert.slots) {
        lines.push(`- ${s.session} ${s.time}: ${s.status}`);
      }
      lines.push("");
    }

    message = lines.join("\n");
  } else {
    available = false;
    message =
      "현재(풋살1~4구장, 내일부터 4주간 월·목·금, 19~22시 시작)에 예약 가능 슬롯이 없습니다.";
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
