import puppeteer from "puppeteer";

// ===== 설정 영역 =====
const placeNames = ["풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeParts = ["05", "05", "05", "05"];
const placeIds   = ["6",  "7",  "8",  "9"]; 

const TARGET_WEEKDAYS = [1, 4, 5]; // 월, 목, 금
const WEEKS_AHEAD = 4;

// 🚀 [중요] GitHub Actions에서 넘겨준 단 하나의 구장 인덱스만 선택 (없으면 기본값 0)
const TARGET_PLACE_IDX = parseInt(process.env.PLACE_INDEX || "0", 10);
const TARGET_PLACE_NAME = placeNames[TARGET_PLACE_IDX];

// ===== 날짜 유틸 =====
function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function formatDatePretty(dateStr) {
  try {
    const yyyy = parseInt(dateStr.slice(0, 4), 10);
    const mm = parseInt(dateStr.slice(4, 6), 10) - 1;
    const dd = parseInt(dateStr.slice(6, 8), 10);
    const d = new Date(yyyy, mm, dd);
    const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
    const day = dayNames[d.getDay()];
    return `${String(mm + 1).padStart(2, "0")}/${String(dd).padStart(2, "0")}(${day})`;
  } catch {
    return dateStr;
  }
}

function getTargetDates() {
  const dates = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() + 1); 

  const end = new Date(start);
  end.setDate(end.getDate() + WEEKS_AHEAD * 7);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (TARGET_WEEKDAYS.includes(d.getDay())) {
      dates.push(formatDate(d));
    }
  }
  return dates;
}

function buildUrl(date, placeIndex) {
  const part = placeParts[placeIndex];
  const place = placeIds[placeIndex];
  return `https://www.bnfmc.or.kr/reservation/www/9?facilities_type=T&base_date=${date}&rent_type=1001&center=NAMGUSPORTS02&part=${part}&place=${place}#regist_list`;
}

// ===== Puppeteer 크롤링 로직 =====
async function checkPageForSlots(page, url, logPrefix) {
  await page.goto(url, {
    waitUntil: "networkidle2", 
    timeout: 60000,
  });

  const rawSlots = await page.evaluate(() => {
    const TARGET_SESSIONS = ["14회", "15회", "16회"];
    const result = [];

    const tables = Array.from(document.querySelectorAll("table"));
    let targetTable = null;
    for (const tbl of tables) {
      const headerText = tbl.innerText || "";
      if (headerText.includes("회차") && headerText.includes("시간") && headerText.includes("예약상태")) {
        targetTable = tbl;
        break;
      }
    }

    if (!targetTable) return result;

    const rows = Array.from(targetTable.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th,td")).map(c => (c.innerText || "").trim());
      if (cells.length < 4) continue;

      if (cells[0].includes("선택") || cells[0].includes("회차") || cells[1].includes("시간")) {
        continue;
      }

      const sessionText = cells[1]; 
      const timeText = cells[2];    
      const statusText = cells[4] || cells[3] || "";
      const status = statusText.trim();

      if (!TARGET_SESSIONS.includes(sessionText)) continue;

      if (status === "예약가능") {
        result.push({ session: sessionText, time: timeText, status: status });
      }
    }
    return result;
  });

  if (rawSlots.length > 0) {
    const sessionNames = rawSlots.map(s => s.session).join(", ");
    console.log(`${logPrefix} 🔓 [단일 슬롯 발견] 총 ${rawSlots.length}개 검색됨 (${sessionNames})`);
  } else {
    console.log(`${logPrefix} 📭 예약가능 슬롯 없음`);
  }

  const sessionOrder = { "14회": 14, "15회": 15, "16회": 16 };
  return rawSlots.sort((a, b) => sessionOrder[a.session] - sessionOrder[b.session]);
}

// ===== 메인 함수 =====
async function main() {
  const dates = getTargetDates();
  console.log(`=== Puppeteer 기반 [${TARGET_PLACE_NAME}] 전용 체크 시작 ===`);
  console.log(`대상 날짜 수: ${dates.length}일 / 타겟 구장: ${TARGET_PLACE_NAME}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const allDiscoveredResults = [];

  // 🚀 지정된 단 하나의 구장에 대해서만 날짜별 태스크 생성 (총 12개)
  const allTasks = dates.map(date => ({ date, pIdx: TARGET_PLACE_IDX, name: TARGET_PLACE_NAME }));

  // 단일 구장만 처리하므로 동시 처리는 4개 단위로 여유 있게 진행 (GitHub 사양 최적화)
  const CHUNK_SIZE = 4; 
  for (let i = 0; i < allTasks.length; i += CHUNK_SIZE) {
    const chunk = allTasks.slice(i, i + CHUNK_SIZE);
    
    await Promise.all(chunk.map(async (task) => {
      const page = await browser.newPage();
      const prettyDate = formatDatePretty(task.date);
      const logPrefix = `[${prettyDate} ${task.name}]`;

      try {
        const url = buildUrl(task.date, task.pIdx);
        await page.setUserAgent("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36");

        const slots = await checkPageForSlots(page, url, logPrefix);
        if (slots.length > 0) {
          allDiscoveredResults.push({ date: task.date, placeIndex: task.pIdx, placeName: task.name, slots });
        }
      } catch (e) {
        console.error(`${logPrefix} 🚨 에러 발생:`, e.message);
      } finally {
        await page.close();
      }
    }));
  }

  await browser.close();

  // ===== 2차 필터링: 연속 2시간 이상 조건 검증 =====
  const alerts = [];
  for (const res of allDiscoveredResults) {
    const availableSessions = res.slots.map(s => s.session);
    const hasContinuousSlots = 
      (availableSessions.includes("14회") && availableSessions.includes("15회")) ||
      (availableSessions.includes("15회") && availableSessions.includes("16회"));

    if (hasContinuousSlots) {
      alerts.push(res);
    }
  }

  // ===== 결과 출력 및 구장별 전용 문자 메시지 생성 =====
  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    alerts.sort((a, b) => a.date.localeCompare(b.date));
    
    const lines = [
      `▣ 백운포 [${TARGET_PLACE_NAME}] 예약 가능 알림 ▣`,
      `[문자 발송 대상 타임 목록]`,
      ""
    ];

    for (const alert of alerts) {
      lines.push(`▶️ ${formatDatePretty(alert.date)}`);
      for (const s of alert.slots) {
        lines.push(`- ${s.session} ${s.time}: ${s.status}`);
      }
      lines.push("");
    }
    message = lines.join("\n");
  } else {
    available = false;
    message = `현재 [${TARGET_PLACE_NAME}]에 예약 가능한 2시간 연속 슬롯이 없습니다.`;
  }

  console.log(`\n==================================================`);
  console.log(`📬 [${TARGET_PLACE_NAME} 문자 발송용 메시지 요약]`);
  console.log(`==================================================`);
  console.log(message);

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const fs = await import("fs");
    fs.appendFileSync(ghOutput, `available=${available}\n`);
    fs.appendFileSync(ghOutput, `message<<EOF\n${message}\nEOF\n`);
  }
}

main().catch((e) => {
  console.error(`${TARGET_PLACE_NAME} 스크립트 실패:`, e);
  process.exit(1);
});
