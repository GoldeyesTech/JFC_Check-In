import React, { useEffect, useMemo, useRef, useState } from "react";
import errorSound from "./error.wav";
import logo from "./logo.png";
import { Html5Qrcode } from "html5-qrcode";
import jsQR from "jsqr";

const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/1Dd9_iUEAlLled1Fb5jNCpjK_Vf5W5bzmpNDFrAgoUfc/edit?usp=sharing";
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbz9wYTGMY-h62viGcmF7At2gjz1gINoJYyRaIBRi_tJWluIrSQXRsw-XbdKWNps6ryj/exec";
const READER_ID = "goldeyes-qr-reader";
const LOG_KEY = "junior-fan-club-checkin-log";
const BRAND_RED = "#922f35";
const WARNING_RED = "#ca3339";
const SUCCESS_GREEN = "#5f9f6f";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDateValue(value) {
  if (!value || value === "—") return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function normalizeScanValue(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/^GJFC-/, "JFC-");
}

function rewardLabel(count) {
  if (count >= 10) return "Prize Tier 3";
  if (count >= 5) return "Prize Tier 2";
  if (count >= 3) return "Prize Tier 1";
  return "—";
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result.map((value) => value.trim());
}

function parseMembersCsv(csvText) {
  const lines = String(csvText ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  const memberIdIndex = headers.indexOf("member id");
  const nameIndex = headers.indexOf("name");
  const attendanceIndex = headers.indexOf("attendance count");
  const lastVisitIndex = headers.indexOf("last visit");

  if (memberIdIndex === -1 || nameIndex === -1) {
    throw new Error(
      "Sheet must include at least 'Member ID' and 'Name' columns."
    );
  }

  return lines
    .slice(1)
    .map((line) => {
      const values = parseCsvLine(line);
      return {
        memberId: normalizeScanValue(values[memberIdIndex] ?? ""),
        name: values[nameIndex] ?? "",
        attendanceCount: Number(values[attendanceIndex] ?? 0) || 0,
        lastVisit: normalizeDateValue(values[lastVisitIndex]) || "—",
      };
    })
    .filter((member) => member.memberId && member.name);
}

function buildGoogleSheetCsvUrl(input) {
  const value = String(input ?? "").trim();
  if (!value) return "";
  if (value.includes("output=csv") || value.includes("format=csv")) {
    return value;
  }

  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) return value;

  const docId = match[1];
  const gidMatch = value.match(/[?&#]gid=([0-9]+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${gid}`;
}

async function fetchMembersFromSheet(sheetUrl) {
  const csvUrl = buildGoogleSheetCsvUrl(sheetUrl);
  const response = await fetch(csvUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Sheet request failed with status ${response.status}`);
  }
  const csvText = await response.text();
  return parseMembersCsv(csvText);
}

async function pushCheckInToSheet(member) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      action: "check_in",
      memberId: normalizeScanValue(member.memberId),
      name: member.name,
      attendanceCount: member.attendanceCount,
      lastVisit: member.lastVisit,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Apps Script request failed with status ${response.status}: ${text}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Apps Script returned invalid JSON: ${text}`);
  }

  if (!data.ok) {
    const err = new Error(data.error || "Apps Script rejected the update.");
    err.code = data.error || "UNKNOWN_APPS_SCRIPT_ERROR";
    throw err;
  }

  return data;
}

function findMemberByScanValue(members, rawValue) {
  const scannedValue = normalizeScanValue(rawValue);
  return (
    members.find((m) => normalizeScanValue(m.memberId) === scannedValue) ?? null
  );
}

function getFriendlyScannerError(error) {
  const text = `${error?.name ?? ""} ${
    error?.message ?? error ?? ""
  }`.toLowerCase();
  if (
    text.includes("notallowederror") ||
    text.includes("permission") ||
    text.includes("denied")
  ) {
    return "Camera access was blocked. Open the app in its own HTTPS tab and allow camera access.";
  }
  if (text.includes("notfounderror") || text.includes("device not found")) {
    return "No camera was found on this device.";
  }
  if (
    text.includes("notreadableerror") ||
    text.includes("trackstart") ||
    text.includes("aborterror") ||
    text.includes("busy")
  ) {
    return "The camera is busy or unavailable. Close other apps using the camera and try again.";
  }
  return "The scanner could not start. You can still scan from a photo or type the Member ID manually.";
}

async function loadImageBitmapFromFile(file) {
  if (typeof createImageBitmap === "function") {
    return await createImageBitmap(file);
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = reject;
      element.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function decodeQrFromImageFile(file) {
  const bitmap = await loadImageBitmapFromFile(file);
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(bitmap, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  const result = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: "attemptBoth",
  });
  return result?.data ?? null;
}

function runSelfTests() {
  const members = [
    { memberId: "JFC-0001", name: "A", attendanceCount: 0, lastVisit: "—" },
    { memberId: "gjfc-0002", name: "B", attendanceCount: 4, lastVisit: "—" },
  ];

  console.assert(
    normalizeScanValue(" gjfc-0001 ") === "JFC-0001",
    "normalizeScanValue should normalize prefix"
  );
  console.assert(
    findMemberByScanValue(members, "JFC-0001")?.name === "A",
    "findMemberByScanValue should find exact match"
  );
  console.assert(
    findMemberByScanValue(members, " gjfc-0002 ")?.name === "B",
    "findMemberByScanValue should ignore case"
  );
  console.assert(
    parseCsvLine('A,"B,C",D')[1] === "B,C",
    "parseCsvLine should handle quoted commas"
  );
  console.assert(
    buildGoogleSheetCsvUrl(
      "https://docs.google.com/spreadsheets/d/abc123/edit#gid=456"
    ).includes("format=csv&gid=456"),
    "buildGoogleSheetCsvUrl should convert edit URL"
  );
  const parsed = parseMembersCsv(
    `Member ID,Name,Attendance Count,Last Visit\nJFC-0001,Johnny,4,2026-04-01`
  );
  console.assert(
    parsed.length === 1 && parsed[0].memberId === "JFC-0001",
    "parseMembersCsv should parse member row"
  );
  console.assert(
    normalizeDateValue("2026-04-01") === "2026-04-01",
    "normalizeDateValue should preserve ISO dates"
  );
}

if (typeof window !== "undefined") {
  runSelfTests();
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f8fafc",
    padding: 16,
    fontFamily: "Inter, system-ui, sans-serif",
    color: "#0f172a",
  },
  shell: {
    maxWidth: 1200,
    margin: "0 auto",
    display: "grid",
    gap: 16,
  },
  row: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brandWrap: {
    width: "100%",
    minHeight: 104,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: BRAND_RED,
    padding: "16px 20px",
    borderRadius: 20,
    marginBottom: 8,
    boxSizing: "border-box",
  },
  logo: {
    height: 80,
    width: "auto",
    objectFit: "contain",
    display: "block",
  },
  card: {
    background: "#ffffff",
    border: "1px solid #e2e8f0",
    borderRadius: 20,
    padding: 12,
    boxShadow: "0 1px 2px rgba(15,23,42,.04)",
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 10,
  },
  button: {
    border: `1px solid ${BRAND_RED}`,
    background: BRAND_RED,
    color: "white",
    borderRadius: 14,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  buttonSecondary: {
    border: `1px solid ${BRAND_RED}`,
    background: "#ffffff",
    color: BRAND_RED,
    borderRadius: 14,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
  },
  input: {
    width: "100%",
    border: "1px solid #cbd5e1",
    borderRadius: 14,
    padding: "12px 14px",
    fontSize: 15,
    boxSizing: "border-box",
  },
  memberButton: {
    width: "100%",
    textAlign: "left",
    border: "1px solid #e2e8f0",
    background: "#ffffff",
    borderRadius: 16,
    padding: 10,
    cursor: "pointer",
    display: "grid",
    gap: 6,
  },
  selectedMemberButton: {
    background: BRAND_RED,
    color: "white",
    borderColor: BRAND_RED,
  },
  bigPanel: {
    borderRadius: 24,
    background: BRAND_RED,
    color: "white",
    padding: 24,
    display: "grid",
    gap: 8,
  },
  overlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(15,23,42,.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 50,
  },
  modal: {
    width: "100%",
    maxWidth: 700,
    background: "white",
    borderRadius: 24,
    padding: 16,
    display: "grid",
    gap: 12,
  },
};

export default function App() {
  const [members, setMembers] = useState([]);
  const [logs, setLogs] = useState([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [sheetLoading, setSheetLoading] = useState(false);
  const [savingCheckIn, setSavingCheckIn] = useState(false);
  const [toast, setToast] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerRunning, setScannerRunning] = useState(false);
  const [scannerStatus, setScannerStatus] = useState(
    "Open the scanner, then tap Start Live Scanner or Scan From Photo."
  );
  const [photoBusy, setPhotoBusy] = useState(false);
  const [activeTab, setActiveTab] = useState("checkin");
  const [warningFlash, setWarningFlash] = useState(false);
  const [successFlash, setSuccessFlash] = useState(false);

  const scannerRef = useRef(null);
  const hasScannedRef = useRef(false);
  const photoInputRef = useRef(null);
  const errorAudioRef = useRef(null);

  useEffect(() => {
    const savedLogs = localStorage.getItem(LOG_KEY);
    if (savedLogs) {
      try {
        setLogs(JSON.parse(savedLogs));
      } catch {}
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(LOG_KEY, JSON.stringify(logs));
  }, [logs]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(""), 2500);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!warningFlash) return;

    try {
      if (!errorAudioRef.current) {
        errorAudioRef.current = new Audio(errorSound);
      }
      errorAudioRef.current.currentTime = 0;
      errorAudioRef.current.play();
    } catch (e) {
      console.warn("Error playing sound", e);
    }

    const id = window.setTimeout(() => setWarningFlash(false), 1200);
    return () => window.clearTimeout(id);
  }, [warningFlash]);

  useEffect(() => {
    if (!successFlash) return;
    const id = window.setTimeout(() => setSuccessFlash(false), 1200);
    return () => window.clearTimeout(id);
  }, [successFlash]);

  async function syncMembersFromSheet(showToast = false) {
    setSheetLoading(true);
    try {
      const nextMembers = await fetchMembersFromSheet(DEFAULT_SHEET_URL);
      setMembers(nextMembers);
      setSelectedId((current) => current || nextMembers[0]?.memberId || "");
      if (showToast) {
        setToast(`Loaded ${nextMembers.length} members from Google Sheets.`);
      }
    } catch (error) {
      console.error(error);
      setToast(
        "Could not load the Google Sheet. Make sure it is shared or published for viewing."
      );
    } finally {
      setSheetLoading(false);
    }
  }

  useEffect(() => {
    void syncMembersFromSheet(false);
    const intervalId = window.setInterval(() => {
      void syncMembersFromSheet(false);
    }, 60000);
    return () => window.clearInterval(intervalId);
  }, []);

  const filteredMembers = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter(
      (member) =>
        member.memberId.toLowerCase().includes(q) ||
        member.name.toLowerCase().includes(q)
    );
  }, [members, query]);

  const selectedMember =
    members.find((member) => member.memberId === selectedId) ||
    filteredMembers[0] ||
    members[0] ||
    null;

  useEffect(() => {
    if (
      filteredMembers.length &&
      !filteredMembers.some((member) => member.memberId === selectedId)
    ) {
      setSelectedId(filteredMembers[0].memberId);
    }
  }, [filteredMembers, selectedId]);

  async function stopScanner() {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    hasScannedRef.current = false;
    setScannerRunning(false);
    if (!scanner) return;
    try {
      await scanner.stop();
    } catch {}
    try {
      await scanner.clear();
    } catch {}
  }

  useEffect(() => {
    if (!scannerOpen) {
      void stopScanner();
    }
  }, [scannerOpen]);

  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, []);

  function addCheckInLog(member) {
    setLogs((current) => [
      {
        memberId: member.memberId,
        name: member.name,
        attendanceNumber: member.attendanceCount,
        timestamp: new Date().toLocaleString(),
        gameDate: todayISO(),
      },
      ...current,
    ]);
  }

  async function checkInMember(memberId) {
    const normalizedMemberId = normalizeScanValue(memberId);

    const existingMember = members.find(
      (member) => normalizeScanValue(member.memberId) === normalizedMemberId
    );

    if (!existingMember) {
      setToast("Member not found.");
      return;
    }

    const requestMember = {
      ...existingMember,
      memberId: normalizeScanValue(existingMember.memberId),
      attendanceCount: existingMember.attendanceCount + 1,
      lastVisit: todayISO(),
    };

    try {
      setSavingCheckIn(true);
      setToast(`Processing ${existingMember.name}...`);

      const result = await pushCheckInToSheet(requestMember);

      const confirmedMember = {
        ...requestMember,
        attendanceCount:
          result.attendanceCount ?? requestMember.attendanceCount,
        lastVisit: result.lastVisit ?? requestMember.lastVisit,
      };

      setMembers((current) =>
        current.map((member) =>
          normalizeScanValue(member.memberId) === normalizedMemberId
            ? confirmedMember
            : member
        )
      );

      setSelectedId(confirmedMember.memberId);
      setQuery("");
      addCheckInLog(confirmedMember);
      setToast(
        `${confirmedMember.name} checked in — visit #${confirmedMember.attendanceCount}`
      );
      setSuccessFlash(true);
    } catch (error) {
      console.error(error);

      if (
        error.code === "ALREADY_CHECKED_IN_TODAY" ||
        error.message === "ALREADY_CHECKED_IN_TODAY"
      ) {
        setToast("Already checked in today.");
        setWarningFlash(true);
        return;
      }

      setToast(`Check-in failed: ${error.code || error.message}`);
    } finally {
      setSavingCheckIn(false);
    }
  }

  async function processScannedCode(rawValue) {
    const member = findMemberByScanValue(members, rawValue);
    const normalized = normalizeScanValue(rawValue);

    if (!member) {
      setScannerStatus(`No member found for ${normalized}`);
      setToast(`No member found for ${normalized}`);
      hasScannedRef.current = false;
      return;
    }

    setSelectedId(member.memberId);
    setScannerStatus(`Processing ${member.name}...`);
    setScannerOpen(false);

    await checkInMember(member.memberId);
  }

  async function startLiveScanner() {
    if (scannerRunning || scannerRef.current) return;
    const readerElement = document.getElementById(READER_ID);
    if (!readerElement) {
      setScannerStatus("Scanner view is still loading. Try again.");
      return;
    }

    setScannerStatus("Requesting camera access...");
    hasScannedRef.current = false;

    try {
      const scanner = new Html5Qrcode(READER_ID);
      scannerRef.current = scanner;
      setScannerRunning(true);

      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 10,
          qrbox: { width: 260, height: 260 },
          aspectRatio: 1.3333333,
        },
        (decodedText) => {
          if (hasScannedRef.current) return;
          hasScannedRef.current = true;
          void processScannedCode(decodedText);
        },
        () => {}
      );

      setScannerStatus("Point the camera at the QR code on the member card.");
    } catch (error) {
      console.error(error);
      const message = getFriendlyScannerError(error);
      setScannerStatus(message);
      setToast(message);
      await stopScanner();
    }
  }

  async function handlePhotoFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setPhotoBusy(true);
    setScannerStatus("Reading QR from photo...");

    try {
      const decodedValue = await decodeQrFromImageFile(file);
      if (!decodedValue) {
        setScannerStatus(
          "No QR code found in that photo. Try a closer, sharper picture."
        );
        setToast("No QR code found in photo.");
      } else {
        await processScannedCode(decodedValue);
      }
    } catch (error) {
      console.error(error);
      setScannerStatus(
        "Photo scanning failed. Try another photo or type the Member ID manually."
      );
      setToast("Photo scanning failed.");
    } finally {
      setPhotoBusy(false);
      event.target.value = "";
    }
  }

  async function manualCheckInFromQuery() {
    const member = findMemberByScanValue(members, query);
    if (!member) {
      setToast("Enter a valid Member ID to check in manually.");
      return;
    }
    setSelectedId(member.memberId);
    await checkInMember(member.memberId);
  }

  function exportCsv() {
    const rows = [
      ["Member ID", "Name", "Attendance Count", "Last Visit", "Reward Tier"],
      ...members.map((member) => [
        member.memberId,
        member.name,
        member.attendanceCount,
        member.lastVisit,
        rewardLabel(member.attendanceCount),
      ]),
    ];
    const csv = rows.map((row) => row.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "junior-fan-club-members.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const todayCheckIns = members.filter(
    (m) => normalizeDateValue(m.lastVisit) === todayISO()
  ).length;

  const stats = {
    totalMembers: members.length,
    totalCheckIns: members.reduce(
      (sum, member) => sum + member.attendanceCount,
      0
    ),
    todayCheckIns,
    rewardsReady: members.filter((member) => member.attendanceCount >= 3)
      .length,
  };

  return (
    <div style={styles.page}>
      <div style={styles.shell}>
        <div style={styles.brandWrap}>
          <img src={logo} alt="Goldeyes Logo" style={styles.logo} />
        </div>
      </div>

      <div style={styles.shell}>
        <div style={styles.row}>
          <div />
        </div>

        <div style={styles.statsGrid}>
          <div style={styles.card}>
            <strong style={{ fontSize: 22 }}>{stats.totalMembers}</strong>
            <div style={{ color: "#64748b", fontSize: 13 }}>JFC Members</div>
          </div>
          <div style={styles.card}>
            <strong style={{ fontSize: 22 }}>{stats.totalCheckIns}</strong>
            <div style={{ color: "#64748b", fontSize: 13 }}>
              Check-Ins This Season
            </div>
          </div>
          <div style={styles.card}>
            <strong style={{ fontSize: 22 }}>{stats.todayCheckIns}</strong>
            <div style={{ color: "#64748b", fontSize: 13 }}>
              Check-Ins Today
            </div>
          </div>
          <div style={styles.card}>
            <strong style={{ fontSize: 22 }}>{stats.rewardsReady}</strong>
            <div style={{ color: "#64748b", fontSize: 13 }}>Prize eligible</div>
          </div>
        </div>

        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}
        >
          <button
            style={
              activeTab === "checkin" ? styles.button : styles.buttonSecondary
            }
            onClick={() => setActiveTab("checkin")}
          >
            Check In
          </button>
          <button
            style={
              activeTab === "members" ? styles.button : styles.buttonSecondary
            }
            onClick={() => setActiveTab("members")}
          >
            Members
          </button>
          <button
            style={styles.buttonSecondary}
            onClick={() => void syncMembersFromSheet(true)}
            disabled={sheetLoading || savingCheckIn}
          >
            {sheetLoading
              ? "Syncing..."
              : savingCheckIn
              ? "Saving..."
              : "Refresh Sheet"}
          </button>
        </div>

        {activeTab === "checkin" && (
          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                minHeight: 64,
                display: "flex",
                alignItems: "flex-start",
              }}
            >
              {(warningFlash || toast) && (
                <div
                  style={{
                    ...styles.card,
                    width: "100%",
                    border: `2px solid ${
                      warningFlash ? WARNING_RED : BRAND_RED
                    }`,
                    color: warningFlash ? WARNING_RED : BRAND_RED,
                    fontWeight: 800,
                    textAlign: "center",
                    padding: 10,
                    boxSizing: "border-box",
                  }}
                >
                  {warningFlash ? "Already checked in today." : toast}
                </div>
              )}
            </div>

            <div style={{ display: "grid", gap: 16 }}>
              <div style={styles.card}>
                <h3 style={{ marginTop: 0 }}>Live check-in result</h3>
                {selectedMember ? (
                  <div style={{ display: "grid", gap: 16 }}>
                    <div
                      style={{
                        ...styles.bigPanel,
                        background: warningFlash
                          ? WARNING_RED
                          : successFlash
                          ? SUCCESS_GREEN
                          : BRAND_RED,
                        color: "white",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 12,
                          letterSpacing: 2,
                          textTransform: "uppercase",
                          opacity: 0.75,
                        }}
                      >
                        Member
                      </div>
                      <div style={{ fontSize: 34, fontWeight: 800 }}>
                        {selectedMember.name}
                      </div>
                      <div style={{ opacity: 0.85 }}>
                        {selectedMember.memberId}
                      </div>
                      <div
                        style={{
                          marginTop: 12,
                          fontSize: 12,
                          letterSpacing: 2,
                          textTransform: "uppercase",
                          opacity: 0.75,
                        }}
                      >
                        Number of Games Attended
                      </div>
                      <div style={{ fontSize: 72, fontWeight: 900 }}>
                        #{selectedMember.attendanceCount}
                      </div>
                      <div>
                        Reward: {rewardLabel(selectedMember.attendanceCount)}
                      </div>
                      <div style={{ opacity: 0.85 }}>
                        Last visit: {selectedMember.lastVisit}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                      }}
                    >
                      <button
                        style={styles.button}
                        onClick={() =>
                          void checkInMember(selectedMember.memberId)
                        }
                        disabled={savingCheckIn}
                      >
                        {savingCheckIn ? "Saving..." : "Check In Now"}
                      </button>
                      <button
                        style={styles.buttonSecondary}
                        onClick={() => setScannerOpen(true)}
                      >
                        Scan Next Card
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={styles.card}>
                    {sheetLoading
                      ? "Loading members from Google Sheet..."
                      : "No members loaded yet."}
                  </div>
                )}
              </div>

              <div style={styles.card}>
                <h3 style={{ marginTop: 0 }}>Scan or search member ID</h3>
                <div style={{ display: "grid", gap: 12 }}>
                  <input
                    style={styles.input}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Scan QR or type member ID / name"
                  />
                  <div
                    style={{
                      display: "grid",
                      gap: 8,
                      maxHeight: 420,
                      overflow: "auto",
                    }}
                  >
                    {filteredMembers.map((member) => (
                      <button
                        key={member.memberId}
                        onClick={() => setSelectedId(member.memberId)}
                        style={{
                          ...styles.memberButton,
                          ...(selectedMember?.memberId === member.memberId
                            ? styles.selectedMemberButton
                            : null),
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 700 }}>{member.name}</div>
                            <div style={{ opacity: 0.8 }}>
                              {member.memberId}
                            </div>
                          </div>
                          <div>#{member.attendanceCount}</div>
                        </div>
                      </button>
                    ))}
                    {!filteredMembers.length && (
                      <div style={styles.card}>No member found.</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "members" && (
          <div style={styles.card}>
            <h3 style={{ marginTop: 0 }}>Members</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {members.map((member) => (
                <div
                  key={member.memberId}
                  style={{ ...styles.card, padding: 12 }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700 }}>{member.name}</div>
                      <div style={{ color: "#64748b" }}>{member.memberId}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 700 }}>
                        #{member.attendanceCount}
                      </div>
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        {rewardLabel(member.attendanceCount)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              {!members.length && (
                <div style={styles.card}>
                  {sheetLoading
                    ? "Loading members from Google Sheet..."
                    : "No members loaded."}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "log" && (
          <div style={styles.card}>
            <h3 style={{ marginTop: 0 }}>Recent check-ins</h3>
            <div style={{ display: "grid", gap: 8 }}>
              {logs.length ? (
                logs.map((entry, index) => (
                  <div
                    key={`${entry.memberId}-${index}`}
                    style={{ ...styles.card, padding: 12 }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700 }}>{entry.name}</div>
                        <div style={{ color: "#64748b" }}>{entry.memberId}</div>
                      </div>
                      <div style={{ fontWeight: 700 }}>
                        Visit #{entry.attendanceNumber}
                      </div>
                      <div style={{ color: "#64748b" }}>{entry.gameDate}</div>
                      <div style={{ color: "#64748b" }}>{entry.timestamp}</div>
                    </div>
                  </div>
                ))
              ) : (
                <div style={styles.card}>No check-ins yet in this demo.</div>
              )}
            </div>
          </div>
        )}

        <div style={styles.card}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>
            Google Sheet source
          </div>
          <div
            style={{ color: "#64748b", fontSize: 14, wordBreak: "break-all" }}
          >
            {DEFAULT_SHEET_URL}
          </div>
          <div
            style={{
              color: "#64748b",
              fontSize: 14,
              wordBreak: "break-all",
              marginTop: 8,
            }}
          >
            Apps Script write-back URL: {APPS_SCRIPT_URL}
          </div>
          <div
            style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <button
              style={styles.buttonSecondary}
              onClick={() => setActiveTab("log")}
            >
              Activity Log
            </button>
            <button style={styles.buttonSecondary} onClick={exportCsv}>
              Export CSV
            </button>
          </div>
        </div>

        {scannerOpen && (
          <div style={styles.overlay}>
            <div style={styles.modal}>
              <div style={styles.row}>
                <div>
                  <div style={{ fontSize: 24, fontWeight: 800 }}>
                    Scan Member QR
                  </div>
                  <div style={{ color: "#64748b" }}>
                    This version is ready for CodeSandbox.
                  </div>
                </div>
                <button
                  style={styles.buttonSecondary}
                  onClick={() => setScannerOpen(false)}
                >
                  Close
                </button>
              </div>

              <div
                id={READER_ID}
                style={{
                  minHeight: 280,
                  borderRadius: 20,
                  overflow: "hidden",
                  background: BRAND_RED,
                }}
              />

              <div style={{ ...styles.card, background: "#f8fafc" }}>
                {scannerStatus}
              </div>

              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                onChange={handlePhotoFile}
              />

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {!scannerRunning && (
                  <button style={styles.button} onClick={startLiveScanner}>
                    Start Live Scanner
                  </button>
                )}
                <button
                  style={styles.buttonSecondary}
                  onClick={() => photoInputRef.current?.click()}
                  disabled={photoBusy}
                >
                  {photoBusy ? "Reading Photo..." : "Scan From Photo"}
                </button>
              </div>

              <div style={{ color: "#64748b", fontSize: 14 }}>
                In CodeSandbox, install <code>html5-qrcode</code> and{" "}
                <code>jsqr</code>, then open the sandbox in its own tab or
                deployed URL for camera access.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
