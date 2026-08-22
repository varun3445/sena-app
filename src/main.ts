import { HandLandmarker, FilesetResolver, type HandLandmarkerResult } from "@mediapipe/tasks-vision";
import "./style.css";

type Gesture = "one" | "two" | "palm" | "fist" | "none";
type Team = 1 | 2;
type TabName = "home" | "history" | "profile";
type Phase = "setup" | "live";

interface TeamConfig {
  name: string;
  players: string[];
}
interface MatchConfig {
  matchType: "singles" | "doubles";
  setsToWin: number;
  gamesPerSet: number;
  team1: TeamConfig;
  team2: TeamConfig;
}
interface SetResult {
  games: [number, number];
  tiebreak?: [number, number];
}
interface MatchRecord {
  id: string;
  date: string;
  config: MatchConfig;
  finalSets: [number, number];
  completedSets: SetResult[];
  winner: Team;
}
interface MatchState {
  points: [number, number];
  tiebreakPoints: [number, number];
  games: [number, number];
  sets: [number, number];
  isTiebreak: boolean;
  matchOver: boolean;
  winner: Team | null;
  completedSets: SetResult[];
}

interface PlayerProfile {
  name: string;
  age: string;
  level: "beginner" | "intermediate" | "advanced" | "pro";
  racquet: string;
}
interface DefaultFormat {
  matchType: "singles" | "doubles";
  setsToWin: number;
  gamesPerSet: number;
}

function defaultConfig(): MatchConfig {
  const fmt = loadDefaultFormat();
  return {
    matchType: fmt.matchType,
    setsToWin: fmt.setsToWin,
    gamesPerSet: fmt.gamesPerSet,
    team1: { name: "Team 1", players: [] },
    team2: { name: "Team 2", players: [] },
  };
}

function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ---- Persistence ----
const HISTORY_KEY = "sena-history";

// Normalizes whatever shape is on disk into the current MatchRecord shape. Match records
// persist indefinitely in localStorage, so a record saved by an older build of this app
// (e.g. before `completedSets` replaced `finalGames`) must never crash the render — it just
// renders with sane fallbacks instead.
function normalizeHistoryRecord(r: any): MatchRecord {
  return {
    id: typeof r?.id === "string" ? r.id : String(Math.random()),
    date: typeof r?.date === "string" ? r.date : new Date().toISOString(),
    config: {
      matchType: r?.config?.matchType === "singles" ? "singles" : "doubles",
      setsToWin: typeof r?.config?.setsToWin === "number" ? r.config.setsToWin : 2,
      gamesPerSet: typeof r?.config?.gamesPerSet === "number" ? r.config.gamesPerSet : 6,
      team1: {
        name: typeof r?.config?.team1?.name === "string" ? r.config.team1.name : "Team 1",
        players: Array.isArray(r?.config?.team1?.players) ? r.config.team1.players : [],
      },
      team2: {
        name: typeof r?.config?.team2?.name === "string" ? r.config.team2.name : "Team 2",
        players: Array.isArray(r?.config?.team2?.players) ? r.config.team2.players : [],
      },
    },
    finalSets: Array.isArray(r?.finalSets) && r.finalSets.length === 2 ? r.finalSets : [0, 0],
    completedSets: Array.isArray(r?.completedSets) ? r.completedSets : [],
    winner: r?.winner === 2 ? 2 : 1,
  };
}

function loadHistory(): MatchRecord[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeHistoryRecord);
  } catch {
    return [];
  }
}
function saveHistoryRecord(rec: MatchRecord) {
  const all = loadHistory();
  all.unshift(rec);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}
function removeMostRecentHistoryRecord() {
  const all = loadHistory();
  all.shift();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}
function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

const PROFILE_KEY = "sena-profile";
function loadProfile(): PlayerProfile {
  try {
    return { name: "", age: "", level: "beginner", racquet: "", ...JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") };
  } catch {
    return { name: "", age: "", level: "beginner", racquet: "" };
  }
}
function saveProfile(p: PlayerProfile) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
}

const FORMAT_KEY = "sena-default-format";
function loadDefaultFormat(): DefaultFormat {
  try {
    return { matchType: "doubles", setsToWin: 2, gamesPerSet: 6, ...JSON.parse(localStorage.getItem(FORMAT_KEY) || "{}") };
  } catch {
    return { matchType: "doubles", setsToWin: 2, gamesPerSet: 6 };
  }
}
function saveDefaultFormat(f: DefaultFormat) {
  localStorage.setItem(FORMAT_KEY, JSON.stringify(f));
}

// ---- App state ----
const state: {
  tab: TabName;
  phase: Phase;
  config: MatchConfig;
  events: Team[];
  paused: boolean;
  savedForThisMatch: boolean;
} = {
  tab: "home",
  phase: "setup",
  config: defaultConfig(),
  events: [],
  paused: true,
  savedForThisMatch: false,
};

const app = document.querySelector<HTMLDivElement>("#app")!;

// ---- Scoring engine (pure replay: undo = drop last event and recompute) ----
function computeMatchState(events: Team[], config: MatchConfig): MatchState {
  const target = config.gamesPerSet;
  const setsToWin = config.setsToWin;
  const games: [number, number] = [0, 0];
  const sets: [number, number] = [0, 0];
  let points: [number, number] = [0, 0];
  let tiebreakPoints: [number, number] = [0, 0];
  let isTiebreak = false;
  let matchOver = false;
  let winner: Team | null = null;
  const completedSets: SetResult[] = [];

  for (const team of events) {
    if (matchOver) break;
    const i = team === 1 ? 0 : 1;
    const j = i === 0 ? 1 : 0;

    if (isTiebreak) {
      tiebreakPoints[i]++;
      if (tiebreakPoints[i] >= 7 && tiebreakPoints[i] - tiebreakPoints[j] >= 2) {
        games[i]++;
        completedSets.push({ games: [games[0], games[1]], tiebreak: [tiebreakPoints[0], tiebreakPoints[1]] });
        sets[i]++;
        games[0] = 0;
        games[1] = 0;
        tiebreakPoints = [0, 0];
        isTiebreak = false;
        if (sets[i] >= setsToWin) {
          matchOver = true;
          winner = team;
        }
      }
    } else {
      points[i]++;
      if (points[i] >= 4 && points[i] - points[j] >= 2) {
        games[i]++;
        points = [0, 0];
        if (games[i] >= target && games[i] - games[j] >= 2) {
          completedSets.push({ games: [games[0], games[1]] });
          sets[i]++;
          games[0] = 0;
          games[1] = 0;
          if (sets[i] >= setsToWin) {
            matchOver = true;
            winner = team;
          }
        } else if (games[0] === target && games[1] === target) {
          isTiebreak = true;
        }
      }
    }
  }

  return { points, tiebreakPoints, games, sets, isTiebreak, matchOver, winner, completedSets };
}

function pointLabel(state: MatchState, i: 0 | 1): string {
  if (state.matchOver) return "–";
  if (state.isTiebreak) return String(state.tiebreakPoints[i]);
  const p = state.points[i];
  const q = state.points[i === 0 ? 1 : 0];
  if (p >= 3 && q >= 3) {
    if (p === q) return "40";
    return p > q ? "AD" : "40";
  }
  return ["0", "15", "30", "40"][Math.min(p, 3)];
}

// ---- Voice callouts ----
const VOICE_KEY = "sena-voice-enabled";
function isVoiceEnabled(): boolean {
  return localStorage.getItem(VOICE_KEY) !== "off";
}
function setVoiceEnabled(on: boolean) {
  localStorage.setItem(VOICE_KEY, on ? "on" : "off");
}

function speak(text: string) {
  if (!isVoiceEnabled()) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// Compares the match state right before and right after a point to decide what's worth saying —
// match win outranks set win outranks game win outranks a deuce/advantage callout outranks just
// reading the new score back. Each check returns early so only one thing gets said per point.
function announcePointOutcome(config: MatchConfig, before: MatchState, after: MatchState, scoringTeam: Team) {
  const teamName = (t: Team) => (t === 1 ? config.team1.name : config.team2.name);

  if (after.matchOver && !before.matchOver) {
    speak(`Game, set, and match. ${teamName(after.winner!)} wins.`);
    return;
  }
  if (after.sets[0] !== before.sets[0] || after.sets[1] !== before.sets[1]) {
    const lastSet = after.completedSets[after.completedSets.length - 1];
    speak(`Set, ${teamName(scoringTeam)}. ${lastSet.games[0]} games to ${lastSet.games[1]}.`);
    return;
  }
  if (after.games[0] !== before.games[0] || after.games[1] !== before.games[1]) {
    speak(`Game, ${teamName(scoringTeam)}.`);
    return;
  }
  if (!after.isTiebreak && after.points[0] >= 3 && after.points[1] >= 3) {
    if (after.points[0] === after.points[1]) {
      speak("Deuce.");
    } else {
      speak(`Advantage, ${teamName(after.points[0] > after.points[1] ? 1 : 2)}.`);
    }
    return;
  }
  const spoken = (label: string) => (label === "0" ? "love" : label);
  speak(`${spoken(pointLabel(after, 0))}, ${spoken(pointLabel(after, 1))}.`);
}

// ---- Icons ----
const ICONS = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9"/></svg>`,
  history: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>`,
  profile: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20c1.4-3.6 4.4-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/></svg>`,
};

function navHTML(): string {
  const tabs: TabName[] = ["home", "history", "profile"];
  return `<div class="nav">
    ${tabs
      .map(
        (t) =>
          `<button type="button" data-tab="${t}" class="${state.tab === t ? "active" : ""}" aria-label="${t}">${ICONS[t]}</button>`
      )
      .join("")}
  </div>`;
}

function wireNav() {
  app.querySelectorAll<HTMLButtonElement>(".nav button").forEach((btn) => {
    btn.addEventListener("click", () => {
      // Dismissing focus (and any on-screen keyboard) before rebuilding the DOM avoids a known
      // mobile Safari/Chrome bug where a fixed-position element's tap hit-box goes stale after
      // the keyboard closes, even though it still looks correctly placed on screen.
      (document.activeElement as HTMLElement | null)?.blur?.();
      state.tab = btn.dataset.tab as TabName;
      renderShell();
    });
  });
}

// ---- Camera / gesture engine (module-level so it survives tab switches without reloading the model) ----
let handLandmarkerPromise: Promise<HandLandmarker> | null = null;
function getHandLandmarker() {
  if (!handLandmarkerPromise) {
    handLandmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/wasm");
      return HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/hand_landmarker.task" },
        runningMode: "VIDEO",
        numHands: 1,
      });
    })();
  }
  return handLandmarkerPromise;
}

let liveStream: MediaStream | null = null;
let liveRAF: number | null = null;
let currentGesture: Gesture = "none";
let gestureSince = 0;
let lastActionTime = 0;

const HOLD_MS = 350;
const COOLDOWN_MS = 1000; // one action per second, flat — stops finger flicker from double-firing

function classifyHand(landmarks: { x: number; y: number }[]): Gesture {
  // Distance-from-wrist, not raw screen Y — an extended finger is farther from the wrist than its
  // own PIP joint regardless of how the hand is rotated in frame (including upside-down).
  const wrist = landmarks[0];
  const distFromWrist = (i: number) => Math.hypot(landmarks[i].x - wrist.x, landmarks[i].y - wrist.y);
  const extended = (tip: number, pip: number) => distFromWrist(tip) > distFromWrist(pip) * 1.15;
  const index = extended(8, 6);
  const middle = extended(12, 10);
  const ring = extended(16, 14);
  const pinky = extended(20, 18);
  const count = [index, middle, ring, pinky].filter(Boolean).length;
  if (count === 0) return "fist";
  if (count >= 4) return "palm";
  if (count === 1 && index) return "one";
  if (count === 2 && index && middle) return "two";
  return "none";
}

// With a racquet-holding hand also in frame, a closed grip reads a lot like a fist to the
// classifier above — and MediaPipe doesn't promise a stable order between the two detected
// hands frame to frame. So every hand gets classified, and a deliberate scoring/pause gesture
// (one/two/palm) always wins over an incidental fist from whichever hand is holding the racquet.
function pickGesture(landmarksList: { x: number; y: number }[][]): Gesture {
  const gestures = landmarksList.map(classifyHand);
  const priority: Gesture[] = ["one", "two", "palm", "fist"];
  for (const g of priority) {
    if (gestures.includes(g)) return g;
  }
  return "none";
}

function stopLive() {
  if (liveRAF !== null) cancelAnimationFrame(liveRAF);
  liveRAF = null;
  if (liveStream) {
    liveStream.getTracks().forEach((t) => t.stop());
    liveStream = null;
  }
  currentGesture = "none";
}

function goToSetup() {
  stopLive();
  state.events = [];
  state.paused = true;
  state.savedForThisMatch = false;
  state.phase = "setup";
  renderShell();
}

function maybeSaveHistory(ms: MatchState) {
  if (ms.matchOver && !state.savedForThisMatch && ms.winner) {
    saveHistoryRecord({
      id: String(Date.now()),
      date: new Date().toISOString(),
      config: state.config,
      finalSets: ms.sets,
      completedSets: ms.completedSets,
      winner: ms.winner,
    });
    state.savedForThisMatch = true;
  }
}

// ---- Live screen ----
function liveScreenHTML(): string {
  const c = state.config;
  return `
  <div class="topline">
    <h1>Seña <span>— live</span></h1>
    <button type="button" class="back-link" id="backBtn">← Setup</button>
  </div>
  <div class="stage">
    <video id="cam" autoplay playsinline muted></video>
    <canvas id="overlay"></canvas>
  </div>
  <div class="banner" id="banner"></div>
  <div class="board">
    <div class="row head">
      <div class="rlabel"></div>
      <div class="val t1">
        <div class="teamline"><span class="dot-mark t1"></span>${escapeHtml(c.team1.name)}</div>
        <div class="players-line">${escapeHtml(c.team1.players.filter(Boolean).join(" & "))}</div>
      </div>
      <div class="val t2">
        <div class="teamline"><span class="dot-mark t2"></span>${escapeHtml(c.team2.name)}</div>
        <div class="players-line">${escapeHtml(c.team2.players.filter(Boolean).join(" & "))}</div>
      </div>
    </div>
    <div class="row sets"><div class="rlabel">Sets</div><div class="val" id="sets1">0</div><div class="val" id="sets2">0</div></div>
    <div class="row games"><div class="rlabel">Games</div><div class="val" id="games1">0</div><div class="val" id="games2">0</div></div>
    <div class="row points"><div class="rlabel" id="pointsLabel">Points</div><div class="val" id="points1">0</div><div class="val" id="points2">0</div></div>
  </div>
  <div class="controls">
    <div class="status" id="status"><span class="dot" id="statusDot"></span><span id="statusText">Loading model…</span></div>
    <button type="button" class="undo" id="undoBtn">Undo last point</button>
  </div>
  <div class="debug" id="debug"></div>
  `;
}

function wireLiveScreen() {
  const video = app.querySelector<HTMLVideoElement>("#cam")!;
  const canvas = app.querySelector<HTMLCanvasElement>("#overlay")!;
  const ctx = canvas.getContext("2d")!;
  const statusDot = app.querySelector<HTMLSpanElement>("#statusDot")!;
  const statusText = app.querySelector<HTMLSpanElement>("#statusText")!;
  const statusRow = app.querySelector<HTMLDivElement>("#status")!;
  const bannerEl = app.querySelector<HTMLDivElement>("#banner")!;
  const pointsLabelEl = app.querySelector<HTMLDivElement>("#pointsLabel")!;
  const sets1El = app.querySelector<HTMLDivElement>("#sets1")!;
  const sets2El = app.querySelector<HTMLDivElement>("#sets2")!;
  const games1El = app.querySelector<HTMLDivElement>("#games1")!;
  const games2El = app.querySelector<HTMLDivElement>("#games2")!;
  const points1El = app.querySelector<HTMLDivElement>("#points1")!;
  const points2El = app.querySelector<HTMLDivElement>("#points2")!;
  const undoBtn = app.querySelector<HTMLButtonElement>("#undoBtn")!;
  const debugEl = app.querySelector<HTMLDivElement>("#debug")!;
  const backBtn = app.querySelector<HTMLButtonElement>("#backBtn")!;

  backBtn.addEventListener("click", goToSetup);

  function setStatus() {
    statusDot.classList.toggle("live", !state.paused);
    statusRow.classList.toggle("is-live", !state.paused);
    statusText.textContent = state.paused ? "Paused — show a fist to resume" : "Live — scoring active";
  }

  function render() {
    const ms = computeMatchState(state.events, state.config);
    sets1El.textContent = String(ms.sets[0]);
    sets2El.textContent = String(ms.sets[1]);
    games1El.textContent = String(ms.games[0]);
    games2El.textContent = String(ms.games[1]);
    points1El.textContent = pointLabel(ms, 0);
    points2El.textContent = pointLabel(ms, 1);
    pointsLabelEl.innerHTML = ms.isTiebreak ? `Points<span class="tb-tag">TB</span>` : "Points";

    maybeSaveHistory(ms);

    if (ms.matchOver) {
      bannerEl.innerHTML = `<div>${escapeHtml(ms.winner === 1 ? state.config.team1.name : state.config.team2.name)} wins the match</div><button type="button" class="new-match-btn" id="newMatchBtn">New match</button>`;
      bannerEl.classList.add("show");
      bannerEl.querySelector("#newMatchBtn")?.addEventListener("click", goToSetup);
    } else {
      bannerEl.classList.remove("show");
    }
    return ms;
  }

  undoBtn.addEventListener("click", () => {
    const wasOver = computeMatchState(state.events, state.config).matchOver;
    state.events.pop();
    const stillOver = computeMatchState(state.events, state.config).matchOver;
    if (wasOver && !stillOver && state.savedForThisMatch) {
      // The match had already been saved to history; undoing the winning point un-ends it,
      // so that saved record is now wrong and needs to come back out.
      removeMostRecentHistoryRecord();
      state.savedForThisMatch = false;
    }
    render();
  });

  setStatus();
  render();

  function handleGesture(g: Gesture) {
    const now = performance.now();
    if (g !== currentGesture) {
      currentGesture = g;
      gestureSince = now;
      return;
    }
    if (now - gestureSince < HOLD_MS) return;
    if (now - lastActionTime < COOLDOWN_MS) return;

    if (g === "fist") {
      if (state.paused) {
        state.paused = false;
        setStatus();
        speak("Scoring.");
        lastActionTime = now;
      }
      return;
    }
    if (g === "palm") {
      if (!state.paused) {
        state.paused = true;
        setStatus();
        speak("Paused.");
        lastActionTime = now;
      }
      return;
    }
    if (state.paused) return;
    const before = computeMatchState(state.events, state.config);
    if (before.matchOver) return;

    if (g === "one" || g === "two") {
      const scoringTeam: Team = g === "one" ? 1 : 2;
      state.events.push(scoringTeam);
      const after = render();
      announcePointOutcome(state.config, before, after, scoringTeam);
      lastActionTime = now;
    }
  }

  (async () => {
    try {
      const handLandmarker = await getHandLandmarker();
      // Higher capture resolution gives the model more pixels on the hand at courtside distance,
      // where landmark noise (and misreads) get worse. `ideal` rather than an exact size so phones
      // that can't hit 720p exactly still fall back gracefully instead of failing the constraint.
      liveStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = liveStream;
      await new Promise((res) => (video.onloadedmetadata = res));
      video.play();
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const connections: [number, number][] = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [5, 9], [9, 10], [10, 11], [11, 12],
        [9, 13], [13, 14], [14, 15], [15, 16],
        [13, 17], [17, 18], [18, 19], [19, 20],
        [0, 17],
      ];

      function drawResult(result: HandLandmarkerResult) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const hand of result.landmarks) {
          ctx.strokeStyle = "rgba(198,255,61,0.9)";
          ctx.lineWidth = 2;
          for (const [a, b] of connections) {
            ctx.beginPath();
            ctx.moveTo(hand[a].x * canvas.width, hand[a].y * canvas.height);
            ctx.lineTo(hand[b].x * canvas.width, hand[b].y * canvas.height);
            ctx.stroke();
          }
          ctx.fillStyle = "#c6ff3d";
          for (const p of hand) {
            ctx.beginPath();
            ctx.arc(p.x * canvas.width, p.y * canvas.height, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }

      function loop() {
        const now = performance.now();
        const result = handLandmarker.detectForVideo(video, now);
        drawResult(result);

        const gesture: Gesture = pickGesture(result.landmarks);
        handleGesture(gesture);

        const cooldownLeft = Math.max(0, COOLDOWN_MS - (now - lastActionTime));
        debugEl.innerHTML = `
          <div>hands: <b>${result.landmarks.length}</b></div>
          <div>gesture: <span class="gesture-live">${currentGesture}</span></div>
          <div>state: <b>${state.paused ? "paused" : "live"}</b></div>
          <div>cooldown: <b>${cooldownLeft.toFixed(0)}ms</b></div>
        `;
        liveRAF = requestAnimationFrame(loop);
      }
      liveRAF = requestAnimationFrame(loop);
    } catch (err: any) {
      statusText.textContent = `Error: ${err.message}`;
      console.error(err);
    }
  })();
}

// ---- Setup screen ----
function setupScreenHTML(): string {
  const c = state.config;
  const isDefault = c.setsToWin === 2 && c.gamesPerSet === 6;
  const p1 = (n: number) => c.team1.players[n] || "";
  const p2 = (n: number) => c.team2.players[n] || "";

  return `
  <h1>Seña <span>— match setup</span></h1>

  <div class="setup">
    <div>
      <div class="section-title">Match type</div>
      <div class="segmented" id="matchTypeSeg">
        <button type="button" data-val="singles" class="${c.matchType === "singles" ? "active" : ""}">Singles</button>
        <button type="button" data-val="doubles" class="${c.matchType === "doubles" ? "active" : ""}">Doubles</button>
      </div>
    </div>

    <div>
      <div class="section-title">Format</div>
      <div class="segmented" id="formatSeg">
        <button type="button" data-val="default" class="${isDefault ? "active" : ""}">Default</button>
        <button type="button" data-val="custom" class="${isDefault ? "" : "active"}">Custom</button>
      </div>
      <div class="format-info ${isDefault ? "" : "hidden"}" id="formatInfo">
        Best of <b>3 sets</b> · first to <b>6 games</b> · tiebreak at 6–6
      </div>
      <div class="custom-format ${isDefault ? "hidden" : ""}" id="customFormat" style="margin-top:10px;">
        <div class="field">
          <label for="setsToWin">Sets to win</label>
          <select id="setsToWin">
            <option value="1" ${c.setsToWin === 1 ? "selected" : ""}>1 (single set)</option>
            <option value="2" ${c.setsToWin === 2 ? "selected" : ""}>2 (best of 3)</option>
            <option value="3" ${c.setsToWin === 3 ? "selected" : ""}>3 (best of 5)</option>
          </select>
        </div>
        <div class="field">
          <label for="gamesPerSet">Games per set</label>
          <select id="gamesPerSet">
            <option value="4" ${c.gamesPerSet === 4 ? "selected" : ""}>First to 4</option>
            <option value="6" ${c.gamesPerSet === 6 ? "selected" : ""}>First to 6</option>
            <option value="8" ${c.gamesPerSet === 8 ? "selected" : ""}>First to 8</option>
          </select>
        </div>
      </div>
    </div>

    <div>
      <div class="section-title">Teams</div>
      <div class="teams-grid">
        <div class="team-card t1">
          <div class="field">
            <label for="team1Name"><span class="dot-mark t1"></span> Team name</label>
            <input id="team1Name" type="text" value="${escapeHtml(c.team1.name)}" placeholder="Team 1" />
          </div>
          <div class="field">
            <label>Player 1</label>
            <input id="t1p0" type="text" value="${escapeHtml(p1(0))}" placeholder="Name" />
          </div>
          <div class="field player2 ${c.matchType === "singles" ? "hidden" : ""}">
            <label>Player 2</label>
            <input id="t1p1" type="text" value="${escapeHtml(p1(1))}" placeholder="Name" />
          </div>
        </div>
        <div class="team-card t2">
          <div class="field">
            <label><span class="dot-mark t2"></span> Team name</label>
            <input id="team2Name" type="text" value="${escapeHtml(c.team2.name)}" placeholder="Team 2" />
          </div>
          <div class="field">
            <label>Player 1</label>
            <input id="t2p0" type="text" value="${escapeHtml(p2(0))}" placeholder="Name" />
          </div>
          <div class="field player2 ${c.matchType === "singles" ? "hidden" : ""}">
            <label>Player 2</label>
            <input id="t2p1" type="text" value="${escapeHtml(p2(1))}" placeholder="Name" />
          </div>
        </div>
      </div>
    </div>

    <div class="setup-error" id="setupError">Enter a name for every player before starting.</div>
    <button type="button" class="start-btn" id="startBtn">Start match</button>
  </div>
  `;
}

function wireSetupScreen() {
  const matchTypeSeg = app.querySelector<HTMLDivElement>("#matchTypeSeg")!;
  const formatSeg = app.querySelector<HTMLDivElement>("#formatSeg")!;
  const formatInfo = app.querySelector<HTMLDivElement>("#formatInfo")!;
  const customFormat = app.querySelector<HTMLDivElement>("#customFormat")!;
  const startBtn = app.querySelector<HTMLButtonElement>("#startBtn")!;

  matchTypeSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      matchTypeSeg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const isDoubles = btn.dataset.val === "doubles";
      app.querySelectorAll(".player2").forEach((el) => el.classList.toggle("hidden", !isDoubles));
    });
  });

  formatSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      formatSeg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const isCustom = btn.dataset.val === "custom";
      formatInfo.classList.toggle("hidden", isCustom);
      customFormat.classList.toggle("hidden", !isCustom);
    });
  });

  const setupError = app.querySelector<HTMLDivElement>("#setupError")!;
  const clearInvalid = (id: string) => {
    (app.querySelector(`#${id}`) as HTMLInputElement).closest(".field")?.classList.remove("invalid");
  };
  ["t1p0", "t1p1", "t2p0", "t2p1"].forEach((id) => {
    app.querySelector(`#${id}`)!.addEventListener("input", () => clearInvalid(id));
  });

  startBtn.addEventListener("click", () => {
    const matchType = (matchTypeSeg.querySelector(".active") as HTMLButtonElement).dataset.val as "singles" | "doubles";
    const isCustom = (formatSeg.querySelector(".active") as HTMLButtonElement).dataset.val === "custom";
    const setsToWin = isCustom ? parseInt((app.querySelector("#setsToWin") as HTMLSelectElement).value, 10) : 2;
    const gamesPerSet = isCustom ? parseInt((app.querySelector("#gamesPerSet") as HTMLSelectElement).value, 10) : 6;

    const val = (id: string) => (app.querySelector(`#${id}`) as HTMLInputElement).value.trim();
    const requiredIds = matchType === "doubles" ? ["t1p0", "t1p1", "t2p0", "t2p1"] : ["t1p0", "t2p0"];
    const missing = requiredIds.filter((id) => !val(id));

    ["t1p0", "t1p1", "t2p0", "t2p1"].forEach((id) => clearInvalid(id));
    if (missing.length > 0) {
      missing.forEach((id) => (app.querySelector(`#${id}`) as HTMLInputElement).closest(".field")?.classList.add("invalid"));
      setupError.classList.add("show");
      (app.querySelector(`#${missing[0]}`) as HTMLInputElement).focus();
      return;
    }
    setupError.classList.remove("show");

    const team1Players = matchType === "doubles" ? [val("t1p0"), val("t1p1")] : [val("t1p0")];
    const team2Players = matchType === "doubles" ? [val("t2p0"), val("t2p1")] : [val("t2p0")];

    state.config = {
      matchType,
      setsToWin,
      gamesPerSet,
      team1: { name: val("team1Name") || "Team 1", players: team1Players.filter(Boolean) },
      team2: { name: val("team2Name") || "Team 2", players: team2Players.filter(Boolean) },
    };
    state.events = [];
    state.paused = true;
    state.savedForThisMatch = false;
    state.phase = "live";
    renderShell();
  });
}

// ---- History screen ----
const CHEVRON_ICON = `<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

function historyScreenHTML(): string {
  const items = loadHistory();
  if (items.length === 0) {
    return `<h1>Seña <span>— history</span></h1><div class="empty-state">No matches yet — play one and it'll show up here.</div>`;
  }
  const rows = items
    .map((rec, idx) => {
      const winnerName = rec.winner === 1 ? rec.config.team1.name : rec.config.team2.name;
      const loserName = rec.winner === 1 ? rec.config.team2.name : rec.config.team1.name;
      const date = new Date(rec.date).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
      const t1players = rec.config.team1.players.filter(Boolean).join(" & ");
      const t2players = rec.config.team2.players.filter(Boolean).join(" & ");

      const setLines = rec.completedSets
        .map((s, i) => {
          const tb = s.tiebreak ? ` <span class="tb-tag">TB ${s.tiebreak[0]}–${s.tiebreak[1]}</span>` : "";
          return `<div class="set-line"><span>Set ${i + 1}</span><span>${s.games[0]}–${s.games[1]}${tb}</span></div>`;
        })
        .join("");

      return `
      <div class="history-item-wrap">
        <button type="button" class="history-item" data-idx="${idx}">
          <div>
            <div class="teams"><span class="winner">${escapeHtml(winnerName)}</span> beat <span class="loser">${escapeHtml(loserName)}</span></div>
            <div class="meta">${date} · ${rec.config.matchType}</div>
          </div>
          <div class="score-wrap">
            <div class="score">${rec.finalSets[0]}–${rec.finalSets[1]}</div>
            ${CHEVRON_ICON}
          </div>
        </button>
        <div class="history-detail hidden" id="detail-${idx}">
          <div class="detail-players">
            <div><span class="dot-mark t1"></span>${escapeHtml(rec.config.team1.name)}${t1players ? ` · ${escapeHtml(t1players)}` : ""}</div>
            <div><span class="dot-mark t2"></span>${escapeHtml(rec.config.team2.name)}${t2players ? ` · ${escapeHtml(t2players)}` : ""}</div>
          </div>
          <div class="detail-sets">${setLines}</div>
        </div>
      </div>`;
    })
    .join("");
  return `<h1>Seña <span>— history</span></h1><div class="history-list">${rows}</div>`;
}

function wireHistoryScreen() {
  app.querySelectorAll<HTMLButtonElement>(".history-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = btn.dataset.idx;
      const detail = app.querySelector(`#detail-${idx}`)!;
      const willOpen = detail.classList.contains("hidden");
      detail.classList.toggle("hidden", !willOpen);
      btn.classList.toggle("expanded", willOpen);
    });
  });
}

// ---- Profile screen ----
const LEVELS: PlayerProfile["level"][] = ["beginner", "intermediate", "advanced", "pro"];

function profileScreenHTML(): string {
  const p = loadProfile();
  const fmt = loadDefaultFormat();
  const isDefaultFmt = fmt.setsToWin === 2 && fmt.gamesPerSet === 6;

  return `
  <h1>Seña <span>— profile</span></h1>

  <div class="section-title">Player</div>
  <div class="profile">
    <div class="field"><label for="profName">Name</label><input id="profName" type="text" value="${escapeHtml(p.name)}" placeholder="Your name" /></div>
    <div class="custom-format">
      <div class="field"><label for="profAge">Age</label><input id="profAge" type="number" min="1" max="120" value="${escapeHtml(p.age)}" placeholder="Age" /></div>
      <div class="field">
        <label for="profLevel">Level</label>
        <select id="profLevel">
          ${LEVELS.map((l) => `<option value="${l}" ${p.level === l ? "selected" : ""}>${l[0].toUpperCase()}${l.slice(1)}</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="field"><label for="profRacquet">Racquet</label><input id="profRacquet" type="text" value="${escapeHtml(p.racquet)}" placeholder="e.g. Babolat Air Viper" /></div>
  </div>

  <div class="section-title">Default match format</div>
  <div class="profile">
    <div class="segmented" id="defMatchTypeSeg">
      <button type="button" data-val="singles" class="${fmt.matchType === "singles" ? "active" : ""}">Singles</button>
      <button type="button" data-val="doubles" class="${fmt.matchType === "doubles" ? "active" : ""}">Doubles</button>
    </div>
    <div class="segmented" id="defFormatSeg">
      <button type="button" data-val="default" class="${isDefaultFmt ? "active" : ""}">Default</button>
      <button type="button" data-val="custom" class="${isDefaultFmt ? "" : "active"}">Custom</button>
    </div>
    <div class="custom-format ${isDefaultFmt ? "hidden" : ""}" id="defCustomFormat">
      <div class="field">
        <label for="defSetsToWin">Sets to win</label>
        <select id="defSetsToWin">
          <option value="1" ${fmt.setsToWin === 1 ? "selected" : ""}>1 (single set)</option>
          <option value="2" ${fmt.setsToWin === 2 ? "selected" : ""}>2 (best of 3)</option>
          <option value="3" ${fmt.setsToWin === 3 ? "selected" : ""}>3 (best of 5)</option>
        </select>
      </div>
      <div class="field">
        <label for="defGamesPerSet">Games per set</label>
        <select id="defGamesPerSet">
          <option value="4" ${fmt.gamesPerSet === 4 ? "selected" : ""}>First to 4</option>
          <option value="6" ${fmt.gamesPerSet === 6 ? "selected" : ""}>First to 6</option>
          <option value="8" ${fmt.gamesPerSet === 8 ? "selected" : ""}>First to 8</option>
        </select>
      </div>
    </div>
  </div>

  <div class="section-title">Permissions</div>
  <div class="profile">
    <div class="perm-row">
      <div>
        <div class="perm-label">Camera</div>
        <div class="perm-status" id="camStatus">Needed for gesture scoring — status unknown until checked</div>
      </div>
      <button type="button" class="clear-btn" id="checkCamBtn">Check access</button>
    </div>
  </div>

  <div class="section-title">Settings</div>
  <div class="profile">
    <div class="perm-row">
      <div>
        <div class="perm-label">Voice callouts</div>
        <div class="perm-status">Speaks score, deuce/advantage, game and set wins</div>
      </div>
      <div class="segmented" id="voiceSeg" style="width:auto;">
        <button type="button" data-val="on" class="${isVoiceEnabled() ? "active" : ""}">On</button>
        <button type="button" data-val="off" class="${isVoiceEnabled() ? "" : "active"}">Off</button>
      </div>
    </div>
    <p>Gesture prototype for scoring padel. No account needed — everything above is stored only on this device.</p>
    <button type="button" class="clear-btn" id="clearHistoryBtn">Clear match history</button>
  </div>
  `;
}

function wireProfileScreen() {
  const nameEl = app.querySelector<HTMLInputElement>("#profName")!;
  const ageEl = app.querySelector<HTMLInputElement>("#profAge")!;
  const levelEl = app.querySelector<HTMLSelectElement>("#profLevel")!;
  const racquetEl = app.querySelector<HTMLInputElement>("#profRacquet")!;

  const saveProfileFromForm = () => {
    saveProfile({
      name: nameEl.value.trim(),
      age: ageEl.value.trim(),
      level: levelEl.value as PlayerProfile["level"],
      racquet: racquetEl.value.trim(),
    });
  };
  [nameEl, ageEl, racquetEl].forEach((el) => el.addEventListener("change", saveProfileFromForm));
  levelEl.addEventListener("change", saveProfileFromForm);

  const matchTypeSeg = app.querySelector<HTMLDivElement>("#defMatchTypeSeg")!;
  const formatSeg = app.querySelector<HTMLDivElement>("#defFormatSeg")!;
  const customFormat = app.querySelector<HTMLDivElement>("#defCustomFormat")!;
  const setsToWinEl = app.querySelector<HTMLSelectElement>("#defSetsToWin")!;
  const gamesPerSetEl = app.querySelector<HTMLSelectElement>("#defGamesPerSet")!;

  const saveFormatFromForm = () => {
    const matchType = (matchTypeSeg.querySelector(".active") as HTMLButtonElement).dataset.val as "singles" | "doubles";
    const isCustom = (formatSeg.querySelector(".active") as HTMLButtonElement).dataset.val === "custom";
    saveDefaultFormat({
      matchType,
      setsToWin: isCustom ? parseInt(setsToWinEl.value, 10) : 2,
      gamesPerSet: isCustom ? parseInt(gamesPerSetEl.value, 10) : 6,
    });
  };

  matchTypeSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      matchTypeSeg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      saveFormatFromForm();
    });
  });
  formatSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      formatSeg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const isCustom = btn.dataset.val === "custom";
      customFormat.classList.toggle("hidden", !isCustom);
      saveFormatFromForm();
    });
  });
  [setsToWinEl, gamesPerSetEl].forEach((el) => el.addEventListener("change", saveFormatFromForm));

  const camStatus = app.querySelector<HTMLDivElement>("#camStatus")!;
  app.querySelector<HTMLButtonElement>("#checkCamBtn")!.addEventListener("click", async () => {
    camStatus.textContent = "Checking…";
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      s.getTracks().forEach((t) => t.stop());
      camStatus.textContent = "Granted — camera is available";
    } catch (err: any) {
      camStatus.textContent = `Not granted (${err.name || "error"}) — allow it when the browser prompts during a match`;
    }
  });

  app.querySelector<HTMLButtonElement>("#clearHistoryBtn")!.addEventListener("click", () => {
    clearHistory();
    renderShell();
  });

  const voiceSeg = app.querySelector<HTMLDivElement>("#voiceSeg")!;
  voiceSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      voiceSeg.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setVoiceEnabled(btn.dataset.val === "on");
    });
  });
}

// ---- Shell dispatcher ----
function renderShell() {
  stopLive();
  let content = "";
  if (state.tab === "home") {
    content = state.phase === "setup" ? setupScreenHTML() : liveScreenHTML();
  } else if (state.tab === "history") {
    content = historyScreenHTML();
  } else {
    content = profileScreenHTML();
  }
  app.innerHTML = content + navHTML();
  wireNav();

  if (state.tab === "home") {
    if (state.phase === "setup") wireSetupScreen();
    else wireLiveScreen();
  } else if (state.tab === "history") {
    wireHistoryScreen();
  } else if (state.tab === "profile") {
    wireProfileScreen();
  }
}

renderShell();
