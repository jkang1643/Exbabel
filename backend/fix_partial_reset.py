#!/usr/bin/env python3
"""Fix partial tracking reset in SOLO mode to prevent buildup"""

import re

file_path = 'soloModeHandler.js'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Add reset function after THROTTLE_MS definition
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

# Insert reset function after THROTTLE_MS
content = re.sub(
    r'(const THROTTLE_MS = 0; // No throttle - instant translation on every character)\s*\n\s*// Helper function to check for partials',
    r'\1\n' + reset_function + r'              // Helper function to check for partials',
    content
)

# Add reset call at end of checkForExtendingPartialsAfterFinal
content = re.sub(
    r'(if \(!foundExtension\) \{[^}]*\})\s*(\n\s*\};)\s*// Helper function to process final text',
    r'\1\n                \n                // CRITICAL FIX: Reset partial tracking AFTER checking for extensions\n                // This prevents partials from building up and causing connection/timeout issues\n                // Similar to HOST mode which resets after final is sent\n                resetPartialTracking();\2\n              \n              // Helper function to process final text',
    content,
    flags=re.DOTALL
)

# Also ensure all manual resets use the function (replace scattered resets)
# Replace: latestPartialText = ''; longestPartialText = ''; (with optional time resets)
content = re.sub(
    r'(\s+)(latestPartialText = \'\';\s+longestPartialText = \'\';\s*(?:latestPartialTime = 0;\s+longestPartialTime = 0;)?)',
    r'\1resetPartialTracking();',
    content
)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"✅ Fixed partial tracking reset in {file_path}")

