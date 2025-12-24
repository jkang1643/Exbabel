#!/usr/bin/env python3
"""Fix resetPartialTracking calls and add to checkForExtendingPartialsAfterFinal"""

import re

file_path = 'soloModeHandler.js'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Fix inline reset calls (add newlines)
content = re.sub(
    r'resetPartialTracking\(\);const waitTime',
    r'resetPartialTracking();\n                        const waitTime',
    content
)

# Add reset call at end of checkForExtendingPartialsAfterFinal if not present
# Find the closing brace of checkForExtendingPartialsAfterFinal
pattern = r'(if \(!foundExtension\) \{[^}]*\})\s*(\n\s*\};)\s*(\n\s*// Helper function to process final text)'
if not re.search(r'resetPartialTracking\(\);.*\n\s*\};.*\n\s*// Helper function to process final text', content, re.DOTALL):
    content = re.sub(
        pattern,
        r'\1\n                \n                // CRITICAL FIX: Reset partial tracking AFTER checking for extensions\n                // This prevents partials from building up and causing connection/timeout issues\n                resetPartialTracking();\2\3',
        content,
        flags=re.DOTALL
    )

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print(f"✅ Fixed resetPartialTracking calls in {file_path}")

