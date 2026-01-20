# Exbabel — Caption Engine Refactor

**Last updated:** 2026-01-20 (America/Chicago) - Multi-Repo Extraction & Portability Hardening

This document tracks the technical refactoring of the core "smarts" (stabilization, deduplication, and event handling) from the React-coupled `ListenerPage.jsx` and `HostPage.jsx` into a framework-agnostic, versioned GitHub package: `@jkang1643/caption-engine`.

---

## 0) BUG FIXES (Resolved Issues)
**Most recent at the top.**

### BUG 2: FIXED — handleFinal Logic Error (Translation Mode)
**Status:** ✅ RESOLVED (2026-01-20)

Fixed a logic error where the engine would incorrectly prioritize `correctedText` (source language) over `translatedText` (target language) during the final commit phase in non-transcription sessions.

#### Root Cause:
The `handleFinal` method was using a broad `finalText` fallback on line 364 that prioritized `correctedText`. This text was then passed to the segmenter and added to history, causing the host's original text to appear in the listener's translation history.

#### Key Fixes:
1. **Target-Aware Buffering:** Updated `handleFinal` to use `textToDisplay` (which correctly branches based on language mode) as the primary input for both the `SentenceSegmenter` and the `addToHistory` call.
2. **Mock Realism:** Updated the test mock segmenter to better reflect the pass-through behavior needed for golden tests.

---

### BUG 1: FIXED — Type Safety & Unused Variables (Build Failure)
**Status:** ✅ RESOLVED (2026-01-20)

Resolved a build failure in the new package caused by strict TypeScript configuration.

#### Root Cause:
1. **TypedEmitter Constraint:** `CaptionEngineEvents` lacked an index signature, violating the `TypedEmitter` record constraint.
2. **Unused Property:** The `sourceLang` class property was assigned but never read (logic used `message.sourceLang` directly).

#### Key Fixes:
1. **Index Signature:** Added `[key: string]: unknown` to `CaptionEngineEvents`.
2. **Logic Unification:** Updated `handlePartial` and `handleFinal` to use `this.sourceLang`, satisfying the compiler and ensuring consistent transcription mode detection.

---

## 1) What we did (feature updates / changes)

### 2026-01-20 — PR 1: Package Infrastructure & Types
**Status:** ✅ IMPLEMENTED

Established the foundational structure for the shared engine package.

**Key Changes:**
- **Package Setup:** Initialized `packages/exbabel-caption-engine` with ESM, TypeScript, and Vitest.
- **Typed SDK:** Defined `CaptionEvent` union and `CaptionViewModel` interfaces to provide a "single source of truth" for the application's data contract.
- **TypedEmitter:** Implemented a minimal, dependency-free `TypedEmitter` for high-performance event dispatching in both Web and Node environments.

---

### 2026-01-20 — PR 2: Logic Lifting & Consolidation
**Status:** ✅ IMPLEMENTED

Extracted ~1,000 lines of complex WebSocket handling logic from React components into the pure TypeScript `CaptionClientEngine` class.

**Key Changes:**
- **Out-of-Order Detection:** Extracted monotonic `seqId` tracking per source sequence to drop late-arriving partials.
- **Deduplication Engine:** Ported the complex overlaps/duplicate detection logic that prevents "ghosting" or duplicated sentences.
- **Grammar Merging:** Extracted `mergeTextWithCorrection` logic from the Host Page to ensure real-time corrections are smoothly integrated into current segments.
- **Throttling:** Implemented a internal timer to limit UI updates to ~15fps, preventing DOM thrashing during high-speed speech.

---

### 2026-01-20 — PR 3: Golden Run Test Harness
**Status:** ✅ IMPLEMENTED

Implemented a deterministic testing system to ensure 1:1 behavior parity and prevent regressions.

**Key Changes:**
- **Trace Replay System:** Created helpers to "play back" WebSocket event logs through the engine and assert against state snapshots.
- **Sample Fixtures:** Created realistic event traces covering edge cases like out-of-order delivery, forced finals, and grammar updates.
- **Automatic Regression Testing:** Integrated into CI/CD flow via `npm test`.

---

### 2026-01-20 — PR 4: Multi-Repo Extraction & Portability
**Status:** ✅ IMPLEMENTED

Extracted the package into a standalone repository to support a multi-repo architecture (Web + Electron) and hardened it for non-browser environments.

**Key Changes:**
- **Scoped Naming:** Renamed the package from `exbabel-caption-engine` to **`@jkang1643/caption-engine`** for clean publishing to GitHub Packages.
- **Standalone Repository:** Created [jkang1643/exbabel-caption-engine](https://github.com/jkang1643/exbabel-caption-engine) with its own lifecycle.
- **WebSocket Decoupling:** Added `connectWithWebSocket(ws)` to allow injecting a `WebSocket` implementation (e.g., the `ws` package), making the engine usable in **Electron Main** or **Node.js** processes without polyfills.
- **CI/CD Automation:** Configured GitHub Actions for:
    - **Test Workflow:** Automatic testing on all PRs/Pushes.
    - **Publish Workflow:** Automatic publishing to GitHub Packages on version tags (e.g., `v0.1.1`).
- **NPM Registry Setup:** Configured `.npmrc` to target `npm.pkg.github.com`.

---

### 2026-01-20 — PR 5: SentenceSegmenter Migration
**Status:** ✅ IMPLEMENTED

Migrated the final major piece of caption logic from the frontend to the shared package.

**Key Changes:**
- **TypeScript Conversion:** Converted `sentenceSegmenter.js` to a strictly typed `SentenceSegmenter.ts` within the `@jkang1643/caption-engine` package.
- **Exporting:** Integrated the segmenter into the main package export for easier consumption.
- **Consumption Update:** Refactored `ListenerPage.jsx`, `HostPage.jsx`, and `TranslationInterface.jsx` in the web repository to use the shared package version, ensuring logic parity across platforms.
- **Package Release:** Published version `0.1.2` with these changes.

---

## 2) Where we are now (implementation status)

### ✅ Implemented
- **Pure Engine:** `CaptionClientEngine` is completely decoupled from React and Browser DOM.
- **Cross-Platform:** Usable in Browser, Electron Renderer, Electron Main, and Node.js.
- **Event-Driven:** Uses a robust subscription model (`engine.on('state', callback)`).
- **Golden Tests:** 10 fundamental test cases covering all stabilization logic.
- **Standalone Repo:** Hosted at `jkang1643/exbabel-caption-engine`.
- **Versioned:** Published as `@jkang1643/caption-engine@0.1.2`.
- **Full Integration:** Applied to `ListenerPage`, `HostPage`, and `TranslationInterface`.
- **Unified Logic:** Both Web and future Electron builds now share the same segmentation/stabilization core.

### 🔍 Known / Remaining
- **TtsPlayerController Migration:** The TTS playback logic is still in the frontend. We should evaluate moving it to the shared engine to support Electron main-process TTS.
- **Test Coverage:** Expand unit tests specifically for the newly migrated `SentenceSegmenter`.

---

## 3) What's next (highest-confidence plan)

### Next Step A — Phase 6: TtsPlayerController Migration
**Goal:** Abstract and move the `TtsPlayerController` logic into the shared engine to allow cross-platform TTS management.

### Next Step B — Phase 7: Electron Main-Process Prototype
**Goal:** Verify the engine works in an Electron main process without a browser window, using the `ws` package for transport.

---

## 4) Constraints and guiding principles

- **Zero UX Regressions:** The shared engine must produce output identical to the legacy React-based implementation.
- **Framework Agnostic:** No imports from `react`, `next`, or any browser-specific globals (beyond optional `WebSocket` which defaults to injection-ready).
- **Sequential Stability:** The engine is the final arbiter of `seqId` monotonicity on the client side.

---

**END OF DOCUMENT**
