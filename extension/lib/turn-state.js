(() => {
  "use strict";

  const PHASES = Object.freeze({
    IDLE: "IDLE",
    THINKING: "THINKING",
    ANSWERING: "ANSWERING",
    COMPLETE: "COMPLETE",
    ERROR: "ERROR"
  });
  const ACTIVE_PHASES = new Set([PHASES.THINKING, PHASES.ANSWERING]);
  const TRUSTED_PROMPT_SOURCES = new Set(["dom-click", "dom-submit", "fetch"]);
  const DEFAULT_CONFIDENCE = Object.freeze({
    PROMPT_SUBMITTED: 0.86,
    GENERATION_ACTIVE: 0.82,
    FIRST_VISIBLE_TOKEN: 0.99,
    VISIBLE_ANSWER: 0.84,
    STREAM_COMPLETE: 0.99,
    DOM_COMPLETE: 0.92,
    GENERATION_INACTIVE: 0.82,
    GENERATION_ERROR: 0.95
  });

  function cleanText(value, maxLength = 160) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (/https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) return "[redacted]";
    return text.slice(0, maxLength);
  }

  function confidence(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.max(0, Math.min(1, numeric));
  }

  function timestamp(value) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
    return new Date().toISOString();
  }

  function isCanonicalConversationPath(path) {
    return path === "/backend-api/f/conversation" || path === "/backend-api/f/responses";
  }

  function classifyLiveStatus(text) {
    const value = String(text || "");
    if (/response complete|generation complete|finished|응답 완료|답변 완료|완료됨/i.test(value)) return "complete";
    if (/\b(thinking|reasoning|working|generating)\b|생각|추론|작업 중|작성 중|응답 중/i.test(value)) return "thinking";
    return "other";
  }

  function hasNewAssistantOutput(assistantTurnCount, baselineCount, visible, rootChanged = false) {
    return Boolean(visible && (Number(assistantTurnCount) > Number(baselineCount) || rootChanged));
  }

  function isDomGenerationActive({statusKind, stopButton, streamMarker}) {
    if (statusKind === "complete") return false;
    return Boolean(statusKind === "thinking" || stopButton || streamMarker);
  }

  function blankState() {
    return {
      protocolVersion: "1.1.0",
      phase: PHASES.IDLE,
      turnSequence: 0,
      turnId: null,
      generationActive: false,
      sawVisibleAnswer: false,
      startedAt: null,
      firstVisibleTokenAt: null,
      completedAt: null,
      errorAt: null,
      confidence: 1,
      source: "initial",
      reason: "waiting",
      lastSignal: null,
      lastSignalAt: null,
      lastSignalSource: null
    };
  }

  function createTracker(initialState = null) {
    let state = blankState();

    function snapshot() {
      return {...state};
    }

    function hydrate(value) {
      const candidate = value && typeof value === "object" ? value : {};
      const phase = Object.values(PHASES).includes(candidate.phase) ? candidate.phase : PHASES.IDLE;
      state = {
        ...blankState(),
        phase,
        turnSequence: Math.max(0, Number(candidate.turnSequence) || 0),
        turnId: cleanText(candidate.turnId, 80),
        generationActive: Boolean(candidate.generationActive && ACTIVE_PHASES.has(phase)),
        sawVisibleAnswer: Boolean(candidate.sawVisibleAnswer),
        startedAt: candidate.startedAt || null,
        firstVisibleTokenAt: candidate.firstVisibleTokenAt || null,
        completedAt: candidate.completedAt || null,
        errorAt: candidate.errorAt || null,
        confidence: confidence(candidate.confidence, 0.5),
        source: cleanText(candidate.source, 80) || "hydrated",
        reason: cleanText(candidate.reason) || "restored session state",
        lastSignal: cleanText(candidate.lastSignal, 80),
        lastSignalAt: candidate.lastSignalAt || null,
        lastSignalSource: cleanText(candidate.lastSignalSource, 80)
      };
      return snapshot();
    }

    function reset() {
      state = blankState();
      return snapshot();
    }

    function ingest(signal, meta = {}) {
      const code = String(signal || "").trim().toUpperCase();
      const at = timestamp(meta.timestamp);
      const transitions = [];
      if (!code) return {changed: false, transition: null, transitions, state: snapshot()};
      if (code === "RESET") {
        const previousPhase = state.phase;
        reset();
        if (previousPhase !== PHASES.IDLE) {
          transitions.push({
            previousPhase,
            phase: PHASES.IDLE,
            signal: code,
            timestamp: at,
            confidence: 1,
            source: cleanText(meta.source, 80) || "reset",
            reason: cleanText(meta.reason) || "tracker reset",
            turnSequence: state.turnSequence,
            turnId: state.turnId
          });
        }
        return {changed: transitions.length > 0, transition: transitions.at(-1) || null, transitions, state: snapshot()};
      }

      const source = cleanText(meta.source, 80) || "unknown";
      const reason = cleanText(meta.reason) || code.toLowerCase().replaceAll("_", " ");
      const signalConfidence = confidence(meta.confidence, DEFAULT_CONFIDENCE[code] ?? 0.6);

      function changePhase(nextPhase) {
        if (state.phase === nextPhase) return;
        const previousPhase = state.phase;
        state.phase = nextPhase;
        state.confidence = signalConfidence;
        state.source = source;
        state.reason = reason;
        transitions.push({
          previousPhase,
          phase: nextPhase,
          signal: code,
          timestamp: at,
          confidence: signalConfidence,
          source,
          reason,
          turnSequence: state.turnSequence,
          turnId: state.turnId
        });
      }

      function beginTurn() {
        if (ACTIVE_PHASES.has(state.phase)) return;
        state.turnSequence += 1;
        state.turnId = cleanText(meta.turnId, 80) || `turn-${state.turnSequence}`;
        state.generationActive = true;
        state.sawVisibleAnswer = false;
        state.startedAt = at;
        state.firstVisibleTokenAt = null;
        state.completedAt = null;
        state.errorAt = null;
        changePhase(PHASES.THINKING);
      }

      function isStrongThinkingFallback() {
        return source === "dom" && signalConfidence >= 0.9 &&
          /(?:live status reports thinking|thinking|reasoning|working|생각|추론|작업 중)/i.test(reason);
      }

      if (code === "PROMPT_SUBMITTED") {
        if (ACTIVE_PHASES.has(state.phase)) {
          state.generationActive = true;
        } else if (TRUSTED_PROMPT_SOURCES.has(source)) {
          beginTurn();
        }
      } else if (code === "GENERATION_ACTIVE") {
        if (ACTIVE_PHASES.has(state.phase)) {
          state.generationActive = true;
        } else if (isStrongThinkingFallback()) {
          beginTurn();
        }
      } else if (code === "FIRST_VISIBLE_TOKEN") {
        if (!ACTIVE_PHASES.has(state.phase)) beginTurn();
        state.generationActive = true;
        if (!state.firstVisibleTokenAt) state.firstVisibleTokenAt = at;
      } else if (code === "VISIBLE_ANSWER") {
        if (ACTIVE_PHASES.has(state.phase)) {
          state.generationActive = true;
          state.sawVisibleAnswer = true;
          if (!state.firstVisibleTokenAt) state.firstVisibleTokenAt = at;
          changePhase(PHASES.ANSWERING);
        }
      } else if (code === "STREAM_COMPLETE" || code === "DOM_COMPLETE" || code === "GENERATION_INACTIVE") {
        if (ACTIVE_PHASES.has(state.phase)) {
          state.generationActive = false;
          state.completedAt = at;
          changePhase(PHASES.COMPLETE);
        }
      } else if (code === "GENERATION_ERROR") {
        if (ACTIVE_PHASES.has(state.phase) || state.turnId) {
          state.generationActive = false;
          state.errorAt = at;
          changePhase(PHASES.ERROR);
        }
      }

      state.lastSignal = code;
      state.lastSignalAt = at;
      state.lastSignalSource = source;
      return {
        changed: transitions.length > 0,
        transition: transitions.at(-1) || null,
        transitions,
        state: snapshot()
      };
    }

    if (initialState) hydrate(initialState);
    return Object.freeze({ingest, snapshot, hydrate, reset});
  }

  const api = Object.freeze({
    PHASES,
    createTracker,
    isCanonicalConversationPath,
    classifyLiveStatus,
    hasNewAssistantOutput,
    isDomGenerationActive
  });
  globalThis.UiStateInspectorTurnState = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
