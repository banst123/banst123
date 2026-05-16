import puppeteer from "puppeteer";

// ===== 설정 영역 =====
const placeNames = ["풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeParts = ["05", "05", "05", "05"];
const placeIds   = ["6",  "7",  "8",  "9"]; 

const TARGET_WEEKDAYS = [1, 4, 5]; // 월, 목, 금
const WEEKS_AHEAD = 4;

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
  // 🛠️ 대기 원복: 예약 데이터 스크립트가 완전히 로드될 때까지 networkidle2로 확실하게 대기
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
      if (
        headerText.includes("회차") &&
        headerText.includes("시간") &&
        headerText.includes("예약상태")
      ) {
        targetTable = tbl;
        break;
      }
    }

    if (!targetTable) return result;

    const rows = Array.from(targetTable.querySelectorAll("tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th,td")).map((c) =>
        (c.innerText || "").trim()
      );
      if (cells.length < 4) continue;

      // 헤더 스킵
      if (
        cells[0].includes("선택") ||
        cells[0].includes("회차") ||
        cells[1].includes("시간")
      ) {
        continue;
      }

      const sessionText = cells[1]; // "14회"
      const timeText = cells[2];    // "19:00~20:00"
      const statusText = cells[4] || cells[3] || "";
      const status = statusText.trim();

      if (!TARGET_SESSIONS.includes(sessionText)) continue;

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

  // 🔍 1시간 단위 발견 로그 출력
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
  console.log("=== Puppeteer 기반 풋살1~4 예약 체크 시작 ===");
  console.log(`대상 날짜 수: ${dates.length}일 / 구장: ${placeNames.join(", ")}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", 
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
  });

  const allDiscoveredResults = [];
  
  const allTasks = [];
  for (const date of dates) {
    for (let pIdx = 0; pIdx < placeNames.length; pIdx++) {
      allTasks.push({ date, pIdx, name: placeNames[pIdx] });
    }
  }

  console.log(`총 실행할 쿼리 수: ${allTasks.length}개 (병렬 처리 시작)\n--------------------------------------------------`);

  // 🛠️ 가상 인프라 무리 방지 및 누락 예방을 위해 동시 처리를 6개 단위 청크로 세팅
  const CHUNK_SIZE = 6; 
  for (let i = 0; i < allTasks.length; i += CHUNK_SIZE) {
    const chunk = allTasks.slice(i, i + CHUNK_SIZE);
    
    await Promise.all(chunk.map(async (task) => {
      const page = await browser.newPage();
      const prettyDate = formatDatePretty(task.date);
      const logPrefix = `[${prettyDate} ${task.name}]`;

      try {
        const url = buildUrl(task.date, task.pIdx);
        await page.setUserAgent(
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
        );

        const slots = await checkPageForSlots(page, url, logPrefix);
        if (slots.length > 0) {
          allDiscoveredResults.push({
            date: task.date,
            placeIndex: task.pIdx,
            placeName: task.name,
            slots, 
          });
        }
      } catch (e) {
        console.error(`${logPrefix} 🚨 에러 발생:`, e.message);
      } finally {
        await page.close();
      }
    }));
    
    console.log(`-------------------------------------------------- [진행률: ${Math.min(i + CHUNK_SIZE, allTasks.length)} / ${allTasks.length} 완료]`);
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

  // ===== 결과 출력 및 GitHub Output 생성 =====
  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    alerts.sort((a, b) => a.date.localeCompare(b.date) || a.placeIndex - b.placeIndex);
    
    const lines = [
      `▣ 백운포 풋살1~4구장 예약 가능 알림 (연속 2시간 이상 확보 완료) ▣`,
      `[문자 발송 대상 타임 목록]`,
      ""
    ];

    for (const alert of alerts) {
      lines.push(`▶️ ${formatDatePretty(alert.date)} ${alert.placeName}`);
      for (const s of alert.slots) {
        lines.push(`- ${s.session} ${s.time}: ${s.status}`);
      }
      lines.push("");
    }
    message = lines.join("\n");
  } else {
    available = false;
    message = "현재 예약 가능한 슬롯이 없습니다. (대상: 내일부터 4주간 월/목/금 14~16회 연속 2시간 이상)";
  }

  console.log("\n==================================================");
  console.log("📬 [최종 알림 내역 - 문자 발송용 메시지]");
  console.log("==================================================");
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
