[UNSTABLE] Partial CoreEngine migration with compatibility layers in host and solo modes

This commit contains experimental and unstable changes as part of the ongoing
CoreEngine extraction refactoring (Phase 7 for solo mode, Phase 8 for host mode).

## Host Mode Changes (`backend/host/adapter.js`)

- **Partial CoreEngine integration**: Host mode now uses CoreEngine for tracking
  engines (timeline, RTT, partial, finalization, forced commit) but still maintains
  extensive compatibility layers
- **Compatibility synchronization**: Added `syncForcedFinalBuffer()` and
  `syncPendingFinalization()` functions throughout the codebase to bridge between
  legacy variable-based state and new engine-managed state
- **Temporary recovery streams**: Implemented experimental audio recovery mechanism
  using temporary Google Speech streams with auto-restart disabled for forced final
  buffer recovery
- **Incomplete force commit**: Force commit logic marked with TODO - not yet
  implemented using CoreEngine (line 2873)
- **Backward compatibility**: Constants and engine access patterns maintained for
  backward compatibility during migration

## Solo Mode Changes (`backend/soloModeHandler.js`)

- **Partial CoreEngine integration**: Solo mode migrated to CoreEngine (Phase 7)
  but retains compatibility layers for gradual migration
- **Compatibility synchronization**: Extensive use of `syncForcedFinalBuffer()` and
  `syncPendingFinalization()` to maintain state synchronization between legacy
  variables and engine state
- **Temporary recovery streams**: Same experimental audio recovery mechanism as
  host mode - temporary streams with auto-restart disabled
- **Engine state bridging**: Helper functions `updateEngineFromPending()` and sync
  functions ensure existing code continues working during transition
- **Multi-session optimization**: Session tracking maintained for fair-share rate
  limiting across concurrent sessions

## Known Issues & Warnings

⚠️ **UNSTABLE STATE**: Both modes are in a transitional migration state with:
- Significant code duplication still present (~2400 lines each)
- Compatibility layers that add complexity and potential sync issues
- Incomplete migration of shared logic (grammar caching, processFinalText, etc.)
- Force commit not fully implemented in host mode

⚠️ **Experimental Features**:
- Temporary recovery stream mechanism may have edge cases
- Auto-restart disabled on recovery streams may cause issues in certain scenarios
- Compatibility layer synchronization may introduce race conditions

## Migration Status

- ✅ CoreEngine initialized and accessible in both modes
- ✅ Individual engines (timeline, RTT, partial, finalization, forced commit) extracted
- ⚠️ Compatibility layers still required for existing code paths
- ❌ Shared logic (grammar cache, processFinalText) not yet fully extracted
- ❌ Force commit incomplete in host mode

This commit represents work-in-progress and should not be considered stable
for production use.
