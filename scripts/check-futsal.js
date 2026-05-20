import puppeteer from "puppeteer";

// ===== 설정 영역 =====
const placeNames = ["풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeParts = ["05", "05", "05", "05"];
const placeIds   = ["6",  "7",  "8",  "9"]; 

// 모니터링 대상 요일: 월(1)~금(5)
const TARGET_WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKS_AHEAD = 4;             // 오늘 기준 4주 뒤까지 검사

// GitHub Actions 환경변수에서 지정한 구장 인덱스만 타겟팅 (기본값: 0구장)
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
  start.setDate(start.getDate() + 1); // 내일부터 시작

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

// ===== Puppeteer 데이터 검증 로직 =====
async function checkPageForSlots(page, url, logPrefix) {
  console.log(`${logPrefix} 🌐 페이지 이동: ${url}`);
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  const rawSlots = await page.evaluate(() => {
    const TARGET_SESSIONS = ["14회", "15회", "16회"]; // 19~21시 타겟 회차
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
    console.log(`[eval] 총 ${rows.length}개 행 검사 예정`);

    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll("th,td")).map((c) =>
        (c.innerText || "").trim()
      );
      if (cells.length < 4) {
        console.log("[eval] 셀 수 부족으로 스킵:", cells);
        continue;
      }

      if (
        cells[0].includes("선택") ||
        cells[0].includes("회차") ||
        cells[1].includes("시간")
      ) {
        // 헤더 행
        continue;
      }

      const sessionText = cells[1]; // 예: "14회"
      const timeText = cells[2];    // 예: "19:00~20:00"
      const statusText = cells[4] || cells[3] || "";
      const status = statusText.trim();

      console.log(
        `[eval] 행 파싱 → 회차:${sessionText} / 시간:${timeText} / 상태:${status}`
      );

      if (!TARGET_SESSIONS.includes(sessionText)) {
        console.log("[eval] 타겟 회차 아님 → 스킵");
        continue;
      }

      if (status === "예약가능") {
        console.log("[eval] ✅ 타겟 회차 + 예약가능 → 채택");
        result.push({
          session: sessionText,
          time: timeText,
          status: status,
        });
      } else {
        console.log("[eval] 상태가 예약가능 아님 → 스킵");
      }
    }
    return result;
  });

  if (rawSlots.length > 0) {
    const sessionNames = rawSlots.map((s) => s.session).join(", ");
    console.log(
      `${logPrefix} 🔓 [단일 슬롯 발견] 총 ${rawSlots.length}개 검색됨 (${sessionNames})`
    );
  } else {
    console.log(`${logPrefix} 📭 예약가능 슬롯 없음`);
  }

  const sessionOrder = { "14회": 14, "15회": 15, "16회": 16 };
  return rawSlots.sort((a, b) => sessionOrder[a.session] - sessionOrder[b.session]);
}

// ===== 메인 프로세스 =====
async function main() {
  const dates = getTargetDates();
  console.log(`=== Puppeteer 기반 [${TARGET_PLACE_NAME}] 전용 크롤링 시작 ===`);
  console.log(`대상 날짜 수: ${dates.length}일 / 타겟 구장: ${TARGET_PLACE_NAME}`);

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
  
  const allTasks = dates.map(date => ({ date, pIdx: TARGET_PLACE_IDX, name: TARGET_PLACE_NAME }));

  console.log(`총 실행할 쿼리 수: ${allTasks.length}개 (병렬 처리 작동 시작)\n--------------------------------------------------`);

  const CHUNK_SIZE = 4; 
  for (let i = 0; i < allTasks.length; i += CHUNK_SIZE) {
    const chunk = allTasks.slice(i, i + CHUNK_SIZE);
    
    await Promise.all(chunk.map(async (task) => {
      const page = await browser.newPage();
      const prettyDate = formatDatePretty(task.date);
      const logPrefix = `[${prettyDate} ${task.name}]`;

      try {
        console.log(`\n[날짜 처리 시작] ${prettyDate} / 타겟 구장: ${TARGET_PLACE_NAME}`);

        const url = buildUrl(task.date, task.pIdx);
        await page.setUserAgent(
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
        );

        const slots = await checkPageForSlots(page, url, logPrefix);
        if (slots.length > 0) {
          console.log(`${logPrefix} ✅ 예약가능 슬롯 ${slots.length}개 수집 완료`);
          allDiscoveredResults.push({
            date: task.date,
            placeIndex: task.pIdx,
            placeName: task.name,
            slots, 
          });
        } else {
          console.log(`${logPrefix} ❌ 예약가능 슬롯 없음 (저장 안 함)`);
        }
      } catch (e) {
        console.error(`${logPrefix} 🚨 크롤링 중 에러 발생:`, e.message);
      } finally {
        await page.close();
      }
    }));
    
    console.log(`-------------------------------------------------- [진행률: ${Math.min(i + CHUNK_SIZE, allTasks.length)} / ${allTasks.length} 완료]`);
  }

  await browser.close();

  // ===== 2차 필터링: 날짜 기준으로, 구장 합산 후 연속 2시간 검사 =====
  const alerts = [];

  // 1) 날짜별 그룹핑
  const groupedByDate = new Map(); // key: date, value: { date, items: [res...] }

  for (const res of allDiscoveredResults) {
    if (!groupedByDate.has(res.date)) {
      groupedByDate.set(res.date, { date: res.date, items: [] });
    }
    groupedByDate.get(res.date).items.push(res);
  }

  // 2) 각 날짜에 대해, 모든 구장의 회차를 합쳐서 연속성 검사
  for (const { date, items } of groupedByDate.values()) {
    const allSlots = items.flatMap(it =>
      it.slots.map(s => ({
        ...s,
        placeIndex: it.placeIndex,
        placeName: it.placeName,
      }))
    );

    if (allSlots.length === 0) {
      const prettyDate = formatDatePretty(date);
      console.log(`[연속검사] ${prettyDate} - 슬롯 없음`);
      continue;
    }

    const allSessions = allSlots.map(s => s.session);
    const hasContinuousSlots =
      (allSessions.includes("14회") && allSessions.includes("15회")) ||
      (allSessions.includes("15회") && allSessions.includes("16회"));

    const prettyDate = formatDatePretty(date);
    console.log(
      `[연속검사] ${prettyDate} - 세션: ${allSessions.join(", ") || "없음"} / 연속 여부: ${hasContinuousSlots}`
    );

    if (!hasContinuousSlots) continue;

    alerts.push({
      date,
      items, // [{ date, placeIndex, placeName, slots }, ...]
    });
  }

  // ===== 결과 출력 및 GitHub Output 환경변수 전달 =====
  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    alerts.sort((a, b) => a.date.localeCompare(b.date));
    
    const lines = [
      "▣ 백운포 풋살장 예약 가능 알림 (구장 혼합 포함, 연속 2시간 확보) ▣",
      "[문자 발송 대상 타임 목록]",
      ""
    ];

    for (const alert of alerts) {
      lines.push(`▶️ ${formatDatePretty(alert.date)}`);

      for (const item of alert.items) {
        if (!item.slots || item.slots.length === 0) continue;

        lines.push(`  • ${item.placeName}`);
        for (const s of item.slots) {
          lines.push(`    - ${s.session} ${s.time}: ${s.status}`);
        }
      }
      lines.push("");
    }

    message = lines.join("\n");
  } else {
    available = false;
    message =
      "현재 (월~금, 14~16회차 중 연속 2시간 이상, 구장 혼합 포함)에 예약 가능 슬롯이 없습니다.";
  }

  console.log("\n==================================================");
  console.log("📬 최종 알림 내역 요약 - 문자 발송용");
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
  console.error(`🚨 [${TARGET_PLACE_NAME}] 모니터링 최종 실패:`, e);
  process.exit(1);
});
