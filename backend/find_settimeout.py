#!/usr/bin/env python3
"""Find setTimeout calls before line 1958"""

with open('soloModeHandler.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find setTimeout calls before line 1958
print("setTimeout calls before line 1958:")
for i in range(1600, 1959):
    if 'setTimeout' in lines[i]:
        print(f'Line {i+1}: {lines[i].strip()[:100]}')
        
# Check the structure around line 1755-1760
print("\nStructure around line 1755-1760:")
for i in range(1750, 1765):
    if i < len(lines):
        print(f'{i+1:4d}: {lines[i].rstrip()}')

