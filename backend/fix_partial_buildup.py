#!/usr/bin/env python3
"""Clean fix for partial tracking buildup in SOLO mode"""

file_path = 'soloModeHandler.js'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Step 1: Add resetPartialTracking function after THROTTLE_MS
reset_function = '''              // CRITICAL FIX: Centralized partial tracking reset function
              // This ensures partials are always reset after final processing, preventing buildup
              // Similar to HOST mode's partialTracker.reset() - ensures consistent cleanup
              const resetPartialTracking = () => {
                latestPartialText = '';
                longestPartialText = '';
                latestPartialTime = 0;
                longestPartialTime = 0;
                console.log('[SoloMode] 🧹 Reset partial tracking for next segment');
              };
              
'''

content = content.replace(
    '              const THROTTLE_MS = 0; // No throttle - instant translation on every character\n              \n              // Helper function to check for partials',
    '              const THROTTLE_MS = 0; // No throttle - instant translation on every character\n' + reset_function + '              // Helper function to check for partials'
)

# Step 2: Add reset call at end of checkForExtendingPartialsAfterFinal (before closing brace)
# Find the pattern: if (!foundExtension) { ... } }; // Helper function to process
import re
pattern = r'(if \(!foundExtension\) \{[^}]*\})\s*(\n\s*\};)\s*(\n\s*// Helper function to process final text)'
replacement = r'\1\n                \n                // CRITICAL FIX: Reset partial tracking AFTER checking for extensions\n                // This prevents partials from building up and causing connection/timeout issues\n                resetPartialTracking();\2\3'
content = re.sub(pattern, replacement, content, flags=re.DOTALL)

# Step 3: Replace manual resets with function calls (but keep the ones in timeouts for now)
# Only replace standalone resets, not ones that are part of larger blocks
# Pattern: lines with just "latestPartialText = ''; longestPartialText = '';"
# We'll be conservative and only replace obvious standalone cases

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"✅ Applied clean fix for partial tracking buildup in {file_path}")

