import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ===== 공통 설정 =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const placeNames = ["풋살1구장", "풋살2구장", "풋살3구장", "풋살4구장"];
const placeParts = ["05", "05", "05", "05"];
const placeIds   = ["6",  "7",  "8",  "9"];

// 환경변수 MODE: collect / merge
const MODE = process.env.MODE || "collect";
// collect 모드일 때: PLACE_INDEX로 구장 지정
const TARGET_PLACE_IDX = parseInt(process.env.PLACE_INDEX || "0", 10);
const TARGET_PLACE_NAME = placeNames[TARGET_PLACE_IDX];

// 결과 JSON 파일 경로 (구장별)
const RESULT_FILES = [
  path.join(__dirname, "futsal_results_0.json"),
  path.join(__dirname, "futsal_results_1.json"),
  path.join(__dirname, "futsal_results_2.json"),
  path.join(__dirname, "futsal_results_3.json"),
];

// “이미 알림 보낸 조합” 기록용 파일 (repo 루트)
const SEEN_FILE = path.join(__dirname, "..", "seen_futsal.json");

// 모니터링 대상 요일: 월(1)~금(5)
const TARGET_WEEKDAYS = [1, 2, 4];
const WEEKS_AHEAD = 5; // 오늘 기준 5주간

// ===== 공통 날짜 유틸 =====
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
  start.setDate(start.getDate() + 1); // 내일부터

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

// ===== seen_futsal.json 유틸 =====
function loadSeenAlertIds() {
  try {
    if (!fs.existsSync(SEEN_FILE)) return new Set();
    const raw = fs.readFileSync(SEEN_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveSeenAlertIds(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(set), null, 2), "utf8");
    console.log(`[SEEN] seen_futsal.json 저장: ${Array.from(set).join(", ") || "(empty)"}`);
  } catch (e) {
    console.error("[ERROR] seen_futsal.json 저장 오류:", e.message);
  }
}

// ===== Puppeteer: 단일 구장/날짜 슬롯 수집 =====
async function checkPageForSlots(page, url, logPrefix) {
  console.log(`${logPrefix} 🌐 페이지 이동: ${url}`);
  await page.goto(url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  const rawSlots = await page.evaluate(() => {
    // 13~17회까지 모두 수집
    const TARGET_SESSIONS = ["13회", "14회", "15회", "16회", "17회"];
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
        continue; // 헤더 행
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

  const sessionOrder = { "13회": 13, "14회": 14, "15회": 15, "16회": 16, "17회": 17 };
  return rawSlots.sort((a, b) => sessionOrder[a.session] - sessionOrder[b.session]);
}

// ===== collect 모드: 한 구장만 크롤링하고 JSON 저장 =====
async function runCollectMode() {
  const dates = getTargetDates();
  console.log(`=== [COLLECT] Puppeteer 기반 [${TARGET_PLACE_NAME}] 크롤링 시작 (월~금) ===`);
  console.log(`대상 날짜 수: ${dates.length}일 / 타겟 구장: ${TARGET_PLACE_NAME}`);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const allDiscoveredResults = [];

  const allTasks = dates.map((date) => ({
    date,
    pIdx: TARGET_PLACE_IDX,
    name: TARGET_PLACE_NAME,
  }));

  console.log(
    `총 실행할 쿼리 수: ${allTasks.length}개 (병렬 처리 작동 시작)\n--------------------------------------------------`
  );

  const CHUNK_SIZE = 4;
  for (let i = 0; i < allTasks.length; i += CHUNK_SIZE) {
    const chunk = allTasks.slice(i, i + CHUNK_SIZE);

    await Promise.all(
      chunk.map(async (task) => {
        const page = await browser.newPage();
        const prettyDate = formatDatePretty(task.date);
        const logPrefix = `[${prettyDate} ${task.name}]`;

        try {
          console.log(
            `\n[날짜 처리 시작] ${prettyDate} / 타겟 구장: ${task.name}`
          );

          const url = buildUrl(task.date, task.pIdx);
          await page.setUserAgent(
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36"
          );

          const slots = await checkPageForSlots(page, url, logPrefix);
          if (slots.length > 0) {
            console.log(
              `${logPrefix} ✅ 예약가능 슬롯 ${slots.length}개 수집 완료`
            );
            allDiscoveredResults.push({
              date: task.date,
              placeIndex: task.pIdx,
              placeName: task.name,
              slots,
            });
          } else {
            console.log(
              `${logPrefix} ❌ 예약가능 슬롯 없음 (저장 안 함)`
            );
          }
        } catch (e) {
          console.error(
            `${logPrefix} 🚨 크롤링 중 에러 발생:`,
            e.message
          );
        } finally {
          await page.close();
        }
      })
    );

    console.log(
      `-------------------------------------------------- [진행률: ${Math.min(
        i + CHUNK_SIZE,
        allTasks.length
      )} / ${allTasks.length} 완료]`
    );
  }

  await browser.close();

  // 결과 JSON 저장 (구장별)
  const outPath = RESULT_FILES[TARGET_PLACE_IDX];
  fs.writeFileSync(
    outPath,
    JSON.stringify(allDiscoveredResults, null, 2),
    "utf8"
  );
  console.log(`📁 [COLLECT] 결과 저장 완료: ${outPath}`);
}

// ===== merge 모드: 4개 JSON 합쳐서 구장 혼합 연속 2~3시간 판정 + 중복 알림 방지 =====
function runMergeMode() {
  console.log("=== [MERGE] 4개 구장 결과 통합 및 연속 2~3시간 판정 시작 ===");

  const allResults = [];

  RESULT_FILES.forEach((file, idx) => {
    if (!fs.existsSync(file)) {
      console.warn(`⚠️ 결과 파일 없음 (구장 ${idx}): ${file}`);
      return;
    }
    try {
      const raw = fs.readFileSync(file, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        allResults.push(...arr);
      } else {
        console.warn(`⚠️ 결과 파일 포맷 이상 (구장 ${idx}): ${file}`);
      }
    } catch (e) {
      console.error(`❌ 결과 파일 파싱 실패 (구장 ${idx}): ${file}`, e.message);
    }
  });

  console.log(
    `📊 통합 대상 데이터 수: ${allResults.length}개 (날짜×구장 단위)`
  );

  // 날짜별 그룹핑
  const groupedByDate = new Map();

  for (const res of allResults) {
    if (!groupedByDate.has(res.date)) {
      groupedByDate.set(res.date, { date: res.date, items: [] });
    }
    groupedByDate.get(res.date).items.push(res);
  }

  const rawAlerts = [];

  for (const { date, items } of groupedByDate.values()) {
    const allSlots = items.flatMap((it) =>
      (it.slots || []).map((s) => ({
        ...s,
        placeIndex: it.placeIndex,
        placeName: it.placeName,
      }))
    );

    const prettyDate = formatDatePretty(date);

    if (allSlots.length === 0) {
      console.log(`[연속검사] ${prettyDate} - 슬롯 없음`);
      continue;
    }

    const allSessions = allSlots.map((s) => s.session);

    // 숫자로 변환해서 unique + 오름차순 정렬
    const nums = Array.from(
      new Set(
        allSessions
          .map((s) => parseInt(s.replace("회", ""), 10))
          .filter((n) => !Number.isNaN(n))
      )
    ).sort((a, b) => a - b);

    // 1. 황금 타임 2시간 연속 확보 (14-15, 15-16)
    const golden2h =
      (nums.includes(14) && nums.includes(15)) ||
      (nums.includes(15) && nums.includes(16));

    // 2. 18시(13회) 포함 시 -> 전후 연속 3시간 확보 (13-14-15)
    const early3h =
      nums.includes(13) && nums.includes(14) && nums.includes(15);

    // 3. 23시(17회) 포함 시 -> 전후 연속 3시간 확보 (15-16-17)
    const late3h =
      nums.includes(15) && nums.includes(16) && nums.includes(17);

    // 최종 연속성 여부
    const hasContinuousSlots = golden2h || early3h || late3h;

    console.log(
      `[연속검사] ${prettyDate} - 세션: ${allSessions.join(", ") || "없음"} ` +
      `/ 황금2h:${golden2h} / 18시연계3h:${early3h} / 23시연계3h:${late3h} -> 최종:${hasContinuousSlots}`
    );

    if (!hasContinuousSlots) continue;

    rawAlerts.push({ date, items, allSessions });
  }

  // ===== 한 번 알린 조합은 다시 알리지 않기 =====
  const seenIds = loadSeenAlertIds();
  console.log(`[SEEN] 로드된 alertId 목록: ${Array.from(seenIds).join(", ") || "(none)"}`);
  const newSeen = new Set(seenIds);

  const alerts = [];

  for (const alert of rawAlerts) {
    const sessionsSorted = Array.from(new Set(alert.allSessions)).sort();
    const alertId = `${alert.date}-${sessionsSorted.join("+")}`;

    if (seenIds.has(alertId)) {
      console.log(
        `[MERGE] 이미 알림 보낸 조합 (skip): ${formatDatePretty(
          alert.date
        )} / ${sessionsSorted.join(", ")}`
      );
      continue;
    }

    console.log(
      `[MERGE] 새 알림 대상 조합: ${formatDatePretty(
        alert.date
      )} / ${sessionsSorted.join(", ")} / id=${alertId}`
    );

    alerts.push({ ...alert, alertId });
    newSeen.add(alertId);
  }

  let available = false;
  let message = "";

  if (alerts.length > 0) {
    available = true;
    alerts.sort((a, b) => a.date.localeCompare(b.date));

    const lines = [
      "▣ 백운포 풋살장 예약 가능 알림 (구장 혼합 포함, 연속 2~3시간 확보) ▣",
      "[문자 발송 대상 타임 목록]",
      "",
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

    // 이번에 새로 알린 조합들을 seen_futsal.json에 저장
    saveSeenAlertIds(newSeen);
  } else {
    available = false;
    message =
      "현재 (월~금, 13~17회차 중 3시간 연속(13~15, 15~17) 또는 2시간 연속(14~15, 15~16)에 새로 알릴 예약 가능 슬롯이 없습니다.";
  }

  console.log("\n==================================================");
  console.log("📬 [MERGE] 최종 알림 내역 요약 - 문자 발송용");
  console.log("==================================================");
  console.log(message);

  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    fs.appendFileSync(ghOutput, `available=${available}\n`);
    fs.appendFileSync(ghOutput, `message<<EOF\n${message}\nEOF\n`);
  }
}

// ===== 엔트리 포인트 =====
(async () => {
  if (MODE === "collect") {
    await runCollectMode();
  } else if (MODE === "merge") {
    runMergeMode();
  } else {
    console.error(
      `❌ MODE 값이 올바르지 않습니다. (현재: ${MODE}, 허용: collect | merge)`
    );
    process.exit(1);
  }
})().catch((e) => {
  console.error("🚨 check-futsal.js 실행 중 에러:", e);
  process.exit(1);
});
