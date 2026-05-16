import puppeteer from "puppeteer";

// ===== 설정 영역 =====

// 테스트: 풋살2구장만 (part=05, place=7)
const placeNames = ["풋살2구장"];
const placeParts = ["05"];
const placeIds   = ["7"];

// 모니터링 대상: 오늘+1일 ~ 오늘+7일 (7일간)
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

// Puppeteer에서 한 날짜+구장에 대해 "예약가능"인 모든 시간 슬롯 추출
async function checkPageForSlots(page, url) {
  console.log(`  [브라우저] 페이지 로딩: ${url}`);

  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  const slots = await page.evaluate(() => {
    const result = [];

    // 예약 테이블 찾기
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

      // 구조 가정: [선택, 회차, 시간, 이용금액, 예약상태, 예약자] 순 또는 비슷한 구조
      const sessionText = cells[1]; // "14회"
      const timeText = cells[2];    // "19:00~20:00"
      const statusText = cells[4] || cells[3] || ""; // "예약가능"/"예약완료"

      const status = statusText.trim();

      // "예약가능"인 경우만 수집 (시간대는 전부 포함)
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
    `  [브라우저] 예약가능 슬롯 수(모든 시간): ${slots.length}`
  );
  return slots;
}

// ===== 메인 =====

async function main() {
  const dates = getNextDaysRange(1, 7); // 오늘+1일 ~ +7일
  console.log("=== Puppeteer 기반 풋살2 예약 체크 시작 (모든 시간대, 예약가능만) ===");
  console.log(`날짜 범위: ${dates[0]} ~ ${dates[dates.length - 1]}`);
  console.log(`구장: ${placeNames.join(", ")}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
  );

  const alerts = [];

  try {
    for (const date of dates) {
      console.log(`\n[날짜] ${date} (${formatDatePretty(date)}) 처리 시작`);

      for (let pIdx = 0; pIdx < placeNames.length; pIdx++) {
        const url = buildUrl(date, pIdx);
        console.log(`  [구장] ${placeNames[pIdx]} URL: ${url}`);

        try {
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
            `  ! Puppeteer evaluate 에러 (${date} ${placeNames[pIdx]}):`,
            e.message
          );
        }
      }
    }
  } finally {
    await browser.close();
  }

  // 텍스트 요약 생성
  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    const lines = [];
    lines.push("▣ 백운포 풋살2구장 예약 가능 알림 (모든 시간대) ▣");
    lines.push("");

    for (const alert of alerts) {
      const dateTitle = formatDatePretty(alert.date);
      lines.push(`▶ ${dateTitle} ${alert.placeName}`);
      for (const s of alert.slots) {
        lines.push(` - ${s.session} ${s.time}: ${s.status}`);
      }
      lines.push("");
    }

    message = lines.join("\n");
  } else {
    available = false;
    message =
      "현재(풋살2구장, 오늘+1~7일, 전체 시간대)에 예약 가능 슬롯이 없습니다.";
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
