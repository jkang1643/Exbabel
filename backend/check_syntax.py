#!/usr/bin/env python3
"""Check for syntax errors in soloModeHandler.js"""

with open('soloModeHandler.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Check around line 1959
print("Lines around 1959:")
for i in range(1850, min(1970, len(lines))):
    line = lines[i].rstrip()
    print(f"{i+1:4d}: {line}")
    
# Check for unclosed parentheses/braces
paren_count = 0
brace_count = 0
for i in range(1850, min(1960, len(lines))):
    line = lines[i]
    paren_count += line.count('(') - line.count(')')
    brace_count += line.count('{') - line.count('}')
    if i == 1958:  # Line 1959 (0-indexed)
        print(f"\nAt line {i+1}: paren_count={paren_count}, brace_count={brace_count}")

