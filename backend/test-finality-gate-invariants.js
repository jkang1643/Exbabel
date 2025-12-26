/**
 * FinalityGate Invariant Tests
 * 
 * Tests that enforce the core invariants of the FinalityGate system:
 * 1. Recovery candidates always win over grammar candidates
 * 2. Grammar candidates are blocked when recovery is pending
 * 3. Recovery candidates can upgrade grammar candidates
 * 4. No candidate can commit after segment is finalized
 * 
 * These tests are designed to catch regressions that would reintroduce
 * the async finalization race condition bug.
 * 
 * Run with: node backend/test-finality-gate-invariants.js
 */

import { FinalityGate, CandidateSource } from '../core/engine/finalityGate.js';

console.log('🧪 FinalityGate Invariant Tests\n');
console.log('='.repeat(80));

let testsPassed = 0;
let testsFailed = 0;

function test(name, testFn) {
  try {
    const result = testFn();
    if (result) {
      console.log(`✅ ${name}`);
      testsPassed++;
    } else {
      console.log(`❌ ${name}`);
      console.log(`   Test returned false`);
      testsFailed++;
    }
  } catch (error) {
    console.log(`❌ ${name}`);
    console.log(`   Error: ${error.message}`);
    console.log(`   Stack: ${error.stack}`);
    testsFailed++;
  }
}

// Test 1: Recovery always wins over Grammar
test('Recovery candidate always wins over Grammar candidate', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-1';
  
  // Submit grammar candidate first
  const grammarCandidate = {
    text: 'You know, when you entertain strangers, you may be entertaining angels unaware. You know, but if you miss that, let me give you this one: where two or three are.',
    source: CandidateSource.Grammar,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  gate.submitCandidate(grammarCandidate);
  
  // Submit recovery candidate (better - has "gathered together")
  const recoveryCandidate = {
    text: 'you know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one where two or three are gathered together',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now() + 100
  };
  
  gate.markRecoveryPending(segmentId);
  const result = gate.submitCandidate(recoveryCandidate);
  
  // Recovery should be able to commit (even though grammar was submitted first)
  if (!result.canCommit) {
    console.log(`   Recovery candidate cannot commit (expected true)`);
    return false;
  }
  
  // Finalize - should get recovery candidate
  const finalized = gate.finalizeSegment(segmentId);
  
  if (!finalized) {
    console.log(`   No candidate finalized (expected recovery candidate)`);
    return false;
  }
  
  // CRITICAL: Final must be recovery candidate
  if (finalized.source !== CandidateSource.Recovery) {
    console.log(`   Finalized source is ${finalized.source}, expected ${CandidateSource.Recovery}`);
    return false;
  }
  
  // CRITICAL: Final must contain the recovery text
  if (!finalized.text.includes('gathered together')) {
    console.log(`   Finalized text does not contain "gathered together"`);
    console.log(`   Finalized text: "${finalized.text.substring(0, 100)}..."`);
    return false;
  }
  
  return true;
});

// Test 2: Grammar blocked when recovery pending
test('Grammar candidate blocked when recovery is pending', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-2';
  
  // Mark recovery as pending
  gate.markRecoveryPending(segmentId);
  
  // Try to submit grammar candidate
  const grammarCandidate = {
    text: 'Some grammar corrected text',
    source: CandidateSource.Grammar,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  const result = gate.submitCandidate(grammarCandidate);
  
  // Grammar should NOT be able to commit
  if (result.canCommit) {
    console.log(`   Grammar candidate can commit when recovery is pending (expected false)`);
    return false;
  }
  
  // Should be blocked
  return true;
});

// Test 3: Recovery can commit even when grammar is pending
test('Recovery candidate can commit even when grammar candidate exists', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-3';
  
  // Submit grammar candidate first
  const grammarCandidate = {
    text: 'Shorter grammar text',
    source: CandidateSource.Grammar,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  gate.submitCandidate(grammarCandidate);
  
  // Mark recovery pending
  gate.markRecoveryPending(segmentId);
  
  // Submit recovery candidate (should be able to commit)
  const recoveryCandidate = {
    text: 'Longer recovery text with additional words',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now() + 100
  };
  
  const result = gate.submitCandidate(recoveryCandidate);
  
  // Recovery should be able to commit
  if (!result.canCommit) {
    console.log(`   Recovery candidate cannot commit (expected true)`);
    return false;
  }
  
  return true;
});

// Test 4: Recovery upgrades grammar candidate
test('Recovery candidate upgrades grammar candidate (replaces it)', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-4';
  
  // Submit grammar candidate
  const grammarCandidate = {
    text: 'where two or three are',
    source: CandidateSource.Grammar,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  gate.submitCandidate(grammarCandidate);
  
  // Submit recovery candidate (upgrade)
  const recoveryCandidate = {
    text: 'where two or three are gathered together',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now() + 100
  };
  
  gate.markRecoveryPending(segmentId);
  gate.submitCandidate(recoveryCandidate);
  gate.markRecoveryComplete(segmentId);
  
  // Finalize - should get recovery candidate
  const finalized = gate.finalizeSegment(segmentId);
  
  if (!finalized) {
    console.log(`   No candidate finalized`);
    return false;
  }
  
  // Should be recovery candidate
  if (finalized.source !== CandidateSource.Recovery) {
    console.log(`   Finalized source is ${finalized.source}, expected ${CandidateSource.Recovery}`);
    return false;
  }
  
  // Should contain recovery text
  if (!finalized.text.includes('gathered together')) {
    console.log(`   Finalized text does not contain recovery text`);
    return false;
  }
  
  // Should NOT be grammar text
  if (finalized.text === grammarCandidate.text) {
    console.log(`   Finalized text is grammar text (expected recovery text)`);
    return false;
  }
  
  return true;
});

// Test 5: No commits after finalization
test('No candidate can commit after segment is finalized', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-5';
  
  // Submit and finalize a recovery candidate
  const recoveryCandidate = {
    text: 'Final recovery text',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  gate.markRecoveryPending(segmentId);
  gate.submitCandidate(recoveryCandidate);
  gate.markRecoveryComplete(segmentId);
  
  const finalized = gate.finalizeSegment(segmentId);
  if (!finalized) {
    console.log(`   Failed to finalize initial candidate`);
    return false;
  }
  
  // Try to submit another candidate after finalization
  const lateCandidate = {
    text: 'Late candidate text',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now() + 1000
  };
  
  const result = gate.submitCandidate(lateCandidate);
  
  // Should NOT be able to commit
  if (result.canCommit) {
    console.log(`   Late candidate can commit after finalization (expected false)`);
    return false;
  }
  
  // Segment should be finalized
  if (!gate.isFinalized(segmentId)) {
    console.log(`   Segment is not finalized (expected true)`);
    return false;
  }
  
  return true;
});

// Test 6: Forced candidate blocked when recovery pending
test('Forced candidate blocked when recovery is pending', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-6';
  
  // Mark recovery as pending
  gate.markRecoveryPending(segmentId);
  
  // Try to submit forced candidate
  const forcedCandidate = {
    text: 'Some forced final text',
    source: CandidateSource.Forced,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  const result = gate.submitCandidate(forcedCandidate);
  
  // Forced should NOT be able to commit
  if (result.canCommit) {
    console.log(`   Forced candidate can commit when recovery is pending (expected false)`);
    return false;
  }
  
  return true;
});

// Test 7: Recovery pending flag clears after finalization
test('Recovery pending flag clears after finalization', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-7';
  
  // Mark recovery pending
  gate.markRecoveryPending(segmentId);
  
  if (!gate.isRecoveryPending(segmentId)) {
    console.log(`   Recovery not marked as pending`);
    return false;
  }
  
  // Submit and finalize recovery candidate
  const recoveryCandidate = {
    text: 'Recovery text',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  gate.submitCandidate(recoveryCandidate);
  gate.markRecoveryComplete(segmentId);
  gate.finalizeSegment(segmentId);
  
  // Recovery should no longer be pending
  if (gate.isRecoveryPending(segmentId)) {
    console.log(`   Recovery still marked as pending after finalization`);
    return false;
  }
  
  return true;
});

// Test 8: Priority ordering (Recovery > Forced > Grammar)
test('Candidate priority ordering: Recovery > Forced > Grammar', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-8';
  
  // Submit candidates in priority order
  const grammarCandidate = {
    text: 'Grammar text',
    source: CandidateSource.Grammar,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  const forcedCandidate = {
    text: 'Forced text',
    source: CandidateSource.Forced,
    segmentId: segmentId,
    timestamp: Date.now() + 100
  };
  
  const recoveryCandidate = {
    text: 'Recovery text',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now() + 200
  };
  
  // Submit grammar first
  gate.submitCandidate(grammarCandidate);
  
  // Submit forced (should upgrade grammar)
  const forcedResult = gate.submitCandidate(forcedCandidate);
  if (!forcedResult.accepted) {
    console.log(`   Forced candidate not accepted (expected upgrade)`);
    return false;
  }
  
  // Mark recovery pending and submit recovery (should upgrade forced)
  gate.markRecoveryPending(segmentId);
  const recoveryResult = gate.submitCandidate(recoveryCandidate);
  if (!recoveryResult.accepted) {
    console.log(`   Recovery candidate not accepted (expected upgrade)`);
    return false;
  }
  
  // Finalize - should get recovery
  gate.markRecoveryComplete(segmentId);
  const finalized = gate.finalizeSegment(segmentId);
  
  if (!finalized || finalized.source !== CandidateSource.Recovery) {
    console.log(`   Finalized candidate is not recovery (expected Recovery)`);
    return false;
  }
  
  return true;
});

// Test 9: Exact bug scenario from issue
test('Exact bug scenario: Grammar commits before recovery, recovery should win', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-9';
  
  // This simulates the exact bug: grammar worker finalizes early
  const grammarText = 'You know, when you entertain strangers, you may be entertaining angels unaware. You know, but if you miss that, let me give you this one: where two or three are.';
  
  // Mark recovery pending first (this is what should happen)
  gate.markRecoveryPending(segmentId);
  
  // Grammar tries to commit (should be blocked)
  const grammarCandidate = {
    text: grammarText,
    source: CandidateSource.Grammar,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  const grammarResult = gate.submitCandidate(grammarCandidate);
  
  // Grammar should be blocked
  if (grammarResult.canCommit) {
    console.log(`   Grammar candidate can commit when recovery is pending (BUG: should be blocked)`);
    return false;
  }
  
  // Recovery resolves with better text
  const recoveryText = 'you know, when you entertain strangers, you may be entertaining angels unaware, you know, but if you miss that, let me give you this one where two or three are gathered together';
  
  const recoveryCandidate = {
    text: recoveryText,
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now() + 100
  };
  
  const recoveryResult = gate.submitCandidate(recoveryCandidate);
  
  if (!recoveryResult.canCommit) {
    console.log(`   Recovery candidate cannot commit (expected true)`);
    return false;
  }
  
  // Mark recovery complete and finalize
  gate.markRecoveryComplete(segmentId);
  const finalized = gate.finalizeSegment(segmentId);
  
  // CRITICAL INVARIANT: Final must be recovery
  if (!finalized || finalized.source !== CandidateSource.Recovery) {
    console.log(`   ❌ BUG: Finalized candidate is not Recovery`);
    console.log(`   Finalized source: ${finalized?.source}`);
    console.log(`   Expected: ${CandidateSource.Recovery}`);
    return false;
  }
  
  // CRITICAL INVARIANT: Final must contain "gathered together"
  if (!finalized.text.includes('gathered together')) {
    console.log(`   ❌ BUG: Finalized text does not contain "gathered together"`);
    console.log(`   Finalized text: "${finalized.text.substring(0, 150)}..."`);
    return false;
  }
  
  return true;
});

// Test 10: Longer text doesn't override higher priority
test('Higher priority source wins even if lower priority text is longer', () => {
  const gate = new FinalityGate();
  const segmentId = 'test-segment-10';
  
  // Submit very long grammar candidate
  const grammarCandidate = {
    text: 'A'.repeat(1000), // Very long
    source: CandidateSource.Grammar,
    segmentId: segmentId,
    timestamp: Date.now()
  };
  
  gate.submitCandidate(grammarCandidate);
  
  // Submit shorter recovery candidate (should win due to priority)
  const recoveryCandidate = {
    text: 'Short recovery',
    source: CandidateSource.Recovery,
    segmentId: segmentId,
    timestamp: Date.now() + 100
  };
  
  gate.markRecoveryPending(segmentId);
  gate.submitCandidate(recoveryCandidate);
  gate.markRecoveryComplete(segmentId);
  
  const finalized = gate.finalizeSegment(segmentId);
  
  // Recovery should win despite being shorter
  if (!finalized || finalized.source !== CandidateSource.Recovery) {
    console.log(`   Grammar won despite recovery having higher priority`);
    return false;
  }
  
  return true;
});

// Summary
console.log('\n' + '='.repeat(80));
console.log(`\n📊 Test Results: ${testsPassed} passed, ${testsFailed} failed\n`);

if (testsFailed === 0) {
  console.log('✅ All invariant tests passed! FinalityGate is working correctly.\n');
  process.exit(0);
} else {
  console.log(`❌ ${testsFailed} invariant test(s) failed. This indicates a regression.\n`);
  process.exit(1);
}

