# Exbabel — UI/UX Revamp
**Last updated:** 2026-01-16 (America/Chicago) - Mobile Header Optimization

This is a running "what is done" document capturing frontend enhancements, user flow improvements, and visual revamps for the Exbabel platform.
**Newest items are at the top.**

---

## 0) BUG FIXES (Resolved Issues)
**Most recent at the top.**

### BUG 2: FIXED — Translation Logic Regression (Split Case Handlers)
**Status:** ✅ RESOLVED (2026-01-15)

Fixed a critical regression in websocket message handling that was inadvertently introduced during the UI/UX rearrange. The translation logic was broken into 4 separate case handlers that incorrectly depended on `message.type` being exact strings instead of using the `message.isPartial` flag.

#### Root Cause:
1. **Split Handlers:** During the UI/UX rearrange, the websocket handler was split into 4 separate cases: `TRANSCRIPT_PARTIAL`, `TRANSLATION_PARTIAL`, `TRANSCRIPT_FINAL`, and `TRANSLATION_FINAL`.
2. **Wrong Detection Logic:** These handlers depended on `message.type` being exact strings instead of using `message.isPartial` boolean flag to detect partial vs final messages.
3. **Duplicate Logic:** The split handlers duplicated logic that already existed in the unified `translation` case handler, creating potential race conditions.

#### Key Fixes:
1. **Removed Split Handlers:** Deleted all 4 split case handlers (274 lines) that were causing the regression.
2. **Restored Unified Handler:** Preserved the existing unified `case 'translation':` handler which already contained the correct logic from commit `da67e37`.
3. **Proper Detection:** Restored partial/final detection using `message.isPartial` flag (NOT `message.updateType`).
4. **Correct Text Selection:** Restored `message.translatedText` with proper `hasTranslation` checks.
5. **Stable Keys:** Restored `message.sourceSeqId ?? message.seqId` as stable correlation key for history commits.
6. **Final Commit Logic:** Restored proper final segment commit, partial clearing, and state reset.
7. **Message Guards:** Ensured non-translation messages (e.g., `session_stats`) don't mutate translation state.

#### Outcome:
- ✅ **Correct Behavior:** Partial vs final detection now uses `isPartial` flag as intended.
- ✅ **Stable Correlation:** Original text properly correlated with translations using `sourceSeqId ?? seqId`.
- ✅ **Clean State:** Finals properly clear partials and reset state for next segment.
- ✅ **UI Preserved:** All UI/UX improvements (TTS controls, voice selectors) remain intact.
- 📊 **Code Quality:** Net -64 lines (298 deletions, 234 insertions).

**Where fixed:**
- **Frontend:** `frontend/src/components/ListenerPage.jsx` (websocket message handler)

---

### BUG 1: FIXED — React DOM Conflict & QR Scanner Crash (removeChild error)
**Status:** ✅ RESOLVED (2026-01-15)

Resolved a critical "White Screen" crash that occurred when activating or closing the QR scanner, where React would throw `Uncaught NotFoundError: Failed to execute 'removeChild' on 'Node'`.

#### Root Cause:
1. **Third-Party DOM Mutation:** The `html5-qrcode` library performs manual DOM manipulations (clearing innerHTML, injecting video/canvas elements) inside its target container.
2. **React Reconciliation Conflict:** React was attempting to manage children (like a "Loading" message) inside the same container. When the scanner library wiped the container, React's virtual DOM became out of sync, leading it to attempt to remove a node that no longer existed in the actual DOM.

#### Key Fixes:
1. **Container Isolation:** Refactored `JoinSessionModal.jsx` to ensure the `#reader` div used by the scanner is completely empty and unmanaged by React.
2. **Sibling Overlays:** Moved all React-managed UI states (loading spinners, "Initializing..." messages) to sibling elements positioned over the scanner using absolute positioning.
3. **Strict Lifecycle Cleanup:** Implemented a robust `handleStopScanner` function that explicitly stops the stream, clears the library state, and manually sanitizes the container DOM on unmount or mode switch.
4. **Race Condition Prevention:** Added a 300ms delay before scanner initialization to ensure the modal's entry animation completes and the DOM node is fully available.

#### Outcome:
- ✅ **Stability:** Zero crashes during scanner activation, deactivation, or rapid mode switching.
- ✅ **Cleanup:** Camera resources are reliably released, preventing hardware locks.

---

## 1) What we did (feature updates / changes)

### 2026-01-15 — PR 1: Join Session Flow Revamp (QR + Manual)
**Status:** ✅ IMPLEMENTED - Production Ready

Replaced the simple text input for joining sessions with a modern, multi-option modal flow that prioritizes speed and accessibility.

**Key Changes:**
- **Centralized Entrance:** Replaced the homepage inline input with a single "Tap to Join Session" button.
- **Join Modal Architecture:** Created `JoinSessionModal.jsx` to handle the selection between camera scanning and manual entry.
- **Adaptive QR Scanner:**
    - Integrated `html5-qrcode` for high-performance browser-side scanning.
    - **Intelligent Fallback:** Automatically attempts the rear camera (environment) first for mobile users, falling back to the webcam (user) for laptops.
- **Performance Optimization:**
    - **20 FPS Recognition:** Increased frame sampling for faster code detection.
    - **Adaptive Viewfinder:** Expanded the scanning region to 80% of the viewfinder for easier alignment.
- **Visual Polish:**
    - Added a CSS-based "Scanning Line" animation and vignette effect to the viewfinder.
    - implemented responsive design for both mobile and desktop camera aspect ratios.
- **Robust Code Extraction:** implemented regex-based parsing to handle both direct session codes and full Join URLs (e.g., `?join=XXXXXX`).

**Where implemented:**
- **Frontend:** `frontend/src/components/JoinSessionModal.jsx`, `frontend/src/components/HomePage.jsx`, `frontend/src/index.css`

---

### 2026-01-15 — PR 2: Listener Page UI Consolidation & TTS Settings Restoration
**Status:** ✅ IMPLEMENTED - Production Ready

Streamlined the Listener Page by merging redundant UI bars into a single unified menu and restoring advanced TTS controls via a modal.

**Key Changes:**
- **Unified Control Bar:**
    - Consolidated the "Session Info Bar" and "TTS Controls" into a single, row-based menu bar.
    - Optimized layout for both mobile and desktop, docking the Session Code, Voice Model, Language, and Action buttons in a logical sequence.
- **Advanced TTS Settings Modal:**
    - **Concept:** "Clean UI, Full Power." Tucked granular settings into a **Settings (Gear Icon)** modal to remove visual noise while preserving functionality.
    - **Restored Controls:**
        - **Global:** Real-time Speaking Rate adjustment.
        - **Gemini Specific:** Prompt Preset selection, Custom Instruction input, and Style Intensity slider.
        - **Chirp 3 HD Specific:** Delivery Style (Preaching, Teaching, etc.) selection.
- **Enhanced Voice Selection:**
    - **Tier-Based Grouping:** Refactored the voice selector to explicitly group voices by their technical tier (Gemini & Studio, Chirp 3 HD, Neural2, Standard).
    - **Accuracy:** Fixed a routing bug where voices with identical names (e.g., "Kore") were misidentified across tiers.
- **Zero-Logic Refactor:** Achieved the layout change without altering WebSocket handling or backend data structures.

**Where implemented:**
- **Frontend:** `frontend/src/components/ListenerPage.jsx`, `frontend/src/components/TtsSettingsModal.jsx` (New)

---

### 2026-01-16 — PR 3: Live Translation Clarity & Visual Revamp
**Status:** ✅ IMPLEMENTED - Production Ready

Refined the live translation experience to prioritize dual-language clarity and improve visual density on the Listener Page.

**Key Changes:**
- **Dual-Language Live Box:**
    - Restored simultaneous display of both original (Host) and translated text in the live partials box.
    - Added high-visibility "LIVE" pulse indicator for active streaming.
- **"Tap-to-Reveal" History:**
    - Modified history segments to show **Translation Only** by default for a cleaner look.
    -Implemented a "Flip" interaction: users can tap any history segment to reveal the original source text.
- **Visual Space Optimization:**
    - Significantly increased font sizes for both live text and history segments (`text-xl` to `text-3xl`) to fill available screen space and reduce dead white space.
- **Auto-Scroll Behavior:**
    - Fixed auto-scroll logic to pin the view to the **bottom** (newest segments) of the history list instead of the top.
- **Precision Voice Defaults:**
    - Isolated speaking rate defaults on a per-tier basis.
    - **Chirp 3 HD:** Reduced default speed to **1.1x** (from 1.45x) for clearer delivery.
    - **Gemini & Studio:** Preserved **1.45x** default for high-performance AI synthesis.
- **Header Removal:**
    - Removed the redundant Exbabel branding header to maximize vertical screen space for translation content.

- **Frontend:** `frontend/src/components/ListenerPage.jsx`
---

### 2026-01-16 — PR 4: Listener Mobile Header Optimization
**Status:** ✅ IMPLEMENTED - Production Ready

Refactored the mobile session information header on the Listener page to reclaim vertical space for translation content.

**Key Changes:**
- **Compact Horizontal Layout:** Replaced the large card-based session info with a single horizontal flex-row on mobile devices.
- **Dynamic Labeling:** Conditionally hid "Session Code" and "Language" labels on mobile, relying on visual cues and icons to reduce vertical height by ~60%.
- **Compact Language Selector:** Enhanced the `LanguageSelector` component with a `compact` property, allowing it to render as a minimal pill for use in dense headers.
- **Consistency:** Shared the compact logic across the Listener Page while intentionally preserving the original layout for the Host Page.

**Where implemented:**
- **Frontend:** `frontend/src/components/ListenerPage.jsx`, `frontend/src/components/LanguageSelector.jsx`

---

### 2026-01-16 — PR 5: Live Partials Interaction & Sticky Header
**Status:** ✅ IMPLEMENTED - Production Ready

Enhanced the "Live Translation" experience by introducing focus-mode defaults, interactive text revealing, and sticky header positioning.

**Key Changes:**
- **Interactive Live Box:**
    - **Refined Default State:** Hides the original English text by default to reduce cognitive load, showing only the target translation.
    - **Tap-to-Expand:** Implemented a toggle interaction where tapping the box reveals/hides the original text.
    - **Visual Cues:** Added subtle "(Tap to expand)" text and hover states to indicate interactivity.
- **Sticky Session Header:**
    - **Bottom Docking:** Pinned the compact session info bar (`sticky bottom-0 z-50`) to the footer area. This resolves conflicts with mobile browser toolbars/notches and improves thumb accessibility.
    - **Stacking Context Fix:** Re-parented the `TtsSettingsModal` and global error display outside the sticky container to ensure modals render in the correct global stacking context (fixed centering and no cutoff).


**Where implemented:**
- **Frontend:** `frontend/src/components/ListenerPage.jsx`

---

## 2) Where we are now (implementation status)

### ✅ Implemented
- **QR Scanning:** Robust browser-side QR detection with multi-camera support.
- **Manual Input:** High-visibility manual code entry with auto-focus and auto-capitalization.
- **Unified Menu Bar:** Single-row header for Listener Page session and TTS management.
- **Advanced TTS Settings:** Full control over AI personality and delivery style via settings modal.
- **Dual-Language Live View:** Simultaneous visibility of host original and translation.
- **Interactive History:** Tap-to-reveal original text flip logic in history list.
- **Adaptive Auto-Scroll:** Pins viewport to newest content at bottom of history.
- **Fine-tuned Speed Defaults:** 1.1x for Chirp3 vs 1.45x for Gemini.
- **Compact Mobile Header (Listener):** Maximized vertical real-estate by condensing the session bar.
- **Interactive Live Box:** Tap-to-reveal original text for focused translation viewing.
- **Bottom Sticky Header:** Persistent session controls docked at the bottom with fixed stacking context for modals.

### 🔍 Known / Remaining
- **Torch Support:** Some mobile browsers support a flashlight toggle; currently not implemented.
- **Permission Persistence:** Users must grant camera permission each time in some restricted browser environments.

---

## 3) What's next (highest-confidence plan)

### Next Step A — Torch Control
**Goal:** Add a flashlight toggle for the QR scanner to improve recognition in low-light environments (mobile only).

### Next Step B — QR Generation Refactor
**Goal:** Standardize the QR code format generated in `HostPage.jsx` to ensure perfect compatibility with the new scanner's regex parsing.

---

## 4) Constraints and guiding principles

- **Mobile First:** Joining sessions is a primarily mobile activity; the camera flow must be flawless on iOS/Android.
- **No White Screens:** Any third-party DOM library must be isolated from React's reconciliation engine.
- **Zero Friction:** A user should be able to join a session in under 3 seconds from landing on the homepage.

---

**END OF DOCUMENT**
