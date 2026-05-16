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
async function checkPageForSlots(page, url) {
  // ⚡ 속도 단축 1: 불필요한 이미지, 폰트, CSS 로딩 차단하여 네트워크 속도 극대화
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // ⚡ 속도 단축 2: domcontentloaded를 기준으로 삼아 렌더링 직후 바로 데이터 추출 (기존 networkidle2보다 대폭 빠름)
  await page.goto(url, {
    waitUntil: "domcontentloaded", 
    timeout: 30000,
  });

  // 해당 예약 테이블이 비동기로 그려질 수 있으므로 테이블 요소가 나타날 때까지만 최소한으로 대기
  try {
    await page.waitForSelector("table", { timeout: 3000 });
  } catch (e) {
    // 테이블이 없으면 예약 불가능한 날짜로 판단하고 빈 배열 반환
    return [];
  }

  const rawSlots = await page.evaluate(() => {
    const TARGET_SESSIONS = ["14회", "15회", "16회"];
    const result = [];

    const tables = Array.from(document.querySelectorAll("table"));
    const targetTable = tables.find(tbl => {
      const text = tbl.innerText || "";
      return text.includes("회차") && text.includes("시간") && text.includes("예약상태");
    });

    if (!targetTable) return result;

    const rows = Array.from(targetTable.querySelectorAll("tbody tr"));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th, td")).map(c => (c.innerText || "").trim());
      if (cells.length < 3) continue;

      const sessionText = cells.find(text => TARGET_SESSIONS.includes(text));
      const isAvailable = cells.some(text => text.includes("예약가능"));
      const timeText = cells.find(text => text.includes("~")) || "";

      if (sessionText && isAvailable) {
        result.push({
          session: sessionText,
          time: timeText,
          status: "예약가능"
        });
      }
    }
    return result;
  });

  const availableSessions = rawSlots.map(s => s.session);
  const hasContinuousSlots = 
    (availableSessions.includes("14회") && availableSessions.includes("15회")) ||
    (availableSessions.includes("15회") && availableSessions.includes("16회"));

  if (!hasContinuousSlots) {
    return [];
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
      "--disable-gpu",
      "--no-first-run",
      "--no-zygote",
      "--single-process" // ⚡ 메모리 사용량 최소화 및 프로세스 오버헤드 감소
    ],
  });

  const alerts = [];
  
  // 모든 날짜 × 모든 구장의 조합을 하나의 단일 배열로 평탄화(Flatten)
  const allTasks = [];
  for (const date of dates) {
    for (let pIdx = 0; pIdx < placeNames.length; pIdx++) {
      allTasks.push({ date, pIdx, name: placeNames[pIdx] });
    }
  }

  console.log(`총 실행할 쿼리 수: ${allTasks.length}개 (완전 병렬 처리 시작)`);

  // ⚡ 속도 단축 3: 날짜 루프를 허물고 48개의 요청을 청크 단위로 동시 처리
  // GitHub Actions 사양을 고려해 한 번에 최대 10개씩 묶어서 병렬 실행 (동시 실행 수 조절 가능)
  const CHUNK_SIZE = 10; 
  for (let i = 0; i < allTasks.length; i += CHUNK_SIZE) {
    const chunk = allTasks.slice(i, i + CHUNK_SIZE);
    
    await Promise.all(chunk.map(async (task) => {
      const page = await browser.newPage();
      try {
        const url = buildUrl(task.date, task.pIdx);
        await page.setUserAgent(
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
        );

        const slots = await checkPageForSlots(page, task.url || url);
        if (slots.length > 0) {
          alerts.push({
            date: task.date,
            placeIndex: task.pIdx,
            placeName: task.name,
            slots,
          });
        }
      } catch (e) {
        console.error(`  ! 에러 발생 (${task.date} ${task.name}):`, e.message);
      } finally {
        await page.close();
      }
    }));
    console.log(`  [진행률] ${Math.min(i + CHUNK_SIZE, allTasks.length)} / ${allTasks.length} 완료`);
  }

  await browser.close();

  // ===== 결과 출력 및 GitHub Output 생성 =====
  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    
    // 날짜 순 정렬
    alerts.sort((a, b) => a.date.localeCompare(b.date) || a.placeIndex - b.placeIndex);
    
    const lines = [
      "▣ 백운포 풋살1~4구장 예약 가능 알림 (월·목·금, 14~16회 중 연속 2시간 이상) ▣",
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
